import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeActionsUser, mergeEdgeUser, mergeSlowUser, publishUserPatch } from './dump-fast-publish.mjs';

const fast = (generation, value = 1) => ({ dp: [value], sp: [value], dpRecent: [], spRecent: [], fastGeneration: String(generation) });
const origin = (generation = '1') => ({ _v: 'old', user: { iidx_id: 'u1', old: true }, ...fast(generation), unknown: { keep: true } });
const patch = (generation = '2', value = 2) => fast(generation, value);

test('legacy mode leaves original user bytes and performs no I/O', async () => {
  const bytes = JSON.stringify({ _v: 'old', dp: [1], unknown: true });
  const untouched = await mergeEdgeUser(JSON.parse(bytes), {}, '1');
  assert.equal(untouched.ok, false);
  assert.equal(JSON.stringify(JSON.parse(bytes)), bytes);
});

test('Edge patches fast five keys and preserves slow and unknown fields', () => {
  const result = mergeEdgeUser(origin(), patch(), '2');
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.unknown, { keep: true });
  assert.deepEqual(result.value.user, origin().user);
  assert.deepEqual(Object.keys(result.value).filter((key) => ['dp', 'sp', 'dpRecent', 'spRecent', 'fastGeneration'].includes(key)), ['dp', 'sp', 'dpRecent', 'spRecent', 'fastGeneration']);
});

test('generation ordering rejects stale writes and same-generation conflicts', () => {
  assert.equal(mergeEdgeUser(origin('3'), patch('2'), '2').reason, 'newer-generation');
  assert.equal(mergeEdgeUser(origin('2'), patch('2', 9), '2').reason, 'generation-conflict');
  assert.equal(mergeEdgeUser(origin('2'), fast('2'), '2').changed, false);
  assert.throws(() => mergeActionsUser({ ...origin(), fastGeneration: 'bad' }, fast('3'), '3'), /fastGeneration/);
});

test('Actions captured generation preserves newer current scores and slow merge uses allowlist', () => {
  const current = { ...origin('8'), persona: 'current', extension: 9 };
  const saved = mergeActionsUser(current, { ...fast('7', 7), persona: 'local', extension: 0 }, '7');
  assert.deepEqual(saved.dp, current.dp);
  assert.equal(saved.persona, 'local');
  const slow = mergeSlowUser(current, { _v: 'new', dp: [99], persona: 'new', user: { name: 'n' }, extension: 0 });
  assert.deepEqual(slow.dp, current.dp);
  assert.deepEqual(slow.user, { ...current.user, name: 'n' });
  assert.equal(slow.extension, 9);
});

test('user CAS conflict stops without retries or a pending done write', async () => {
  const writes = [], reads = [];
  let current = { body: JSON.stringify(origin()), etag: '"u1"' };
  const r2 = {
    async read(key) { reads.push(key); return key.startsWith('user/') ? current : { body: JSON.stringify({ generation: '2', since: '2026-10-24T00:00:00.000Z' }), etag: '"p1"' }; },
    async put(key, body, etag) { writes.push([key, body, etag]); if (key.startsWith('user/')) throw new Error('HTTP 412'); },
  };
  const result = await publishUserPatch({ r2, id: 'u1', patch: patch(), generation: '2', since: '2026-10-24T00:00:00.000Z' });
  assert.equal(result.reason, 'user-put-failed');
  assert.equal(writes.length, 1);
  assert.equal(reads.filter((key) => key.startsWith('pending/')).length, 1);
});

test('lost/invalid writes never trigger a fallback or done after failure', async () => {
  for (const bad of [null, { body: '{', etag: '"u"' }, { body: JSON.stringify(origin()), etag: null }]) {
    let puts = 0;
    const r2 = { async read(key) { return key.startsWith('user/') ? bad : { body: JSON.stringify({ generation: '2', since: '2026-10-24T00:00:00.000Z' }), etag: '"p"' }; }, async put() { puts++; } };
    const result = await publishUserPatch({ r2, id: 'u1', patch: patch(), generation: '2', since: '2026-10-24T00:00:00.000Z' });
    assert.equal(result.ok, false);
    assert.equal(puts, 0);
  }
});

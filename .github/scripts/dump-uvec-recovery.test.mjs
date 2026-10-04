import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from './dump-uvec.mjs';
import { md5 } from './r2-client.mjs';

const silent = { log() {}, warn() {} };

async function fixture(t, ids = ['A', 'B']) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uvec-recovery-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'v3/services'), { recursive: true });
  await fs.writeFile(path.join(dir, 'v3/services/uvec-slice.js'), `
export async function computeUvecSlice(id, { fetchImpl }) {
  const profile = await (await fetchImpl('https://data.iidx.in/user/' + id + '.json')).json();
  if (profile.fail) throw new Error('calculation failed');
  return { v: 1, id, date: profile.date, arrangeSig: '', vec: profile.empty ? null : { id } };
}`);
  const objects = new Map(ids.map((id) => [`user/${id}.json`, JSON.stringify({ date: 1 })]));
  const calls = { writes: [], reads: [] };
  const client = {
    async getText(key) { calls.reads.push(key); return objects.get(key) ?? null; },
    async listEntries(prefix) {
      return [...objects].filter(([key]) => key.startsWith(prefix))
        .map(([key, body]) => ({ key, etag: md5(body) }));
    },
    async putText(key, body) {
      calls.writes.push(['put', key]); objects.set(key, body); return { ok: true };
    },
    async del(key) { calls.writes.push(['del', key]); objects.delete(key); return true; },
  };
  return {
    objects, calls, client,
    run: (options = {}) => run({ webBase: dir, client, fetchImpl: async () => new Response('{}'),
      sleep: async () => {}, log: silent, ...options }),
  };
}

test('missing vec is restored with unchanged inputs, then becomes complete', async (t) => {
  const f = await fixture(t, ['A']);
  await f.run({ apply: true });
  const saved = f.objects.get('meta/uvec-state.json');
  f.objects.delete('uslice/A-vec-dp.json');
  const restored = await f.run({ apply: true });
  assert.equal(restored.targets, 1);
  assert.equal(restored.computed, 1);
  assert.ok(f.objects.has('uslice/A-vec-dp.json'));
  assert.equal((await f.run({ apply: true })).targets, 0);
  assert.notEqual(saved, undefined);
});

test('hist change with missing vec is recovered; vec null still counts as present', async (t) => {
  const f = await fixture(t, ['A']);
  f.objects.set('user/A.json', JSON.stringify({ date: 1, empty: true }));
  await f.run({ apply: true });
  assert.equal(JSON.parse(f.objects.get('uslice/A-vec-dp.json')).vec, null);
  const stateBefore = JSON.parse(f.objects.get('meta/uvec-state.json'));
  f.objects.delete('uslice/A-vec-dp.json'); // Admin hist upload removed the derived vector.
  const result = await f.run({ apply: true });
  assert.equal(result.computed, 1);
  assert.equal(JSON.parse(f.objects.get('uslice/A-vec-dp.json')).vec, null);
  assert.equal(stateBefore.users.A.userEtag, result.state.users.A.userEtag);
});

test('deleted user is not restored and orphan vec removal preserves other uslice keys', async (t) => {
  const f = await fixture(t, ['A']);
  f.objects.set('uslice/A-r-dp-00.json', 'shard');
  await f.run({ apply: true });
  f.objects.delete('user/A.json');
  const result = await f.run({ apply: true });
  assert.equal(result.computed, 0);
  assert.equal(result.deletes, 1);
  assert.ok(!f.objects.has('uslice/A-vec-dp.json'));
  assert.equal(f.objects.get('uslice/A-r-dp-00.json'), 'shard');
  assert.ok(!JSON.parse(f.objects.get('meta/uvec-state.json')).users.A);
});

test('rotating bounded retries let B complete while A remains retryable', async (t) => {
  const f = await fixture(t, ['A', 'B']);
  f.objects.set('user/A.json', JSON.stringify({ date: 1, fail: true }));
  const first = await f.run({ apply: true, maxUsers: 1 });
  const second = await f.run({ apply: true, maxUsers: 1 });
  assert.equal(first.computed, 0);
  assert.equal(first.failures, 1);
  assert.equal(second.computed, 1);
  assert.ok(f.objects.has('uslice/B-vec-dp.json'));
  assert.ok(!JSON.parse(f.objects.get('meta/uvec-state.json')).users.A);
  assert.equal((await f.run({ apply: true, maxUsers: 1 })).failures, 1);
});

test('many failing and healthy users rotate within the attempt and delete budgets', async (t) => {
  const ids = ['A', 'B', 'C', 'D', 'E'];
  const f = await fixture(t, ids);
  for (const id of ['A', 'B', 'C']) f.objects.set(`user/${id}.json`, JSON.stringify({ date: 1, fail: true }));
  for (let n = 0; n < 7; n++) {
    const result = await f.run({ apply: true, maxUsers: 2 });
    assert.ok(result.computed + result.failures + result.deletes <= 2);
  }
  for (const id of ['D', 'E']) assert.ok(f.objects.has(`uslice/${id}-vec-dp.json`), `${id} should finish`);
  const state = JSON.parse(f.objects.get('meta/uvec-state.json'));
  for (const id of ['A', 'B', 'C']) assert.ok(!state.users[id], `${id} failure must remain pending`);
});

test('old state without cursor works; list/read/put failures restore globals and stop', async (t) => {
  const f = await fixture(t, ['A']);
  f.objects.set('meta/uvec-state.json', JSON.stringify({ v: 1, users: {}, assets: {} }));
  const originalFetch = globalThis.fetch, originalWindow = globalThis.window;
  await f.run({ apply: true });
  assert.equal(globalThis.fetch, originalFetch);
  assert.equal(globalThis.window, originalWindow);

  const list = f.client.listEntries;
  f.client.listEntries = async (prefix) => {
    if (prefix === 'uslice/') throw new Error('list unavailable');
    return list(prefix);
  };
  await assert.rejects(f.run(), /list unavailable/);
  f.client.listEntries = list;

  f.objects.delete('uslice/A-vec-dp.json');
  const getText = f.client.getText;
  f.client.getText = async (key) => {
    if (key === 'user/A.json') throw new Error('input unavailable');
    return getText(key);
  };
  await assert.rejects(f.run({ apply: true }), /input unavailable/);
  f.client.getText = getText;

  f.objects.delete('uslice/A-vec-dp.json');
  f.client.putText = async () => ({ ok: false });
  await assert.rejects(f.run({ apply: true }), /PUT 실패/);
  assert.equal(globalThis.fetch, originalFetch);
  assert.equal(globalThis.window, originalWindow);
});

test('dry run performs no writes', async (t) => {
  const f = await fixture(t, ['A']);
  const result = await f.run();
  assert.equal(result.computed, 1);
  assert.deepEqual(f.calls.writes, []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { runLightDump } from '../../supabase/functions/_shared/dump-fast-worker.ts';

const since = '2026-10-24T00:00:00.000Z';
const etag = (value) => `"${value}"`;
const fixture = () => {
  const user = { _v: since, user: { iidx_id: 'u1' }, radars: [1], dp: [1], sp: [1], dpRecent: [], spRecent: [], fastGeneration: '4', extension: { keep: true } };
  const objects = new Map([
    ['pending/u1.json', { generation: '5', since, extra: 'keep' }],
    ['user/u1.json', user],
    ['hist/u1.json', []],
    ['meta/song-aliases.json', {}],
    ['songs.json', []],
  ]);
  const puts = [];
  const deps = {
    async read(key) { return { body: JSON.stringify(objects.get(key)), etag: etag(key) }; },
    async put(key, body, match) { puts.push({ key, body, match }); objects.set(key, JSON.parse(body)); },
    async readBuffer() { return { rows: [{ score_id: 1 }], fingerprint: 'same' }; },
    prepareFastDump({ generation }) {
      return { histBytes: new TextEncoder().encode('[]'), candidate: null,
        fastPatch: { dp: [generation], sp: [generation], dpRecent: [], spRecent: [], fastGeneration: generation, histRevision: 'ignored' } };
    },
    now: () => '2026-10-24T00:00:01.000Z', nowMs: () => Date.parse(since),
  };
  return { deps, objects, puts };
};

test('initial off path is inert when the caller does not invoke the worker', async () => {
  const { deps, puts } = fixture();
  const before = JSON.stringify(await deps.read('user/u1.json'));
  assert.equal(JSON.stringify(await deps.read('user/u1.json')), before);
  assert.deepEqual(puts, []);
});

test('normal publication writes only fast keys and completes the matching pending generation', async () => {
  const { deps, objects, puts } = fixture();
  const result = await runLightDump({ id: 'u1', G: '5', since, deps });
  assert.deepEqual(result, { ok: true, changed: true, done: true, value: objects.get('user/u1.json') });
  assert.deepEqual(objects.get('user/u1.json').user, { iidx_id: 'u1' });
  assert.deepEqual(objects.get('user/u1.json').radars, [1]);
  assert.deepEqual(objects.get('user/u1.json').extension, { keep: true });
  assert.equal(objects.get('user/u1.json').fastGeneration, '5');
  assert.equal(puts.length, 2);
  assert.equal(puts[0].match, etag('user/u1.json'));
  assert.equal(puts[1].match, etag('pending/u1.json'));
});

test('buffer or reference drift exits before either write', async () => {
  for (const drift of ['buffer', 'hist', 'alias']) {
    const { deps, puts } = fixture();
    let calls = 0;
    if (drift === 'buffer') deps.readBuffer = async () => ({ rows: [], fingerprint: `v${++calls}` });
    else {
      const read = deps.read;
      deps.read = async (key) => {
        const result = await read(key);
        if ((drift === 'hist' && key.startsWith('hist/')) || (drift === 'alias' && key.includes('aliases'))) {
          calls++;
          return { ...result, body: calls > 1 ? `${result.body} ` : result.body };
        }
        return result;
      };
    }
    const result = await runLightDump({ id: 'u1', G: '5', since, deps });
    assert.equal(result.ok, false, drift);
    assert.equal(puts.length, 0, drift);
  }
});

test('user CAS conflict never retries, regresses fast keys, or loses slow and unknown fields', async () => {
  const { deps, objects, puts } = fixture();
  deps.put = async (key, body) => { puts.push(key); if (key.startsWith('user/')) throw new Error('412'); objects.set(key, JSON.parse(body)); };
  const result = await runLightDump({ id: 'u1', G: '5', since, deps });
  assert.equal(result.reason, 'user-put-failed');
  assert.equal(puts.length, 1);
  assert.deepEqual(objects.get('user/u1.json').dp, [1]);
  assert.deepEqual(objects.get('user/u1.json').radars, [1]);
  assert.deepEqual(objects.get('user/u1.json').extension, { keep: true });
});

test('stale generation, user timeout, and failed done preserve fields and stop follow-up writes', async () => {
  const stale = fixture();
  stale.objects.set('user/u1.json', { ...stale.objects.get('user/u1.json'), fastGeneration: '6' });
  assert.equal((await runLightDump({ id: 'u1', G: '5', since, deps: stale.deps })).reason, 'newer-generation');
  assert.equal(stale.puts.length, 0);
  const timeout = fixture();
  timeout.deps.put = async (key) => { timeout.puts.push(key); throw new Error('timeout'); };
  assert.equal((await runLightDump({ id: 'u1', G: '5', since, deps: timeout.deps })).reason, 'user-put-failed');
  assert.equal(timeout.puts.length, 1);
  const doneFail = fixture();
  doneFail.deps.put = async (key, body) => { doneFail.puts.push(key); if (key.startsWith('pending/')) throw new Error('timeout'); doneFail.objects.set(key, JSON.parse(body)); };
  const result = await runLightDump({ id: 'u1', G: '5', since, deps: doneFail.deps });
  assert.deepEqual(result, { ok: true, changed: true, done: false, reason: 'done-put-failed' });
  assert.deepEqual(doneFail.objects.get('user/u1.json').user, { iidx_id: 'u1' });
  assert.deepEqual(doneFail.objects.get('user/u1.json').extension, { keep: true });
  assert.equal(doneFail.puts.length, 2);
});

test('done CAS 412 after user success is partial success with no retry', async () => {
  const { deps, objects, puts } = fixture();
  deps.put = async (key, body, match) => {
    puts.push({ key, match });
    if (key.startsWith('pending/')) throw new Error('412');
    objects.set(key, JSON.parse(body));
  };
  const result = await runLightDump({ id: 'u1', G: '5', since, deps });
  assert.deepEqual(result, { ok: true, changed: true, done: false, reason: 'done-put-failed' });
  assert.equal(objects.get('user/u1.json').fastGeneration, '5');
  assert.deepEqual(objects.get('user/u1.json').radars, [1]);
  assert.deepEqual(objects.get('user/u1.json').extension, { keep: true });
  assert.deepEqual(puts.map(({ key }) => key), ['user/u1.json', 'pending/u1.json']);
  assert.equal(puts.length, 2);
});

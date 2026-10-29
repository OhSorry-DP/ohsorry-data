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

// Stateful fake enforces object existence, strong ETags and conditional creation.
const histFixture = () => {
  const f = fixture();
  let revision = 0;
  const versions = new Map([...f.objects.keys()].map(key => [key, etag(++revision)]));
  f.deps.histPublish = true;
  f.deps.read = async key => f.objects.has(key) ? { body: JSON.stringify(f.objects.get(key)), etag: versions.get(key) } : null;
  f.deps.put = async (key, body, match) => {
    f.puts.push({ key, body, match });
    if (match !== (versions.get(key) ?? null)) throw Object.assign(new Error('412'), { status: 412 });
    f.objects.set(key, JSON.parse(body)); versions.set(key, etag(++revision));
  };
  f.deps.prepareFastDump = ({ previousHistRows, restRows, generation }) => {
    const rows = [...previousHistRows];
    for (const row of restRows) if (!rows.some(x => x.score_id === row.score_id)) rows.push(row);
    return { histRows: rows, histBytes: new TextEncoder().encode(JSON.stringify(rows)), candidate: { mustNotPublish: true },
      fastPatch: { dp: [rows.length], sp: [generation], dpRecent: [], spRecent: [] } };
  };
  f.remove = key => { f.objects.delete(key); versions.delete(key); };
  f.run = () => runLightDump({ id: 'u1', G: '5', since, deps: f.deps });
  return f;
};

test('hist ON publishes readback, user, completion then releases; same G rerun is idempotent', async () => {
  const f = histFixture();
  assert.equal((await f.run()).done, true);
  assert.deepEqual(f.puts.map(x => x.key), ['meta/fast-hist-lease-u1.json', 'hist/u1.json', 'user/u1.json', 'pending/u1.json', 'meta/fast-hist-lease-u1.json']);
  const user = f.objects.get('user/u1.json'), marker = f.objects.get('pending/u1.json');
  assert.match(user.histRevision, /^[a-f0-9]{64}$/); assert.equal(marker.histRevision, user.histRevision); assert.equal(marker.viewGeneration, '5');
  assert.deepEqual(user.radars, [1]); assert.deepEqual(user.extension, { keep: true });
  f.puts.length = 0;
  const again = await f.run(); assert.equal(again.done, true); assert.equal(again.changed, false);
  assert.ok(f.puts.every(x => !x.key.startsWith('hist/') && !x.key.startsWith('user/')));
});

test('hist success / user failure leaves no completion; same G revision recovery follows expiry', async () => {
  const f = histFixture(), put = f.deps.put;
  f.objects.get('user/u1.json').fastGeneration = '5';
  f.objects.get('user/u1.json').histRevision = 'a'.repeat(64);
  f.deps.put = async (...args) => { if (args[0].startsWith('user/')) throw Error('lost response'); return put(...args); };
  assert.equal((await f.run()).reason, 'user-put-failed');
  assert.deepEqual(f.objects.get('hist/u1.json'), [{ score_id: 1 }]);
  assert.equal(f.objects.get('pending/u1.json').viewGeneration, undefined);
  assert.equal(f.objects.get('meta/fast-hist-lease-u1.json').expiresAt, '2026-10-24T00:00:15.000Z');
  assert.equal((await f.run()).reason, 'lease-busy');
  f.deps.nowMs = () => Date.parse(since) + 16000; f.deps.put = put;
  assert.equal((await f.run()).done, true); assert.deepEqual(f.objects.get('user/u1.json').dp, [1]);
});

test('higher generation and busy lease skip without histogram or user writes', async () => {
  const newer = histFixture(); newer.objects.get('user/u1.json').fastGeneration = '6';
  assert.equal((await newer.run()).reason, 'newer-generation'); assert.equal(newer.puts.length, 0);
  const busy = histFixture();
  await busy.deps.put('meta/fast-hist-lease-u1.json', JSON.stringify({ token: 'other', expiresAt: '2026-10-24T00:00:15.000Z' }), null);
  busy.puts.length = 0;
  assert.equal((await busy.run()).reason, 'lease-busy'); assert.equal(busy.puts.length, 0);
});

test('hist 412 reloads references and merges original buffer with winning history', async () => {
  const f = histFixture(), put = f.deps.put, read = f.deps.read;
  let conflict = true, aliasesReads = 0;
  f.deps.read = async key => { if (key.includes('aliases')) aliasesReads++; return read(key); };
  f.deps.put = async (key, body, match) => {
    if (key.startsWith('hist/') && conflict) {
      conflict = false; await put(key, JSON.stringify([{ score_id: 2 }]), match);
      f.objects.set('meta/song-aliases.json', { changed: true });
      throw Object.assign(Error('412'), { status: 412 });
    }
    return put(key, body, match);
  };
  assert.equal((await f.run()).done, true);
  assert.deepEqual(f.objects.get('hist/u1.json'), [{ score_id: 2 }, { score_id: 1 }]);
  assert.deepEqual(f.objects.get('user/u1.json').dp, [2]); assert.equal(aliasesReads, 4);
});

test('new user/hist creation requires both 404, matching pending and nonempty stable buffer', async () => {
  const f = histFixture(); f.remove('hist/u1.json'); f.remove('user/u1.json');
  assert.equal((await f.run()).done, true);
  assert.equal(f.puts.find(x => x.key === 'hist/u1.json').match, null);
  assert.equal(f.puts.find(x => x.key === 'user/u1.json').match, null);
  assert.equal(f.objects.get('user/u1.json').user, null);
  for (const key of ['hist/u1.json', 'user/u1.json']) {
    const partial = histFixture(); partial.remove(key);
    assert.equal((await partial.run()).reason, 'invalid-reference'); assert.equal(partial.puts.length, 0);
  }
  const empty = histFixture(); empty.remove('hist/u1.json'); empty.remove('user/u1.json');
  empty.deps.readBuffer = async () => ({ rows: [], fingerprint: 'same' });
  assert.equal((await empty.run()).reason, 'invalid-buffer'); assert.equal(empty.puts.length, 0);
});

test('hist readback mismatch, buffer drift, lease expiry and uncertain PUT suppress user/completion', async () => {
  for (const mode of ['readback', 'buffer', 'expiry', 'uncertain']) {
    const f = histFixture(), put = f.deps.put, read = f.deps.read;
    let wrote = false, buffers = 0, time = Date.parse(since);
    f.deps.nowMs = () => time;
    if (mode === 'buffer') f.deps.readBuffer = async () => ({ rows: [{ score_id: 1 }], fingerprint: String(++buffers) });
    f.deps.put = async (...args) => {
      await put(...args);
      if (args[0].startsWith('hist/')) {
        wrote = true;
        if (mode === 'expiry') time += 16000;
        if (mode === 'uncertain') throw Error('response lost');
      }
    };
    f.deps.read = async key => {
      const source = await read(key);
      return mode === 'readback' && wrote && key.startsWith('hist/') ? { ...source, body: '[]' } : source;
    };
    assert.equal((await f.run()).ok, false, mode);
    assert.ok(f.puts.every(x => !x.key.startsWith('user/') && !x.key.startsWith('pending/')), mode);
  }
});

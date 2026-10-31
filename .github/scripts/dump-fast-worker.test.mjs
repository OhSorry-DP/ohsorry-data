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
  const beforeHist = JSON.stringify(f.objects.get('hist/u1.json')), beforeUser = JSON.stringify(f.objects.get('user/u1.json'));
  let gets = 0; const read = f.deps.read;
  f.deps.read = async (...args) => { gets++; return read(...args); };
  const again = await f.run(); assert.equal(again.done, true); assert.equal(again.changed, false);
  assert.equal(gets, 27);
  assert.deepEqual(f.puts.map(x => x.key), ['meta/fast-hist-lease-u1.json','pending/u1.json','meta/fast-hist-lease-u1.json']);
  assert.deepEqual(f.objects.get('hist/u1.json'), JSON.parse(beforeHist)); assert.deepEqual(f.objects.get('user/u1.json'), JSON.parse(beforeUser));
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
  let conflict = true, aliasesReads = 0, songsReads = 0;
  f.deps.read = async key => { if (key.includes('aliases')) aliasesReads++; if (key === 'songs.json') songsReads++; return read(key); };
  f.deps.put = async (key, body, match) => {
    if (key.startsWith('hist/') && conflict) {
      conflict = false;
      f.objects.set('meta/song-aliases.json', { v: 1 });
      f.objects.set(key, [{ score_id: 2 }]);
      await put(key, JSON.stringify([{ score_id: 2 }]), etag(key));
      throw Object.assign(Error('412'), { status: 412 });
    }
    return put(key, body, match);
  };
  assert.equal((await f.run()).done, true);
  assert.deepEqual(f.objects.get('hist/u1.json'), [{ score_id: 2 }, { score_id: 1 }]);
  assert.deepEqual(f.objects.get('user/u1.json').dp, [2]); assert.equal(aliasesReads, 4); assert.equal(songsReads, 4);
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

test('empty buffer remains accepted with existing objects and rejected for creation', async () => {
  const stable = histFixture();
  stable.deps.readBuffer = async () => ({ rows: [], fingerprint: 'same' });
  assert.equal((await stable.run()).done, true);
  assert.ok(stable.puts.some(x => x.key === 'user/u1.json'));
  const existingUserOnly = histFixture(); existingUserOnly.remove('hist/u1.json');
  existingUserOnly.deps.readBuffer = async () => ({ rows: [], fingerprint: 'same' });
  assert.deepEqual(await existingUserOnly.run(), { ok: false, reason: 'invalid-reference' });
  assert.equal(existingUserOnly.puts.length, 0);
  const create = histFixture(); create.remove('hist/u1.json'); create.remove('user/u1.json');
  create.deps.readBuffer = async () => ({ rows: [], fingerprint: 'same' });
  assert.deepEqual(await create.run(), { ok: false, reason: 'invalid-buffer' });
  assert.equal(create.puts.length, 0);
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


test('verify before user PUT rejects hist drift and lease loss', async () => {
  for (const mode of ['hist', 'lease']) {
    const f = histFixture(), read = f.deps.read, put = f.deps.put;
    let published = false, userReads = 0;
    f.deps.put = async (...args) => { await put(...args); if (args[0] === 'hist/u1.json') published = true; };
    f.deps.read = async key => {
      const source = await read(key);
      if (key === 'user/u1.json' && ++userReads === 2) {
        assert.equal(published, true);
        if (mode === 'hist') { const hist = await read('hist/u1.json'); await put('hist/u1.json', JSON.stringify([{ score_id: 99 }]), hist.etag); }
        else { const lease = await read('meta/fast-hist-lease-u1.json'); await put('meta/fast-hist-lease-u1.json', JSON.stringify({ token: 'other', expiresAt: lease && JSON.parse(lease.body).expiresAt }), lease.etag); }
      }
      return source;
    };
    assert.deepEqual(await f.run(), { ok: false, reason: 'read-or-calculation-failed' }, mode);
    if (mode === 'hist') assert.deepEqual(f.objects.get('hist/u1.json'), [{ score_id: 99 }]);
    assert.equal(f.puts.filter(x => x.key.startsWith('user/') || x.key.startsWith('pending/')).length, 0, mode);
  }
});

test('verify before pending PUT rejects hist drift or lease loss after user success', async () => {
  for (const mode of ['hist', 'lease']) {
    const f = histFixture(), read = f.deps.read, put = f.deps.put;
    let pendingReads = 0;
    f.deps.read = async key => {
      const source = await read(key);
      if (key === 'pending/u1.json' && ++pendingReads === 3) {
        if (mode === 'hist') { const hist = await read('hist/u1.json'); await put('hist/u1.json', JSON.stringify([{ score_id: 99 }]), hist.etag); }
        else { const lease = await read('meta/fast-hist-lease-u1.json'); await put('meta/fast-hist-lease-u1.json', JSON.stringify({ token: 'other', expiresAt: JSON.parse(lease.body).expiresAt }), lease.etag); }
      }
      return source;
    };
    const result = await f.run();
    assert.deepEqual(result, { ok: false, reason: 'read-or-calculation-failed' }, mode);
    assert.equal(f.puts.filter(x => x.key === 'user/u1.json').length, 1, mode);
    assert.equal(f.puts.filter(x => x.key === 'pending/u1.json').length, 0, mode);
    assert.equal(f.puts.filter(x => x.key === 'meta/fast-hist-lease-u1.json').length, mode === 'lease' ? 2 : 1, mode);
    if (mode === 'lease') assert.equal(f.objects.get('meta/fast-hist-lease-u1.json').token, 'other');
  }
});

test('late multi-conflict reports user and pending reasons before the removed verify', async () => {
  const user = histFixture(), userRead = user.deps.read, userPut = user.deps.put;
  let userReads = 0;
  user.deps.read = async key => {
    const source = await userRead(key);
    if (key === 'user/u1.json' && ++userReads === 2) { const hist = await userRead('hist/u1.json'); await userPut('hist/u1.json', JSON.stringify([{ score_id: 99 }]), hist.etag); return null; }
    return source;
  };
  assert.deepEqual(await user.run(), { ok: false, reason: 'invalid-reference' });
  assert.equal(user.puts.filter(x => x.key === 'user/u1.json' || x.key === 'pending/u1.json').length, 0);

  const pending = histFixture(), pendingRead = pending.deps.read, pendingPut = pending.deps.put;
  let pendingReads = 0;
  pending.deps.read = async key => {
    const source = await pendingRead(key);
    if (key === 'pending/u1.json' && ++pendingReads === 3) {
      const hist = await pendingRead('hist/u1.json'); await pendingPut('hist/u1.json', JSON.stringify([{ score_id: 99 }]), hist.etag);
      return { ...source, body: JSON.stringify({ generation: '6', since }) };
    }
    return source;
  };
  assert.deepEqual(await pending.run(), { ok: true, changed: true, done: false, reason: 'pending-changed' });
  assert.equal(pending.puts.filter(x => x.key === 'user/u1.json').length, 1);
  assert.equal(pending.puts.filter(x => x.key === 'pending/u1.json').length, 0);
});

test('held lease expires at user PUT boundary after final lease GET; user and completion PUTs stay zero', async () => {
  const f = histFixture(), read = f.deps.read;
  let time = Date.parse(since), userReads = 0, leaseReadsAfterUser = 0;
  let expireOnNextClock = false;
  f.deps.nowMs = () => {
    const value = time;
    if (expireOnNextClock) { time += 16000; expireOnNextClock = false; }
    return value;
  };
  f.deps.read = async key => {
    const source = await read(key);
    if (key === 'user/u1.json') userReads++;
    // The second verify after the current user GET ends with this lease GET.
    if (userReads === 2 && key.includes('lease') && ++leaseReadsAfterUser === 2) expireOnNextClock = true;
    return source;
  };
  const result = await f.run();
  assert.equal(leaseReadsAfterUser, 2);
  assert.equal(f.puts.filter(x => x.key.startsWith('user/') || x.key.startsWith('pending/')).length, 0);
  assert.equal(result.reason, 'user-put-failed');
  assert.equal(f.objects.get('pending/u1.json').viewGeneration, undefined);
});

test('initial five R2 reads and buffer start together; results wait behind initial validation', async () => {
  const f = histFixture(), events = [], gates = new Map(), reached = new Map();
  const initial = ['pending/u1.json', 'user/u1.json', 'hist/u1.json'];
  const references = ['meta/song-aliases.json', 'songs.json'];
  for (const name of [...initial, ...references, 'buffer']) {
    let release, signal;
    gates.set(name, new Promise(resolve => { release = resolve; }));
    reached.set(name, new Promise(resolve => { signal = resolve; }));
    gates.set(`${name}:release`, () => release());
    gates.set(`${name}:signal`, () => signal());
  }
  const read = f.deps.read, readBuffer = f.deps.readBuffer;
  f.deps.read = async key => {
    if (initial.includes(key) || references.includes(key)) { events.push(key); gates.get(`${key}:signal`)(); await gates.get(key); }
    return read(key);
  };
  f.deps.readBuffer = async (...args) => { events.push('buffer'); gates.get('buffer:signal')(); await gates.get('buffer'); return readBuffer(...args); };
  const resultPromise = f.run();
  await Promise.all([...initial, ...references, 'buffer'].map(name => reached.get(name)));
  assert.deepEqual(events.sort(), [...initial, ...references, 'buffer'].sort());
  assert.equal(f.puts.length, 0);
  gates.get('buffer:release')();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.puts.length, 0);
  for (const key of [...initial, ...references]) gates.get(`${key}:release`)();
  assert.equal((await resultPromise).done, true);
  assert.deepEqual(f.puts.map(x => x.key), ['meta/fast-hist-lease-u1.json', 'hist/u1.json', 'user/u1.json', 'pending/u1.json', 'meta/fast-hist-lease-u1.json']);
});

test('first reference bodies are revalidated before protected writes', async () => {
  for (const [key, first, after] of [['meta/song-aliases.json', '{}', '{"x":"y"}'], ['songs.json', '[]', '[1]']]) {
    const f = histFixture(), read = f.deps.read;
    let count = 0;
    f.deps.read = async name => name === key ? { body: ++count === 1 ? first : after, etag: etag(name) } : read(name);
    assert.equal((await f.run()).reason, 'hist-validation-failed');
    assert.equal(f.puts.filter(x => ['hist/u1.json', 'user/u1.json', 'pending/u1.json'].includes(x.key)).length, 0);
  }
});

test('prefetched reference failure preserves pending and prepare error priority without unhandled rejection', async () => {
  const unhandled = [], onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    const changed = histFixture(), changedRead = changed.deps.read;
    changed.objects.get('pending/u1.json').generation = '6';
    changed.deps.read = async key => key === 'meta/song-aliases.json' ? Promise.reject(Error('reference-failed')) : changedRead(key);
    assert.deepEqual(await changed.run(), { ok: false, reason: 'pending-changed' });
    assert.equal(changed.puts.length, 0);

    const valid = histFixture(), validRead = valid.deps.read;
    valid.deps.read = async key => key === 'meta/song-aliases.json' ? Promise.reject(Error('reference-failed')) : validRead(key);
    assert.deepEqual(await valid.run(), { ok: false, reason: 'hist-validation-failed' });
    assert.equal(valid.puts.filter(x => ['hist/u1.json', 'user/u1.json', 'pending/u1.json'].includes(x.key)).length, 0);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(unhandled.length, 0);
  } finally { process.off('unhandledRejection', onUnhandled); }
});

test('buffer failure does not override pending change or initial R2 failure', async () => {
  const unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
  const pending = histFixture(), pendingRead = pending.deps.read;
  pending.deps.read = async key => key === 'pending/u1.json'
    ? { body: JSON.stringify({ generation: '6', since }), etag: etag('pending') } : pendingRead(key);
  pending.deps.readBuffer = async () => { throw Error('buffer-failed'); };
  assert.deepEqual(await pending.run(), { ok: false, reason: 'pending-changed' });
  assert.equal(pending.puts.length, 0);

  const failed = histFixture(), read = failed.deps.read;
  failed.deps.read = async key => { if (key === 'user/u1.json') throw Error('initial-read-failed'); return read(key); };
  failed.deps.readBuffer = async () => { throw Error('buffer-failed'); };
  assert.deepEqual(await failed.run(), { ok: false, reason: 'read-or-calculation-failed' });
  assert.equal(failed.puts.length, 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(unhandled.length, 0);
  } finally { process.off('unhandledRejection', onUnhandled); }
});

const withFakePerformance = async (fn) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  let time = 0;
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => time } });
  try { await fn((ms) => { time += ms; }); }
  finally { if (original) Object.defineProperty(globalThis, 'performance', original); else delete globalThis.performance; }
};

test('hist timing records buffer and prepare boundaries while preserving lease and five PUT order', async () => {
  await withFakePerformance(async advance => {
    const f = histFixture(), steps = {};
    f.deps.timing = (step, ms) => { steps[step] = (steps[step] ?? 0) + ms; };
    const readBuffer = f.deps.readBuffer, prepare = f.deps.prepareFastDump;
    f.deps.readBuffer = async (...args) => { advance(5); return readBuffer(...args); };
    f.deps.prepareFastDump = (...args) => { advance(3); return prepare(...args); };
    const result = await f.run();
    assert.equal(result.done, true);
    assert.equal(steps.bufferRead, 10);
    assert.equal(steps.compute, 6);
    assert.deepEqual(f.puts.map(x => x.key), ['meta/fast-hist-lease-u1.json', 'hist/u1.json', 'user/u1.json', 'pending/u1.json', 'meta/fast-hist-lease-u1.json']);
  });
});

test('hist timing separates initial history read from readback and lease checks', async () => {
  await withFakePerformance(async advance => {
    const f = histFixture(), steps = {}, read = f.deps.read;
    f.deps.timing = (step, ms) => { steps[step] = (steps[step] ?? 0) + ms; };
    f.deps.read = async key => { if (key.startsWith('hist/')) advance(4); if (key.includes('lease')) advance(2); return read(key); };
    assert.equal((await f.run()).done, true);
    assert.equal(steps.histVerify, 12);
    assert.equal(steps.histRead, 8);
    assert.ok(steps.leaseCheck > 0);
    assert.equal(steps.leaseAcquire, 2);
    assert.equal(steps.leaseRelease, 2);
  });
});

test('light timing records only its read and compute boundaries without changing result', async () => {
  await withFakePerformance(async advance => {
    const { deps, objects, puts } = fixture(), steps = {};
    deps.timing = (step, ms) => { steps[step] = (steps[step] ?? 0) + ms; };
    const readBuffer = deps.readBuffer;
    deps.readBuffer = async (...args) => { advance(5); return readBuffer(...args); };
    deps.histPublish = false;
    const result = await runLightDump({ id: 'u1', G: '5', since, deps });
    assert.deepEqual(result, { ok: true, changed: true, done: true, value: objects.get('user/u1.json') });
    assert.equal(steps.bufferRead, 10);
    assert.equal(steps.histPut ?? 0, 0);
    assert.equal(steps.leaseAcquire ?? 0, 0);
    assert.equal(steps.leaseRelease ?? 0, 0);
    assert.deepEqual(puts.map(x => x.key), ['user/u1.json', 'pending/u1.json']);
    assert.equal(puts.length, 2);
  });
});

test('failed user and completion PUTs retain timed partial results and do not release early', async () => {
  await withFakePerformance(async advance => {
    const user = histFixture(), userSteps = {};
    user.deps.timing = (step, ms) => { userSteps[step] = (userSteps[step] ?? 0) + ms; };
    const userPut = user.deps.put;
    user.deps.put = async (key, ...args) => { if (key.startsWith('user/')) { advance(7); throw Error('lost'); } return userPut(key, ...args); };
    assert.equal((await user.run()).reason, 'user-put-failed');
    assert.equal(userSteps.userPut, 7);
    assert.equal(user.puts.filter(x => x.key.startsWith('pending/')).length, 0);
    assert.equal(user.puts.filter(x => x.key.startsWith('meta/fast-hist-lease')).length, 1);

    const done = histFixture(), doneSteps = {}, put = done.deps.put;
    done.deps.timing = (step, ms) => { doneSteps[step] = (doneSteps[step] ?? 0) + ms; };
    done.deps.put = async (key, ...args) => { if (key.startsWith('pending/')) { advance(9); throw Error('lost'); } return put(key, ...args); };
    const result = await done.run();
    assert.deepEqual(result, { ok: true, changed: true, done: false, reason: 'done-put-failed' });
    assert.equal(doneSteps.pendingDone, 9);
    assert.deepEqual(done.puts.map(x => x.key), ['meta/fast-hist-lease-u1.json', 'hist/u1.json', 'user/u1.json']);
    assert.equal(done.puts.filter(x => x.key.startsWith('pending/')).length, 0);
  });
});

test('early pending change and buffer failure preserve result while recording completed boundaries', async () => {
  await withFakePerformance(async advance => {
    const early = fixture(), earlySteps = {};
    early.deps.timing = (step, ms) => { earlySteps[step] = (earlySteps[step] ?? 0) + ms; };
    const read = early.deps.read;
    early.deps.read = async key => { const value = await read(key); if (key === 'pending/u1.json') advance(5); return value; };
    early.objects.set('pending/u1.json', { generation: '6', since });
    assert.deepEqual(await runLightDump({ id: 'u1', G: '5', since, deps: early.deps }), { ok: false, reason: 'pending-changed' });
    assert.equal(earlySteps.pendingRead, 5);

    const failure = fixture(), failedSteps = {};
    failure.deps.timing = (step, ms) => { failedSteps[step] = (failedSteps[step] ?? 0) + ms; };
    failure.deps.readBuffer = async () => { advance(5); throw Error('buffer read'); };
    assert.deepEqual(await runLightDump({ id: 'u1', G: '5', since, deps: failure.deps }), { ok: false, reason: 'read-or-calculation-failed' });
    assert.equal(failedSteps.bufferRead, 5);
  });
});

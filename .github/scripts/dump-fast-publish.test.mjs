import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { mergeActionsUser, mergeEdgeUser, mergeSlowUser, publishUserPatch, runCli } from './dump-fast-publish.mjs';
import { HIST_LEASE_MS, histGuardEnabled, acquireHistLease, assertHistLease, releaseHistLease,
  publishHistWithLease, mergeHistUser, mergeHistPending } from './dump-fast-publish.mjs';
import { replayScoreBuffer } from './score-history.mjs';

const fast = (generation, value = 1) => ({ dp: [value], sp: [value], dpRecent: [], spRecent: [], fastGeneration: String(generation) });
const origin = (generation = '1') => ({ _v: 'old', user: { iidx_id: 'u1', old: true }, ...fast(generation), unknown: { keep: true } });
const patch = (generation = '2', value = 2) => fast(generation, value);

function histStore(initial = {}) {
  const objects = new Map(Object.entries(initial));
  const calls = [];
  let sequence = 0;
  return {
    objects, calls,
    async read(key) { calls.push(['read', key]); return objects.get(key) ?? null; },
    async put(key, body, etag) {
      calls.push(['put', key, body, etag]);
      const current = objects.get(key);
      if (etag === null ? current !== undefined : !current || current.etag !== etag)
        throw Object.assign(new Error('HTTP 412'), { status: 412 });
      objects.set(key, { body, etag: `"h${++sequence}"` });
    },
  };
}
const historyRow = (song, score, version = 34) => ({ score_id: song, iidx_id: 'u1', song_id: song,
  diff: 3, lamp: 4, ex_score: score, played_version: version, date: '2026-10-29T00:00:00.000Z',
  date_kst: '2026-10-29', play_style: 1, bp: null, note_count: null });
const prepareHist = ({ previousHistRows, restRows }) => {
  const histRows = replayScoreBuffer(previousHistRows, restRows);
  return { histRows, histBytes: new TextEncoder().encode(JSON.stringify(histRows)) };
};
const histArgs = (r2, extra = {}) => ({ r2, id: 'u1', restRows: [historyRow(1, 100)],
  prepare: prepareHist, enabled: true, now: () => Date.parse('2026-10-29T00:00:00.000Z'), token: 'writer-a', ...extra });

test('hist guard defaults OFF with zero I/O and legacy merges remain byte-identical', async () => {
  const r2 = histStore();
  assert.equal(HIST_LEASE_MS, 15000);
  for (const env of [{}, { FAST_DUMP_HIST_GUARD: '0' }, { FAST_DUMP_HIST_GUARD: true }]) assert.equal(histGuardEnabled(env), false);
  assert.equal(histGuardEnabled({ FAST_DUMP_HIST_GUARD: '1' }), true);
  assert.deepEqual(await acquireHistLease({ r2, id: 'u1' }), { ok: false, reason: 'disabled' });
  assert.deepEqual(await publishHistWithLease({ r2, id: 'u1' }), { ok: false, reason: 'disabled' });
  assert.equal(r2.calls.length, 0);
  const current = { ...origin('2'), histRevision: 'a'.repeat(64) };
  const bytes = JSON.stringify(current);
  assert.equal(JSON.stringify(mergeEdgeUser(current, fast('2'), '2').value), bytes);
  assert.equal(mergeActionsUser(current, fast('1', 99), '1').histRevision, current.histRevision);
  assert.equal(JSON.stringify(current), bytes);
});

test('hist lease has 15s expiry, one-shot contention, conditional release and no expired follow-up', async () => {
  let time = Date.parse('2026-10-29T00:00:00.000Z');
  const r2 = histStore({ 'hist/u1.json': { body: '[]', etag: '"old"' } });
  const args = histArgs(r2, { now: () => time });
  const first = await acquireHistLease(args);
  assert.equal(first.lease.expiresAt, '2026-10-29T00:00:15.000Z');
  const before = r2.calls.length;
  assert.equal((await acquireHistLease({ ...args, token: 'writer-b' })).reason, 'lease-busy');
  assert.equal(r2.calls.length, before + 1);
  const saved = r2.objects.get(first.lease.key);
  r2.objects.set(first.lease.key, { ...saved, body: JSON.stringify({ ...JSON.parse(saved.body), unknown: 9 }) });
  assert.equal((await releaseHistLease({ ...args, lease: first.lease })).ok, true);
  assert.equal(JSON.parse(r2.objects.get(first.lease.key).body).unknown, 9);
  const second = await acquireHistLease({ ...args, token: 'writer-b' });
  const puts = r2.calls.filter(([op]) => op === 'put').length;
  assert.equal((await releaseHistLease({ ...args, lease: first.lease })).ok, false);
  assert.equal(r2.calls.filter(([op]) => op === 'put').length, puts);
  time += HIST_LEASE_MS;
  await assert.rejects(assertHistLease({ ...args, lease: second.lease }), /expired or lost/);
  const third = await acquireHistLease({ ...args, token: 'writer-c' });
  assert.equal(third.ok, true);
  await releaseHistLease({ ...args, lease: third.lease });
  const result = await publishHistWithLease({ ...args, token: 'writer-d', prepare: (input) => { time += HIST_LEASE_MS; return prepareHist(input); } });
  assert.equal(result.ok, false);
  assert.equal(r2.calls.filter(([op, key]) => op === 'put' && key.startsWith('hist/')).length, 0);
  const conflict = histStore();
  conflict.put = async () => { throw Object.assign(new Error('precondition'), { status: 412 }); };
  assert.equal((await acquireHistLease(histArgs(conflict))).reason, 'lease-conflict');
});

test('reverse writers fence a delayed expired PUT and Actions replay retains both uploads including late 33', async () => {
  let time = Date.parse('2026-10-29T00:00:00.000Z');
  const r2 = histStore({ 'hist/u1.json': { body: '[]', etag: '"old"' } });
  const args = histArgs(r2, { now: () => time, restRows: [historyRow(1, 100, 33)] });
  const put = r2.put.bind(r2);
  let delayed = true, successor;
  r2.put = async (key, body, etag) => {
    if (key === 'hist/u1.json' && delayed) {
      delayed = false;
      time += HIST_LEASE_MS;
      successor = await publishHistWithLease({ ...args, token: 'writer-b', restRows: [historyRow(2, 200)] });
    }
    return put(key, body, etag);
  };
  const old = await publishHistWithLease(args);
  assert.equal(successor.ok, true);
  assert.equal(old.ok, false);
  assert.deepEqual(JSON.parse(r2.objects.get('hist/u1.json').body).map((r) => r[0]), [2]);
  time += HIST_LEASE_MS;
  const recovered = await publishHistWithLease({ ...args, token: 'actions' });
  assert.equal(recovered.ok, true);
  assert.deepEqual(new Set(recovered.histRows.map((r) => r[0])), new Set([1, 2]));
  assert.equal(recovered.histRows.find((r) => r[0] === 1)[4], 33);
  assert.equal(recovered.histRevision.length, 64);
  assert.equal(recovered.histBytes instanceof Uint8Array, true);
  // The opposite arrival order: the expired PUT wins first, so its successor
  // must replay both buffers against that committed body rather than overwrite it.
  const opposite = histStore({ 'hist/u1.json': { body: '[]', etag: '"old"' } });
  const commit = opposite.put.bind(opposite);
  let phase = 'old', delayedBody, delayedEtag, next;
  opposite.put = async (key, body, etag) => {
    if (key !== 'hist/u1.json') return commit(key, body, etag);
    if (phase === 'old') {
      phase = 'successor'; delayedBody = body; delayedEtag = etag;
      time += HIST_LEASE_MS;
      next = await publishHistWithLease({ ...args, r2: opposite, token: 'writer-next', restRows: [historyRow(2, 200)] });
      return;
    }
    if (phase === 'successor') {
      phase = 'committed';
      await commit(key, delayedBody, delayedEtag);
    }
    return commit(key, body, etag);
  };
  assert.equal((await publishHistWithLease({ ...args, r2: opposite })).ok, false);
  assert.equal(next.ok, true);
  assert.deepEqual(new Set(next.histRows.map((r) => r[0])), new Set([1, 2]));
});

test('hist 412 rebuilds from new origin and original buffer; conflicts stop at three PUTs', async () => {
  const r2 = histStore({ 'hist/u1.json': { body: '[]', etag: '"old"' } });
  const put = r2.put.bind(r2), inputs = [];
  let first = true;
  r2.put = async (key, body, etag) => {
    if (key === 'hist/u1.json' && first) {
      first = false;
      r2.objects.set(key, { body: JSON.stringify(prepareHist({ previousHistRows: [], restRows: [historyRow(2, 200)] }).histRows), etag: '"new"' });
    }
    return put(key, body, etag);
  };
  const result = await publishHistWithLease(histArgs(r2, { prepare: (input) => {
    inputs.push(structuredClone(input));
    const prepared = prepareHist(input);
    input.restRows.length = 0;
    return prepared;
  } }));
  assert.equal(result.ok, true);
  assert.deepEqual(inputs.map((input) => input.restRows.length), [1, 1]);
  assert.equal(inputs[1].previousHistRows[0][0], 2);
  const puts = r2.calls.filter(([op, key]) => op === 'put' && key === 'hist/u1.json');
  assert.deepEqual(puts.map((call) => call[3]), ['"old"', '"new"']);
  assert.deepEqual(new Set(result.histRows.map((r) => r[0])), new Set([1, 2]));
  const conflict = histStore({ 'hist/u1.json': { body: '[]', etag: '"old"' } });
  const basePut = conflict.put.bind(conflict);
  let count = 0;
  conflict.put = async (...args) => { if (args[0].startsWith('hist/')) { count++; throw new Error('HTTP 412'); } return basePut(...args); };
  assert.equal((await publishHistWithLease(histArgs(conflict))).reason, 'hist-conflict-exhausted');
  assert.equal(count, 3);
});

test('uncertain PUTs never retry, release, or complete; missing, weak and mismatched hist fail closed', async () => {
  for (const target of ['lease', 'hist']) {
    const r2 = histStore({ 'hist/u1.json': { body: '[]', etag: '"old"' } });
    const put = r2.put.bind(r2);
    let failureAt;
    r2.put = async (...args) => {
      await put(...args);
      if (target === 'lease' ? args[0].startsWith('meta/') : args[0].startsWith('hist/')) {
        failureAt = r2.calls.length;
        throw new Error('response lost after commit');
      }
    };
    const result = await publishHistWithLease(histArgs(r2));
    assert.equal(result.ok, false);
    assert.equal(r2.calls.length, failureAt);
    assert.equal(r2.calls.some(([, key]) => /^(user|pending)\//.test(key)), false);
  }
  for (const source of [undefined, { body: '[]', etag: 'W/"weak"' }, { body: '{}', etag: '"x"' }]) {
    const r2 = histStore(source ? { 'hist/u1.json': source } : {});
    assert.equal((await publishHistWithLease(histArgs(r2))).ok, false);
    assert.equal(r2.calls.filter(([op, key]) => op === 'put' && key.startsWith('hist/')).length, 0);
  }
  const create = histStore();
  assert.equal((await publishHistWithLease(histArgs(create, { allowCreate: true }))).ok, true);
  assert.equal(create.calls.find(([op, key]) => op === 'put' && key.startsWith('hist/'))[3], null);
  const mismatch = histStore({ 'hist/u1.json': { body: '[]', etag: '"old"' } });
  const put = mismatch.put.bind(mismatch);
  mismatch.put = async (...args) => { await put(...args); if (args[0].startsWith('hist/')) mismatch.objects.set(args[0], { body: '[]', etag: '"other"' }); };
  assert.equal((await publishHistWithLease(histArgs(mismatch))).reason, 'hist-readback-mismatch');
});

test('verified revision repairs same generation without losing unknown fields and fences view completion', () => {
  const revision = 'b'.repeat(64), old = 'a'.repeat(64);
  const current = { ...origin('2'), histRevision: old };
  const next = { ...patch('2', 20), histRevision: revision };
  const result = mergeHistUser(current, next, '2', revision);
  assert.equal(result.ok, true);
  assert.equal(result.value.histRevision, revision);
  assert.deepEqual(result.value.unknown, current.unknown);
  assert.deepEqual(result.value.user, current.user);
  assert.equal(result.value._v, current._v);
  assert.equal(mergeHistUser(result.value, next, '2', revision).changed, false);
  assert.equal(mergeHistUser({ ...result.value, dp: [99] }, next, '2', revision).reason, 'generation-conflict');
  assert.equal(mergeHistUser({ ...current, fastGeneration: '3' }, next, '2', revision).reason, 'newer-generation');
  assert.equal(mergeHistUser(current, { ...next, persona: 'bad' }, '2', revision).reason, 'invalid-patch');
  const since = '2026-10-29T00:00:00.000Z', done = '2026-10-29T00:00:01.000Z';
  const marker = { generation: '2', since, done: '2026-10-29T00:00:03.000Z', unknown: { keep: true } };
  const completed = mergeHistPending(marker, { generation: '2', since, histRevision: revision, done });
  assert.deepEqual(completed.value, { ...marker, viewGeneration: '2', histRevision: revision });
  assert.equal(mergeHistPending({ ...marker, generation: '3' }, { generation: '2', since, histRevision: revision, done }).reason, 'pending-changed');
  assert.equal(mergeHistPending(marker, { generation: '2', since, histRevision: 'bad', done }).reason, 'invalid-completion');
});

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

const cliEnv = (extra = {}) => ({ CLOUDFLARE_R2_ACCESS_KEY_ID: 'id', CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'secret', ...extra });
function memoryR2(objects = {}) {
  const calls = [];
  return {
    calls,
    async request(key, init = {}) {
      calls.push({ key, ...init });
      const current = objects[key];
      if (!init.method) return current
        ? { status: 200, ok: true, headers: { get: () => current.etag }, text: async () => current.body }
        : { status: 404, ok: false, headers: { get: () => null }, text: async () => '' };
      if (init.headers?.['If-Match'] && (!current || init.headers['If-Match'] !== current.etag))
        return { status: 412, ok: false, headers: { get: () => null }, text: async () => '' };
      if (init.headers?.['If-None-Match'] === '*' && current)
        return { status: 412, ok: false, headers: { get: () => null }, text: async () => '' };
      objects[key] = { body: init.body, etag: '"written"' };
      return { status: 200, ok: true, headers: { get: () => '"written"' }, text: async () => '' };
    },
  };
}
const cliDeps = (client, env = {}, local = {}) => ({
  env: cliEnv(env), createClient: async () => client,
  readFile: async () => JSON.stringify(local), appendFile: async () => {},
  now: () => '2026-10-24T00:01:00.000Z',
});

test('CLI import is inert and arguments, ID, credentials, and process exit are validated', async () => {
  assert.equal(await runCli(['bogus', 'x'], { env: cliEnv() }), 2);
  assert.equal(await runCli(['capture-generation', '../x'], { env: cliEnv() }), 2);
  assert.equal(await runCli(['capture-generation', 'x'], { env: {} }), 2);
  const proc = spawnSync(process.execPath, ['.github/scripts/dump-fast-publish.mjs', 'bogus', 'x'], { encoding: 'utf8' });
  assert.equal(proc.status, 2);
});

test('generation capture accepts valid and legacy markers and 404, but rejects invalid markers without writes', async () => {
  for (const [body, expected] of [
    ['{"generation":"12","since":"2026-10-24T00:00:00.000Z"}', 'FAST_DUMP_GENERATION=12'],
    ['{"since":"2026-10-24T00:00:00.000Z"}', 'FAST_DUMP_GENERATION='],
    [null, 'FAST_DUMP_MARKER_CAPTURED=0'],
  ]) {
    const client = memoryR2(body === null ? {} : { 'pending/u1.json': { body, etag: '"p"' } }); let output = '';
    const code = await runCli(['capture-generation', 'u1'], { ...cliDeps(client, { GITHUB_ENV: 'env' }), appendFile: async (_f, s) => { output += s; } });
    assert.equal(code, 0); assert.ok(output.includes(expected));
  }
  for (const body of ['{"generation":2}', '[]', 'null', '{']) {
    const client = memoryR2({ 'pending/u1.json': { body, etag: '"p"' } }); let writes = 0;
    const code = await runCli(['capture-generation', 'u1'], { ...cliDeps(client, { GITHUB_ENV: 'env' }), appendFile: async () => { writes++; } });
    assert.equal(code, 2); assert.equal(writes, 0);
  }
});

test('Actions merge preserves newer Edge fast fields and applies local slow fields', async () => {
  const objects = { 'user/u1.json': { body: JSON.stringify({ ...origin('9'), ...fast('9', 90) }), etag: '"u1"' } };
  const client = memoryR2(objects);
  await runCli(['publish-actions-user', 'u1'], cliDeps(client, { FAST_DUMP_MARKER_CAPTURED: '1', FAST_DUMP_GENERATION: '8' },
    { ...fast('999', 2), _v: 'local', persona: 'local persona', user: { name: 'local' }, extension: 'local' }));
  const saved = JSON.parse(objects['user/u1.json'].body);
  assert.equal(saved.dp[0], 90); assert.equal(saved.fastGeneration, '9'); assert.equal(saved._v, 'local');
  assert.equal(saved.persona, 'local persona'); assert.deepEqual(saved.user, { name: 'local' });
  assert.deepEqual(saved.unknown, { keep: true });
});

test('new user conditional create uses captured generation, not local fastGeneration', async () => {
  const client = memoryR2();
  await runCli(['publish-actions-user', 'u1'], cliDeps(client, { FAST_DUMP_MARKER_CAPTURED: '1', FAST_DUMP_GENERATION: '3' }, { ...fast('999'), _v: 'v' }));
  const put = client.calls.find((call) => call.method === 'PUT');
  assert.equal(put.headers['If-None-Match'], '*'); assert.equal(JSON.parse(put.body).fastGeneration, '3');
  assert.equal(client.calls.length, 2);
});

test('user CAS retries after 412 with fresh ETag and exhausts after exactly four PUTs', async () => {
  const data = { 'user/u1.json': { body: JSON.stringify(origin('2')), etag: '"a"' } };
  const client = memoryR2(data); let first = true; const baseRequest = client.request.bind(client);
  client.request = async (key, init) => {
    if (init?.method === 'PUT' && first) { first = false; client.calls.push({ key, ...init }); data[key] = { body: JSON.stringify(origin('2')), etag: '"b"' }; return { status: 412, ok: false, headers: { get: () => null }, text: async () => '' }; }
    return baseRequest(key, init);
  };
  await runCli(['publish-actions-user', 'u1'], cliDeps(client, { FAST_DUMP_MARKER_CAPTURED: '1', FAST_DUMP_GENERATION: '3' }, { ...fast('3'), _v: 'local' }));
  assert.equal(client.calls.filter((call) => call.method === 'PUT').length, 2);
  assert.equal(client.calls.at(-1).headers['If-Match'], '"b"');
  const conflict = { calls: [], async request(key, init = {}) {
    this.calls.push({ key, ...init });
    return init.method === 'PUT' ? { status: 412, ok: false, headers: { get: () => null }, text: async () => '' }
      : { status: 200, ok: true, headers: { get: () => '"e"' }, text: async () => JSON.stringify(origin('2')) };
  } };
  await assert.rejects(runCli(['publish-actions-user', 'u1'], cliDeps(conflict, { FAST_DUMP_MARKER_CAPTURED: '1', FAST_DUMP_GENERATION: '3' }, fast('3'))));
  assert.equal(conflict.calls.filter((call) => call.method === 'PUT').length, 4);
  assert.equal(conflict.calls.filter((call) => call.method === 'PUT' && call.key.startsWith('pending/')).length, 0);
});

test('non-conflict publish failures do not fall back or write pending', async () => {
  for (const status of [403, 500]) {
    const client = { calls: [], async request(key, init = {}) {
      this.calls.push({ key, ...init });
      return init.method ? { status, ok: false, headers: { get: () => null }, text: async () => '' }
        : { status: 200, ok: true, headers: { get: () => '"e"' }, text: async () => JSON.stringify(origin()) };
    } };
    await assert.rejects(runCli(['publish-actions-user', 'u1'], cliDeps(client, { FAST_DUMP_MARKER_CAPTURED: '1', FAST_DUMP_GENERATION: '2' }, fast('2'))));
    assert.equal(client.calls.some((call) => call.key.startsWith('pending/')), false);
  }
});

const BASE_OFF_UPLOAD = Buffer.from('aWYgWyAteiAiJENMT1VERkxBUkVfQVBJX1RPS0VOIiBdOyB0aGVuCiAgZWNobyAiOjp3YXJuaW5nOjpDTE9VREZMQVJFX0FQSV9UT0tFTiDrr7jshKTsoJUg4oCUIFIyIOyXheuhnOuTnCBza2lwIgogIGVjaG8gInVzZXI9c2tpcCIgPj4gIiRHSVRIVUJfT1VUUFVUIgogIGVjaG8gImhpc3Q9c2tpcCIgPj4gIiRHSVRIVUJfT1VUUFVUIgogIGV4aXQgMApmaQojIO2VnOyqveydtCDsi6TtjKjtlbTrj4Qg64uk66W4IOyqveydgCDrsJjrk5zsi5wg7Iuc64+E7ZWcIOuSpCwg7ZWY64KY652864+EIOyLpO2MqO2WiOycvOuptCDsiqTthZ3snYQg7Iuk7Yyo66GcIOuBneuCuOuLpC4KIyAgICjsooXsoIQgYC4uLiB8fCB7IGVjaG8gd2FybmluZzsgcmV0dXJuIDE7IH1gIOydgCDquLDrs7gg7IW4IGBiYXNoIC1lYCDsnZggZXJyZXhpdCDsl5Ag6rG466CkCiMgICAg7LKrIOyLpO2MqOyXkOyEnCDsiqTthZ3snbQg7KO96rOgIHVzZXJzLWxpc3QuanNvbiBQVVQg7J20IOyVhOyYiCDsi6TtlonrkJjsp4Ag7JWK7JWY64ukLikKcmM9MApSMl9VUkw9Imh0dHBzOi8vYXBpLmNsb3VkZmxhcmUuY29tL2NsaWVudC92NC9hY2NvdW50cy8kQ0xPVURGTEFSRV9BQ0NPVU5UX0lEL3IyL2J1Y2tldHMvb2hzb3JyeS1kYXRhL29iamVjdHMiCnB1dCgpIHsKICBsb2NhbCBzdGF0dXMKICBpZiBzdGF0dXM9JChjdXJsIC1zUyAtbyAvZGV2L251bGwgLXcgJyV7aHR0cF9jb2RlfScgLVggUFVUIFwKICAgICAgIC1IICJBdXRob3JpemF0aW9uOiBCZWFyZXIgJENMT1VERkxBUkVfQVBJX1RPS0VOIiBcCiAgICAgICAtSCAiQ29udGVudC1UeXBlOiBhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04IiAtLWRhdGEtYmluYXJ5ICJAJDEiICIkUjJfVVJMLyQxIikgXAogICAgICYmIFtbICIkc3RhdHVzIiA9PSAyPz8gXV07IHRoZW4KICAgIGVjaG8gIlIyIE9LOiAkMSIKICAgIGlmIFtbICIkMSIgPT0gInVzZXIvJElJRFhfSUQuanNvbiIgXV07IHRoZW4gZWNobyAidXNlcj1zdWNjZXNzIiA+PiAiJEdJVEhVQl9PVVRQVVQiOyBmaQogICAgaWYgW1sgIiQxIiA9PSAiaGlzdC8kSUlEWF9JRC5qc29uIiBdXTsgdGhlbiBlY2hvICJoaXN0PXN1Y2Nlc3MiID4+ICIkR0lUSFVCX09VVFBVVCI7IGZpCiAgZWxzZQogICAgZWNobyAiOjplcnJvcjo6UjIg7JeF66Gc65OcIOyLpO2MqDogJDEiOyByYz0xCiAgZmkKfQpwdXQgInVzZXIvJElJRFhfSUQuanNvbiIKaWYgWyAtZiAidXNlci8kSUlEWF9JRC5qc29uIiBdOyB0aGVuCiAgOgplbHNlCiAgZWNobyAiOjplcnJvcjo6dXNlciDtjIzsnbwg7JeG7J2MIOKAlCBQVVQg67aI6rCAIjsgcmM9MQpmaQojIHVzZXJzLWxpc3QuanNvbiDsnYAg7Jes6riw7IScIFBVVCDtlZjsp4Ag7JWK64qU64ukIOKAlCDtm4Tsho0gbWVyZ2Ug7Iqk7YGs66a97Yq46rCAIEdFVOKGklBVVOKGkuqygOymneq5jOyngAojICAg64u064u57ZWc64ukKOugiOydtOyKpCDssL0g7LWc7IaM7ZmULCAyMDI2LTA4LTE0KS4g7Jes6riw7IScIOuYkCDsmKzrpqzrqbQg6rKA7Kad7J2EIO2GteqzvO2VnCDstZzsi6Drs7jsnYQKIyAgIOydtCDsnqHsnZgg64Kh7J2AIOuhnOy7rCDsgqzrs7jsnLzroZwg65CY64+M66Ck67KE66aw64ukLgojIGhpc3Qg64+EIFIyIFBVVCDsnbQg7Jyg7J287ZWcIOuztOq0gCDqsr3roZzri6QuIOuzgOqyveydtCDsl4bslrQg7J6s7IOd7ISx7J2EIOqxtOuEiOubtCDtmozssKjrj4Qg6re464yA66GcIOuLpOyLnAojICAg7Jis66aw64ukKOuCtOyaqSDrj5nsnbwgwrcgaW5ncmVzcyDrrLTro4wgwrcgQ2xhc3MgQSDripQg7JuUIDEwMOunjCDspJEg7ZWY66OoIDcw7JesIO2ajCkuCmlmIFsgIiRTQ09SRV9CVUZGRVJfQ1VNVUxBVElWRSIgIT0gIjEiIF0gJiYgWyAiJFNDT1JFX0JVRkZFUl9QUkVQQVJFIiAhPSAiMSIgXTsgdGhlbgogIGlmIFsgLWYgImhpc3QvJElJRFhfSUQuanNvbiIgXTsgdGhlbiBwdXQgImhpc3QvJElJRFhfSUQuanNvbiI7IGVsc2UgZWNobyAiOjp3YXJuaW5nOjpoaXN0IO2MjOydvCDsl4bsnYwg4oCUIFBVVCBza2lwIjsgZWNobyAiaGlzdD1za2lwIiA+PiAiJEdJVEhVQl9PVVRQVVQiOyBmaQplbHNlCiAgZWNobyAiaGlzdD1wdWJsaXNoZWQtYnktZHVtcCIgPj4gIiRHSVRIVUJfT1VUUFVUIgpmaQpleGl0ICRyYw==', 'base64').toString();
const BASE_OFF_PENDING = Buffer.from('aWYgWyAteiAiJENMT1VERkxBUkVfQVBJX1RPS0VOIiBdOyB0aGVuCiAgZWNobyAiOjplcnJvcjo6cGVuZGluZyDsmYTro4wg6rKM7IucIOyLpO2MqDogUjIg7Yag7YGwIOyXhuydjCI7IGV4aXQgMQpmaQpVU0VSX0ZJTEU9InVzZXIvJElJRFhfSUQuanNvbiIKaWYgWyAhIC1mICIkVVNFUl9GSUxFIiBdOyB0aGVuIGVjaG8gIjo6ZXJyb3I6OnBlbmRpbmcg7JmE66OMIOqyjOyLnCDsi6TtjKg6IHVzZXIg7YyM7J28IOyXhuydjCI7IGV4aXQgMTsgZmkKbm9kZSAtLWlucHV0LXR5cGU9bW9kdWxlIDw8J0pTJwppbXBvcnQgeyByZWFkRmlsZSB9IGZyb20gJ25vZGU6ZnMvcHJvbWlzZXMnOwppbXBvcnQgeyBjb25kaXRpb25hbFIyQ2xpZW50IH0gZnJvbSAnLi8uZ2l0aHViL3NjcmlwdHMvcjItY2xpZW50Lm1qcyc7Cgpjb25zdCB1c2VyID0gSlNPTi5wYXJzZShhd2FpdCByZWFkRmlsZShgdXNlci8ke3Byb2Nlc3MuZW52LklJRFhfSUR9Lmpzb25gLCAndXRmOCcpKTsKY29uc3QgdmVyc2lvbiA9IHVzZXI/Ll92OwppZiAodHlwZW9mIHZlcnNpb24gIT09ICdzdHJpbmcnIHx8ICFOdW1iZXIuaXNGaW5pdGUoRGF0ZS5wYXJzZSh2ZXJzaW9uKSkpIHsKICBjb25zb2xlLmVycm9yKCc6OmVycm9yOjpwZW5kaW5nIOyZhOujjCDqsozsi5wg7Iuk7YyoOiB1c2VyIF92IOustO2aqCcpOwogIHByb2Nlc3MuZXhpdCgxKTsKfQp0cnkgewogIGNvbnN0IGNsaWVudCA9IGNvbmRpdGlvbmFsUjJDbGllbnQoeyBhY2NvdW50OiBwcm9jZXNzLmVudi5DTE9VREZMQVJFX0FDQ09VTlRfSUQsIHRva2VuOiBwcm9jZXNzLmVudi5DTE9VREZMQVJFX0FQSV9UT0tFTiB9KTsKICBjb25zdCByZXN1bHQgPSBhd2FpdCBjbGllbnQubWVyZ2VQZW5kaW5nRG9uZShwcm9jZXNzLmVudi5JSURYX0lELCB2ZXJzaW9uKTsKICBpZiAocmVzdWx0Lm9rKSB7CiAgICBjb25zb2xlLmxvZyhg cGVuZGluZyDsmYTro4wg6rKM7IucIOyEseqztTogJHtyZXN1bHQuZG9uZX1gKTsKICAgIHByb2Nlc3MuZXhpdCgwKTsKICB9CiAgY29uc3QgY29uZmxpY3QgPSByZXN1bHQucmVhc29uID09PSAnY29uZmxpY3QtZXhoYXVzdGVkJzsKICBjb25zb2xlLmVycm9yKGA6OmVycm9yOjpwZW5kaW5nIOyZhOujjCDqsozsi5wgJHtjb25mbGljdCA/ICfstqnrj4wnIDogJ+yLpO2MqCd9OiAke3Jlc3VsdC5yZWFzb259YCk7CiAgcHJvY2Vzcy5leGl0KDEpOwp9IGNhdGNoIChlcnJvcikgewogIGNvbnNvbGUuZXJyb3IoYDo6ZXJyb3I6OnBlbmRpbmcg7JmE66OMIOqyjOyLnCDsi6TtjKg6ICR7ZXJyb3I/Lm1lc3NhZ2UgfHwgJ+yVjCDsiJgg7JeG64qUIOyYpOulmCd9YCk7CiAgcHJvY2Vzcy5leGl0KDEpOwp9CkpT', 'base64').toString();

function workflowRuns(source) {
  const lines = source.replace(/\r/g, '').split('\n');
  const runs = [];
  let job = '(unknown job)', step = '(unknown step)';
  for (let i = 0; i < lines.length; i++) {
    const jobMatch = /^(\s{2})([A-Za-z0-9_-]+):\s*$/.exec(lines[i]);
    if (jobMatch && !['on', 'permissions', 'env', 'outputs', 'concurrency'].includes(jobMatch[2])) { job = jobMatch[2]; step = '(job level)'; }
    const stepMatch = /^\s{6}- name: (.*)$/.exec(lines[i]);
    if (stepMatch) step = stepMatch[1];
    const match = /^(\s*)run:\s*(.*)$/.exec(lines[i]);
    if (!match) continue;
    const indent = match[1].length, value = match[2];
    if (value === '|') {
      let end = i + 1;
      while (end < lines.length) {
        const line = lines[end];
        if (line.trim() && line.match(/^\s*/)[0].length <= indent) break;
        end++;
      }
      const block = lines.slice(i + 1, end);
      const nonempty = block.filter((line) => line.trim());
      if (!nonempty.length) throw new Error(`empty run block: ${job}/${step} line ${i + 1}`);
      const common = Math.min(...nonempty.map((line) => /^\s*/.exec(line)[0].length));
      runs.push({ job, step, line: i + 1, script: block.map((line) => line.trim() ? line.slice(common) : '').join('\n') });
      i = end - 1;
    } else if (value && value !== '>' && !value.startsWith('>')) {
      runs.push({ job, step, line: i + 1, script: value });
    } else throw new Error(`unsupported run form ${JSON.stringify(value)}: ${job}/${step} line ${i + 1}`);
  }
  return runs;
}

function removeGuard(script) {
  const lines = script.split('\n');
  const start = lines.findIndex((line) => line.trim() === 'if [ "$FAST_DUMP_LIGHT_GUARD" = "1" ]; then');
  if (start < 0) return script;
  let depth = 0, end = -1;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^if\b/.test(line)) depth++;
    if (/^fi\b/.test(line) && --depth === 0) { end = i; break; }
  }
  if (end < 0) throw new Error('unterminated guard branch');
  lines.splice(start, end - start + 1);
  return lines.slice(start).join('\n').replace(/^\n/, '').replace(/\n$/, '');
}

function bashCandidate({ env = process.env, platform = process.platform, exists = (path) => {
  const result = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 3000, shell: false });
  return !result.error && result.status === 0;
} } = {}) {
  const denied = (path) => /(?:^|[\\/])(?:System32|Sysnative)[\\/]bash\.exe$/i.test(path) || /wsl/i.test(path);
  if (env.BASH_BIN) {
    if (denied(env.BASH_BIN) || !exists(env.BASH_BIN)) throw new Error(`BASH_BIN unavailable or disallowed: ${env.BASH_BIN}`);
    return env.BASH_BIN;
  }
  if (platform === 'win32') {
    for (const path of ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe']) if (exists(path)) return path;
  }
  const pathDirs = (env.PATH || '').split(platform === 'win32' ? ';' : delimiter);
  const candidates = pathDirs.flatMap((dir) => platform === 'win32'
    ? [`${dir.replace(/[\\/]+$/, '')}/bash.exe`, `${dir.replace(/[\\/]+$/, '')}/bash`]
    : [join(dir, 'bash')]);
  const found = candidates.find((path) => !denied(path) && exists(path));
  if (!found) throw new Error('bash executable not found');
  return found;
}

function checkBash(script, bash) {
  const safe = script.replace(/\$\{\{[\s\S]*?\}\}/g, 'EXPR_VALUE');
  const result = spawnSync(bash, ['-n'], { input: safe, encoding: 'utf8', timeout: 5000, shell: false });
  if (result.error || result.status !== 0 || /here-document/i.test(result.stderr || ''))
    throw new Error(`bash syntax failed: ${result.error?.message || ''} ${result.stderr || ''}`);
}

test('workflow OFF bodies match fixed 89cacab16 baseline and ON sequencing is guarded', () => {
  const workflow = readFileSync(new URL('../workflows/dump-user.yml', import.meta.url), 'utf8');
  const runs = workflowRuns(workflow);
  const named = (name) => runs.find((run) => run.step === name);
  const capture = workflow.indexOf('      - name: Capture fast dump generation');
  const dump = workflow.indexOf('      - name: Dump user from supabase');
  assert.ok(capture >= 0 && dump > capture);
  const captureBlock = workflow.slice(capture, dump);
  assert.match(captureBlock, /id: capture_generation/);
  assert.match(captureBlock, /if: \$\{\{ env\.FAST_DUMP_LIGHT_GUARD == '1' \}\}/);
  const upload = named('Upload to R2 (data.iidx.in)');
  const pending = named('Publish pending completion marker');
  assert.ok(upload && pending);
  assert.equal(removeGuard(upload.script), BASE_OFF_UPLOAD);
  assert.equal(removeGuard(pending.script), BASE_OFF_PENDING);
  const uploadStepAt = workflow.indexOf('      - name: Upload to R2 (data.iidx.in)');
  const uploadIfAt = workflow.indexOf('        if:', uploadStepAt);
  const uploadEnvAt = workflow.indexOf('        env:', uploadIfAt);
  assert.match(workflow.slice(uploadIfAt, uploadEnvAt), /steps\.dump\.outcome == 'success'.*env\.FAST_DUMP_LIGHT_GUARD != '1' \|\| steps\.capture_generation\.outcome == 'success'/s);
  assert.ok(workflow.includes('node .github/scripts/dump-fast-publish.mjs publish-actions-user "$IIDX_ID"'));
  assert.ok(workflow.includes('node .github/scripts/dump-fast-publish.mjs complete-actions-pending "$IIDX_ID"'));
  const on = upload.script.slice(0, upload.script.indexOf('          fi\n'));
  assert.ok(on.indexOf('publish-actions-user') < on.indexOf('hist=') && on.indexOf('hist=') < on.indexOf('user=success') && on.indexOf('user=success') < on.indexOf('exit 0'));
  assert.ok(pending.script.indexOf('complete-actions-pending') < pending.script.indexOf('exit $?'));
  const pendingStep = workflow.slice(workflow.indexOf('      - name: Publish pending completion marker'), workflow.indexOf('      - name:', workflow.indexOf('      - name: Publish pending completion marker') + 10));
  assert.match(pendingStep, /CLOUDFLARE_R2_ACCESS_KEY_ID:/);
  assert.match(pendingStep, /CLOUDFLARE_R2_SECRET_ACCESS_KEY:/);
});

test('repersona workflow blocks pass guard and R2 S3 credentials', () => {
  const dumpWorkflow = readFileSync(new URL('../workflows/dump-user.yml', import.meta.url), 'utf8');
  const repersonaWorkflow = readFileSync(new URL('../workflows/repersona-r2.yml', import.meta.url), 'utf8');
  const personaAt = dumpWorkflow.indexOf('\n  persona:');
  assert.ok(personaAt >= 0, 'persona job not found');
  const nextJobAt = dumpWorkflow.indexOf('\n  dispatch-coach-user:', personaAt);
  const personaBlock = dumpWorkflow.slice(personaAt, nextJobAt < 0 ? undefined : nextJobAt);
  const stepAt = repersonaWorkflow.indexOf('      - name: Repersona on R2');
  assert.ok(stepAt >= 0, 'Repersona on R2 step not found');
  const nextStepAt = repersonaWorkflow.indexOf('      - name:', stepAt + 1);
  const repersonaStepBlock = repersonaWorkflow.slice(stepAt, nextStepAt < 0 ? undefined : nextStepAt);
  const expected = [
    /^\s*FAST_DUMP_LIGHT_GUARD: \$\{\{ vars\.FAST_DUMP_LIGHT_GUARD \|\| '0' \}\}$/m,
    /^\s*CLOUDFLARE_R2_ACCESS_KEY_ID: \$\{\{ secrets\.CLOUDFLARE_R2_ACCESS_KEY_ID \}\}$/m,
    /^\s*CLOUDFLARE_R2_SECRET_ACCESS_KEY: \$\{\{ secrets\.CLOUDFLARE_R2_SECRET_ACCESS_KEY \}\}$/m,
  ];
  for (const [name, block] of [['dump-user persona job', personaBlock], ['repersona-r2 step', repersonaStepBlock]]) {
    for (const pattern of expected) assert.match(block, pattern, `${name} missing ${pattern}`);
  }
});

test('all workflow run blocks parse with bash -n and heredoc warnings fail', () => {
  const workflow = readFileSync(new URL('../workflows/dump-user.yml', import.meta.url), 'utf8');
  const runs = workflowRuns(workflow);
  assert.ok(runs.length > 0, 'no run blocks extracted');
  const bash = bashCandidate();
  console.log(`bash syntax checker: ${bash}; run blocks: ${runs.length}`);
  for (const run of runs) assert.doesNotThrow(() => checkBash(run.script, bash), `${run.job}/${run.step} line ${run.line}`);
  assert.doesNotThrow(() => checkBash("if true; then\ncat <<'JS'\nx\nJS\nfi\n", bash));
  assert.throws(() => checkBash("if true; then\n  cat <<'JS'\n  x\n  JS\nfi\n", bash), /bash syntax failed/);
  assert.throws(() => checkBash("cat <<'JS'\n  x\n", bash), /bash syntax failed/);
});

test('bash selection honors BASH_BIN and rejects WSL launchers and missing candidates', () => {
  assert.throws(() => bashCandidate({ env: { BASH_BIN: 'missing-bash' }, platform: 'linux', exists: () => false }), /BASH_BIN unavailable/);
  assert.throws(() => bashCandidate({ env: { PATH: '' }, platform: 'linux', exists: () => false }), /not found/);
  assert.throws(() => bashCandidate({ env: { BASH_BIN: 'C:/Windows/System32/bash.exe' }, platform: 'win32', exists: () => true }), /disallowed/);
  assert.throws(() => bashCandidate({ env: { BASH_BIN: 'C:/Windows/Sysnative/bash.exe' }, platform: 'win32', exists: () => true }), /disallowed/);
  assert.throws(() => bashCandidate({ env: { BASH_BIN: 'C:/Windows/System32/wsl.exe' }, platform: 'win32', exists: () => true }), /disallowed/);
  assert.equal(bashCandidate({ env: { PATH: 'path' }, platform: 'win32', exists: (path) => path === 'C:/Program Files/Git/usr/bin/bash.exe' }), 'C:/Program Files/Git/usr/bin/bash.exe');
  assert.equal(bashCandidate({ env: { PATH: 'C:/Windows/System32;C:/Tools' }, platform: 'win32', exists: (path) => path === 'C:/Tools/bash.exe' }), 'C:/Tools/bash.exe');
});

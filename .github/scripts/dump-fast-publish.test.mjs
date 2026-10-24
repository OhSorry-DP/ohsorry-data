import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mergeActionsUser, mergeEdgeUser, mergeSlowUser, publishUserPatch, runCli } from './dump-fast-publish.mjs';

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

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { produceUser, createClient, parseArgs, main, createDiskCache } from '../coach-precompute.mjs';
import { conditionalR2Client, createRequestGate } from '../r2-client.mjs';
import { collectGraph, digest } from '../uvec-lib.mjs';
import { CELLS, validateIndex } from '../../../../ohSorryWeb/functions/_shared/coach-precompute-contract.js';

const webRoot = fileURLToPath(new URL('../../../../ohSorryWeb/', import.meta.url));
const id = '12345678';
async function fixture(t, mode = '') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coach-producer-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'functions/api/[iidxId]'), { recursive: true });
  await fs.mkdir(path.join(root, 'functions/_shared'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await fs.copyFile(path.join(webRoot, 'functions/_shared/coach-precompute-contract.js'), path.join(root, 'functions/_shared/coach-precompute-contract.js'));
  await fs.writeFile(path.join(root, 'functions/_shared/coach-recs-phys.js'), 'export const EXPECTED_CONTRACT = { model: "fixture" };');
  await fs.writeFile(path.join(root, 'functions/api/[iidxId]/[resource].js'), `
import '../../_shared/coach-precompute-contract.js';
import '../../_shared/coach-recs-phys.js';
export async function onRequestCalculated({ request, env }) {
  const object = await env.DATA.get('user/12345678.json');
  const first = await object.json(); first.mutated = true;
  const fresh = await object.json();
  if (fresh.mutated) throw new Error('json isolation');
  const raw = new Uint8Array(await object.arrayBuffer());
  if (raw[0] !== 31 || raw[1] !== 139) throw new Error('raw gzip lost');
  await env.DATA.head('arrange/12345678.json');
  await env.DATA.get('data/common.json');
  await env.DATA.get('data/missing.json');
  if ('${mode}' === 'transport') { try { await fetch('https://unexpected.invalid/asset'); } catch {} }
  return new Response(JSON.stringify('${mode}' === 'error' ? {error:'failed'} : '${mode}' === 'no_star' ? {error:'no_star'} : '${mode}' === 'no_r_star' ? {error:'no_r_star'} : { query:new URL(request.url).search, fresh }),
    {status: '${mode}' === 'http' ? 500 : 200, headers:{'content-type':'application/json; charset=utf-8'}});
}`);
  const objects = new Map([['user/12345678.json', gzipSync('{"v":1}')]]), puts = [];
  const client = {
    async read(key) { const bytes = objects.get(key); return bytes === undefined ? null : { bytes: Buffer.from(bytes), etag: `"${digest(bytes)}"` }; },
    async put(key, bytes, etag) {
      const current = await this.read(key);
      if ((current?.etag ?? null) !== etag) throw new Error('conditional_conflict');
      puts.push(key); objects.set(key, Buffer.from(bytes));
    },
  };
  const graph = await collectGraph(root, fetch, { mode: 'coach' });
  const fingerprint = graph.coachFingerprint; await graph.cleanup();
  return { root, client, objects, puts, fingerprint,
    run: (options = {}) => produceUser({ webRoot: root, id, client, env: { COACH_RECS_ENGINE_SHA256: fingerprint }, ...options }) };
}

test('32 route bytes·gzip raw/json 격리·2 PUT·index 검증과 REST raw 보존', async t => {
  const f = await fixture(t), result = await f.run();
  assert.equal(result.ok, true, result.reason); assert.equal(result.cells.length, 32); assert.equal(result.puts, 2);
  const index = JSON.parse(f.objects.get(`uslice/${id}-coach-recs.json`));
  assert.equal(validateIndex(index, { id, engine_sha256: f.fingerprint }), true);
  const graph = await collectGraph(f.root, fetch, { mode: 'coach' });
  t.after(() => graph.cleanup());
  const { onRequestCalculated } = await import(graph.entry);
  for (const cell of CELLS) {
    const item = index.cells[cell];
    const bytes = f.objects.get(`uslice/${id}-coach-recs-${result.generation}.bin`).subarray(item.offset, item.offset + item.length);
    assert.equal(digest(bytes), index.cells[cell].body_sha256);
    assert.equal(bytes.length, index.cells[cell].byte_length);
    assert.equal(JSON.parse(bytes).fresh.v, 1);
    const response = await onRequestCalculated({ request: new Request(`https://iidx.in/api/${id}/recommend${JSON.parse(bytes).query}`),
      env: { DATA: { async get() { return { json: async () => ({ v: 1 }), arrayBuffer: async () => Uint8Array.from(gzipSync('{"v":1}')).buffer }; }, async head() { return null; } } } });
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  }
  const raw = gzipSync('{"한글":true}');
  const client = createClient({ CLOUDFLARE_ACCOUNT_ID: 'fixture', CLOUDFLARE_API_TOKEN: 'fixture' }, async () =>
    new Response(raw, { headers: { etag: '"raw"' } }));
  assert.deepEqual((await client.read('data/a.gz')).bytes, raw);
});

test('원본 변경 두 번이면 이전 index 보존·조건부 index 충돌도 보존', async t => {
  const f = await fixture(t); f.objects.set(`uslice/${id}-coach-recs.json`, Buffer.from('previous'));
  const read = f.client.read.bind(f.client); let reads = 0;
  f.client.read = async key => {
    if (key === `user/${id}.json` && ++reads % 2 === 0) f.objects.set(key, gzipSync(JSON.stringify({ v: reads })));
    return read(key);
  };
  const result = await f.run(); assert.equal(result.ok, false); assert.equal(result.reason, 'source_changed');
  assert.equal(f.objects.get(`uslice/${id}-coach-recs.json`).toString(), 'previous');
  assert.equal(f.puts.some(key => key === `uslice/${id}-coach-recs.json`), false);
  f.client.read = read;
  const put = f.client.put.bind(f.client);
  f.client.put = async (key, bytes, etag) => {
    if (key === `uslice/${id}-coach-recs.json`) f.objects.set(key, Buffer.from('newer'));
    return put(key, bytes, etag);
  };
  assert.equal((await f.run()).reason, 'conditional_conflict');
  assert.equal(f.objects.get(`uslice/${id}-coach-recs.json`).toString(), 'newer');
});

test('에러 응답·삼켜진 통신 실패는 게시 금지', async t => {
  for (const mode of ['error', 'http', 'transport']) {
    const f = await fixture(t, mode), result = await f.run();
    assert.equal(result.ok, false, mode); assert.equal(f.puts.length, 0);
    assert.equal(f.objects.has(`uslice/${id}-coach-recs.json`), false);
  }
  const deterministic = await fixture(t, 'no_r_star');
  assert.equal((await deterministic.run()).ok, true);
  assert.equal(deterministic.puts.length, 2);
});

test('dry 32칸 계산·PUT 0 및 CLI 옵션 검증', async t => {
  const f = await fixture(t), result = await f.run({ dry: true });
  assert.equal(result.ok, true, result.reason); assert.equal(result.cells.length, 32);
  assert.equal(result.puts, 0); assert.equal(f.puts.length, 0);
  assert.equal(parseArgs(['--web-root', webRoot, '--only', id, '--dry']).concurrency, 2);
  assert.deepEqual(parseArgs([]), { dry: false, concurrency: 2, requestsPerSecond: 3 });
  for (const args of [['--web-root', webRoot, '--concurrency', '0'], ['--web-root'], ['--requests-per-second', '0'], ['--requests-per-second', 'NaN'], ['--unknown']]) assert.throws(() => parseArgs(args));
  console.log(JSON.stringify({ fixture: 'synthetic gzip bucket', ...result }));
  const objects = new Map(Object.entries({
    'user/12345678.json': { user: { iidx_id: id, star: 10, native_star: 10 }, scores: [], _v: '2026-10-09T00:00:00.000Z' },
    'songs.json': [], 'data/patterns-dp-1112.json': {}, 'data/ohSorryRating.json': { ratings: [] },
    'data/textage-meta.json': { songs: {} }, 'data/feature-scores-slim.json': {},
  }).map(([key, value]) => [key, Buffer.from(JSON.stringify(value))]));
  const actual = await produceUser({ webRoot, id, dry: true, env: {}, client: {
    async read(key) { const bytes = objects.get(key); return bytes ? { bytes, etag: `"${digest(bytes)}"` } : null; },
    async put() { assert.fail('dry PUT'); },
  } });
  assert.equal(actual.ok, true, actual.reason); assert.equal(actual.cells.length, 32); assert.equal(actual.puts, 0);
  console.log(JSON.stringify({ fixture: 'actual web route / synthetic empty charts, not production user', ...actual }));
});

test('지문은 collectGraph와 동일·expected mismatch/누락은 게시 금지', async t => {
  const f = await fixture(t);
  assert.equal((await f.run()).engine_sha256, f.fingerprint);
  assert.equal((await f.run({ env: { COACH_RECS_ENGINE_SHA256: '0'.repeat(64) } })).reason, 'engine_mismatch');
  const optional = await f.run({ env: {} });
  assert.equal(optional.ok, true, optional.reason);
  assert.equal(optional.engine_sha256, f.fingerprint);
  assert.equal(JSON.parse(f.objects.get(`uslice/${id}-coach-recs.json`)).engine_sha256, f.fingerprint);
});

test('같은 입력 재실행 generation 동일·immutable body 재PUT 없음·쓰기 경로 제한', async t => {
  const f = await fixture(t), first = await f.run(), second = await f.run();
  assert.equal(second.ok, true, second.reason); assert.equal(first.generation, second.generation);
  assert.equal(second.puts, 0);
  assert.ok(f.puts.every(key => key.startsWith(`uslice/${id}-coach-recs`)));
});


async function engineFixture(t, umd = false) {
  const f = await fixture(t);
  if (umd) {
    await fs.writeFile(path.join(f.root, 'functions/_shared/recommend.js'), '(function () { module.exports = { value: 7 }; })();\n');
    await fs.appendFile(path.join(f.root, 'functions/api/[iidxId]/[resource].js'), "\nimport recommend from '../../_shared/recommend.js';\nif (recommend.value !== 7) throw new Error('UMD import failed');\n");
  }
  const files = {};
  const graph = await collectGraph(f.root, fetch, { mode: 'coach' });
  f.fingerprint = graph.coachFingerprint;
  try {
    for (const name of Object.keys(graph.coachSources)) files[name] = (await fs.readFile(path.join(f.root, name), 'utf8')).replace(/\r\n?/g, '\n');
  } finally { await graph.cleanup(); }
  const bundle = { schema: 'coach-recs-engine/1', engine_sha256: f.fingerprint, files };
  f.objects.set('engine/coach-recs/current.json', Buffer.from(JSON.stringify({ schema: bundle.schema, engine_sha256: f.fingerprint })));
  f.objects.set(`engine/coach-recs/${f.fingerprint}.json`, Buffer.from(JSON.stringify(bundle)));
  return { ...f, bundle };
}

test('parent passes original R2 UMD sources to strict-module child with original fingerprint', async t => {
  const f = await engineFixture(t, true);
  const graph = await collectGraph(undefined, fetch, { mode: 'coach', client: f.client });
  try {
    assert.equal(await fs.readFile(path.join(graph.sourceRoot, 'functions/_shared/recommend.js'), 'utf8'), f.bundle.files['functions/_shared/recommend.js']);
    await assert.rejects(fs.access(path.join(graph.sourceRoot, 'functions/_shared/recommend.js.cjs')), { code: 'ENOENT' });
  } finally { await graph.cleanup(); }
  await assert.rejects(fs.access(graph.sourceRoot), { code: 'ENOENT' });
  const results = await main(['--only', id], { client: f.client, childExecArgv: ['--no-experimental-detect-module'] });
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true, results[0].reason);
  assert.equal(results[0].engine_sha256, f.fingerprint);
  assert.equal(results[0].cells.length, 32);
  assert.equal(results[0].puts, 2);
  assert.equal(JSON.parse(f.objects.get(`uslice/${id}-coach-recs.json`)).engine_sha256, f.fingerprint);
});

test('child rejects parent fingerprint mismatch before reads or publication', async t => {
  const f = await engineFixture(t, true);
  const reads = [], read = f.client.read.bind(f.client);
  f.client.read = async key => { reads.push(key); return read(key); };
  const result = await produceUser({ webRoot: f.root, id, client: f.client, env: {}, expectedEngineSha256: '0'.repeat(64) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'engine_mismatch');
  assert.equal(result.engine_sha256, f.fingerprint);
  assert.equal(result.puts, 0);
  assert.equal(f.puts.length, 0);
  assert.deepEqual(reads, []);
});

test('R2 engine fingerprint recomputation matches and publishes all cells', async t => {
  const f = await engineFixture(t);
  const result = await produceUser({ id, client: f.client, env: {} });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.engine_sha256, f.fingerprint);
  assert.equal(result.puts, 2);
  assert.equal(f.puts.length, 2);
});

test('R2 engine source or object fingerprint mismatch forbids any publication', async t => {
  const f = await engineFixture(t);
  for (const change of [b => { b.files['functions/_shared/coach-recs-phys.js'] += '\n// tampered'; }, b => { b.engine_sha256 = '0'.repeat(64); }]) {
    const bundle = structuredClone(f.bundle); change(bundle);
    f.objects.set(`engine/coach-recs/${f.fingerprint}.json`, Buffer.from(JSON.stringify(bundle)));
    const result = await produceUser({ id, client: f.client, env: {} });
    assert.equal(result.ok, false);
    assert.match(result.reason, /engine_mismatch|engine_bundle_invalid/);
    assert.equal(f.puts.length, 0);
  }
});

test('missing current pointer warns and skips before user reads or publication', async () => {
  const reads = [], warnings = [];
  const saved = console.warn;
  console.warn = value => warnings.push(value);
  try {
    const client = { read: async key => { reads.push(key); return null; }, put: async () => assert.fail('publication forbidden') };
    assert.deepEqual(await main([], { client }), []);
    const result = await produceUser({ id, client, env: {} });
    assert.equal(result.ok, true); assert.equal(result.skipped, true); assert.equal(result.puts, 0);
    assert.deepEqual(reads, ['engine/coach-recs/current.json', 'engine/coach-recs/current.json']);
    assert.equal(warnings.length, 2); assert.match(warnings[0], /::warning::.*current.json missing/);
  } finally { console.warn = saved; }
});


test('no_star는 skipped 성공이며 PUT 없이 coach-only 집계에 포함', async t => {
  const f = await fixture(t, 'no_star');
  const result = await f.run();
  assert.equal(result.ok, true); assert.equal(result.skipped, true);
  assert.equal(result.reason, 'no_star'); assert.equal(result.puts, 0); assert.equal(f.puts.length, 0);
  const { runCoachOnly, parseArgs: parseCoachArgs } = await import('../r2-repersona.mjs');
  const previous = process.exitCode, messages = [], log = console.log;
  try {
    process.exitCode = 0; console.log = value => messages.push(value);
    await runCoachOnly({ ids: [id], options: parseCoachArgs(['--coach-only']), producerMain: async () => [result] });
    assert.equal(process.exitCode, 0); assert.match(messages.join('\n'), /성공 0\/1.*skipped 1.*실패 0/);
  } finally { console.log = log; process.exitCode = previous; }
});

test('429·5xx·네트워크 재시도와 Retry-After·전체 요청 예산·PUT 응답 유실 복구', async () => {
  let now = 0, calls = 0; const waits = [], starts = [];
  const sleep = async ms => { waits.push(ms); now += ms; };
  const gate = createRequestGate({ intervalMs: 1000 / 3, now: () => now, sleep });
  const bytes = Buffer.from('raw');
  const client = conditionalR2Client({ account: 'fixture', token: 'fixture', retry: true, requestGate: gate, sleep,
    fetchImpl: async (_url, init) => {
      starts.push(now); calls++;
      if (calls === 1) return new Response(null, { status: 429, headers: { 'Retry-After': '5' } });
      if (calls === 2) return new Response(null, { status: 503 });
      if (calls === 3) throw new TypeError('fetch failed');
      return new Response(bytes, { headers: { etag: '"raw"' } });
    },
  });
  assert.equal((await client.read('data/a')).body, 'raw'); assert.equal(calls, 4);
  assert.ok(waits[0] >= 5000); assert.ok(waits[1] >= 2000); assert.ok(waits[2] >= 4000);
  await Promise.all([client.read('a'), client.read('b'), client.read('c')]);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 1000 / 3 - 0.001);
  let queuedNow = 0, queuedGate;
  const queuedStarts = [];
  queuedGate = createRequestGate({ intervalMs: 100, recheckDefer: true, now: () => queuedNow,
    sleep: async ms => { queuedNow += ms; if (queuedNow === 100) queuedGate.defer(5000); },
  });
  await queuedGate.run(() => queuedStarts.push(queuedNow));
  await queuedGate.run(() => queuedStarts.push(queuedNow));
  assert.deepEqual(queuedStarts, [0, 5100]);
  let puts = 0;
  const recovered = conditionalR2Client({ account: 'fixture', token: 'fixture', retry: true, sleep: async () => {},
    fetchImpl: async (_url, init) => {
      if (init.method === 'PUT') {
        if (++puts === 1) throw new TypeError('response lost');
        return new Response(null, { status: 412 });
      }
      return new Response(bytes, { headers: { etag: '"raw"' } });
    },
  });
  await recovered.put('a.bin', bytes, null); assert.equal(puts, 2);
  let exhausted = 0;
  const failed = conditionalR2Client({ account: 'fixture', token: 'fixture', retry: true, sleep: async () => {},
    fetchImpl: async () => { exhausted++; return new Response(null, { status: 429 }); },
  });
  await assert.rejects(failed.read('a'), /HTTP 429/); assert.equal(exhausted, 4);
});

test('실제 child 3명도 공용 자산과 부재 GET은 실행당 1회·디스크 raw 보존', async t => {
  const f = await engineFixture(t), reads = new Map(), read = f.client.read.bind(f.client);
  const common = gzipSync('{"공용":true}'); f.objects.set('data/common.json', common);
  f.client.read = async key => { reads.set(key, (reads.get(key) || 0) + 1); return read(key); };
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'coach-cache-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cached = createDiskCache(f.client, directory);
  const copies = await Promise.all(Array.from({ length: 3 }, () => cached.read('data/common.json')));
  for (const copy of copies) { assert.deepEqual(copy.bytes, common); assert.deepEqual(await fs.readFile(copy.file), common); }
  assert.equal(reads.get('data/common.json'), 1); reads.clear();
  const results = await main(['--only', '12345678,23456789,34567890', '--concurrency', '2'], { client: f.client });
  assert.equal(results.length, 3); assert.ok(results.every(result => result.ok && result.puts === 2));
  assert.equal(reads.get('data/common.json'), 1); assert.equal(reads.get('data/missing.json'), 1);
  assert.equal(reads.get('engine/coach-recs/current.json'), 1);
  assert.equal(reads.get(`engine/coach-recs/${f.fingerprint}.json`), 1);
  assert.equal(reads.get('user/12345678.json'), 6); assert.equal(reads.get('arrange/12345678.json'), 6);
});

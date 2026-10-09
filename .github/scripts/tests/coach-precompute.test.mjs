import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { produceUser, createClient, parseArgs, main } from '../coach-precompute.mjs';
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
  if ('${mode}' === 'transport') { try { await fetch('https://unexpected.invalid/asset'); } catch {} }
  return new Response(JSON.stringify('${mode}' === 'error' ? {error:'failed'} : '${mode}' === 'no_r_star' ? {error:'no_r_star'} : { query:new URL(request.url).search, fresh }),
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

test('32 route bytes·gzip raw/json 격리·33 PUT·index 검증과 REST raw 보존', async t => {
  const f = await fixture(t), result = await f.run();
  assert.equal(result.ok, true, result.reason); assert.equal(result.cells.length, 32); assert.equal(result.puts, 33);
  const index = JSON.parse(f.objects.get(`uslice/${id}-coach-recs.json`));
  assert.equal(validateIndex(index, { id, engine_sha256: f.fingerprint }), true);
  const graph = await collectGraph(f.root, fetch, { mode: 'coach' });
  t.after(() => graph.cleanup());
  const { onRequestCalculated } = await import(graph.entry);
  for (const cell of CELLS) {
    const bytes = f.objects.get(`uslice/${id}-coach-recs-${result.generation}-${cell}.json`);
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
  assert.equal(deterministic.puts.length, 33);
});

test('dry 32칸 계산·PUT 0 및 CLI 옵션 검증', async t => {
  const f = await fixture(t), result = await f.run({ dry: true });
  assert.equal(result.ok, true, result.reason); assert.equal(result.cells.length, 32);
  assert.equal(result.puts, 0); assert.equal(f.puts.length, 0);
  assert.equal(parseArgs(['--web-root', webRoot, '--only', id, '--dry']).concurrency, 4);
  assert.deepEqual(parseArgs([]), { dry: false, concurrency: 4 });
  for (const args of [['--web-root', webRoot, '--concurrency', '0'], ['--web-root'], ['--unknown']]) assert.throws(() => parseArgs(args));
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
  assert.equal(second.puts, 1);
  assert.ok(f.puts.every(key => key.startsWith(`uslice/${id}-coach-recs`)));
});


async function engineFixture(t) {
  const f = await fixture(t);
  const files = {};
  const graph = await collectGraph(f.root, fetch, { mode: 'coach' });
  try {
    for (const name of Object.keys(graph.coachSources)) files[name] = (await fs.readFile(path.join(f.root, name), 'utf8')).replace(/\r\n?/g, '\n');
  } finally { await graph.cleanup(); }
  const bundle = { schema: 'coach-recs-engine/1', engine_sha256: f.fingerprint, files };
  f.objects.set('engine/coach-recs/current.json', Buffer.from(JSON.stringify({ schema: bundle.schema, engine_sha256: f.fingerprint })));
  f.objects.set(`engine/coach-recs/${f.fingerprint}.json`, Buffer.from(JSON.stringify(bundle)));
  return { ...f, bundle };
}

test('R2 engine fingerprint recomputation matches and publishes all cells', async t => {
  const f = await engineFixture(t);
  const result = await produceUser({ id, client: f.client, env: {} });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.engine_sha256, f.fingerprint);
  assert.equal(result.puts, 33);
  assert.equal(f.puts.length, 33);
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

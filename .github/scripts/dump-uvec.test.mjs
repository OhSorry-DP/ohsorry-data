import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run, parseArgs } from './dump-uvec.mjs';
import { imports, collectGraph, createNetwork, createSliceFetch, probeAssets, selectTargets, inputKey, digest } from './uvec-lib.mjs';
import { md5 } from './r2-client.mjs';
import { publishUserSlice } from './user-slice.mjs';

const silent = { log() {}, warn() {} };
async function fixture(t, ids = ['A1', 'b2']) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uvec-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'v3/services'), { recursive: true });
  await fs.mkdir(path.join(dir, 'v3/shared'), { recursive: true });
  await fs.writeFile(path.join(dir, 'v3/shared/value.js'), 'export const v = 1;');
  await fs.writeFile(path.join(dir, 'v3/services/uvec-slice.js'), `import { v } from '../shared/value.js';
export async function computeUvecSlice(id, { fetchImpl }) {
  if (window !== globalThis) throw new Error('shim 없음');
  const profile = await (await fetchImpl('https://data.iidx.in/user/' + id + '.json')).json();
  await fetchImpl('https://data.iidx.in/arrange/' + id + '.json');
  const asset = await (await fetch('https://data.iidx.in/data/common.json')).json();
  if (profile.fail) throw new Error('계산 실패');
  return { v, id, date: profile.date, arrangeSig: '', vec: profile.empty ? null : { strength: asset.strength } };
}`);
  const objects = new Map(ids.map((id) => [`user/${id}.json`, JSON.stringify({ date: 1 })]));
  const calls = { writes: [], reads: [], http: [], sleeps: [] };
  const client = {
    async getText(key) { calls.reads.push(key); return objects.get(key) ?? null; },
    async listEntries(prefix) { return [...objects].filter(([key]) => key.startsWith(prefix)).map(([key, body]) => ({ key, etag: md5(body) })); },
    async putText(key, body) { calls.writes.push(['put', key]); objects.set(key, body); return { ok: true }; },
    async del(key) { calls.writes.push(['del', key]); objects.delete(key); return true; },
  };
  let version = 1;
  const fetchImpl = async (url, init) => {
    calls.http.push([String(url), init?.method || 'GET']);
    return new Response(init?.method === 'HEAD' ? null : JSON.stringify({ strength: version }), { headers: { etag: `"asset-${version}"` } });
  };
  return { objects, calls, client, dir, version: (n) => { version = n; },
    run: (options = {}) => run({ webBase: dir, client, fetchImpl, sleep: async (ms) => { calls.sleeps.push(ms); }, log: silent, ...options }) };
}

test('옵션은 기본 dry·100명·웹 배포 경로이며 잘못된 값 거절', () => {
  assert.deepEqual(parseArgs([]), { apply: false, maxUsers: 100, webBase: 'https://iidx.in/' });
  assert.equal(parseArgs(['--apply', '--max-users', '2', '--web-base', 'D:/fake']).apply, true);
  for (const args of [['--max-users', '0'], ['--max-users', '1.2'], ['--web-base'], ['--oops']]) assert.throws(() => parseArgs(args));
});
test('그래프 지정자는 import·재export·리터럴 동적 import만 수집', () => {
  assert.deepEqual(imports(`// import './bad.js';
const text = "import './bad.js'";
import './a.js'; export { a } from '../b.js'; export * from './c.js';
import('./d.js'); const here = import.meta.url;`), ['./a.js', '../b.js', './c.js', './d.js']);
  assert.throws(() => imports('import(name)'));
  assert.throws(() => imports("import x from 'external'"));
});
test('로컬 그래프를 같은 배치로 받고 원본 export를 import', async (t) => {
  const f = await fixture(t);
  const graph = await collectGraph(f.dir, () => { throw new Error('로컬은 HTTP 금지'); });
  try { assert.equal(Object.keys(graph.modules).length, 2); assert.equal(typeof (await import(graph.entry)).computeUvecSlice, 'function'); }
  finally { await graph.cleanup(); }
});
test('원격 그래프 순환·중복 수집과 ETag 기록', async () => {
  const sources = new Map([
    ['https://web/v3/services/uvec-slice.js', "export * from '../a.js'; import '../a.js';"],
    ['https://web/v3/a.js', "import './services/uvec-slice.js'; export const n=1;"],
  ]);
  const calls = [];
  const graph = await collectGraph('https://web/', async (url) => { calls.push(url); return new Response(sources.get(url), { headers: { etag: '"tag"' } }); });
  try { assert.equal(calls.length, 2); assert.deepEqual(Object.values(graph.modules), ['tag', 'tag']); }
  finally { await graph.cleanup(); }
});
test('그래프 루트 탈출·모듈 HTTP 실패는 중단', async () => {
  await assert.rejects(collectGraph('https://web/root/', async () => new Response("import '../../../escape.js';")), /루트 밖/);
  await assert.rejects(collectGraph('https://web/', async () => new Response('', { status: 500 })), /HTTP 500/);
});
test('fetch는 user·arrange만 REST 라우팅하고 공통 자산은 1회 GET·복제 응답', async () => {
  const reads = [], urls = [], assets = {};
  const fetchSlice = createSliceFetch({ read: async (key) => { reads.push(key); return key.startsWith('user') ? '{}' : null; },
    network: async (url) => { urls.push(url); return new Response('{"v":1}', { headers: { etag: 'W/"e1"' } }); }, assets });
  assert.equal((await fetchSlice('https://data.iidx.in/user/A.json?fresh=1')).status, 200);
  assert.equal((await fetchSlice(new Request('https://data.iidx.in/arrange/A.json'))).status, 404);
  for (let n = 0; n < 2; n++) assert.deepEqual(await (await fetchSlice('https://data.iidx.in/songs.json')).json(), { v: 1 });
  assert.deepEqual(reads, ['user/A.json', 'arrange/A.json']); assert.equal(urls.length, 1);
  assert.equal(assets[urls[0]], 'e1');
  await assert.rejects(fetchSlice('https://web/', { method: 'PUT' }), /쓰기 요청/);
});
test('자산 HEAD·ETag 없음 본문 해시·404 정상 부재', async () => {
  const calls = [];
  const network = async (url, init) => { calls.push([url, init.method || 'GET']);
    if (url.endsWith('/missing')) return new Response(null, { status: 404 });
    return new Response(init.method === 'HEAD' ? null : 'body', { headers: url.endsWith('/etag') ? { etag: '"e"' } : {} }); };
  assert.deepEqual(await probeAssets({ 'https://x/etag': '', 'https://x/hash': '', 'https://x/missing': '' }, network),
    { 'https://x/etag': 'e', 'https://x/hash': digest('body'), 'https://x/missing': 'status:404' });
  assert.equal(calls.length, 4);
  await assert.rejects(probeAssets({ 'https://x/fail': '' }, async () => new Response(null, { status: 500 })));
});
test('입력 키는 URL·ETag 순서 무관, 모듈·자산 변경 모두 감지', () => {
  assert.equal(inputKey({ b: '2', a: '1' }, {}), inputKey({ a: '1', b: '2' }, {}));
  assert.notEqual(inputKey({ a: '1' }, { b: '2' }), inputKey({ a: '2' }, { b: '2' }));
  assert.notEqual(inputKey({ a: '1' }, { b: '2' }), inputKey({ a: '1' }, { b: '3' }));
});
test('대상은 신규·user 변경·arrange 변경·입력 키 변경', () => {
  const users = new Map([['A', 'u'], ['B', 'u'], ['C', 'u']]);
  const state = { users: { A: { userEtag: 'u', arrangeEtag: null, inputKey: 'k' }, B: { userEtag: 'old', arrangeEtag: null, inputKey: 'k' } } };
  assert.deepEqual(selectTargets(users, new Map(), state, 'k'), ['B', 'C']);
  assert.deepEqual(selectTargets(users, new Map([['A', 'a']]), state, 'k'), ['A', 'B', 'C']);
  assert.deepEqual(selectTargets(users, new Map(), state, 'new'), ['A', 'B', 'C']);
});
test('기본 dry 쓰기 0·공통 자산 GET 1회·전역 복구·간격 250ms', async (t) => {
  const f = await fixture(t), original = globalThis.fetch;
  const result = await f.run();
  assert.equal(result.computed, 2); assert.equal(f.calls.writes.length, 0);
  assert.equal(f.calls.http.length, 1); assert.equal(globalThis.fetch, original);
  assert.ok(f.calls.sleeps.every((ms) => ms >= 250));
});
test('apply 상한과 상태 저장으로 다음 회차 나머지 처리·md5 같으면 PUT 생략', async (t) => {
  const f = await fixture(t);
  const first = await f.run({ apply: true, maxUsers: 1 }); assert.equal(first.computed, 1);
  const second = await f.run({ apply: true, maxUsers: 1 }); assert.equal(second.computed, 1);
  const third = await f.run({ apply: true }); assert.equal(third.computed, 0);
  const writeCount = f.calls.writes.length;
  await f.run({ apply: true }); assert.equal(f.calls.writes.length, writeCount);
  f.objects.set('arrange/A1.json', '{}');
  const fourth = await f.run({ apply: true }); assert.equal(fourth.computed, 1); assert.equal(fourth.skips, 1); assert.equal(fourth.puts, 0);
});
test('공통 자산 키 변경은 전원 대상·상한 이후 회차에서도 유지', async (t) => {
  const f = await fixture(t); await f.run({ apply: true }); f.version(2);
  const first = await f.run({ apply: true, maxUsers: 1 }); assert.equal(first.targets, 2);
  const second = await f.run({ apply: true, maxUsers: 1 }); assert.equal(second.targets, 1);
  assert.equal((await f.run()).targets, 0);
});
test('웹 모듈 변경도 전원 재계산', async (t) => {
  const f = await fixture(t); await f.run({ apply: true });
  await fs.appendFile(path.join(f.dir, 'v3/shared/value.js'), '\n// 새 모듈 버전');
  assert.equal((await f.run()).targets, 2);
});
test('user 삭제는 vec만 삭제·삭제도 상한 예산·dry 삭제 0', async (t) => {
  const f = await fixture(t); await f.run({ apply: true });
  f.objects.delete('user/A1.json'); f.objects.set('uslice/A1-r-dp-00.json', '{}');
  const dry = await f.run(); assert.equal(dry.deletes, 1); assert.ok(f.objects.has('uslice/A1-vec-dp.json'));
  const applied = await f.run({ apply: true, maxUsers: 1 }); assert.equal(applied.deletes, 1); assert.equal(applied.computed, 0);
  assert.ok(!f.objects.has('uslice/A1-vec-dp.json')); assert.ok(f.objects.has('uslice/A1-r-dp-00.json'));
});
test('유저 데이터 계산 실패는 건너뛰고 뒤 유저 계속·상태 미갱신(다음 회차 재시도)·전역 fetch 복구', async (t) => {
  const f = await fixture(t, ['A1', 'b2', 'c3']); f.objects.set('user/b2.json', '{"date":1,"fail":true}');
  const original = globalThis.fetch;
  const r = await f.run({ apply: true });
  assert.equal(r.failures, 1); assert.equal(r.computed, 2);
  const state = JSON.parse(f.objects.get('meta/uvec-state.json'));
  assert.ok(state.users.A1); assert.ok(!state.users.b2); assert.ok(state.users.c3); assert.equal(globalThis.fetch, original);
  assert.ok(!f.objects.has('uslice/b2-vec-dp.json'));
  assert.equal((await f.run()).targets, 1);
});
test('vec:null은 정상 결과로 게시', async (t) => {
  const f = await fixture(t, ['A1']); f.objects.set('user/A1.json', '{"date":1,"empty":true}');
  await f.run({ apply: true }); assert.equal(JSON.parse(f.objects.get('uslice/A1-vec-dp.json')).vec, null);
});
test('목록·상태 손상·PUT 실패는 완료 상태로 찍지 않는다', async (t) => {
  const f = await fixture(t);
  f.objects.set('meta/uvec-state.json', '{}'); await assert.rejects(f.run({ apply: true }), /상태 형식/); assert.equal(f.calls.writes.length, 0);
  f.objects.delete('meta/uvec-state.json'); f.client.putText = async () => ({ ok: false });
  await assert.rejects(f.run({ apply: true }), /상태 PUT|vec PUT/);
  assert.ok(!f.objects.has('meta/uvec-state.json'));
});
test('목록 이후 user 본문 변경은 중단·완료 없음', async (t) => {
  const f = await fixture(t, ['A1']);
  const list = f.client.listEntries;
  f.client.listEntries = async (prefix) => { const result = await list(prefix); if (prefix === 'uslice/') f.objects.set('user/A1.json', '{"date":2}'); return result; };
  await assert.rejects(f.run({ apply: true }), /목록 이후 입력 변경/);
  assert.ok(!f.objects.has('uslice/A1-vec-dp.json'));
});
test('실제 HTTP 429 Retry-After와 재시도도 요청 간격 보장', async () => {
  const waits = [], calls = []; let n = 0;
  const network = createNetwork(async () => { calls.push(n++); return n === 1 ? new Response('', { status: 429, headers: { 'retry-after': '2' } }) : new Response('ok'); }, async (ms) => { waits.push(ms); });
  assert.equal(await (await network('https://x')).text(), 'ok');
  assert.deepEqual(waits, [250, 2000, 250]); assert.equal(calls.length, 2);
});
test('user-slice 실제 shard DELETE가 vec 키와 다른 유저를 보존', async () => {
  const deleted = [];
  const result = await publishUserSlice('A1', { ok: true, summary: { id: 'A1' }, objects: {} }, {
    listEntries: async () => ['uslice/A1-vec-dp.json', 'uslice/A1-r-dp-00.json', 'uslice/A1-h-sp-15.json', 'uslice/A1-r-dp-99.json', 'uslice/B2-r-dp-00.json'].map((key) => ({ key, etag: 'old' })),
    getText: async () => null, putText: async () => ({ ok: true }), del: async (key) => { deleted.push(key); return true; }, log: silent,
  });
  assert.equal(result.ok, true); assert.deepEqual(deleted, ['uslice/A1-r-dp-00.json', 'uslice/A1-h-sp-15.json']);
});
test('workflow cron만 apply·dispatch dry·독립 concurrency·Node20', async () => {
  const source = await fs.readFile(new URL('../workflows/dump-uvec.yml', import.meta.url), 'utf8');
  assert.match(source, /20,50 \* \* \* \*/); assert.match(source, /group: dump-uvec/);
  assert.match(source, /node-version: 20/); assert.match(source, /github.event_name == 'schedule' && '--apply' \|\| ''/);
});

test('웹 로더가 네트워크 장애를 삼켜도 완료로 게시하지 않는다', async (t) => {
  const f = await fixture(t, ['A1']);
  await fs.writeFile(path.join(f.dir, 'v3/services/uvec-slice.js'), `export async function computeUvecSlice(id) {
    try { await fetch('https://data.iidx.in/data/fail.json'); } catch {}
    return {v:1,id,date:1,arrangeSig:'',vec:null};
  }`);
  await assert.rejects(f.run({ apply: true, fetchImpl: async () => { throw new Error('연결 끊김'); } }), /연결 끊김/);
  assert.ok(!f.objects.has('uslice/A1-vec-dp.json'));
});

test('vec가 이미 없는 탈퇴 유저의 상태도 제거', async (t) => {
  const f = await fixture(t); await f.run({ apply: true });
  f.objects.delete('user/A1.json'); f.objects.delete('uslice/A1-vec-dp.json');
  await f.run({ apply: true });
  assert.ok(!JSON.parse(f.objects.get('meta/uvec-state.json')).users.A1);
});
test('계산 중 전역 fetch 로 들어온 R2 REST 요청은 자산으로 기록하지 않고 그대로 통과', async () => {
  const seen = [], assets = {};
  const network = async (url) => { seen.push(String(url)); return new Response('{}', { status: 200, headers: { etag: '"x"' } }); };
  const f = createSliceFetch({ read: async () => null, network, assets });
  const url = 'https://api.cloudflare.com/client/v4/accounts/a/r2/buckets/b/objects/user%2FA1.json';
  await f(url, { method: 'GET' }); await f(url, { method: 'PUT', body: '{}' });
  assert.deepEqual(seen, [url, url]); assert.deepEqual(assets, {}); assert.equal(f.failures.length, 0);
});

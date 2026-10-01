import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Node에서 Worker 모듈을 로드한다. R2·Cache·Rate Limiting은 모두 로컬 모형이다.
const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const { default: worker } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
function fixture() {
  const calls = { head: [], get: [], limit: [], waits: [] }, stored = new Map(), pending = [];
  const cache = { match: async (req) => stored.get(req.url)?.clone(),
    put: async (req, res) => { stored.set(req.url, res.clone()); }, delete: async (req) => stored.delete(req.url) };
  globalThis.caches = { default: cache };
  const env = { DATA: {
    head: async (key) => { calls.head.push(key); return { httpEtag: '"new"' }; },
    get: async (key) => { calls.get.push(key); return { httpEtag: '"new"', size: 2, arrayBuffer: async () => new TextEncoder().encode('{}').buffer }; },
  }, RL_ENUM: { limit: async ({ key }) => { calls.limit.push(key); return { success: true }; } } };
  const ctx = { waitUntil: (p) => pending.push(p) };
  const fetch = async (key, init = {}) => {
    const res = await worker.fetch(new Request('https://local.invalid/' + key, init), env, ctx);
    await Promise.all(pending.splice(0));
    return res;
  };
  return { calls, cache, env, ctx, fetch };
}
test('계약 키 허용: 요약·r/h·dp/sp·두 자리 NN', async () => {
  const d = fixture();
  for (const key of ['uslice/A1.json', 'uslice/001-r-dp-00.json', 'uslice/A1-r-sp-15.json', 'uslice/A1-h-dp-01.json', 'uslice/A1-h-sp-15.json', 'uslice/A1-r-dp-99.json']) {
    assert.equal((await d.fetch(key)).status, 200, key);
  }
  assert.equal(d.calls.head.length, 6);
});
test('거부 키는 R2·감속 접근 없이 404', async () => {
  const d = fixture();
  for (const key of ['uslice/A_1.json', 'uslice/A-1.json', 'uslice/A1-x-dp-01.json', 'uslice/A1-r-DP-01.json',
    'uslice/A1-r-dp-1.json', 'uslice/A1-r-dp-001.json', 'uslice/A1-r-dp--1.json', 'uslice/A1.json/extra',
    'uslice/A1.txt', 'uslice//A1.json', 'uslice/A1%2Fextra.json', 'uslice/%2e%2e%2Fsecret.json', '__etag/uslice/A1.json']) {
    assert.equal((await d.fetch(key, { headers: { 'CF-Connecting-IP': '127.0.0.1' } })).status, 404, key);
  }
  assert.equal(d.calls.head.length, 0); assert.equal(d.calls.limit.length, 0);
});
test('fresh=1은 uslice 요약·기록·이력의 낡은 ETag 메모를 우회', async () => {
  const d = fixture();
  for (const key of ['uslice/A1.json', 'uslice/A1-r-dp-01.json', 'uslice/A1-h-sp-01.json']) {
    await d.cache.put(new Request('https://local.invalid/__etag/' + key), new Response(JSON.stringify({ etag: '"old"', t: Date.now() })));
    const res = await d.fetch(key + '?fresh=1');
    assert.equal(res.headers.get('etag'), '"new"');
    assert.equal(d.calls.head.at(-1), key);
  }
  assert.equal(d.calls.head.length, 3);
});
test('slice 캐시 HIT도 열거 한도에 포함·공용 songs는 제외', async () => {
  const d = fixture(), init = { headers: { 'CF-Connecting-IP': '127.0.0.1' } };
  await d.fetch('uslice/A1-r-dp-01.json', init);
  assert.equal((await d.fetch('uslice/A1-r-dp-01.json', init)).headers.get('x-ohs-cache'), 'HIT');
  await d.fetch('uslice/A1.json', init); await d.fetch('uslice/A1-h-sp-01.json', init);
  await d.fetch('songs.json', init);
  assert.equal(d.calls.limit.length, 4);
});
test('열거 한도 초과는 기존 10초 대기·IP 및 바인딩 없음은 대기 없음', async () => {
  const d = fixture(), originalTimer = globalThis.setTimeout;
  d.env.RL_ENUM.limit = async () => ({ success: false });
  globalThis.setTimeout = (fn, ms) => { d.calls.waits.push(ms); fn(); return 0; };
  try {
    await d.fetch('uslice/A1-h-dp-01.json', { headers: { 'CF-Connecting-IP': '127.0.0.1' } });
    await d.fetch('uslice/A1.json');
    delete d.env.RL_ENUM;
    await d.fetch('uslice/A1-r-sp-01.json', { headers: { 'CF-Connecting-IP': '127.0.0.1' } });
    assert.deepEqual(d.calls.waits, [10000]);
  } finally { globalThis.setTimeout = originalTimer; }
});

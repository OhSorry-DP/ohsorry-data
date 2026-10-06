import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const { default: worker } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

function fixture() {
  const calls = { head: [], get: [], limit: [] }, stored = new Map(), pending = [];
  const cache = { match: async (req) => stored.get(req.url)?.clone(),
    put: async (req, res) => { stored.set(req.url, res.clone()); }, delete: async (req) => stored.delete(req.url) };
  globalThis.caches = { default: cache };
  const env = { DATA: {
    head: async (key) => { calls.head.push(key); return key === 'chart-graph/missing.json' || key === 'chart-graph/missing.dp_ano.runs.json' ? null : { httpEtag: key.endsWith('.runs.json') ? '"runs-v1"' : '"graph-v1"' }; },
    get: async (key) => { calls.get.push(key); return { httpEtag: key.endsWith('.runs.json') ? '"runs-v1"' : '"graph-v1"', size: 2, arrayBuffer: async () => new TextEncoder().encode('{}').buffer }; },
  }, RL_ENUM: { limit: async ({ key }) => { calls.limit.push(key); return { success: true }; } } };
  const ctx = { waitUntil: (p) => pending.push(p) };
  const fetch = async (key, init = {}) => {
    const req = new Request('https://local.invalid/' + key, init);
    if (key.includes('/../') || key.includes('/%2e%2e/')) {
      Object.defineProperty(req, 'url', { value: 'https://local.invalid/' + key.split('?')[0] });
    }
    const res = await worker.fetch(req, env, ctx);
    await Promise.all(pending.splice(0));
    return res;
  };
  return { calls, cache, fetch };
}

test('chart-graph 공개 JSON GET 정상 및 열거 제한 미적용', async () => {
  const d = fixture();
  const res = await d.fetch('chart-graph/fixture.json', { headers: { 'CF-Connecting-IP': '127.0.0.1' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(res.headers.get('etag'), '"graph-v1"');
  assert.equal(d.calls.head[0], 'chart-graph/fixture.json');
  assert.deepEqual(d.calls.limit, []);
});

test('DP runs GET/HEAD, ETag 및 다섯 난이도 차트 모두 허용', async () => {
  const d = fixture();
  const get = await d.fetch('chart-graph/fixture.dp_ano.runs.json');
  assert.equal(get.status, 200);
  assert.equal(get.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(get.headers.get('etag'), '"runs-v1"');
  assert.equal(get.headers.get('access-control-allow-origin'), '*');
  const head = await d.fetch('chart-graph/fixture.dp_ano.runs.json', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('etag'), '"runs-v1"');
  for (const diff of ['beg', 'nor', 'hyp', 'ano', 'leg']) {
    assert.equal((await d.fetch(`chart-graph/song_1.dp_${diff}.runs.json`)).status, 200, diff);
  }
});

test('DP runs 모드에서 SP, 대문자, 임의 suffix·중간 경로는 거부', async () => {
  const d = fixture();
  for (const key of ['chart-graph/fixture.sp_ano.runs.json', 'chart-graph/Fixture.dp_ano.runs.json',
    'chart-graph/fixture.dp_XXX.runs.json', 'chart-graph/fixture.dp_ano.runs.json.bak',
    'chart-graph/a/b.dp_ano.runs.json']) {
    assert.equal((await d.fetch(key)).status, 404, key);
  }
  assert.deepEqual(d.calls.head, []);
});

test('HEAD, CORS 및 ETag 조건부 캐시 분기 유지', async () => {
  const d = fixture();
  const head = await d.fetch('chart-graph/fixture.json', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('access-control-allow-origin'), '*');
  assert.equal(head.headers.get('content-type'), 'application/json; charset=utf-8');
  const conditional = await d.fetch('chart-graph/fixture.json', { headers: { 'If-None-Match': 'W/"graph-v1"' } });
  assert.equal(conditional.status, 304);
  assert.equal(conditional.headers.get('etag'), '"graph-v1"');
  assert.equal(conditional.headers.get('access-control-allow-origin'), '*');
  assert.equal(d.calls.get.length, 1);
});

test('허용 문법의 prefix더라도 R2에 없는 key는 404', async () => {
  const d = fixture();
  assert.equal((await d.fetch('chart-graph/missing.json')).status, 404);
  assert.deepEqual(d.calls.head, ['chart-graph/missing.json']);
  assert.deepEqual(d.calls.limit, []);
});

test('traversal, 임의 확장자, 하위 경로와 비공개 파일은 R2 조회 전에 거부', async () => {
  const d = fixture();
  for (const key of ['chart-graph/../secret.json', 'chart-graph/%2e%2e/secret.json',
    'chart-graph/fixture.txt', 'chart-graph/a/b.json', 'chart-graph/Chart.json',
    'chart-graph/manifest.json', 'chart-graph/%2e%2e/fixture.dp_ano.runs.json',
    'chart-graph-state.json', 'chart-graph/report.html']) {
    assert.equal((await d.fetch(key)).status, 404, key);
  }
  assert.deepEqual(d.calls.head, []);
  assert.deepEqual(d.calls.get, []);
  // chart-graph 안에서 끝나는 점 경로는 URL 정규화로 정상 공개 key 가 된다 — 그 key 로만 R2 를 읽는다.
  assert.equal((await d.fetch('chart-graph/a/../fixture.dp_ano.runs.json')).status, 200);
  assert.deepEqual(d.calls.get, ['chart-graph/fixture.dp_ano.runs.json']);
});

test('missing runs object 404, CORS 및 bars GET/HEAD 동작은 그대로 유지', async () => {
  const d = fixture();
  assert.equal((await d.fetch('chart-graph/missing.dp_ano.runs.json')).status, 404);
  assert.equal((await d.fetch('chart-graph/fixture.json')).status, 200);
  assert.equal((await d.fetch('chart-graph/fixture.json', { method: 'HEAD' })).status, 200);
});

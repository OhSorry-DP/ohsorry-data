import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const { default: worker } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

function fixture() {
  const calls = { head: [], get: [] }, stored = new Map(), pending = [];
  const cache = {
    match: async (req) => stored.get(req.url)?.clone(),
    put: async (req, res) => { stored.set(req.url, res.clone()); },
    delete: async (req) => stored.delete(req.url),
  };
  globalThis.caches = { default: cache };
  const env = { DATA: {
    head: async (key) => { calls.head.push(key); return { httpEtag: '"new"' }; },
    get: async (key) => {
      calls.get.push(key);
      return { httpEtag: '"new"', size: 2, arrayBuffer: async () => new TextEncoder().encode('{}').buffer };
    },
  } };
  const ctx = { waitUntil: (promise) => pending.push(promise) };
  const fetch = async (path, init = {}) => {
    const response = await worker.fetch(new Request('https://local.invalid/' + path, init), env, ctx);
    await Promise.all(pending.splice(0));
    return response;
  };
  return { calls, fetch };
}

test('sp-phys-cdn/1 — AC ID 공개 허용', async () => {
  const d = fixture();
  assert.equal((await d.fetch('phys/user-sp/12345678.json')).status, 200);
  assert.deepEqual(d.calls.get, ['phys/user-sp/12345678.json']);
});

test('sp-phys-cdn/2 — INF ID 공개 허용', async () => {
  const d = fixture();
  assert.equal((await d.fetch('phys/user-sp/A123456789012.json')).status, 200);
  assert.deepEqual(d.calls.get, ['phys/user-sp/A123456789012.json']);
});

test('sp-phys-cdn/3 — 소문자·잘못된 길이·하이픈 ID 거부', async () => {
  const d = fixture();
  for (const id of ['a123456789012', '1234567', '123456789', 'A12345678901', 'A1234567890123', '1234-5678']) {
    assert.equal((await d.fetch(`phys/user-sp/${id}.json`)).status, 404, id);
  }
  assert.equal(d.calls.head.length, 0);
  assert.equal(d.calls.get.length, 0);
});

test('sp-phys-cdn/4 — traversal 및 encoded slash 거부', async () => {
  const d = fixture();
  for (const path of ['phys/user-sp/%2e%2e%2Fsecret.json', 'phys/user-sp/12345678%2Fextra.json', 'phys/user-sp/12345678.json/extra']) {
    assert.equal((await d.fetch(path)).status, 404, path);
  }
  assert.equal(d.calls.head.length, 0);
  assert.equal(d.calls.get.length, 0);
});

test('sp-phys-cdn/5 — 기존 ETag 조건부 요청은 304', async () => {
  const d = fixture();
  const first = await d.fetch('phys/user-sp/12345678.json');
  assert.equal(first.status, 200);
  assert.equal((await d.fetch('phys/user-sp/12345678.json', { headers: { 'if-none-match': 'W/"new"' } })).status, 304);
  assert.equal(d.calls.get.length, 1);
});

test('sp-phys-cdn/6 — DP 공개 경로와 기존 응답 정책 유지', async () => {
  const d = fixture();
  const response = await d.fetch('phys/user/12345678.json');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('etag'), '"new"');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=60, s-maxage=31536000');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.deepEqual(d.calls.get, ['phys/user/12345678.json']);
});

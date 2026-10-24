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
  }, RL_ENUM: { limit: async ({ key }) => { calls.limit.push(key); return { success: false }; } } };
  const ctx = { waitUntil: (p) => pending.push(p) };
  const fetch = async (key, init = {}) => {
    const res = await worker.fetch(new Request('https://local.invalid/' + key, init), env, ctx);
    await Promise.all(pending.splice(0));
    return res;
  };
  return { calls, cache, env, fetch };
}

test('RL_ENUM 거부 상태에서도 pending/{id}.json은 대기 없이 처리', async () => {
  const d = fixture(), originalTimer = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => { d.calls.waits.push(ms); fn(); return 0; };
  try {
    const response = await d.fetch('pending/abc123.json', { headers: { 'CF-Connecting-IP': '127.0.0.1' } });
    assert.equal(response.status, 200);
    assert.deepEqual(d.calls.limit, []);
    assert.deepEqual(d.calls.waits, []);
    assert.deepEqual(d.calls.head, ['pending/abc123.json']);
    assert.deepEqual(d.calls.get, ['pending/abc123.json']);
  } finally { globalThis.setTimeout = originalTimer; }
});

test('같은 RL_ENUM 거부 상태에서 pending fresh는 메모를 우회해 기존 R2 경로로 처리', async () => {
  const d = fixture(), key = 'pending/abc123.json', originalTimer = globalThis.setTimeout;
  await d.cache.put(new Request('https://local.invalid/__etag/' + key), new Response(JSON.stringify({ etag: '"old"', t: Date.now() })));
  globalThis.setTimeout = (fn, ms) => { d.calls.waits.push(ms); fn(); return 0; };
  try {
    const response = await d.fetch(key + '?fresh=1', { headers: { 'CF-Connecting-IP': '127.0.0.1' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('etag'), '"new"');
    assert.deepEqual(d.calls.limit, []);
    assert.deepEqual(d.calls.waits, []);
    assert.deepEqual(d.calls.head, [key]);
    assert.deepEqual(d.calls.get, [key]);
  } finally { globalThis.setTimeout = originalTimer; }
});

test('같은 RL_ENUM 거부 상태에서 user 요청은 기존 열거 대기를 유지', async () => {
  const d = fixture(), originalTimer = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => { d.calls.waits.push(ms); fn(); return 0; };
  try {
    const response = await d.fetch('user/abc123.json', { headers: { 'CF-Connecting-IP': '127.0.0.1' } });
    assert.equal(response.status, 200);
    assert.deepEqual(d.calls.limit, ['127.0.0.1']);
    assert.deepEqual(d.calls.waits, [10000]);
    assert.deepEqual(d.calls.head, ['user/abc123.json']);
    assert.deepEqual(d.calls.get, ['user/abc123.json']);
  } finally { globalThis.setTimeout = originalTimer; }
});

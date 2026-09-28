import test from 'node:test';
import assert from 'node:assert/strict';

const account = 'test-account';
process.env.CLOUDFLARE_ACCOUNT_ID = account;
process.env.CLOUDFLARE_API_TOKEN = 'test-token';

const { getText, list } = await import(`./r2-client.mjs?test=${Date.now()}`);
const base = `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/ohsorry-data/objects`;
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('list URL and cursor pagination', async () => {
  const urls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return urls.length === 1
      ? response({ result: [{ key: 'a' }], result_info: { cursor: 'C1' } })
      : response({ result: [{ key: 'b' }] });
  };
  try { assert.deepEqual(await list('ranking-state/dirty/'), ['a', 'b']); }
  finally { globalThis.fetch = originalFetch; }
  assert.equal(urls.length, 2);
  assert.equal(urls[0], `${base}?prefix=ranking-state%2Fdirty%2F&per_page=1000`);
  assert.equal(urls[0].includes('/objects/?'), false);
  assert.equal(urls[1], `${base}?prefix=ranking-state%2Fdirty%2F&per_page=1000&cursor=C1`);
});

test('list throws for 404', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => response({}, 404);
  try { await assert.rejects(list('ranking-state/dirty/'), /HTTP 404/); }
  finally { globalThis.fetch = originalFetch; }
});

test('getText keeps the single-object URL', async () => {
  const urls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { urls.push(String(url)); return new Response('hello'); };
  try { assert.equal(await getText('user/1.json'), 'hello'); }
  finally { globalThis.fetch = originalFetch; }
  assert.equal(urls[0], `${base}/user/1.json`);
});

import test from 'node:test';
import assert from 'node:assert/strict';

const account = 'test-account';
process.env.CLOUDFLARE_ACCOUNT_ID = account;
process.env.CLOUDFLARE_API_TOKEN = 'test-token';

const { getText, list, listEntries, conditionalR2Client, s3R2Client } = await import(`./r2-client.mjs?test=${Date.now()}`);
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

test('listEntries returns key and etag with the same list URL', async () => {
  const urls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { urls.push(String(url)); return response({ result: [{ key: 'a', etag: 'abc' }] }); };
  try { assert.deepEqual(await listEntries('ranking/'), [{ key: 'a', etag: 'abc' }]); }
  finally { globalThis.fetch = originalFetch; }
  assert.equal(urls[0], `${base}?prefix=ranking%2F&per_page=1000`);
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

test('채보 키의 리터럴 퍼센트는 HTTP 경로에서 한 번 더 인코딩한다', async () => {
  const key = `phys/chart/phys-line-v1/${encodeURIComponent('仮想|ANOTHER')}.json`;
  const urls = [];
  const client = conditionalR2Client({ account, token: 'test-token', fetchImpl: async url => {
    urls.push(String(url)); return new Response('{}', { headers: { etag: '"test-etag"' } });
  } });
  assert.equal((await client.read(key)).body, '{}');
  assert.equal(urls[0], `${base}/${key.split('/').map(encodeURIComponent).join('/')}`);
  assert.equal(decodeURIComponent(new URL(urls[0]).pathname.split('/objects/')[1]), key);
  assert.ok(urls[0].includes('%25E4'));
  assert.ok(urls[0].includes('%257C'));
});

const crypto = await import('node:crypto');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => crypto.createHmac('sha256', key).update(value, 'utf8').digest();
const fixedNow = Date.UTC(2026, 0, 2, 3, 4, 5);
const s3Options = (extra = {}) => ({ account, accessKeyId: 'test-access', secretAccessKey: 'test-secret', now: () => fixedNow, fetchImpl: async () => { throw new Error('unexpected real fetch'); }, ...extra });
function expectedSignature({ method, path, query = '', headers, payloadHash }) {
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map(name => `${name}:${headers[name].trim().replace(/\s+/g, ' ')}\n`).join('');
  const canonical = [method, path, query, canonicalHeaders, names.join(';'), payloadHash].join('\n');
  const scope = '20260102/auto/s3/aws4_request';
  const stringToSign = `AWS4-HMAC-SHA256\n20260102T030405Z\n${scope}\n${sha256(Buffer.from(canonical, 'utf8'))}`;
  const kd = hmac(Buffer.from('AWS4test-secret'), '20260102');
  const kr = hmac(kd, 'auto');
  const ks = hmac(hmac(kr, 's3'), 'aws4_request');
  return crypto.createHmac('sha256', ks).update(stringToSign).digest('hex');
}
async function captureS3(key, init, options = {}) {
  let captured;
  const client = s3R2Client(s3Options({ fetchImpl: async (url, requestOptions) => { captured = new Request(url, requestOptions); return new Response(''); }, ...options }));
  await client.request(key, init);
  return captured;
}

test('S3 GET uses the exact endpoint and independently verifiable SigV4 headers', async () => {
  const req = await captureS3('data/feature-scores-slim.json', { method: 'GET' });
  assert.equal(req.url, 'https://test-account.r2.cloudflarestorage.com/ohsorry-data/data/feature-scores-slim.json');
  assert.equal(req.method, 'GET');
  const headers = Object.fromEntries(req.headers.entries());
  assert.match(headers.authorization, /^AWS4-HMAC-SHA256 Credential=test-access\/20260102\/auto\/s3\/aws4_request, SignedHeaders=[^,]+, Signature=[0-9a-f]{64}$/);
  assert.equal(headers['x-amz-date'], '20260102T030405Z');
  assert.equal(headers['x-amz-content-sha256'], sha256(Buffer.alloc(0)));
  const canonicalHeaders = { host: 'test-account.r2.cloudflarestorage.com', 'x-amz-content-sha256': headers['x-amz-content-sha256'], 'x-amz-date': headers['x-amz-date'], 'accept-encoding': 'identity' };
  assert.equal(headers.authorization.match(/Signature=([0-9a-f]{64})$/)[1], expectedSignature({ method: 'GET', path: '/ohsorry-data/data/feature-scores-slim.json', headers: canonicalHeaders, payloadHash: headers['x-amz-content-sha256'] }));
});

test('S3 PUT preserves UTF-8 bytes and signs exact key and payload', async () => {
  const body = Buffer.from('{"曲":"こんにちは"}', 'utf8');
  const req = await captureS3('data/song-features-dp-61.json', { method: 'PUT', headers: { 'content-type': 'application/json; charset=utf-8' }, body });
  assert.equal(req.url, 'https://test-account.r2.cloudflarestorage.com/ohsorry-data/data/song-features-dp-61.json');
  assert.equal(req.method, 'PUT');
  assert.deepEqual(Buffer.from(await req.arrayBuffer()), body);
  assert.equal(req.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(req.headers.get('x-amz-content-sha256'), sha256(body));
  const headers = Object.fromEntries(req.headers.entries());
  const canonicalHeaders = { host: 'test-account.r2.cloudflarestorage.com', 'content-type': 'application/json; charset=utf-8', 'x-amz-content-sha256': headers['x-amz-content-sha256'], 'x-amz-date': headers['x-amz-date'] };
  assert.equal(headers.authorization.match(/Signature=([0-9a-f]{64})$/)[1], expectedSignature({ method: 'PUT', path: '/ohsorry-data/data/song-features-dp-61.json', headers: canonicalHeaders, payloadHash: headers['x-amz-content-sha256'] }));
  const encoded = await captureS3('data/曲 +.json', { method: 'GET' });
  assert.equal(new URL(encoded.url).pathname, '/ohsorry-data/data/%E6%9B%B2%20%2B.json');
});

test('S3 list parses two XML pages and signs encoded continuation token query', async () => {
  const requests = [];
  const pages = [
    '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>next+/=</NextContinuationToken><Contents><Key>data/song-features-a&amp;b.json</Key><ETag>&quot;abc&quot;</ETag></Contents></ListBucketResult>',
    '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>data/song-features-曲.json</Key><ETag>&quot;def&quot;</ETag></Contents></ListBucketResult>',
  ];
  const client = s3R2Client(s3Options({ fetchImpl: async (url, init) => { requests.push(new Request(url, init)); return new Response(pages.shift()); } }));
  assert.deepEqual([...await client.list()], [['data/song-features-a&b.json', '"abc"'], ['data/song-features-曲.json', '"def"']]);
  assert.equal(requests.length, 2);
  for (const req of requests) { assert.equal(req.method, 'GET'); assert.match(req.headers.get('authorization'), /^AWS4-HMAC-SHA256 .*Signature=[0-9a-f]{64}$/); }
  const second = new URL(requests[1].url);
  assert.equal(second.searchParams.get('continuation-token'), 'next+/=');
  assert.ok(requests[1].url.includes('continuation-token=next%2B%2F%3D'));
  const hs = Object.fromEntries(requests[1].headers.entries());
  const query = [...second.searchParams].map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)]).sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv)).map(([k, v]) => `${k}=${v}`).join('&');
  assert.equal(hs.authorization.match(/Signature=([0-9a-f]{64})$/)[1], expectedSignature({ method: 'GET', path: '/ohsorry-data', query, headers: { host: second.host, 'x-amz-content-sha256': hs['x-amz-content-sha256'], 'x-amz-date': hs['x-amz-date'], 'accept-encoding': 'identity' }, payloadHash: hs['x-amz-content-sha256'] }));
});

test('S3 list accepts empty XML and rejects malformed, out-of-prefix, truncated, repeated-token, and 403 responses', async () => {
  const run = (xml, status = 200) => s3R2Client(s3Options({ fetchImpl: async () => new Response(xml, { status }) })).list();
  assert.equal((await run('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>')).size, 0);
  for (const xml of ['<broken>', '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>other</Key><ETag>"e"</ETag></Contents></ListBucketResult>', '<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>']) await assert.rejects(run(xml));
  const repeated = s3R2Client(s3Options({ fetchImpl: async () => new Response('<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>x</NextContinuationToken></ListBucketResult>') }));
  await assert.rejects(repeated.list(), /반복/);
  await assert.rejects(run('', 403), /403/);
});

test('S3 retries use fake time for 429 numeric, date, fallback, 503, and network exhaustion', async () => {
  let time = fixedNow; const sleeps = [];
  const sleep = async ms => { sleeps.push(ms); time += ms; };
  const now = () => time;
  for (const [retryAfter, expected] of [['2', 2000], ['date', 3000], [null, 2000]]) {
    let calls = 0;
    const header = retryAfter === 'date' ? new Date(time + expected).toUTCString() : retryAfter;
    const client = s3R2Client(s3Options({ now, sleep, retries: 1, fetchImpl: async () => ++calls === 1 ? new Response('', { status: 429, headers: header ? { 'retry-after': header } : {} }) : new Response('') }));
    assert.equal((await client.request('data/x', { method: 'GET' })).status, 200);
    assert.equal(sleeps.at(-1), expected);
  }
  let calls = 0;
  const client = s3R2Client(s3Options({ now, sleep, retries: 2, fetchImpl: async () => ++calls <= 2 ? new Response('', { status: 503 }) : new Response('') }));
  assert.equal((await client.request('data/x', { method: 'GET' })).status, 200);
  assert.equal(calls, 3);
  calls = 0;
  const failing = s3R2Client(s3Options({ now, sleep, retries: 1, fetchImpl: async () => { calls++; throw new Error('offline'); } }));
  await assert.rejects(failing.request('data/x'), /offline/);
  assert.equal(calls, 2);
  let gateCalls = 0;
  const shared = s3R2Client(s3Options({ now, sleep, fetchImpl: async () => ++gateCalls === 1 ? new Response('', { status: 429, headers: { 'retry-after': '1' } }) : new Response('') }));
  await Promise.all([shared.request('data/a'), shared.request('data/b')]);
  assert.equal(gateCalls, 3);
});

test('S3 missing credentials fail before fetch and parallel GETs have no REST spacing', async () => {
  let calls = 0;
  assert.throws(() => s3R2Client({ account, fetchImpl: async () => { calls++; } }), /access key/);
  assert.equal(calls, 0);
  let time = 0; const starts = [];
  const client = s3R2Client(s3Options({ now: () => time, sleep: async ms => { time += ms; }, fetchImpl: async () => { starts.push(time); return new Response(''); } }));
  await Promise.all([client.request('data/a'), client.request('data/b')]);
  assert.equal(starts.length, 2);
  assert.equal(Math.abs(starts[0] - starts[1]), 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

class FakeAwsClient {
  constructor(config) { this.config = config; }
  async sign(input, init) { return new Request(input, { ...init, headers: init.headers }); }
}

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'aws4fetch') return { url: 'test:aws4fetch', shortCircuit: true };
  return nextResolve(specifier, context);
}, load(url, context, nextLoad) {
  if (url === 'test:aws4fetch') return { format: 'module', shortCircuit: true, source: `export const AwsClient = ${FakeAwsClient.toString()};` };
  return nextLoad(url, context);
} });

const source = new URL('../../supabase/functions/_shared/r2-s3.ts', import.meta.url);
const { createR2S3Adapter, R2S3HttpError, R2S3TransportError } = await import(source.href);

const adapter = (fetchImpl, extra = {}) => createR2S3Adapter({ accountId: 'acct', accessKeyId: 'key', secretAccessKey: 'secret', bucket: 'bucket space', fetchImpl, ...extra }, FakeAwsClient);

test('GET path encoding, bytes, status, and quoted ETag are preserved', async () => {
  let request;
  const client = adapter(async req => { request = req; return new Response(new Uint8Array([0, 255, 2]), { status: 200, headers: { etag: '"opaque-tag"' } }); });
  const result = await client.get('dir/a b%?#.bin');
  assert.equal(new URL(request.url).pathname, '/bucket%20space/dir/a%20b%25%3F%23.bin');
  assert.deepEqual([...result.value], [0, 255, 2]);
  assert.equal(result.status, 200);
  assert.equal(result.etag, '"opaque-tag"');
});

test('PUT forwards body and conditional headers unchanged', async () => {
  let request;
  const client = adapter(async req => { request = req; return new Response(null, { status: 200, headers: { etag: '"new"' } }); });
  const result = await client.put('object', new Uint8Array([1, 2, 3]), { ifMatch: '"old"', ifNoneMatch: '*' });
  assert.deepEqual([...new Uint8Array(await request.arrayBuffer())], [1, 2, 3]);
  assert.equal(request.headers.get('if-match'), '"old"');
  assert.equal(request.headers.get('if-none-match'), '*');
  assert.equal(result.etag, '"new"');
});

test('404 and 412 remain distinct HTTP errors', async () => {
  for (const status of [404, 412]) {
    const client = adapter(async () => new Response('', { status }));
    await assert.rejects(client.get('x'), error => error instanceof R2S3HttpError && error.status === status);
  }
});

test('timeout and transport errors surface, with PUT outcome marked unknown', async () => {
  const timed = adapter(req => new Promise((resolve, reject) => req.signal.addEventListener('abort', () => reject(req.signal.reason))), { timeoutMs: 5 });
  await assert.rejects(timed.get('x'), error => error instanceof R2S3TransportError);
  const failed = adapter(async () => { throw new Error('offline'); });
  await assert.rejects(failed.put('x', new Uint8Array([1])), error => error instanceof R2S3TransportError && error.outcomeUnknown);
});

test('exactly one request is made per call and attempt is observable', async () => {
  let calls = 0;
  const observed = [];
  const client = adapter(async () => { calls++; return new Response(null, { status: 200 }); }, { onRequest: e => observed.push(e) });
  await client.head('x');
  assert.equal(calls, 1);
  assert.deepEqual(observed, [{ operation: 'HEAD', attempt: 1 }]);
});

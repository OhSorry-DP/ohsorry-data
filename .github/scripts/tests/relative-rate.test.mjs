import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cdnEtag, conditionalR2Client, createRequestGate, md5 } from '../r2-client.mjs';

function fakeClock() {
  let time = 0;
  return { now: () => time, sleep: async ms => { time += ms; }, advance: ms => { time += ms; } };
}
function response(status = 200, body = '', headers = {}) {
  return new Response(body, { status, headers });
}

test('8 concurrent requests start at least 500ms apart', async () => {
  const clock = fakeClock(); const starts = [];
  const gate = createRequestGate({ intervalMs: 500, now: clock.now, sleep: clock.sleep });
  const client = conditionalR2Client({ account: 'a', token: 'secret', requestGate: gate,
    fetchImpl: async () => { starts.push(clock.now()); return response(200, JSON.stringify({ result: [] }), { 'content-type': 'application/json' }); } });
  await Promise.all(Array.from({ length: 8 }, (_, i) => client.listEntries(`p${i}`)));
  assert.equal(starts.length, 8);
  assert.deepEqual(starts.slice(1).map((time, i) => time - starts[i]), Array(7).fill(500));
});

test('GET, HEAD, and PUT use the same request gate', async () => {
  const clock = fakeClock(); const starts = [];
  const gate = createRequestGate({ intervalMs: 500, now: clock.now, sleep: clock.sleep });
  const client = conditionalR2Client({ account: 'a', token: 'secret', requestGate: gate,
    fetchImpl: async (url, init) => {
      starts.push([init.method, clock.now()]);
      if (url.includes('?prefix=')) return response(200, JSON.stringify({ result: [{ key: 'coach/relative/current.json', etag: md5('{}') }] }));
      if (init.method === 'PUT') return response(200);
      return response(200, '{}', { etag: '"strong"' });
    } });
  await Promise.all([
    client.read('coach/relative/current.json'),
    cdnEtag('asset', { requestGate: gate, fetchImpl: async (_url, init) => { starts.push([init.method, clock.now()]); return response(200, '', { etag: '"x"' }); } }),
    client.put('coach/relative/current.json', '{}', '"strong"'),
  ]);
  assert.deepEqual(starts.map(([method]) => method), ['GET', 'HEAD', 'PUT', 'GET']);
  assert.deepEqual(starts.map(([, time]) => time), [0, 500, 1000, 1500]);
});

test('429 Retry-After delays retry and subsequent request starts', async () => {
  const clock = fakeClock(); const starts = []; let calls = 0;
  const gate = createRequestGate({ intervalMs: 500, now: clock.now, sleep: clock.sleep });
  const client = conditionalR2Client({ account: 'a', token: 'secret', requestGate: gate,
    fetchImpl: async () => { starts.push(clock.now()); if (++calls === 1) return response(429, '', { 'retry-after': '2' }); return response(200, JSON.stringify({ result: [] })); } });
  await client.listEntries('one'); await client.listEntries('two');
  assert.deepEqual(starts, [0, 2000, 2500]);
});

test('rate limiting is disabled by default', async () => {
  const starts = [];
  const client = conditionalR2Client({ account: 'a', token: 'secret', fetchImpl: async () => {
    starts.push(Date.now()); return response(200, JSON.stringify({ result: [] }));
  } });
  await Promise.all(Array.from({ length: 8 }, (_, i) => client.listEntries(`p${i}`)));
  assert.equal(starts.length, 8);
  assert.ok(Math.max(...starts) - Math.min(...starts) < 500);
});

test('a failed attempt releases the queue for retry and later work', async () => {
  const clock = fakeClock(); const starts = []; let failed = false;
  const gate = createRequestGate({ intervalMs: 500, now: clock.now, sleep: clock.sleep });
  const client = conditionalR2Client({ account: 'a', token: 'secret', requestGate: gate,
    fetchImpl: async () => { starts.push(clock.now()); if (!failed) { failed = true; throw new Error('fixture'); } return response(200, JSON.stringify({ result: [] })); } });
  await assert.rejects(client.listEntries('first'), /fixture/);
  await Promise.all([client.listEntries('retry'), client.listEntries('next')]);
  assert.deepEqual(starts, [0, 500, 1000]);
});

test('relative workflow injects 2req/s and preserves the daily 03:05 cron', () => {
  const workflow = fs.readFileSync(new URL('../../workflows/dump-users-list.yml', import.meta.url), 'utf8');
  assert.match(workflow, /cron: '5 18 \* \* \*'.*UTC 18:05 = KST 03:05/);
  assert.match(workflow, /cron: '\*\/30 \* \* \* \*'/);
  assert.match(workflow, /args=\(.*--request-rate 2\)/);
  assert.match(workflow, /github\.event\.schedule/);
});

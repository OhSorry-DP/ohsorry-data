import test from 'node:test';
import assert from 'node:assert/strict';
import { listEntries } from './r2-client.mjs';

test('429는 Retry-After(상한 60초)를 따르고 없으면 종전 백오프', async () => {
  for (const [header, expected] of [['2', 2000], ['600', 60000], [null, 500], ['invalid', 500]]) {
    let requests = 0;
    const waits = [];
    const entries = await listEntries('uslice/A1-', { token: 'test',
      sleep: async (ms) => waits.push(ms),
      fetchImpl: async () => ++requests === 1
        ? new Response('', { status: 429, headers: header === null ? {} : { 'retry-after': header } })
        : new Response(JSON.stringify({ result: [] })),
    });
    assert.deepEqual(entries, []); assert.equal(requests, 2); assert.deepEqual(waits, [expected]);
  }
});
test('429 반복은 최대 4회 후 실패이며 성공으로 보고하지 않는다', async () => {
  let requests = 0;
  const waits = [];
  await assert.rejects(listEntries('uslice/A1-', { token: 'test', sleep: async (ms) => waits.push(ms),
    fetchImpl: async () => { requests++; return new Response('', { status: 429 }); } }), /HTTP 429/);
  assert.equal(requests, 4); assert.deepEqual(waits, [500, 2000, 4500]);
});

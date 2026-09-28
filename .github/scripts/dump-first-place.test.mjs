import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllFirstPlace, parseContentRangeTotal, toOutput, validateRows } from './dump-first-place.mjs';

test('Content-Range 총수 파싱', () => assert.equal(parseContentRangeTotal('0-999/7234'), 7234));
test('RPC POST init 검증', async () => {
  process.env.SUPABASE_URL = 'https://example.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'key';
  let init;
  await assert.rejects(() => fetchAllFirstPlace(async (_url, requestInit) => {
    init = requestInit;
    return { ok: true, headers: new Headers({ 'Content-Range': '0-0/0' }), json: async () => [] };
  }));
  assert.equal(init.method, 'POST');
  assert.equal(init.body, '{}');
  assert.equal(init.headers['Content-Type'], 'application/json');
});
test('모든 페이지 URL에 정렬 순서가 포함됨', async () => {
  const urls = [];
  let page = 0;
  await fetchAllFirstPlace(async (url) => {
    urls.push(url);
    page += 1;
    return {
      ok: true,
      headers: new Headers({ 'Content-Range': page === 1 ? '0-999/1001' : '1000-1000/1001' }),
      json: async () => page === 1
        ? Array.from({ length: 1000 }, (_, i) => ({ song_id: i + 1, diff: 1, iidx_id: `u${i}` }))
        : [{ song_id: 1001, diff: 1, iidx_id: 'u1000' }],
    };
  });
  assert.ok(urls.length > 0);
  assert.ok(urls.every((url) => new URL(url).searchParams.get('order') === 'song_id.asc,diff.asc'));
});
test('Content-Range 총수 불일치 거부', async () => {
  await assert.rejects(() => fetchAllFirstPlace(async () => ({
    ok: true, headers: new Headers({ 'Content-Range': '0-0/2' }), json: async () => [{ song_id: 1, diff: 1, iidx_id: 'a' }],
  })), /행 수 불일치/);
});
test('여러 페이지 수집 후 총수 일치', async () => {
  let page = 0;
  const result = await fetchAllFirstPlace(async () => ({
    ok: true, headers: new Headers({ 'Content-Range': '0-999/1234' }),
    json: async () => page++ === 0
      ? Array.from({ length: 1000 }, (_, i) => ({ song_id: i + 10, diff: 1, iidx_id: `u${i}` }))
      : Array.from({ length: 234 }, (_, i) => ({ song_id: i + 1010, diff: 1, iidx_id: `u${i + 1000}` })),
  }));
  assert.equal(result.length, 1234);
});

const rows = [
  { song_id: 2, diff: 3, iidx_id: 'z' },
  { song_id: 1, diff: 2, iidx_id: 'a' },
  { song_id: 1, diff: 1, iidx_id: 'a' },
];

test('정상 변환', () => assert.deepEqual(toOutput(rows, '2026-01-01T00:00:00.000Z'), {
  _v: '2026-01-01T00:00:00.000Z', n: 3, w: { a: [[1, 1], [1, 2]], z: [[2, 3]] },
}));
test('0행 거부', () => assert.throws(() => validateRows([])));
test('중복 거부', () => assert.throws(() => validateRows([...rows, rows[0]])));
test('필드 불량 거부', () => assert.throws(() => validateRows([{ song_id: '1', diff: 1, iidx_id: 'a' }])));
test('결정적 순서', () => assert.equal(JSON.stringify(toOutput(rows, 'x')), JSON.stringify(toOutput([rows[2], rows[0], rows[1]], 'x'))));

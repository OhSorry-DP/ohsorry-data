import test from 'node:test';
import assert from 'node:assert/strict';
import { exitCodeForResult, run, serializeRows } from './dump-chart-rankings.mjs';
import { md5 } from './r2-client.mjs';

const row = (rank, id = 'p') => ({ rank, iidx_id: id, ex_score: 100 });
function deps(extra = {}) { const calls = { put: [], del: [], rpc: [], entries: 0 }; return { calls, rpc: async (s, d) => { calls.rpc.push([s, d]); return [row(2), row(1, 'a')]; }, getText: async () => JSON.stringify({ charts: [[2, 3], [1, 2]] }), list: async (p) => p.startsWith('ranking-state') ? ['ranking-state/dirty/x.json'] : [], listEntries: async () => { calls.entries++; return []; }, putText: async (...x) => { calls.put.push(x); return { ok: true }; }, del: async (k) => { calls.del.push(k); return true; }, ...extra }; }
test('결정적 직렬화', () => assert.equal(serializeRows([row(2), row(1, 'a')]), serializeRows([row(1, 'a'), row(2)])));
test('마커 합집합과 중복 제거', async () => { const d = deps({ getText: async () => JSON.stringify({ charts: [[1, 2], [2, 3], [1, 2]] }) }); const r = await run(d); assert.equal(r.charts.length, 2); });
test('파싱 실패 마커는 삭제 제외', async () => { const d = deps({ getText: async () => '{' }); const r = await run(d); assert.deepEqual(r.deletedMarkers, []); assert.deepEqual(d.calls.del, []); });
test('실패 시 마커 보존', async () => { const d = deps({ rpc: async () => { throw new Error('x'); } }); const r = await run(d); assert.equal(r.failures, 2); assert.deepEqual(d.calls.del, []); });
test('0행은 삭제, 행은 PUT', async () => { let n = 0; const d = deps({ rpc: async () => n++ ? [row(1)] : [] }); await run(d); assert.equal(d.calls.put.length, 1); assert.equal(d.calls.del.filter((x) => x.startsWith('ranking/')).length, 1); });
test('--all은 winners/ranking/marker 합집합', async () => { let entriesCalls = 0; const d = deps({ getText: async (k) => k === 'first-place-winners.json' ? JSON.stringify({ w: { x: [[9, 9]] } }) : JSON.stringify({ charts: [[1, 2]] }), list: async (p) => p === 'ranking-state/dirty/' ? ['m'] : [], listEntries: async () => { entriesCalls++; return [{ key: 'ranking/3-4.json', etag: 'other' }]; } }); const r = await run({ ...d, all: true }); assert.deepEqual(r.charts.map(String), ['1,2', '3,4', '9,9']); assert.equal(entriesCalls, 1); });
test('실패가 있으면 main 판정은 exitCode 1', () => {
  assert.equal(exitCodeForResult({ failures: 1 }), 1);
  assert.equal(exitCodeForResult({ failures: 0 }), 0);
});
test('마커 getText가 null이면 삭제 목록에 넣지 않는다', async () => {
  const d = deps({ getText: async () => null });
  const r = await run(d);
  assert.deepEqual(r.deletedMarkers, []);
  assert.deepEqual(d.calls.del, []);
});
test('putText가 실패하면 차트 실패로 집계하고 마커를 지우지 않는다', async () => {
  const d = deps({ putText: async () => ({ ok: false, msg: 'x' }) });
  const r = await run(d);
  assert.equal(r.failures, 2);
  assert.deepEqual(d.calls.del, []);
});
test('원격 etag가 md5와 같으면 PUT 없이 skip', async () => { const rows = [row(1, 'fox')]; const body = serializeRows(rows); const d = deps({ getText: async () => JSON.stringify({ charts: [[1, 2]] }), rpc: async () => rows, listEntries: async () => [{ key: 'ranking/1-2.json', etag: md5(body) }] }); const r = await run(d); assert.equal(r.skips, 1); assert.equal(d.calls.put.length, 0); });
test('원격 etag가 다르거나 없으면 PUT', async () => { for (const etag of ['different', undefined]) { const d = deps({ listEntries: async () => [{ key: 'ranking/2-3.json', etag }] }); const r = await run(d); assert.equal(r.puts, 2); assert.equal(d.calls.put.length, 2); } });
test('listEntries 실패 시 마커를 삭제하지 않음', async () => { const d = deps({ listEntries: async () => { throw new Error('list failed'); } }); await assert.rejects(run(d)); assert.deepEqual(d.calls.del, []); });

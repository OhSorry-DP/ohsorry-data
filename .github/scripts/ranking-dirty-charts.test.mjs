import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDirtyCharts } from './ranking-dirty-charts.mjs';
const row = (song_id, diff, ex_score, played_version = 1, extra = {}) => ({ song_id, diff, ex_score, played_version, date: '2026-01-01', lamp: 'A', bp: 1, ...extra });
const calc = (prev, dp, extra = {}) => computeDirtyCharts({ prevOk: true, prev: { user: { dj_name: 'A' }, dp: prev }, user: { dj_name: 'A' }, dp, ...extra });
test('dirty chart 판정', async (t) => {
  await t.test('동일', () => assert.deepEqual(calc([row(1, 2, 100)], [row(1, 2, 100)]), []));
  await t.test('EX 향상', () => assert.deepEqual(calc([row(1, 2, 100), row(2, 1, 50)], [row(1, 2, 101), row(2, 1, 50)]), [[1, 2]]));
  await t.test('과거 date도 검출', () => assert.deepEqual(calc([row(1, 2, 100)], [row(1, 2, 101, 1, { date: '2020-01-01' })]), [[1, 2]]));
  await t.test('차트 추가·삭제', () => assert.deepEqual(calc([row(1, 2, 100)], [row(2, 1, 50)]), [[1, 2], [2, 1]]));
  await t.test('played_version 변경', () => assert.deepEqual(calc([row(1, 2, 100, 1)], [row(1, 2, 100, 2)]), [[1, 2]]));
  await t.test('prevOk=false 합집합', () => assert.deepEqual(calc([row(1, 2, 100), row(3, 1, 70)], [row(1, 2, 100), row(3, 1, 70)], { prevOk: false }), [[1, 2], [3, 1]]));
  await t.test('신규 유저', () => assert.deepEqual(computeDirtyCharts({ prevOk: true, prev: null, user: { dj_name: 'A' }, dp: [row(2, 1, 50), row(1, 2, 100)] }), [[1, 2], [2, 1]]));
  await t.test('dj_name 변경', () => assert.deepEqual(computeDirtyCharts({ prevOk: true, prev: { user: { dj_name: 'A' }, dp: [row(1, 2, 100), row(3, 1, 70)] }, user: { dj_name: 'B' }, dp: [row(1, 2, 100), row(3, 1, 70)] }), [[1, 2], [3, 1]]));
  await t.test('DBR 무시', () => assert.deepEqual(calc([row(1, 2, 100, -10)], [row(1, 2, 200, -10)]), []));
  await t.test('lamp·bp·date 변경 무시', () => assert.deepEqual(calc([row(1, 2, 100)], [row(1, 2, 100, 1, { lamp: 'AAA', bp: 9, date: '2020-01-01' })]), []));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeScoreHistory } from './score-history.mjs';

const d = '2026-10-20T03:12:45.123456+00:00';
const d2 = '2026-10-20T03:12:45.123457+00:00';
const row = (song, diff = 0, lamp = 4, score = 100, season = 30, date = d,
  dateKst = '2026-10-20', style = 1, bp = null, notes = null) =>
  [song, diff, lamp, score, season, date, dateKst, style, bp, notes];

test('8열 확장, 빈 입력, 입력 불변, 10열 유지 및 DBR 슬롯 보존', () => {
  const legacy = [row(1).slice(0, 8)];
  const dbr = row(2, 0, 7, 150, -10, '2026-10-20T03:12:45Z', '2026-10-20');
  const hist = [legacy[0], dbr];
  const before = structuredClone(hist);
  const result = mergeScoreHistory(hist, []);
  assert.deepEqual(hist, before);
  assert.deepEqual(result[0], [...legacy[0], null, null]);
  assert.deepEqual(result[1], dbr);
  assert.equal(result.length, 2);
  assert.ok(result.every((r) => r.length === 10));
  assert.notEqual(result, hist);
});

test('최초 append, 열등·동점 무시, EX 우선 및 같은 EX의 램프 향상', () => {
  const hist = [row(1, 0, 4, 100)];
  const first = mergeScoreHistory(hist, [row(2, 0, 2, 50)]);
  assert.equal(first.length, 2);
  assert.equal(mergeScoreHistory(first, [row(1, 0, 7, 90)]).length, 2);
  assert.equal(mergeScoreHistory(first, [row(1, 0, 4, 100)])[0][2], 4);
  const improved = mergeScoreHistory(first, [row(1, 0, 7, 100, 30, d2)]);
  assert.equal(improved[0][2], 7);
  assert.equal(improved[0][5], d2);
});

test('당일 슬롯 교체, 시즌·스타일 분리, 원문 마이크로초 보존과 hist 순서 유지', () => {
  const hist = [row(9), row(1, 0, 4, 100), row(8, 1, 1, 20)];
  const tied = row(1, 0, 4, 100, 30, d2);
  const ignored = mergeScoreHistory(hist, [tied]);
  assert.equal(ignored[1][5], d);
  const improvedRow = row(1, 0, 5, 101, 30, d2);
  const improved = mergeScoreHistory(hist, [improvedRow]);
  assert.deepEqual(improved.map((r) => r[0]), [9, 1, 8]);
  assert.equal(improved[1][5], d2);
  assert.deepEqual(mergeScoreHistory(improved, [improvedRow]), improved);
  const separated = mergeScoreHistory(hist, [row(1, 0, 1, 101, 31), row(1, 0, 1, 101, 30, d, '2026-10-20', 0)]);
  assert.equal(separated.length, 5);
});

test('NULL BP·노트 보충, 동일 EX만 BP 보충, 0 보존 및 날짜 유지', () => {
  const hist = [row(1, 0, 4, 100, 30, d, '2026-10-20', 1, null, null),
    row(2, 0, 4, 100, 30, d, '2026-10-20', 1, null, null),
    row(3, 0, 4, 80, 30, d, '2026-10-20', 1, 0, 0)];
  const result = mergeScoreHistory(hist, [row(1, 0, 4, 100, 30, d2, '2026-10-20', 1, 0, 120),
    row(2, 0, 5, 95, 30, d2, '2026-10-20', 1, 7, 110)]);
  assert.equal(result[0][8], 0);
  assert.equal(result[0][9], 120);
  assert.equal(result[0][5], d);
  assert.equal(result[1][8], null);
  assert.equal(result[1][9], 110);
  assert.deepEqual(result[2].slice(8), [0, 0]);
});

test('재적용 멱등성 회귀와 같은 EX 램프 향상의 BP 보존', () => {
  const initial = [row(1, 0, 4, 100, 30, d, '2026-10-20', 1, 5, 100)];
  const a = row(1, 0, 4, 100, 30, d, '2026-10-20', 1, 5, 100);
  const b = row(1, 0, 5, 200, 30, d2, '2026-10-20', 1, null, null);
  const afterA = mergeScoreHistory(initial, [a]);
  const afterB = mergeScoreHistory(afterA, [b]);
  assert.equal(afterB[0][9], 100);
  assert.equal(afterB[0][8], null);
  assert.deepEqual(mergeScoreHistory(mergeScoreHistory(afterB, [a]), [b]), afterB);
  assert.deepEqual(mergeScoreHistory(afterB, [b]), afterB);
  const sameExLamp = mergeScoreHistory(initial, [row(1, 0, 5, 100, 30, d2, '2026-10-20', 1, null, null)]);
  assert.equal(sameExLamp[0][8], 5);
});

test('중복 요청·잘못된 날짜·불일치 날짜·11열·신규 DBR·기존 중복 K 거부', () => {
  const valid = row(1);
  const cases = [
    () => mergeScoreHistory([], [valid, [...valid]]),
    () => mergeScoreHistory([], [row(1, 0, 4, 100, 30, 'not-a-date')]),
    () => mergeScoreHistory([], [row(1, 0, 4, 100, 30, d, '2026-10-21')]),
    () => mergeScoreHistory([], [[...valid, 1]]),
    () => mergeScoreHistory([], [row(1, 0, 4, 100, -10)]),
    () => mergeScoreHistory([valid, [...valid]], []),
  ];
  const sourceBefore = structuredClone(valid);
  for (const run of cases) assert.throws(run);
  assert.deepEqual(valid, sourceBefore);
});

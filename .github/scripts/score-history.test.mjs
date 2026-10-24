import test from 'node:test';
import assert from 'node:assert/strict';
import { filterScoreHistoryRows, mergeScoreHistory, replayScoreBuffer } from './score-history.mjs';

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

test('date memo: 성공값 재사용, 실패 비저장, day와 instant 상한 퇴출', async () => {
  const { historyInstant } = await import('./score-history.mjs');
  const validDay = '2026-10-23';
  const validInstant = `${validDay}T03:12:45.123456+00:00`;
  const expected = historyInstant(validInstant);
  assert.equal(historyInstant(validInstant), expected);
  for (const value of ['invalid-date', '2026-10-24T25:00:00Z']) {
    const capture = () => {
      try { historyInstant(value); }
      catch (error) { return error; }
      assert.fail('expected invalid date input to throw');
    };
    const first = capture();
    const second = capture();
    assert.equal(second.constructor, first.constructor);
    assert.equal(second.message, first.message);
  }
  const invalidDayCapture = () => {
    try { mergeScoreHistory([], [row(1, 0, 1, 1, 1, validInstant, '2026-02-30')]); }
    catch (error) { return error; }
    assert.fail('expected invalid date_kst to throw');
  };
  const firstInvalidDay = invalidDayCapture();
  const secondInvalidDay = invalidDayCapture();
  assert.equal(firstInvalidDay.constructor, secondInvalidDay.constructor);
  assert.equal(firstInvalidDay.message, 'invalid date_kst');
  assert.equal(secondInvalidDay.message, 'invalid date_kst');
  const validDays = Array.from({ length: 32769 }, (_, index) =>
    new Date(Date.UTC(2000, 0, 1 + index)).toISOString().slice(0, 10));
  for (const value of validDays) assert.equal(historyInstant(`${value}T00:00:00Z`) >= 0n, true);
  assert.equal(historyInstant(validInstant), expected);
  for (const value of validDays) assert.equal(mergeScoreHistory([], [row(1, 0, 1, 1, 1,
    `${value}T00:00:00Z`, value)]).length, 1);
  assert.equal(mergeScoreHistory([], [row(1, 0, 1, 1, 1, validInstant, validDay)]).length, 1);
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

const rest = (scoreId, overrides = {}) => ({
  score_id: scoreId, iidx_id: '89388691', song_id: 100, diff: 3, played_version: 33,
  play_style: 1, ex_score: 2000, lamp: 5, bp: null, note_count: 1500,
  date: '2026-10-22T01:02:03.123456+00:00', date_kst: '2026-10-22', ...overrides,
});

test('누적 재생은 여러 요청의 동일 채보를 허용하고 단일 요청 내부 중복은 거부', () => {
  const first = replayScoreBuffer([], [rest(10)]);
  const second = replayScoreBuffer(first, [rest(11, { ex_score: 2100 })]);
  assert.equal(second.length, 1);
  assert.equal(second[0][3], 2100);
  assert.throws(() => replayScoreBuffer([], [rest(10), rest(10)]), /duplicate score_id/);
});

test('첫 슬롯이 센티널 이하인 chart도 동점 incoming을 차단하고 순차 merge와 일치', () => {
  const mk = (id, date, exScore, lampValue) => ({
    score_id: id, iidx_id: 'x', song_id: 1000, diff: 3, lamp: lampValue,
    ex_score: exScore, played_version: 34, date: `${date}T00:00:00+00:00`,
    date_kst: date, play_style: 1, bp: null, note_count: null,
  });
  for (const [exScore, lampValue] of [[null, 0], [null, null], [null, -1]]) {
    const older = mk(1, '2026-10-01', exScore, lampValue);
    const incoming = mk(2, '2026-10-02', exScore, lampValue);
    const replayed = replayScoreBuffer([], [older, incoming]);
    const sequential = [older, incoming].reduce((history, item) => mergeScoreHistory(history, [[
      item.song_id, item.diff, item.lamp, item.ex_score, item.played_version, item.date,
      item.date_kst, item.play_style, item.bp, item.note_count,
    ]]), []);
    assert.equal(replayed.length, 1);
    assert.equal(JSON.stringify(replayed), JSON.stringify(sequential));
  }
});

test('누적 재생은 같은 날 개선 결과로 슬롯을 교체하고 NULL BP·notes를 보충', () => {
  const hist = [row(100, 3, 5, 2000, 33, '2026-10-22T01:02:03.123456+00:00', '2026-10-22', 1, null, null)];
  const result = replayScoreBuffer(hist, [rest(12, { ex_score: 2100, lamp: 6, bp: 0, note_count: 1500 })]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].slice(2, 4), [6, 2100]);
  assert.deepEqual(result[0].slice(8), [0, 1500]);
  assert.equal(result[0][5], hist[0][5]);
});

test('같은 버퍼를 두 번 재생해도 멱등이고 입력 배열을 바꾸지 않음', () => {
  const hist = [row(100, 3, 4, 1800, 33, '2026-10-21T01:02:03Z', '2026-10-21', 1, null, null)];
  const rows = [rest(20, { ex_score: 2000 })];
  const beforeHist = structuredClone(hist);
  const beforeRows = structuredClone(rows);
  const once = replayScoreBuffer(hist, rows);
  const twice = replayScoreBuffer(once, rows);
  assert.deepEqual(twice, once);
  assert.deepEqual(hist, beforeHist);
  assert.deepEqual(rows, beforeRows);
});

test('33 늦은 업로드는 34·INF와 SP·DP 슬롯과 공존', () => {
  const hist = [
    row(100, 3, 7, 2200, 34, '2026-10-22T01:02:03Z', '2026-10-22', 1),
    row(100, 3, 6, 1900, 0, '2026-10-22T01:02:04Z', '2026-10-22', 1),
    row(100, 3, 4, 1700, 33, '2026-10-22T01:02:05Z', '2026-10-22', 0),
  ];
  const result = replayScoreBuffer(hist, [rest(30)]);
  assert.deepEqual(result, [...hist, row(100, 3, 5, 2000, 33, rest(30).date, '2026-10-22', 1, null, 1500)]);
});

test('score_id 정렬 순으로 재생하고 마이크로초 및 원문 타임존을 보존하며 안전 정수 오류 거부', () => {
  const early = rest(1, { ex_score: 1900, date: '2026-10-22T01:02:03.123456+00:00' });
  const late = rest(2, { ex_score: 2000, date: '2026-10-22T01:02:03.123457+00:00' });
  const input = [late, early];
  const result = replayScoreBuffer([], input);
  assert.equal(result.length, 1);
  assert.equal(result[0][5], late.date);
  assert.equal(result[0][3], late.ex_score);
  assert.throws(() => replayScoreBuffer([], [rest(Number.MAX_SAFE_INTEGER + 1)]), /safe integer/);
  assert.throws(() => replayScoreBuffer([], [rest(-1)]), /safe integer/);
});

test('기존 저점 이력·슬롯 순서·8열 확장·DBR 행을 보존', () => {
  const low = row(100, 3, 2, 1500, 33, '2026-10-20T01:02:03Z', '2026-10-20', 1, 8, 1500);
  const legacy = row(200, 1, 3, 800, 30, '2026-10-19T01:02:03Z', '2026-10-19', 0).slice(0, 8);
  const dbr = row(300, 0, 7, 400, -10, '2026-10-18T01:02:03Z', '2026-10-18', 1, null, 300);
  const hist = [low, legacy, dbr];
  const result = replayScoreBuffer(hist, [rest(44)]);
  assert.deepEqual(result, [low, [...legacy, null, null], dbr, row(100, 3, 5, 2000, 33,
    rest(44).date, '2026-10-22', 1, null, 1500)]);
});

test('replay empty REST preserves invalid and legacy history by identity', () => {
  for (const hist of [[[1]], [[1, 0, 4, 100, 30, d, '2026-10-20', 1, null, null]]]) {
    assert.equal(replayScoreBuffer(hist, []), hist);
  }
});

test('replay preserves REST and history validation order and incoming index zero', () => {
  assert.throws(() => replayScoreBuffer([[1]], [{ score_id: -1 }]), /score_id must be a safe integer/);
  assert.throws(() => replayScoreBuffer([[1]], [rest(1)]), /hist row at index 0/);
  assert.throws(() => replayScoreBuffer([], [rest(1), rest(2, { song_id: NaN })]), /column 0 must be a finite integer/);
});

test('replay BP fill targets current same-day slot after EX replacement', () => {
  const hist = [row(1, 0, 4, 100, 30, d, '2026-10-20', 1, null, null)];
  const result = replayScoreBuffer(hist, [
    rest(1, { song_id: 1, diff: 0, played_version: 30, date: d, date_kst: '2026-10-20', ex_score: 200, bp: null }),
    rest(2, { song_id: 1, diff: 0, played_version: 30, date: d2, date_kst: '2026-10-20', ex_score: 100, bp: 7 }),
  ]);
  assert.equal(result[0][3], 200);
  assert.equal(result[0][8], null);
});

test('replay preserves same EX BP and lets ignored incoming rows fill NULLs with zero', () => {
  const hist = [row(1, 0, 4, 100, 30, d, '2026-10-20', 1, 5, null)];
  const result = replayScoreBuffer(hist, [
    rest(1, { song_id: 1, diff: 0, played_version: 30, ex_score: 100, lamp: 7, bp: 9, note_count: 0 }),
    rest(2, { song_id: 1, diff: 0, played_version: 30, ex_score: 90, lamp: 7, bp: 4, note_count: 120 }),
  ]);
  assert.deepEqual(result[0].slice(8), [5, 0]);
});

test('replay preserves DBR, seasons, styles, slot order and source timestamps', () => {
  const dbr = row(7, 0, 7, 500, -10, d, '2026-10-20', 1);
  const legacy = row(1, 0, 4, 100, 33, d, '2026-10-20', 1).slice(0, 8);
  const hist = [dbr, legacy, row(1, 0, 4, 100, 34, d, '2026-10-20', 1),
    row(1, 0, 4, 100, 0, d, '2026-10-20', 1), row(1, 0, 4, 100, 33, d, '2026-10-20', 0)];
  const result = replayScoreBuffer(hist, [rest(1, { song_id: 2 }), rest(2, { song_id: 3 })]);
  assert.deepEqual(result.slice(0, 5), [dbr, [...legacy, null, null], ...hist.slice(2)]);
  assert.equal(result[1][5], d);
});

test('replay long same-chart sequence matches sequential merge and preserves inputs', () => {
  const hist = [row(1, 0, 4, 10, 30, d, '2026-10-20', 1, null, null)];
  const rows = Array.from({ length: 80 }, (_, i) => rest(i + 1, {
    song_id: 1, diff: 0, played_version: 30, play_style: 1,
    date: `2026-10-${String(20 + Math.floor(i / 20)).padStart(2, '0')}T03:12:45Z`,
    date_kst: `2026-10-${String(20 + Math.floor(i / 20)).padStart(2, '0')}`,
    ex_score: 10 + i, lamp: i % 8, bp: i % 3 === 0 ? i : null, note_count: i % 5 === 0 ? i : null,
  }));
  const beforeHist = structuredClone(hist);
  const beforeRows = structuredClone(rows);
  let expected = hist;
  for (const item of rows) expected = mergeScoreHistory(expected, [[item.song_id, item.diff, item.lamp,
    item.ex_score, item.played_version, item.date, item.date_kst, item.play_style, item.bp, item.note_count]]);
  assert.deepEqual(replayScoreBuffer(hist, rows), expected);
  assert.deepEqual(hist, beforeHist);
  assert.deepEqual(rows, beforeRows);
});

test('replay final NULL fill follows score_id order, separates chart and EX, and preserves known values', () => {
  const mk = (id, date, exScore, bp, notes, overrides = {}) => rest(id, {
    song_id: 1, diff: 0, played_version: 30, play_style: 1, lamp: id === 30 ? 5 : 2,
    date: `${date}T00:00:00Z`, date_kst: date, ex_score: exScore, bp, note_count: notes, ...overrides,
  });
  const pairs = [
    [mk(1, '2026-10-09', 1862, 115, 1400), mk(2, '2026-10-23', 1862, null, null, { lamp: 3 })],
    [mk(3, '2026-10-11', 2072, 100, 1500), mk(4, '2026-10-23', 2072, null, null, { lamp: 3 })],
  ];
  for (const [older, later] of pairs) {
    const result = replayScoreBuffer([], [later, older]);
    assert.deepEqual(result.map((r) => r.slice(0, 8)), [older, later].map((r) => [
      r.song_id, r.diff, r.lamp, r.ex_score, r.played_version, r.date, r.date_kst, r.play_style,
    ]));
    assert.deepEqual(result.map((r) => r[8]), [older.bp, older.bp]);
    assert.deepEqual(replayScoreBuffer(result, [older, later]), result);
  }

  const split = replayScoreBuffer([], [mk(5, '2026-10-09', 100, 7, 1000),
    mk(6, '2026-10-23', 110, null, null)]);
  assert.deepEqual(split.map((r) => r.slice(8)), [[7, 1000], [null, 1000]]);

  const candidates = [mk(10, '2026-10-09', 100, 9, 1000), mk(20, '2026-10-10', 200, 7, 1200),
    mk(30, '2026-10-23', 200, null, null, { lamp: 5 })];
  const expected = replayScoreBuffer([], candidates);
  assert.deepEqual(expected.map((r) => r.slice(8)), [[9, 1000], [7, 1200], [7, 1000]]);
  assert.deepEqual(replayScoreBuffer([], [...candidates].reverse()), expected);

  const isolated = replayScoreBuffer([row(1, 0, 4, 100, 30, d, '2026-10-20', 1, 0, 0),
    row(2, 0, 4, null, 30, d, '2026-10-20', 1, null, null)], [
    mk(40, '2026-10-21', 100, 9, 900, { played_version: 31 }),
    mk(41, '2026-10-21', 100, 8, 800, { play_style: 0 }),
    mk(42, '2026-10-21', null, 6, 700, { song_id: 2, lamp: 5 }),
  ]);
  assert.deepEqual(isolated[0].slice(8), [0, 0]);
  assert.deepEqual(isolated[1].slice(8), [null, 700]);
  assert.deepEqual(isolated.slice(2).map((r) => r.slice(8)), [[9, 900], [8, 800], [6, 700]]);
  const sameEx = mergeScoreHistory([row(2, 0, 2, 100, 30, d, '2026-10-20', 1, null, 500)], [
    row(2, 0, 5, 100, 30, d2, '2026-10-20', 1, 8, null),
  ]);
  assert.deepEqual(sameEx[0].slice(8), [8, 500]);
  const changedEx = mergeScoreHistory([row(3, 0, 2, 100, 30, d, '2026-10-20', 1, 8, 500)], [
    row(3, 0, 5, 110, 30, d2, '2026-10-20', 1, null, null),
  ]);
  assert.deepEqual(changedEx[0].slice(8), [null, 500]);
});

function assertUploadFilter(hist, incoming, expected) {
  const baseline = mergeScoreHistory(hist, []);
  const selected = filterScoreHistoryRows(hist, incoming);
  assert.deepEqual(selected.map((r) => incoming.indexOf(r)), expected);
  assert.deepEqual(mergeScoreHistory(hist, selected), mergeScoreHistory(hist, incoming));
  assert.deepEqual(mergeScoreHistory(hist, selected), mergeScoreHistory(baseline, selected));
}

test('upload filter: EX and lamp decisions', () => {
  const hist = [row(1, 0, 5, 200), row(2, 0, 5, 200), row(3, 0, 5, 200),
    row(4, 0, 5, 200), row(5, 0, 5, 200)];
  const incoming = [row(1, 0, 7, 199), row(2, 0, 5, 200), row(3, 0, 4, 201),
    row(4, 0, 6, 200, 30, d2), row(5, 0, 7, 199, 31)];
  assertUploadFilter(hist, incoming, [2, 3, 4]);
});

test('upload filter: same KST date slot replacement and date-only no-op', () => {
  const hist = [row(1, 0, 4, 100, 30, d, '2026-10-20'), row(2, 0, 4, 100, 30, d, '2026-10-20')];
  const incoming = [row(1, 0, 5, 101, 30, d2, '2026-10-20'),
    row(2, 0, 4, 100, 30, '2026-10-20T04:00:00Z', '2026-10-20')];
  assertUploadFilter(hist, incoming, [0]);
});

test('upload filter: note_count NULL fill without replacing a known value', () => {
  const hist = [row(1, 0, 4, 100, 30, d, '2026-10-20', 1, 3, null),
    row(2, 0, 4, 100, 30, d, '2026-10-20', 1, 3, 120)];
  const incoming = [row(1, 0, 1, 90, 30, d2, '2026-10-20', 1, 9, 110),
    row(2, 0, 7, 90, 30, d2, '2026-10-20', 1, 9, 130)];
  assertUploadFilter(hist, incoming, [0]);
});

test('upload filter: BP NULL and zero fill; lower BP alone is ignored', () => {
  const hist = [row(1, 0, 4, 100, 30, d, '2026-10-20', 1, null, 100),
    row(2, 0, 4, 100, 30, d, '2026-10-20', 1, null, 100),
    row(3, 0, 4, 100, 30, d, '2026-10-20', 1, 2, 100)];
  const incoming = [row(1, 0, 4, 100, 30, d2, '2026-10-20', 1, 5, 100),
    row(2, 0, 4, 100, 30, d2, '2026-10-20', 1, 0, 100),
    row(3, 0, 4, 100, 30, d2, '2026-10-20', 1, 1, 100)];
  assertUploadFilter(hist, incoming, [0, 1]);
});

test('upload filter: late version 33 plus SP/DP and version zero separation', () => {
  const hist = [row(100, 3, 7, 2200, 34), row(100, 3, 4, 1800, 33, d, '2026-10-20', 1),
    row(100, 3, 3, 1600, 33, d, '2026-10-20', 0), row(100, 3, 2, 1500, 0)];
  const incoming = [row(100, 3, 5, 1900, 33, d2, '2026-10-20', 1),
    row(100, 3, 5, 1700, 33, d2, '2026-10-20', 0), row(100, 3, 3, 1550, 0, d2)];
  assertUploadFilter(hist, incoming, [0, 1, 2]);
});

test('upload filter: legacy rows, microseconds, duplicates, errors, DBR, immutability and idempotence', () => {
  const legacy = row(1, 0, 4, 100, 30, d, '2026-10-20', 1).slice(0, 8);
  const hist = [legacy, row(2, 0, 7, 300, -10, '2026-10-20T03:12:45Z', '2026-10-20')];
  const incoming = [row(1, 0, 5, 101, 30, d2, '2026-10-20'),
    row(3, 0, 4, 80, 30, '2026-10-20T03:12:45.123458+00:00', '2026-10-20')];
  const histBefore = structuredClone(hist);
  const incomingBefore = structuredClone(incoming);
  assertUploadFilter(hist, incoming, [0, 1]);
  const filtered = filterScoreHistoryRows(hist, incoming);
  assert.deepEqual(filterScoreHistoryRows(hist, filtered), filtered);
  assert.deepEqual(hist, histBefore);
  assert.deepEqual(incoming, incomingBefore);
  assert.throws(() => filterScoreHistoryRows([], [incoming[0], [...incoming[0]]]), /duplicate/);
  assert.throws(() => filterScoreHistoryRows([], [row(4, 0, 4, 100, 30, 'bad-date')]), /date/);
  const dbr = { scores: [], history: [], updatedAt: '2026-10-23T02:00:00Z', v: 1 };
  assert.throws(() => filterScoreHistoryRows(dbr, incoming), /arrays/);
});

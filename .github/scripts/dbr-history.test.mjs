import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DBR_HISTORY_COLS, validateDbrHistory, normalizeDbrHistory, mergeDbrHistory,
  extendDbrPayload, getDbrRecentDates, getDbrRecentData,
} from './dbr-history.mjs';

const row = (extra = {}) => ({
  song_id: 1, diff: 3, lamp: 4, ex_score: 100, played_version: -10,
  date: '2026-09-01T10:00:00Z', date_kst: '2026-09-01', play_style: 1,
  bp: 30, note_count: 500, score_id: 1, ...extra,
});
const full = (rows) => normalizeDbrHistory(rows, { complete: true, revision: 7 });
const later = (extra = {}) => row({ date: '2026-09-02T10:00:00Z', date_kst: '2026-09-02', score_id: 2, ...extra });

test('계약 앞 10열은 실제 HIST_COLS와 일치하며 import 부작용이 없다', () => {
  const source = readFileSync(new URL('./dump-user.mjs', import.meta.url), 'utf8');
  const match = source.match(/export const HIST_COLS = (\[[^;]+\]);/);
  assert.ok(match);
  const cols = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(DBR_HISTORY_COLS.slice(0, 10), cols);
  assert.equal(DBR_HISTORY_COLS[10], 'score_id');
  assert.equal(validateDbrHistory(full([])), true);
});

test('DBR DP 원천만 정규화하고 0·음수·null EX 및 선택 열의 null을 보존한다', () => {
  const input = [row({ ex_score: 0 }), row({ song_id: 2, score_id: 2, ex_score: -1 }),
    row({ song_id: 3, score_id: 3, ex_score: null, bp: undefined, lamp: null, note_count: null }),
    row({ played_version: 0 }), row({ played_version: 33 }), row({ play_style: 0 })];
  const before = structuredClone(input), history = full(input);
  assert.equal(history.rows.length, 3);
  assert.deepEqual(history.rows.map((r) => r[3]), [0, -1, null]);
  assert.equal(history.rows[2][8], null);
  assert.deepEqual(getDbrRecentDates(history), { status: 'empty', complete: true, dates: [] });
  assert.equal(getDbrRecentData(history, '2026-09-01').rows.length, 0);
  assert.deepEqual(input, before);
  assert.deepEqual(full(history.rows), history);
});

test('같은 날 재저장은 낮은 점수·램프도 전체 교체하고 다른 날은 추가한다', () => {
  const previous = full([row({ ex_score: 500, lamp: 7 })]);
  const before = structuredClone(previous);
  const updated = mergeDbrHistory(previous, [row({ ex_score: 20, lamp: 1, bp: null }), later()]);
  assert.equal(updated.rows.length, 2);
  assert.deepEqual(updated.rows[0], DBR_HISTORY_COLS.map((c) => row({ ex_score: 20, lamp: 1, bp: null })[c]));
  assert.equal(updated.rows[1][6], '2026-09-02');
  assert.equal(updated.complete, true);
  assert.equal(updated.revision, 8);
  assert.deepEqual(previous, before);
  const duplicates = full([row({ ex_score: 900 }), row({ ex_score: 50 }), row({ ex_score: 0 })]);
  assert.equal(duplicates.rows.length, 1);
  assert.equal(duplicates.rows[0][3], 0);
  updated.rows[0][3] = 999;
  assert.deepEqual(previous, before);
});

test('score_id 변경 교체·차트 분리·빈 차분·명시적 완료 및 revision 처리', () => {
  const partial = mergeDbrHistory(undefined, [row(), row({ song_id: 2, score_id: 2 }), row({ diff: 2, score_id: 3 })]);
  assert.equal(partial.complete, false);
  assert.equal(partial.revision, 1);
  const next = mergeDbrHistory(partial, [row({ score_id: 4, ex_score: 10 })], { complete: true, revision: 9 });
  assert.equal(next.rows.length, 3);
  assert.equal(next.rows[0][10], 4);
  assert.equal(next.complete, true);
  assert.deepEqual(mergeDbrHistory(next, []).rows, next.rows);
  assert.throws(() => mergeDbrHistory(next, [], { revision: 9 }), /revision/);
  assert.throws(() => mergeDbrHistory(next, [], { complete: 'yes' }), /complete/);
});

test('기존 scores 맵과 부가 필드는 확장 전후 그대로 보존한다', () => {
  const payload = { scores: { '1_3': { ex_score: 900, lamp: 7 } }, id: 'TEST', _v: 'legacy' };
  const before = structuredClone(payload), updated = extendDbrPayload(payload, [row()]);
  assert.deepEqual(payload, before);
  assert.strictEqual(updated.scores, payload.scores);
  assert.equal(updated.id, payload.id);
  assert.equal(updated._v, payload._v);
  assert.equal(updated.history.complete, false);
  const completed = extendDbrPayload(updated, [], { complete: true });
  assert.equal(completed.history.revision, 2);
  assert.strictEqual(completed.scores, payload.scores);
  assert.throws(() => extendDbrPayload({}, []), /scores/);
});

test('누락·미완료는 기록 없음과 구별하고 부분 결과도 미완료로 표시한다', () => {
  for (const history of [undefined, null, normalizeDbrHistory([]), normalizeDbrHistory([row()])]) {
    assert.equal(getDbrRecentDates(history).status, 'incomplete');
    assert.equal(getDbrRecentData(history, '2026-09-01').status, 'incomplete');
  }
  assert.equal(getDbrRecentDates(normalizeDbrHistory([row()])).dates.length, 1);
  assert.equal(getDbrRecentDates(full([])).status, 'empty');
  assert.equal(getDbrRecentData(full([row()]), '2026-09-03').status, 'empty');
  assert.equal(getDbrRecentData(full([row()]), '2026-09-01').status, 'ready');
});

test('SQL 날짜별 유효 행수·날짜 내림차순·score_id 오름차순 패리티', () => {
  const history = full([later({ song_id: 2, score_id: 20 }), row({ score_id: 9 }),
    later({ score_id: 3 }), later({ song_id: 3, score_id: 4, ex_score: 0 }),
    later({ song_id: 4, score_id: 5, ex_score: null })]);
  assert.deepEqual(getDbrRecentDates(history).dates, [
    { date_kst: '2026-09-02', row_count: 2 }, { date_kst: '2026-09-01', row_count: 1 },
  ]);
  assert.deepEqual(getDbrRecentData(history, '2026-09-02').rows.map((r) => r.score_id), [3, 20]);
});

test('직전값은 현재 행 자신을 제외하고 최근 양수 행의 값이며 최고점이 아니다', () => {
  const history = full([row({ ex_score: 900, lamp: 7 }), later({ ex_score: 50, lamp: 1, bp: 45 }),
    row({ date: '2026-09-03T10:00:00Z', date_kst: '2026-09-03', score_id: 3, ex_score: 0 }),
    row({ date: '2026-09-04T10:00:00Z', date_kst: '2026-09-04', score_id: 4, ex_score: 200 })]);
  const first = getDbrRecentData(history, '2026-09-01').rows[0];
  assert.deepEqual([first.prev_lamp, first.prev_ex_score, first.prev_played_version, first.prev_bp], [null, null, null, null]);
  const last = getDbrRecentData(history, '2026-09-04').rows[0];
  assert.deepEqual([last.prev_lamp, last.prev_ex_score, last.prev_played_version, last.prev_bp], [1, 50, -10, 45]);
  assert.equal(last.note_count, 500);
  assert.equal(getDbrRecentData(history, '2026-09-02').rows[0].prev_ex_score, 900);
});

test('직전값은 곡·난이도·스타일·버전 격리, 미래 기록 및 무점수 제외', () => {
  const history = full([row({ played_version: 0, ex_score: 999 }), row({ played_version: 33, ex_score: 999 }),
    row({ play_style: 0, ex_score: 999 }), row({ diff: 2, score_id: 3, ex_score: 999 }),
    row({ song_id: 2, score_id: 4, ex_score: 999 }), row({ ex_score: -1 }),
    later(), row({ date: '2026-09-03T10:00:00Z', date_kst: '2026-09-03', score_id: 5, ex_score: 999 })]);
  assert.equal(getDbrRecentData(history, '2026-09-02').rows[0].prev_ex_score, null);
});

test('timezone 동치·KST 경계·마이크로초·SQL bigint 정렬을 보존한다', () => {
  const history = full([
    row({ date: '2026-09-01T14:59:59.999999Z', score_id: '9223372036854775807', ex_score: 123 }),
    later({ date: '2026-09-02T00:00:00.000001+09:00', score_id: '9007199254740993' }),
    later({ song_id: 2, date: '2026-09-01T15:00:00+00', score_id: '9007199254740992' }),
  ]);
  const current = getDbrRecentData(history, '2026-09-02').rows;
  assert.deepEqual(current.map((r) => r.score_id), ['9007199254740992', '9007199254740993']);
  assert.equal(current[1].prev_ex_score, 123);
  assert.equal(current[0].prev_ex_score, null);
  assert.throws(() => full([row({ date: '2026-09-01T15:00:00Z' })]), /KST/);
  assert.throws(() => full([row({ score_id: 9007199254740992 })]), /safe integer/);
});

test('계약 검증은 잘못된 메타데이터·열·행·중복·시각을 거부한다', () => {
  const valid = full([row()]);
  for (const patch of [{ schemaVersion: 2 }, { complete: null }, { revision: -1 }, { revision: 0.5 },
    { cols: [...DBR_HISTORY_COLS].reverse() }, { cols: DBR_HISTORY_COLS.slice(0, 10) }, { rows: null },
    { rows: [...valid.rows, [...valid.rows[0]]] }, { rows: [valid.rows[0].slice(0, 10)] }]) {
    assert.throws(() => validateDbrHistory({ ...valid, ...patch }), TypeError);
  }
  for (const patch of [{ date: '2026-09-01' }, { date: '2026-09-01T10:00:00' },
    { date: '2026-09-01T25:00:00Z' }, { date: '2026-09-01T10:00:00.1234567Z' },
    { date_kst: '2026-02-30' }, { score_id: null }, { ex_score: '100' }, { score_id: '9223372036854775808' }]) {
    assert.throws(() => full([row(patch)]), TypeError);
  }
  assert.throws(() => full([row(), row({ song_id: 2 })]), /score_id/);
  assert.throws(() => normalizeDbrHistory([row({ played_version: '-10' })]), /integer/);
  assert.throws(() => getDbrRecentData(valid, 'bad'), /date_kst/);
  assert.throws(() => getDbrRecentDates({}), /schemaVersion/);
  assert.throws(() => validateDbrHistory({ ...valid, rows: [DBR_HISTORY_COLS.map((c) => row({ played_version: 0 })[c])] }), /DBR/);
});

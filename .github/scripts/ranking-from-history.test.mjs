import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHistoryRankings } from './ranking-from-history.mjs';
import { normalizeAliasInputs } from './song-aliases.mjs';

const aliases = { v: 1, rules: [] };
const songs = [{ song_id: 1 }, { song_id: 2 }, { song_id: 3 }, { song_id: 4 }, { song_id: 5 }];
const stamp = (day, micros = '000000', zone = '+00:00') =>
  `2026-10-${String(day).padStart(2, '0')}T00:00:00.${micros}${zone}`;
const sourceRow = ({ song = 1, diff = 0, lamp = 1, ex = 100, version = 33,
  date = stamp(1), dateKst = `2026-10-${String(Number(date.slice(8, 10))).padStart(2, '0')}`,
  style = 1, bp = 20, notes = 1000, eight = false }) => {
  const row = [song, diff, lamp, ex, version, date, dateKst, style, bp, notes];
  return eight ? row.slice(0, 8) : row;
};
function normalized(histRows) {
  return normalizeAliasInputs({ histRows, restRows: [], aliases, songs }).histRows;
}
function calculate(entries, userRows = null) {
  const users = userRows ?? entries.map(([id]) => ({ iidx_id: id, dj_name: `DJ-${id}` }));
  const histories = new Map(entries.map(([id, rows]) => [id, normalized(rows)]));
  return buildHistoryRankings({ users, histories });
}
const chart = (result, song = 1, diff = 0) => result.charts.find((x) => x.song_id === song && x.diff === diff);

test('대표 행은 최고 EX의 가장 이른 날짜 행 전체를 선택한다', () => {
  const result = calculate([['u1', [
    sourceRow({ ex: 900, version: 33, date: stamp(1), lamp: 2, bp: 30, notes: 900 }),
    sourceRow({ ex: 900, version: 34, date: stamp(2), lamp: 8, bp: 1, notes: 1200 }),
  ]]]);
  assert.deepEqual(chart(result).rows, [{ rank: 1, iidx_id: 'u1', dj_name: 'DJ-u1', ex_score: 900,
    lamp: 2, played_version: 33, date: stamp(1), bp: 30, note_count: 900 }]);
});

test('같은 EX와 순간의 최종 JSON 키가 삽입 순서와 무관하게 결과를 결정한다', () => {
  const a = sourceRow({ ex: 500, version: 33, date: '2026-10-01T00:00:00.000000Z', lamp: 3 });
  const b = sourceRow({ ex: 500, version: 34, date: '2026-10-01T00:00:00+00:00', lamp: 7 });
  const expected = JSON.stringify([1, 0, 3, 500, 33, '2026-10-01T00:00:00.000000Z', '2026-10-01', 1, 20, 1000])
    < JSON.stringify([1, 0, 7, 500, 34, '2026-10-01T00:00:00+00:00', '2026-10-01', 1, 20, 1000])
    ? { rank: 1, iidx_id: 'a', dj_name: 'DJ-a', ex_score: 500, lamp: 3, played_version: 33, date: a[5], bp: 20, note_count: 1000 }
    : { rank: 1, iidx_id: 'a', dj_name: 'DJ-a', ex_score: 500, lamp: 7, played_version: 34, date: b[5], bp: 20, note_count: 1000 };
  const forward = calculate([['a', [a]], ['b', [b]]]);
  const reversed = calculate([['b', [b]], ['a', [a]]], [{ iidx_id: 'b', dj_name: 'DJ-b' }, { iidx_id: 'a', dj_name: 'DJ-a' }]);
  assert.deepEqual(forward, reversed);
  assert.deepEqual(chart(forward).rows[0], expected);
  assert.equal(chart(forward).rows[1].rank, 1);
});

test('랭킹은 EX DESC, 날짜 ASC, ID ASC로 정렬하고 동점 경쟁 순위와 100행 절단을 지킨다', () => {
  const entries = [];
  for (let i = 0; i < 101; i += 1) {
    const id = `u${String(1000 - i).padStart(4, '0')}`;
    const day = i === 0 ? 1 : i < 99 ? 2 : 3;
    entries.push([id, [sourceRow({ ex: i < 99 ? 500 : 400, date: stamp(day), lamp: 1 })]]);
  }
  const result = calculate(entries);
  const rows = chart(result).rows;
  assert.equal(rows.length, 100);
  assert.equal(rows[0].iidx_id, 'u1000');
  assert.equal(rows[1].iidx_id, 'u0902');
  assert.equal(rows[98].iidx_id, 'u0999');
  assert.equal(rows[99].iidx_id, 'u0900');
  assert.equal(rows[99].ex_score, 400);
  assert.deepEqual(rows.slice(0, 3).map((x) => x.rank), [1, 1, 1]);
  const ranks = calculate([['a', [sourceRow({ ex: 700 })]], ['b', [sourceRow({ ex: 700, date: stamp(2) })]],
    ['c', [sourceRow({ ex: 600 })]]]).charts[0].rows.map((x) => x.rank);
  assert.deepEqual(ranks, [1, 1, 3]);
});

test('버전 33 늦은 업로드, 34 기록, 0/-1 포함 및 SP/DBR 제외', () => {
  const result = calculate([
    ['old', [sourceRow({ ex: 700, version: 34, date: stamp(1) }), sourceRow({ ex: 800, version: 33, date: stamp(3) })]],
    ['zero', [sourceRow({ ex: 0, version: 0, date: stamp(1) })]],
    ['minus', [sourceRow({ ex: 10, version: -1, date: stamp(1) })]],
    ['sp', [sourceRow({ ex: 1000, style: 0 })]],
    ['dbr', [sourceRow({ ex: 1000, version: -10 })]],
  ]);
  const rows = chart(result).rows;
  assert.deepEqual(rows.map((x) => [x.iidx_id, x.ex_score, x.played_version]), [
    ['old', 800, 33], ['minus', 10, -1], ['zero', 0, 0],
  ]);
  assert.equal(result.charts.some((x) => x.song_id === 2), false);
  assert.equal(result.charts.some((x) => x.song_id === 3), false);
});

test('0 EX는 유효하고 반환 NULL은 실패하며 상위 100 밖 NULL은 무시한다', () => {
  const zero = calculate([['zero', [sourceRow({ ex: 0 })]]]);
  assert.equal(chart(zero).rows[0].ex_score, 0);
  assert.throws(() => calculate([['null', [sourceRow({ ex: null })]]]), /null ex_score/);
  const entries = [['top', [sourceRow({ ex: 1000 })]]];
  for (let i = 0; i < 100; i += 1) entries.push([`v${i}`, [sourceRow({ ex: 500, date: stamp(2) })]]);
  entries.push(['null-low', [sourceRow({ ex: null, date: stamp(3) })]]);
  const result = calculate(entries);
  assert.equal(chart(result).rows.length, 100);
  assert.equal(chart(result).rows.some((x) => x.iidx_id === 'null-low'), false);
  assert.equal(chart(result).rows.some((x) => x.ex_score === 0), false);
});

test('1위는 원본 전체 후보에서 EX/date/ID로 선택하고 마이크로초·0·삭제 유저·NULL 이름을 처리한다', () => {
  const hist = [
    sourceRow({ song: 2, ex: 900, date: '2026-10-01T00:00:00.123457+00:00' }),
    sourceRow({ song: 2, ex: 900, date: '2026-10-01T00:00:00.123456+00:00' }),
    sourceRow({ song: 2, ex: 900, date: '2026-10-01T00:00:00.123456Z' }),
    sourceRow({ song: 2, ex: 1000, date: stamp(2) }),
    sourceRow({ song: 3, ex: 0, date: stamp(1) }),
    sourceRow({ song: 4, ex: null, date: stamp(1) }),
    sourceRow({ song: 5, ex: 999, date: stamp(1) }),
  ];
  const before = structuredClone(hist);
  const users = [{ iidx_id: 'winner', dj_name: null }, { iidx_id: 'zero', dj_name: 'Zero' }];
  const histories = new Map([
    ['winner', normalized(hist.slice(0, 4).map((row, index) => [...row.slice(0, 4), 34 + index, ...row.slice(5)]))],
    ['zero', normalized([hist[4]])],
    ['null-score', normalized([hist[5]])],
    ['deleted', normalized([hist[6]])],
  ]);
  const result = buildHistoryRankings({ users, histories });
  assert.deepEqual(result.winners, [{ song_id: 2, diff: 0, iidx_id: 'winner' }, { song_id: 3, diff: 0, iidx_id: 'zero' }]);
  assert.equal(chart(result, 2).rows[0].date, stamp(2));
  assert.equal(result.winners[0].iidx_id, 'winner');
  assert.equal(chart(result, 2).rows[0].dj_name, null);
  assert.equal(chart(result, 3).rows[0].ex_score, 0);
  assert.deepEqual(hist, before);
  assert.equal(histories.get('winner')[0][5], '2026-10-01T00:00:00.123457+00:00');
  assert.equal(histories.get('winner')[1][5], '2026-10-01T00:00:00.123456+00:00');
  assert.equal(histories.get('winner')[2][5], '2026-10-01T00:00:00.123456Z');
});

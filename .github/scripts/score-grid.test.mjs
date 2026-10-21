import test from 'node:test';
import assert from 'node:assert/strict';
import { gridFromHistory } from './score-history.mjs';

const d0 = '2026-10-20T03:12:45.123456+00:00';
const d1 = '2026-10-20T03:12:45.123457+00:00';
const row = (song, diff = 0, lamp = 4, ex = 100, season = 30, date = d0,
  dateKst = '2026-10-20', style = 1, bp = null, notes = null) =>
  [song, diff, lamp, ex, season, date, dateKst, style, bp, notes];
const song = (id, title = `song-${id}`) => ({
  song_id: id, textage_song_id: `t${id}`, title, series_no: 31, ac: 30, legen: 0,
});
const expected = (id, diff, lamp, ex, season, date, bp, notes, meta = song(id)) => ({
  song_id: id, iidx_id: 'player', diff, lamp, ex_score: ex, played_version: season,
  date, date_kst: '2026-10-20', textage_song_id: meta.textage_song_id,
  title: meta.title, series_no: meta.series_no, ac: meta.ac, legen: meta.legen,
  bp, note_count: notes,
});

test('EX 대표와 램프 대표를 각각 선택하고 더 늦은 시각의 시즌을 출력한다', () => {
  const hist = [row(1, 0, 3, 200, 30, d0, '2026-10-20', 1, 9, 100),
    row(1, 0, 7, 100, 31, d1, '2026-10-20', 1, 1, 90)];
  assert.deepEqual(gridFromHistory('player', hist, [song(1)]), [
    expected(1, 0, 7, 200, 31, d1, 9, 100),
  ]);
});

test('EX와 램프 동률은 더 이른 마이크로초 instant, 완전 동률은 ordinal을 우선한다', () => {
  const hist = [
    row(1, 0, 5, 100, 30, d1, '2026-10-20', 1, 1, 10),
    row(1, 0, 5, 100, 31, d0, '2026-10-20', 1, 2, 20),
    row(2, 0, 5, 100, 30, d0, '2026-10-20', 1, 3, 30),
    row(2, 0, 5, 100, 31, d0, '2026-10-20', 1, 4, 40),
    row(3, 0, 5, 100, 30, d0, '2026-10-20', 1, 5, 50),
    row(3, 0, 5, 100, 31, d1, '2026-10-20', 1, 6, 60),
  ];
  assert.deepEqual(gridFromHistory('player', hist, [song(1), song(2), song(3)]), [
    expected(1, 0, 5, 100, 31, d0, 2, 20),
    expected(2, 0, 5, 100, 30, d0, 3, 30),
    expected(3, 0, 5, 100, 30, d0, 5, 50),
  ]);
});

test('동일 instant의 표기가 달라도 EX 대표 원문과 시즌을 보존하고 KST 불일치를 거부한다', () => {
  const alternate = '2026-10-20T12:12:45.123456+09:00';
  const hist = [row(1, 0, 3, 200, 30, d0, '2026-10-20', 1, 9, 100),
    row(1, 0, 7, 100, 31, alternate, '2026-10-20', 1, 1, 90)];
  assert.deepEqual(gridFromHistory('player', hist, [song(1)]), [
    expected(1, 0, 7, 200, 30, d0, 9, 100),
  ]);
  assert.throws(() => gridFromHistory('player', [row(2, 0, 1, 1, 30, d0, '2026-10-21')], [song(2)]));
});

test('SP와 DP를 나누고 DBR·없는 곡을 빼며 시즌을 합쳐 정렬한다', () => {
  const hist = [
    row(3, 1, 2, 20), row(1, 0, 2, 20),
    row(1, 0, 7, 30, 31, d1),
    row(2, 0, 6, 50, 30, d0, '2026-10-20', 0),
    row(2, 0, 7, 99, -10), row(99, 0, 7, 99),
  ];
  assert.deepEqual(gridFromHistory('player', hist, [song(1), song(2), song(3)], 1), [
    expected(1, 0, 7, 30, 31, d1, null, null),
    expected(3, 1, 2, 20, 30, d0, null, null),
  ]);
  assert.deepEqual(gridFromHistory('player', hist, [song(1), song(2), song(3)], 0), [
    expected(2, 0, 6, 50, 30, d0, null, null),
  ]);
});

test('NULL은 비교용 기본값만 적용하고 0과 8열 확장값은 보존한다', () => {
  const hist = [
    row(1, 0, null, null, 30, d0, '2026-10-20', 1, 0, 0),
    row(1, 0, 0, -1, 31, d1, '2026-10-20', 1, 8, 80),
    row(2, 0, null, 0, 30, d0, '2026-10-20', 1, null, null).slice(0, 8),
  ];
  assert.deepEqual(gridFromHistory('player', hist, [song(1), song(2)]), [
    expected(1, 0, null, null, 30, d0, 0, 0),
    expected(2, 0, null, 0, 30, d0, null, null),
  ]);
});

test('전체 출력 필드, 입력 불변, 중복 song_id 거부, 빈 결과를 확인한다', () => {
  const hist = [row(1, 0, 6, 150, 32, d0, '2026-10-20', 1, 0, 0)];
  const songs = [song(1, 'fixed title')];
  const beforeHist = structuredClone(hist);
  const beforeSongs = structuredClone(songs);
  assert.deepEqual(gridFromHistory('player', hist, songs), [
    expected(1, 0, 6, 150, 32, d0, 0, 0, songs[0]),
  ]);
  assert.deepEqual(hist, beforeHist);
  assert.deepEqual(songs, beforeSongs);
  assert.throws(() => gridFromHistory('player', hist, [song(1), song(1)]));
  assert.deepEqual(gridFromHistory('player', [], songs), []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mergeScoreHistory, gridFromHistory } from './score-history.mjs';
import { normalizeAliasInputs, resolveSongId, validateAliases } from './song-aliases.mjs';

const row = (song, diff = 3, lamp = 5, score = 2000, version = 33,
  date = '2026-10-22T01:02:03.123456+00:00', kst = '2026-10-22', style = 1,
  bp = null, notes = 1500) => [song, diff, lamp, score, version, date, kst, style, bp, notes];
const rest = (id, song, overrides = {}) => ({ score_id: id, iidx_id: '89388691', song_id: song,
  diff: 3, played_version: 33, play_style: 1, ex_score: 2000, lamp: 5, bp: null,
  note_count: 1500, date: '2026-10-22T01:02:03.123456+00:00', date_kst: '2026-10-22', ...overrides });

const variantMap = JSON.parse(await readFile('D:/work/ohSorryRating/variant-map.json', 'utf8'));
const variant = variantMap.variants[0];
assert.ok(variant?.ac && variant?.inf);
const variants = [{ song_id: 100, textage_song_id: variant.ac }, { song_id: 200, textage_song_id: variant.inf }];
const songs = [{ song_id: 100, title: 'A', series_no: 33, ac: 1, legen: 0 },
  { song_id: 200, title: 'B', series_no: 33, ac: 1, legen: 0 },
  { song_id: 400, title: 'C', series_no: 33, ac: 1, legen: 0 }];
const aliases = { v: 1, rules: [
  { from: 100, to: 200, scope: 'song' },
  { from: 300, to: 400, scope: 'chart-ac', diff: 3 },
] };
void variants;

test('1. song 全体移動、SP/DP、DBR例外', () => {
  assert.equal(resolveSongId(100, 3, 33, aliases), 200);
  assert.equal(resolveSongId(100, 3, 33, aliases), 200); // song scope covers both play styles
  assert.equal(resolveSongId(100, 3, -10, aliases), 100);
  assert.deepEqual(normalizeAliasInputs({ histRows: [row(100)], restRows: [rest(12345, 100)], aliases, songs }), {
    histRows: [row(200)], restRows: [rest(12345, 200)],
  });
});

test('2. chart-ac은 일치 diff의 양수 version만 SP/DP 이동, 33 포함', () => {
  for (const style of [0, 1]) {
    assert.equal(resolveSongId(300, 3, 33, aliases), 400);
    assert.equal(resolveSongId(300, 3, 34, aliases), 400);
    assert.equal(resolveSongId(300, 3, 0, aliases), 300);
    assert.equal(resolveSongId(300, 3, -1, aliases), 300);
    assert.equal(resolveSongId(300, 2, 33, aliases), 300);
    assert.equal(normalizeAliasInputs({ histRows: [row(300, 3, 5, 2000, 33, undefined, undefined, style)],
      restRows: [rest(1, 300, { play_style: style })], aliases, songs: [...songs, { song_id: 300, title: 'source' }] })
      .histRows[0][0], 400);
  }
});

test('3. 同日 A/B 衝突をマイクロ秒・ordinal順にbest mergeしNULL補充', () => {
  const hist = [row(100, 3, 5, 2000, 33, '2026-10-22T01:02:03.123456+00:00', '2026-10-22', 1, null, null),
    row(200, 3, 5, 2000, 33, '2026-10-22T01:02:03.123457+00:00', '2026-10-22', 1, 4, 1400)];
  const before = structuredClone(hist);
  const result = normalizeAliasInputs({ histRows: hist, restRows: [], aliases, songs });
  assert.deepEqual(result.histRows, [row(200, 3, 5, 2000, 33,
    '2026-10-22T01:02:03.123456+00:00', '2026-10-22', 1, 4, 1400)]);
  assert.deepEqual(hist, before);
});

test('4. 連쇄 종착점·재적용 멱等·入力不変', () => {
  const chain = { v: 1, rules: [{ from: 100, to: 200, scope: 'song' }, { from: 200, to: 400, scope: 'song' }] };
  const hist = [row(100)]; const restRows = [rest(7, 100)];
  const before = structuredClone({ hist, restRows, chain });
  const once = normalizeAliasInputs({ histRows: hist, restRows, aliases: chain, songs });
  const twice = normalizeAliasInputs({ histRows: once.histRows, restRows: once.restRows, aliases: chain, songs });
  assert.equal(once.histRows[0][0], 400);
  assert.deepEqual(twice, once);
  assert.deepEqual({ hist, restRows, chain }, before);
});

test('5. 循環・自己参照・重複・分岐・存在しない終点を拒否', () => {
  for (const bad of [
    { v: 1, rules: [{ from: 100, to: 200, scope: 'song' }, { from: 200, to: 100, scope: 'song' }] },
    { v: 1, rules: [{ from: 100, to: 100, scope: 'song' }] },
    { v: 1, rules: [{ from: 100, to: 200, scope: 'song' }, { from: 100, to: 400, scope: 'chart-ac', diff: 3 }] },
    { v: 1, rules: [{ from: 100, to: 200, scope: 'chart-ac', diff: 3 }, { from: 100, to: 400, scope: 'chart-ac', diff: 3 }] },
    { v: 1, rules: [{ from: 100, to: 999, scope: 'song' }] },
  ]) assert.throws(() => validateAliases(bad, songs));
});

test('6. 非衝突slot・既存best/grid・8列→10列を保つ', () => {
  const legacy = row(100).slice(0, 8);
  const hist = [legacy, row(200, 1, 4, 800, 30, '2026-10-21T01:02:03Z', '2026-10-21', 1)];
  const normalized = normalizeAliasInputs({ histRows: hist, restRows: [], aliases, songs });
  assert.equal(normalized.histRows[0][0], 200);
  assert.deepEqual(normalized.histRows[1], [...hist[1]]);
  assert.deepEqual(mergeScoreHistory(normalized.histRows, []), normalized.histRows);
  assert.deepEqual(gridFromHistory('89388691', normalized.histRows, songs, 1).map((x) => x.song_id), [200, 200]);
  assert.equal(normalized.histRows[0].length, 10);
  assert.deepEqual(hist[0], legacy);
});

test('alias collision replays in time order and preserves the winning timestamp spelling', () => {
  const hist = [
    row(100, 3, 4, 2100, 33, '2026-10-22T10:00:00.000001Z'),
    row(200, 3, 6, 2100, 33, '2026-10-22T19:00:00.000002+09:00'),
  ];
  const result = normalizeAliasInputs({ histRows: hist, restRows: [], aliases, songs });
  assert.deepEqual(result.histRows, [row(200, 3, 6, 2100, 33, '2026-10-22T19:00:00.000002+09:00')]);
});

test('collision chart history is inserted at its first original slot', () => {
  const hist = [
    row(100, 3, 4, 2100, 33, '2026-10-21T10:00:00Z', '2026-10-21'),
    row(400, 1, 4, 800, 30, '2026-10-20T10:00:00Z', '2026-10-20'),
    row(200, 3, 6, 2200, 33, '2026-10-22T10:00:00Z', '2026-10-22'),
    row(100, 3, 5, 2150, 33, '2026-10-23T10:00:00Z', '2026-10-23'),
  ];
  const result = normalizeAliasInputs({ histRows: hist, restRows: [], aliases, songs });
  assert.deepEqual(result.histRows.map((r) => [r[0], r[6]]), [
    [200, '2026-10-21'], [400, '2026-10-20'], [200, '2026-10-22'], [200, '2026-10-23'],
  ]);
});

test('microsecond ties retain ordinal order and fill null BP and notes with zero', () => {
  const hist = [
    row(100, 3, 5, 2000, 33, '2026-10-22T01:02:03.123456Z', undefined, 1, null, null),
    row(200, 3, 5, 2000, 33, '2026-10-22T10:02:03.123456+09:00', undefined, 1, 0, 0),
  ];
  const result = normalizeAliasInputs({ histRows: hist, restRows: [], aliases, songs });
  assert.deepEqual(result.histRows, [row(200, 3, 5, 2000, 33,
    '2026-10-22T01:02:03.123456Z', '2026-10-22', 1, 0, 0)]);
});

test('original natural duplicates fail before aliasing and DBR, legacy rows, and inputs stay intact', () => {
  const hist = [row(100, 3, 5, 2000, 33, undefined, undefined, 1, null, null),
    row(200, 1, 4, 800, 30, '2026-10-21T01:02:03Z', '2026-10-21', 1),
    row(400, 2, 3, 500, -10, '2026-10-20T01:02:03Z', '2026-10-20', 1, 7, 8),
    row(100).slice(0, 8), row(100)];
  const before = structuredClone(hist);
  assert.throws(() => normalizeAliasInputs({ histRows: hist, restRows: [], aliases, songs }),
    { name: 'TypeError', message: 'duplicate natural key in hist at row 3: [100,3,33,1,"2026-10-22"]' });
  assert.deepEqual(hist, before);
  const valid = normalizeAliasInputs({ histRows: hist.slice(0, 3), restRows: [], aliases, songs });
  assert.deepEqual(valid.histRows[1], hist[1]);
  assert.deepEqual(valid.histRows[2], hist[2]);
});

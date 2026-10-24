import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleUserDump, HIST_COLS, prepareFastDump, recentHistoryFromRows, slimRow } from './dump-fast-core.mjs';
import { normalizeAliasInputs } from './song-aliases.mjs';
import { replayScoreBuffer } from './score-history.mjs';
import { buildCandidate, sha256Hex } from './score-buffer.mjs';

process.env.SUPABASE_URL = 'https://supabase.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
const { HIST_COLS: legacyHistCols } = await import('./dump-user.mjs');

test('slimRow preserves DP/SP field order and null while omitting missing fields', () => {
  const row = { note_count: null, ignored: 5, bp: 0, date: null, played_version: undefined,
    ex_score: 12, lamp: null, diff: 3, song_id: 42 };
  assert.deepEqual(slimRow(row), { song_id: 42, diff: 3, lamp: null, ex_score: 12, date: null, bp: 0, note_count: null });
  assert.deepEqual(Object.keys(slimRow(row)), ['song_id', 'diff', 'lamp', 'ex_score', 'date', 'bp', 'note_count']);
  assert.equal(legacyHistCols, HIST_COLS);
});

test('recent history has fixed KST boundary, sort, dedupe, DBR and play style behavior', () => {
  const now = Date.parse('2026-10-24T03:00:00Z'); // KST 2026-10-24
  const row = (song, diff, date, style = 1, version = 30) => [song, diff, null, null, version, null, date, style, null, null];
  const rows = [
    row(9, 2, '2026-07-24'), row(8, 2, '2026-07-24'), // inclusive cutoff
    row(8, 1, '2026-10-24'), row(8, 1, '2026-10-24'), // duplicate
    row(7, 1, '2026-10-25'), row(6, 1, '2026-07-22'),
    row(5, 1, '2026-10-24', 0), row(4, 1, '2026-10-24', 1, -10),
    ['short'],
  ];
  const expected = [
    { song_id: 8, diff: 1, date_kst: '2026-10-24' },
    { song_id: 8, diff: 2, date_kst: '2026-07-24' },
    { song_id: 9, diff: 2, date_kst: '2026-07-24' },
  ];
  assert.deepEqual(recentHistoryFromRows(rows, 1, now), expected);
  assert.deepEqual(recentHistoryFromRows(rows, 1, now), recentHistoryFromRows(rows, 1, now));
});

test('user assembly preserves nulls, omission rules, property order and JSON bytes', () => {
  const fields = { timestamp: '2026-10-24T03:00:00.000Z', userRows: [{ iidx_id: 'abc', sp_r_star: undefined }],
    radars: null, osPattern: {}, persona: null, spPersona: null, reachNps: null,
    dpRows: [{ song_id: 1, diff: 2, date: null }], sp: [{ song_id: 3 }], cumulative: false, dpRecent: null, spRecent: undefined };
  const output = assembleUserDump(fields);
  assert.deepEqual(Object.keys(output), ['_v', 'user', 'radars', 'osPattern', 'persona', 'spPersona', 'reachNps', 'dp', 'sp']);
  assert.deepEqual(Object.keys(output.user), ['iidx_id', 'sp_r_star', 'sp_r_star_model_id', 'sp_r_star_formula_version']);
  assert.equal(JSON.stringify(output), '{"_v":"2026-10-24T03:00:00.000Z","user":{"iidx_id":"abc","sp_r_star":null,"sp_r_star_model_id":null,"sp_r_star_formula_version":null},"radars":null,"osPattern":{},"persona":null,"spPersona":null,"reachNps":null,"dp":[{"song_id":1,"diff":2,"date":null}],"sp":[{"song_id":3}]}');
  assert.deepEqual(Object.keys(assembleUserDump({ ...fields, cumulative: true })),
    ['_v', 'user', 'radars', 'osPattern', 'persona', 'spPersona', 'reachNps', 'dp', 'sp', 'dpRecent', 'spRecent']);
  assert.equal(assembleUserDump({ ...fields, sp: [{ old: true }], cumulative: false }).sp[0].old, true);
});

const fastFixture = () => {
  const aliases = { v: 1, rules: [
    { from: 10, to: 11, scope: 'song' }, { from: 11, to: 12, scope: 'song' },
  ] };
  const aliasesBytes = new TextEncoder().encode(JSON.stringify(aliases));
  const songs = [12, 20, 30].map((song_id) => ({ song_id, textage_song_id: `s${song_id}`, title: `Song ${song_id}`,
    series_no: 1, ac: true, legen: false }));
  const row = (song_id, diff, lamp, ex_score, played_version, date, style, bp, note_count) =>
    [song_id, diff, lamp, ex_score, played_version, date, date.slice(0, 10), style, bp, note_count];
  const previousHistRows = [
    row(10, 0, 2, 500, 32, '2026-10-23T00:00:00Z', 1, 4, 100),
    row(20, 1, 3, 600, 33, '2026-10-23T01:00:00Z', 0, 3, 120),
    row(30, 0, 8, 900, -10, '2026-10-23T02:00:00Z', 1, 1, 200),
    row(12, 2, 4, 700, 32, '2026-10-23T03:00:00Z', 1, 2, 150),
  ];
  const restRows = [{ score_id: 7, iidx_id: 'user7', song_id: 10, diff: 0, lamp: 4, ex_score: 550,
    played_version: 33, date: '2026-10-24T00:00:00Z', date_kst: '2026-10-24', play_style: 1, bp: 2, note_count: 100 },
  { score_id: 8, iidx_id: 'user7', song_id: 10, diff: 0, lamp: 4, ex_score: 550,
    played_version: 33, date: '2026-10-24T00:00:00Z', date_kst: '2026-10-24', play_style: 1, bp: 2, note_count: 100 }];
  const input = { iidxId: 'user7', previousHistRows, restRows, aliases, aliasesBytes, songs,
    previousUser: { user: 'unchanged' }, generation: 1, nowMs: 1792810800000 };
  return { input, row };
};

test('prepareFastDump is deterministic for fixed nowMs and emits fixed patch keys', () => {
  const { input } = fastFixture();
  const first = prepareFastDump(input);
  const second = prepareFastDump(input);
  assert.deepEqual(first.histBytes, second.histBytes);
  assert.deepEqual(first.fastPatch, second.fastPatch);
  assert.deepEqual(Object.keys(first.fastPatch), ['dp', 'sp', 'dpRecent', 'spRecent', 'fastGeneration', 'histRevision']);
  assert.equal(first.fastPatch.histRevision, sha256Hex(first.histBytes));
  assert.equal(first.fastPatch.fastGeneration, 1);
});

test('prepareFastDump matches canonical alias chain and duplicate replay results', () => {
  const { input } = fastFixture();
  const normalized = normalizeAliasInputs({ histRows: input.previousHistRows, restRows: input.restRows,
    aliases: input.aliases, songs: input.songs });
  const expected = replayScoreBuffer(normalized.histRows, normalized.restRows);
  const result = prepareFastDump(input);
  assert.deepEqual(result.histRows, expected);
  const candidate = buildCandidate({ iidxId: input.iidxId, restRows: input.restRows,
    previousHistRows: input.previousHistRows, aliases: input.aliases, aliasesBytes: input.aliasesBytes,
    songs: input.songs, publishedHistBytes: result.histBytes, downloadedHistBytes: result.histBytes });
  assert.deepEqual(result.candidate, candidate);
});

test('prepareFastDump retains late version 33 and replay is idempotent', () => {
  const { input } = fastFixture();
  const result = prepareFastDump(input);
  assert.ok(result.histRows.some((row) => row[0] === 12 && row[4] === 33));
  const normalizedAgain = normalizeAliasInputs({ histRows: result.histRows, restRows: input.restRows,
    aliases: input.aliases, songs: input.songs });
  const again = replayScoreBuffer(normalizedAgain.histRows, normalizedAgain.restRows);
  assert.deepEqual(again, result.histRows);
});

test('prepareFastDump preserves DBR and excludes it from grids, recent, and deletion fingerprints', () => {
  const { input } = fastFixture();
  const result = prepareFastDump(input);
  assert.ok(result.histRows.some((row) => row[4] === -10));
  assert.ok(!result.fastPatch.dp.some((row) => row.song_id === 30));
  assert.ok(!result.fastPatch.sp.some((row) => row.song_id === 30));
  assert.ok(!result.fastPatch.dpRecent.some((row) => row.song_id === 30));
  assert.ok(!result.candidate.rows.some((row) => row.played_version === -10));
});

test('prepareFastDump leaves all input values and REST fingerprint fields untouched', () => {
  const { input } = fastFixture();
  const before = structuredClone(input);
  prepareFastDump(input);
  assert.deepEqual(input, before);
});

test('prepareFastDump rejects invalid generation, alias bytes, and another user fingerprint', () => {
  const { input } = fastFixture();
  for (const generation of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => prepareFastDump({ ...input, generation }), /generation/);
  }
  assert.throws(() => prepareFastDump({ ...input, aliasesBytes: new TextEncoder().encode('{"v":1,"rules":[]}') }), /aliases differ/);
  assert.throws(() => prepareFastDump({ ...input, restRows: input.restRows.map((row) => ({ ...row, iidx_id: 'other' })) }), /differs from requested user/);
});

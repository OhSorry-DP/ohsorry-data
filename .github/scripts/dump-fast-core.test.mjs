import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleUserDump, HIST_COLS, recentHistoryFromRows, slimRow } from './dump-fast-core.mjs';

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

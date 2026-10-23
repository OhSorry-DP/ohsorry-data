import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildHistoryRankings } from './ranking-from-history.mjs';
import { normalizeAliasInputs } from './song-aliases.mjs';
import { parseContentRangeTotal, toOutput, validateRows } from './dump-first-place.mjs';

const script = fileURLToPath(new URL('./dump-first-place.mjs', import.meta.url));
const createdAt = '2026-10-24T00:00:00.000Z';

test('toOutput keeps the complete _v,n,w contract, ID keys, and sorted chart pairs', () => {
  const rows = [
    { song_id: 8, diff: 3, iidx_id: 'z', extra: 'ignored' },
    { song_id: 4, diff: 2, iidx_id: 'a' },
    { song_id: 4, diff: 1, iidx_id: 'a' },
    { song_id: 2, diff: 2, iidx_id: 'a' },
  ];
  assert.deepEqual(toOutput(rows, createdAt), {
    _v: createdAt, n: 4, w: { a: [[2, 2], [4, 1], [4, 2]], z: [[8, 3]] },
  });
  assert.deepEqual(Object.keys(toOutput(rows, createdAt)), ['_v', 'n', 'w']);
  assert.deepEqual(Object.keys(toOutput(rows, createdAt).w), ['a', 'z']);
});

test('validateRows rejects empty input, duplicate charts, blank IDs, and noninteger song or diff', () => {
  assert.throws(() => validateRows([]));
  assert.throws(() => validateRows([{ song_id: 1, diff: 1, iidx_id: 'a' }, { song_id: 1, diff: 1, iidx_id: 'b' }]));
  assert.throws(() => validateRows([{ song_id: 1, diff: 1, iidx_id: '  ' }]));
  assert.throws(() => validateRows([{ song_id: 1.5, diff: 1, iidx_id: 'a' }]));
  assert.throws(() => validateRows([{ song_id: 1, diff: '2', iidx_id: 'a' }]));
});

test('P01 winners feed the existing toOutput contract; late uploads, EX zero, and NULL are handled', () => {
  const aliases = { v: 1, rules: [] };
  const songs = [{ song_id: 1 }, { song_id: 2 }];
  const make = (song, ex, version, date) => [song, 0, 5, ex, version, date, '2026-10-23', 1, 10, 100];
  const raw = [
    ['late', [make(1, 900, 33, '2026-10-23T00:00:00.000002+00:00')]],
    ['best', [make(1, 900, 34, '2026-10-23T00:00:00.000001+00:00')]],
    ['zero', [make(2, 0, 0, '2026-10-23T00:00:00.000000+00:00')]],
  ];
  const histories = new Map(raw.map(([id, histRows]) => [id,
    normalizeAliasInputs({ histRows, restRows: [], aliases, songs }).histRows]));
  const result = buildHistoryRankings({ users: raw.map(([iidx_id]) => ({ iidx_id, dj_name: null })), histories });
  assert.deepEqual(result.winners, [
    { song_id: 1, diff: 0, iidx_id: 'best' },
    { song_id: 2, diff: 0, iidx_id: 'zero' },
  ]);
  assert.equal(result.winners.some(({ iidx_id }) => iidx_id === 'null'), false);
  assert.deepEqual(toOutput(result.winners, createdAt), {
    _v: createdAt, n: 2, w: { best: [[1, 0]], zero: [[2, 0]] },
  });
});

test('whole history winner uses EX DESC and precise instant ASC, then normalized row key', () => {
  const aliases = { v: 1, rules: [] };
  const songs = [{ song_id: 1 }];
  const rows = [
    ['late', [1, 0, 1, 700, 33, '2026-10-23T09:00:00.123457+00:00', '2026-10-23', 1, 1, 10]],
    ['early', [1, 0, 2, 700, 33, '2026-10-23T00:00:00.123456Z', '2026-10-23', 1, 2, 10]],
    ['same-a', [1, 0, 3, 700, 33, '2026-10-23T09:00:00.123456+09:00', '2026-10-23', 1, 3, 10]],
    ['same-b', [1, 0, 4, 700, 33, '2026-10-23T00:00:00.123456+00:00', '2026-10-23', 1, 4, 10]],
    ['high', [1, 0, 5, 800, 33, '2026-10-23T00:00:00.123457+00:00', '2026-10-23', 1, 5, 10]],
  ];
  const histories = new Map(rows.map(([id, row]) => [id, normalizeAliasInputs({ histRows: [row], restRows: [], aliases, songs }).histRows]));
  const result = buildHistoryRankings({ users: rows.map(([iidx_id]) => ({ iidx_id, dj_name: null })), histories });
  assert.deepEqual(result.winners, [{ song_id: 1, diff: 0, iidx_id: 'high' }]);
  assert.equal(result.charts[0].rows[0].ex_score, 800);
  assert.equal(result.winners[0].iidx_id, 'high');
  const tiedHistories = new Map([
    ['z', normalizeAliasInputs({ histRows: [[1, 0, 1, 700, 33, '2026-10-23T00:00:00.123456Z', '2026-10-23', 1, 1, 10]], restRows: [], aliases, songs }).histRows],
    ['a', normalizeAliasInputs({ histRows: [[1, 0, 1, 700, 33, '2026-10-23T09:00:00.123456+09:00', '2026-10-23', 1, 1, 10]], restRows: [], aliases, songs }).histRows],
  ]);
  const tied = buildHistoryRankings({ users: ['z', 'a'].map((iidx_id) => ({ iidx_id, dj_name: null })), histories: tiedHistories });
  assert.equal(tied.winners[0].iidx_id, 'a');
});

test('Content-Range parser accepts totals and wildcard, rejects malformed headers', () => {
  assert.equal(parseContentRangeTotal('0-999/7234'), 7234);
  assert.equal(parseContentRangeTotal('0-0/0'), 0);
  assert.equal(parseContentRangeTotal('0-999/*'), null);
  for (const header of ['7234', 'items 0-1/2', '0-1/-1', '0-1/2x', ' 0-1/2']) {
    assert.equal(parseContentRangeTotal(header), null);
  }
});

test('import is side-effect free and standalone CLI prints guidance and exits 1', () => {
  assert.equal(typeof toOutput, 'function');
  const env = { ...process.env, SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '' };
  const child = spawnSync(process.execPath, [script], { encoding: 'utf8', env });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /dump-chart-rankings\.mjs/);
});

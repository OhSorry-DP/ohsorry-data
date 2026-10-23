import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSqlCandidates, compareRankingRow, judgeSqlRanking, judgeSqlWinner,
  compareFingerprints, createReadOnlyFetch, fetchSqlWinners, compareHistoryRankings,
} from './compare-history-rankings.mjs';

const dateA = '2026-10-23T01:02:03.123456+00:00';
const dateZ = '2026-10-23T01:02:03.123456Z';
const row = (id, ex, date = dateA, lamp = 4, bp = 12, notes = 1000, song = 100, diff = 3) =>
  [song, diff, lamp, ex, 33, date, '2026-10-23', 1, bp, notes];
const user = (id, dj_name = `DJ${id}`) => ({ iidx_id: id, dj_name });
const publicRow = (id, rank, ex, date = dateA, dj_name = `DJ${id}`, lamp = 4, bp = 12, note_count = 1000) =>
  ({ rank, iidx_id: id, dj_name, ex_score: ex, lamp, played_version: 33, date, bp, note_count });
const candidate = (histories, users = [user('a'), user('b'), user('c')]) =>
  buildSqlCandidates({ users, histories });

test('compares all nine fields; equivalent timestamp spellings are diagnostic and microseconds matter', () => {
  const expected = publicRow('a', 1, 2000);
  const equivalent = compareRankingRow(expected, { ...expected, date: dateZ });
  assert.equal(equivalent.equal, true);
  assert.deepEqual(equivalent.differences, []);
  assert.equal(equivalent.dateRepresentations.length, 1);
  assert.equal(compareRankingRow(expected, { ...expected, lamp: 3 }).equal, false);
  assert.equal(compareRankingRow(expected, { ...expected, bp: 13 }).equal, false);
  assert.equal(compareRankingRow(expected, { ...expected, note_count: 999 }).equal, false);
  assert.equal(compareRankingRow(expected, { ...expected, dj_name: 'Other' }).equal, false);
  assert.equal(compareRankingRow(expected, { ...expected, date: '2026-10-23T01:02:03.123457Z' }).equal, false);
});

test('accepts any SQL actual highest-EX representative, but rejects mixed source fields and lower EX', () => {
  const histories = new Map([['a', [row('a', 2000, '2026-10-23T01:00:00Z', 2, 20, 900), row('a', 2000, '2026-10-23T02:00:00Z', 5, 10, 1100), row('a', 1900, dateA, 6)]]]);
  const chart = candidate(histories, [user('a')]).get('100/3');
  const actual = [{ ...publicRow('a', 1, 2000, '2026-10-23T02:00:00Z', 'DJa', 5, 10, 1100) }];
  assert.equal(judgeSqlRanking(chart, actual).valid, true);
  assert.equal(judgeSqlRanking(chart, [{ ...actual[0], lamp: 2 }]).valid, false);
  assert.equal(judgeSqlRanking(chart, [{ ...actual[0], ex_score: 1900 }]).valid, false);
  assert.equal(judgeSqlRanking(chart, [{ ...actual[0], dj_name: 'wrong' }]).valid, false);
  const mixed = [{ ...actual[0], lamp: 2, bp: 10, note_count: 1100 }];
  assert.equal(judgeSqlRanking(chart, mixed).valid, false);
});

test('accepts a feasible alternative at the EX=101 boundary and rejects incomplete or impossible sets', () => {
  const users = Array.from({ length: 102 }, (_, n) => user(`u${String(n).padStart(3, '0')}`));
  const histories = new Map(users.map((u, n) => [u.iidx_id, [row(u.iidx_id, n === 0 ? 1000 : n <= 100 ? 900 : 800)]]));
  const chart = candidate(histories, users).get('100/3');
  const make = (id, rank, ex) => publicRow(id, rank, ex);
  const feasible = [make('u000', 1, 1000), ...Array.from({ length: 99 }, (_, n) => make(`u${String(n + 2).padStart(3, '0')}`, 2, 900))];
  assert.equal(feasible.length, 100);
  assert.equal(judgeSqlRanking(chart, feasible).valid, true);
  assert.equal(judgeSqlRanking(chart, feasible.slice(0, 99)).valid, false);
  assert.equal(judgeSqlRanking(chart, [...feasible.slice(0, 99), feasible[1]]).valid, false);
  assert.equal(judgeSqlRanking(chart, feasible.map((r, i) => ({ ...r, rank: i + 1 }))).valid, false);
  assert.equal(judgeSqlRanking(chart, [...feasible.slice(0, 99), make('outsider', 2, 900)]).valid, false);
  assert.equal(judgeSqlRanking(chart, [...feasible.slice(0, 99), make('u101', 2, 900)]).valid, false);
  assert.equal(judgeSqlRanking(chart, [...feasible.slice(0, 99), make('u101', 2, 800)]).valid, false);
});

test('winner accepts ties in EX and earliest instant; rejects later date and handles zero/NULL EX', () => {
  const histories = new Map([
    ['a', [row('a', 2000, '2026-10-23T00:00:00Z')]],
    ['b', [row('b', 2000, '2026-10-23T00:00:00.000000+00:00')]],
    ['c', [row('c', 2000, '2026-10-24T00:00:00Z')]],
    ['z', [row('z', 0, dateA, 1, 0, 0, 101, 2)]],
    ['n', [row('n', null, dateA, 1, 0, 0, 102, 2)]],
  ]);
  const charts = candidate(histories, [...histories.keys()].map(id => user(id)));
  assert.equal(judgeSqlWinner(charts.get('100/3'), 'b').valid, true);
  assert.equal(judgeSqlWinner(charts.get('100/3'), 'c').valid, false);
  assert.equal(judgeSqlWinner(charts.get('101/2'), 'z').valid, true);
  assert.equal(judgeSqlWinner(charts.get('102/2'), 'n').valid, false);
});

const fingerprint = (etag = 'e1') => ({ version: 1, hist: [{ key: 'hist/a.json', etag }], etags_complete: true,
  missing_etag_keys: [], aliases_hash: 'a', songs_hash: 's', users_hash: 'u' });
test('fingerprints require complete ETags and identical input snapshots', () => {
  assert.equal(compareFingerprints(fingerprint(), fingerprint()).valid, true);
  assert.equal(compareFingerprints(fingerprint(), fingerprint('changed')).valid, false);
  assert.equal(compareFingerprints(fingerprint(), { ...fingerprint(), etags_complete: false }).valid, false);
  assert.equal(compareFingerprints(fingerprint(), { ...fingerprint(), hist: [{ key: 'hist/a.json', etag: '' }] }).valid, false);
});

test('fetches actual 1000-row plus next page using PostgREST object arrays and Content-Range headers', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const offset = new URL(url).searchParams.get('offset');
    const page = offset === '0' ? Array.from({ length: 1000 }, (_, n) => ({ song_id: n, diff: 0, iidx_id: `u${n}` })) :
      [{ song_id: 1000, diff: 0, iidx_id: 'last' }];
    const start = Number(offset), end = start + page.length - 1;
    return { ok: true, headers: new Headers({ 'Content-Range': `${start}-${end}/1001` }), json: async () => page };
  };
  const rows = await fetchSqlWinners({ fetchImpl, supabaseUrl: 'https://db.example', serviceKey: 'secret' });
  assert.equal(rows.length, 1001);
  assert.equal(calls.length, 2);
  for (const [n, call] of calls.entries()) {
    assert.equal(call.url, `https://db.example/rest/v1/rpc/get_first_place_winners?limit=1000&offset=${n * 1000}&order=song_id.asc,diff.asc`);
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.Prefer, 'count=exact');
    assert.equal(call.init.headers['Content-Type'], 'application/json');
    assert.equal(call.init.body, '{}');
  }
});

test('rejects partial first-place paging and read-only fetch blocks every unsupported or mutating request', async () => {
  await assert.rejects(fetchSqlWinners({ supabaseUrl: 'https://db.example', serviceKey: 'x', fetchImpl: async () => ({
    ok: true, headers: new Headers({ 'Content-Range': '0-998/1000' }), json: async () => Array.from({ length: 999 }, (_, n) => ({ song_id: n, diff: 0, iidx_id: `u${n}` })),
  }) }), /page count mismatch/);
  const safe = createReadOnlyFetch(async () => ({ ok: true }), { supabaseUrl: 'https://db.example' });
  for (const [url, method] of [
    ['https://db.example/rest/v1/scores', 'GET'], ['https://db.example/rest/v1/users', 'PUT'],
    ['https://db.example/rest/v1/users', 'DELETE'], ['https://db.example/rest/v1/rpc/refresh', 'POST'],
    ['https://db.example/rest/v1/rpc/unknown', 'POST'], ['https://db.example/rest/v1/rpc/get_chart_ranking_v2', 'PUT'],
  ]) await assert.rejects(safe(url, { method }), /Read-only network policy rejected/);
  assert.equal((await safe('https://db.example/rest/v1/users', { method: 'GET' })).ok, true);
  assert.equal((await safe('https://api.cloudflare.com/client/v4/accounts/607eea1b073bea6747e6e9b76f2d7b41/r2/buckets/ohsorry-data/objects?prefix=hist%2F', { method: 'GET' })).ok, true);
});

test('integration discovers union scope, uses expected RPC and R2/user reads, counts only SQL in summary, and invalidates changed fingerprints', async () => {
  const calls = [], reads = [], lists = [], fingerprint1 = fingerprint(), fingerprint2 = fingerprint();
  let endFingerprint = fingerprint1;
  const inputs = { users: [user('a')], histories: new Map([['a', [row('a', 2000, dateA, 4, 12, 1000, 100, 3)]]]), fingerprint: fingerprint1, diagnostics: {} };
  const deps = {
    supabaseUrl: 'https://db.example', serviceKey: 'secret', account: 'acct',
    loadInputs: async () => inputs, verifyFingerprint: async () => endFingerprint,
    buildRankings: async () => ({ charts: [{ song_id: 100, diff: 3, rows: [publicRow('a', 1, 2000)] }], winners: [{ song_id: 100, diff: 3, iidx_id: 'a' }] }),
    listEntries: async prefix => { lists.push(prefix); return prefix === 'ranking/' ? [{ key: 'ranking/20-3.json' }] : []; },
    getText: async key => { reads.push(key); return key === 'first-place-winners.json' ? JSON.stringify({ n: 1, w: { b: [[30, 2]] } }) : null; },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('get_first_place_winners')) return { ok: true, headers: new Headers({ 'Content-Range': '0-0/1' }), json: async () => [{ song_id: 40, diff: 4, iidx_id: 'a' }] };
      if (String(url).includes('get_chart_ranking_v2')) {
        const body = JSON.parse(init.body);
        if (body.p_song_id === 10) return { ok: true, json: async () => [] };
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => [{ iidx_id: 'a', dj_name: 'DJa' }] };
    },
    log: () => {},
  };
  const report = await compareHistoryRankings(deps);
  assert.deepEqual(lists, ['ranking/']);
  assert.deepEqual(reads.sort(), ['first-place-winners.json', 'ranking/20-3.json']);
  const rpcCalls = calls.filter(c => c.url.includes('/rpc/'));
  assert.deepEqual(rpcCalls.map(c => new URL(c.url).pathname).sort(), [
    '/rest/v1/rpc/get_chart_ranking_v2', '/rest/v1/rpc/get_chart_ranking_v2',
    '/rest/v1/rpc/get_chart_ranking_v2', '/rest/v1/rpc/get_chart_ranking_v2', '/rest/v1/rpc/get_first_place_winners',
  ].sort());
  const chartCalls = rpcCalls.filter(c => c.url.includes('get_chart_ranking_v2'));
  assert.deepEqual(chartCalls.map(c => JSON.parse(c.init.body)).sort((a, b) => a.p_song_id - b.p_song_id), [20, 30, 40, 100].map(p_song_id => ({ p_song_id, p_diff: p_song_id === 20 ? 3 : p_song_id === 30 ? 2 : p_song_id === 40 ? 4 : 3, p_played_version: null })));
  for (const c of rpcCalls) {
    assert.equal(c.init.method, 'POST');
    assert.equal(c.init.headers.Prefer, 'count=exact');
  }
  assert.equal(report.summary.different, 3);
  assert.equal(report.summary.query_failed, 0);
  assert.equal(report.summary.incomparable, 0);
  assert.equal(report.public_summary.different >= 1, true);
  assert.equal(report.passed, false);
  const publicOnly = await compareHistoryRankings({ ...deps, listEntries: async () => [], getText: async key => key === 'first-place-winners.json' ? JSON.stringify({ n: 0, w: {} }) : null,
    buildRankings: async () => ({ charts: [{ song_id: 100, diff: 3, rows: [publicRow('a', 1, 2000)] }], winners: [{ song_id: 100, diff: 3, iidx_id: 'a' }] }),
    fetchImpl: async (url, init) => {
      if (String(url).includes('get_first_place_winners')) return { ok: true, headers: new Headers({ 'Content-Range': '0-0/1' }), json: async () => [{ song_id: 100, diff: 3, iidx_id: 'a' }] };
      if (String(url).includes('get_chart_ranking_v2')) {
        const body = JSON.parse(init.body);
        return { ok: true, json: async () => body.p_song_id === 100 ? [publicRow('a', 1, 2000)] : [] };
      }
      return { ok: true, json: async () => [{ iidx_id: 'a', dj_name: 'DJa' }] };
    } });
  assert.equal(publicOnly.public_summary.different, 2);
  assert.equal(publicOnly.public_summary.identical, 0);
  assert.equal(publicOnly.summary.different, 0);
  assert.equal(publicOnly.summary.query_failed, 0);
  assert.equal(publicOnly.summary.incomparable, 0);
  assert.equal(publicOnly.fingerprints.valid, true);
  assert.equal(publicOnly.scope_complete, true);
  assert.equal(publicOnly.production_possible, true);
  assert.deepEqual(publicOnly.failures, []);
  assert.equal(publicOnly.public_summary.different > 0 && publicOnly.summary.different === 0 && publicOnly.summary.query_failed === 0 && publicOnly.summary.incomparable === 0 && publicOnly.fingerprints.valid && publicOnly.scope_complete && publicOnly.production_possible && publicOnly.failures.length === 0, true);
  assert.equal(publicOnly.passed, true);

  endFingerprint = { ...fingerprint2, users_hash: 'changed-users-hash' };
  const changed = await compareHistoryRankings(deps);
  assert.equal(changed.fingerprints.valid, false);
  assert.equal(changed.passed, false);
});

test('integration rejects SQL ranking rows outside the computed history ranking', async () => {
  const histories = new Map([
    ['a', [row('a', 2000, dateA, 4, 12, 1000, 100, 3)]],
    ['b', [row('b', 1900, dateA, 4, 12, 1000, 100, 3)]],
  ]);
  const inputs = { users: [user('a'), user('b')], histories, fingerprint: fingerprint(), diagnostics: {} };
  const deps = {
    supabaseUrl: 'https://db.example', serviceKey: 'secret', account: 'acct',
    loadInputs: async () => inputs, verifyFingerprint: async () => fingerprint(),
    buildRankings: async () => ({ charts: [{ song_id: 100, diff: 3, rows: [publicRow('a', 1, 2000)] }], winners: [{ song_id: 100, diff: 3, iidx_id: 'a' }] }),
    listEntries: async () => [], getText: async key => key === 'first-place-winners.json' ? JSON.stringify({ n: 0, w: {} }) : null,
    fetchImpl: async (url, init) => {
      if (String(url).includes('get_first_place_winners')) return { ok: true, headers: new Headers({ 'Content-Range': '*/0' }), json: async () => [] };
      if (String(url).includes('get_chart_ranking_v2')) return { ok: true, json: async () => [publicRow('a', 1, 2000), publicRow('b', 2, 1900)] };
      return { ok: true, json: async () => [{ iidx_id: 'a', dj_name: 'DJa' }, { iidx_id: 'b', dj_name: 'DJb' }] };
    },
    log: () => {},
  };
  const report = await compareHistoryRankings(deps);
  const chart = report.charts.find(item => item.song_id === 100 && item.diff === 3);
  assert.equal(chart.sql_ranking.status, 'different');
  assert.equal(report.passed, false);
});

test('integration rejects a SQL winner who is only matched by a non-candidate computed winner', async () => {
  const histories = new Map([
    ['a', [row('a', 2000, dateA, 4, 12, 1000, 100, 3)]],
    ['b', [row('b', 2000, dateA, 4, 12, 1000, 100, 3)]],
  ]);
  const inputs = { users: [user('a'), user('b'), user('c')], histories, fingerprint: fingerprint(), diagnostics: {} };
  const deps = {
    supabaseUrl: 'https://db.example', serviceKey: 'secret', account: 'acct',
    loadInputs: async () => inputs, verifyFingerprint: async () => fingerprint(),
    buildRankings: async () => ({ charts: [{ song_id: 100, diff: 3, rows: [publicRow('a', 1, 2000), publicRow('b', 1, 2000)] }], winners: [{ song_id: 100, diff: 3, iidx_id: 'c' }] }),
    listEntries: async () => [], getText: async key => key === 'first-place-winners.json' ? JSON.stringify({ n: 0, w: {} }) : null,
    fetchImpl: async (url, init) => {
      if (String(url).includes('get_first_place_winners')) return { ok: true, headers: new Headers({ 'Content-Range': '0-0/1' }), json: async () => [{ song_id: 100, diff: 3, iidx_id: 'a' }] };
      if (String(url).includes('get_chart_ranking_v2')) return { ok: true, json: async () => [publicRow('a', 1, 2000), publicRow('b', 1, 2000)] };
      return { ok: true, json: async () => [{ iidx_id: 'a', dj_name: 'DJa' }, { iidx_id: 'b', dj_name: 'DJb' }, { iidx_id: 'c', dj_name: 'DJc' }] };
    },
    log: () => {},
  };
  const report = await compareHistoryRankings(deps);
  const chart = report.charts.find(item => item.song_id === 100 && item.diff === 3);
  assert.equal(chart.sql_winner.status, 'different');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { exitCodeForResult, run, serializeRows } from './dump-chart-rankings.mjs';
import { md5 } from './r2-client.mjs';
import { buildHistoryRankings } from './ranking-from-history.mjs';

const quiet = { log() {}, error() {} };
const users = [{ iidx_id: 'a', dj_name: null }, { iidx_id: 'b', dj_name: 'Bee' }];
const ranking = (song, diff, rows) => ({ song_id: song, diff, rows });
const publicRow = (id, ex = 100, date = '2026-10-24T00:00:00.000000+00:00', rank = 1) => ({
  rank, iidx_id: id, dj_name: null, ex_score: ex, lamp: 4, played_version: 34, date, bp: 2, note_count: 10,
});
function fixture({ charts = [ranking(1, 2, [publicRow('a')])], winners = [{ song_id: 1, diff: 2, iidx_id: 'a' }],
  remote = [], texts = {}, putText, del, loadInputs, buildRankings, mode = 'publish' } = {}) {
  const calls = { put: [], del: [], gets: [], lists: [], loads: 0 };
  const deps = {
    mode, log: quiet,
    loadInputs: loadInputs ?? (async () => { calls.loads++; return { users, histories: new Map([['a', []], ['b', []]]), fingerprint: {}, diagnostics: {} }; }),
    buildRankings: buildRankings ?? (async () => ({ charts, winners })),
    getText: async (key) => { calls.gets.push(key); return texts[key] ?? null; },
    listEntries: async (prefix) => { calls.lists.push(prefix); return remote; },
    putText: async (key, body) => { calls.put.push([key, body]); return putText ? putText(key, body) : { ok: true }; },
    del: async (key) => { calls.del.push(key); return del ? del(key) : true; },
  };
  return { calls, deps };
}
const go = (options) => { const f = fixture(options); return { ...f, promise: run(f.deps) }; };

test('serializeRows is deterministic and compares microsecond instants, then ID', () => {
  const later = publicRow('a', 200, '2026-10-24T01:02:03.123457+00:00');
  const earlier = publicRow('z', 200, '2026-10-24T01:02:03.123456+00:00');
  const sameDateLowId = publicRow('a', 200, earlier.date);
  const expected = JSON.stringify([sameDateLowId, earlier, later]);
  assert.equal(serializeRows([later, sameDateLowId, earlier]), expected);
  assert.equal(serializeRows([earlier, later, sameDateLowId]), expected);
});

test('history ranking includes current user history, competition ranks, exact 100 row cut, and late uploads', async () => {
  const mk = (ex, day, id, version = 34) => [10, 2, 4, ex, version,
    `2026-10-${day}T00:00:00.000000+00:00`, `2026-10-${day}`, 1, 2, 10];
  const histories = new Map([
    ['a', [mk(300, '24', 'a'), mk(350, '23', 'a')]],
    ['b', [mk(350, '24', 'b')]],
  ]);
  let first = buildHistoryRankings({ users, histories });
  assert.deepEqual(first.charts[0].rows.map((r) => [r.iidx_id, r.rank]), [['a', 1], ['b', 1]]);
  assert.equal(first.charts[0].rows.length, 2);
  // Add a 33 season upload after the first calculation: each calculation consumes its fresh full map.
  histories.get('b').push(mk(250, '22', 'b', 33));
  first = buildHistoryRankings({ users, histories });
  assert.deepEqual(first.charts[0].rows.map((r) => [r.iidx_id, r.rank]), [['a', 1], ['b', 1]]);
  assert.equal(first.winners[0].iidx_id, 'a');
  const many = new Map(Array.from({ length: 101 }, (_, i) => [String(i).padStart(3, '0'), [mk(1000 - i, '24', 'x')]]));
  const allUsers = [...many.keys()].map((iidx_id) => ({ iidx_id, dj_name: null }));
  assert.equal(buildHistoryRankings({ users: allUsers, histories: many }).charts[0].rows.length, 100);
});

test('whole input is loaded on every run; new charts are discovered without existing ranking keys', async () => {
  let historyGeneration = 0;
  const loadInputs = async () => {
    historyGeneration++;
    return { users, histories: new Map([['a', [[20, 3, 4, 100, 33, `2026-10-2${historyGeneration}T00:00:00.123456+00:00`, '2026-10-24', 1, null, null]]]]), fingerprint: {}, diagnostics: {} };
  };
  const buildRankings = async ({ histories }) => ({ charts: [ranking(20, 3, [publicRow('a', histories.get('a')[0][3])])], winners: [{ song_id: 20, diff: 3, iidx_id: 'a' }] });
  const f = fixture({ remote: [], loadInputs, buildRankings });
  const first = await run(f.deps), second = await run(f.deps);
  assert.equal(first.charts.some(([s, d]) => s === 20 && d === 3), true);
  assert.equal(second.charts.some(([s, d]) => s === 20 && d === 3), true);
  assert.equal(historyGeneration, 2);
});

test('preflight failures never PUT or DELETE; empty valid history remains allowed', async (t) => {
  const failures = [
    ['hist GET', async () => { throw Error('hist GET'); }],
    ['users', async () => { throw Error('users'); }],
    ['aliases', async () => { throw Error('aliases'); }],
    ['concurrent change', async () => { throw Error('changed'); }],
  ];
  for (const [label, loadInputs] of failures) await t.test(label, async () => {
    const f = fixture({ loadInputs }); await assert.rejects(run(f.deps));
    assert.equal(f.calls.put.length + f.calls.del.length, 0);
  });
  for (const [label, mutate] of [
    ['null output', (x) => { x.charts = [ranking(1, 2, [publicRow('a', null)])]; }],
    ['empty winners', (x) => { x.winners = []; }],
  ]) await t.test(label, async () => {
    const opts = { charts: [ranking(1, 2, [publicRow('a')])], winners: [{ song_id: 1, diff: 2, iidx_id: 'a' }] }; mutate(opts);
    const f = fixture({ ...opts, remote: [{ key: 'ranking/9-9.json', etag: 'x' }] });
    await assert.rejects(run(f.deps)); assert.equal(f.calls.put.length + f.calls.del.length, 0);
  });
  const badList = fixture({ remote: [{ key: 'ranking/1-2.json', etag: 'x' }], });
  badList.deps.listEntries = async (prefix) => { if (prefix === 'ranking/') throw Error('list failure'); return []; };
  await assert.rejects(run(badList.deps)); assert.equal(badList.calls.put.length + badList.calls.del.length, 0);
  const badGet = fixture({ remote: [{ key: 'ranking/1-2.json', etag: 'unknown' }] });
  badGet.deps.getText = async () => { throw Error('existing GET failure'); };
  await assert.rejects(run(badGet.deps)); assert.equal(badGet.calls.put.length + badGet.calls.del.length, 0);
  const empty = fixture({ charts: [ranking(1, 2, [])] });
  const result = await run(empty.deps); assert.equal(result.failures, 0);
});

test('ETag and body comparisons skip identical bodies, PUT only changed content, and delete confirmed empty keys', async () => {
  const body = JSON.stringify([publicRow('a')]);
  const f = fixture({ charts: [ranking(1, 2, [publicRow('a')]), ranking(2, 2, [publicRow('a', 99)])],
    winners: [{ song_id: 1, diff: 2, iidx_id: 'a' }, { song_id: 2, diff: 2, iidx_id: 'a' }],
    remote: [{ key: 'ranking/1-2.json', etag: md5(body) }, { key: 'ranking/2-2.json', etag: 'multipart' }, { key: 'ranking/3-3.json', etag: md5('old') }],
    texts: { 'ranking/2-2.json': 'old', 'ranking/3-3.json': 'existing',
      'first-place-winners.json': JSON.stringify({ _v: 'old', n: 2, w: { a: [[1, 2], [2, 2]] } }) } });
  const result = await run(f.deps);
  assert.deepEqual(f.calls.put.map(([key]) => key), ['ranking/2-2.json']);
  assert.deepEqual(f.calls.del, ['ranking/3-3.json']);
  assert.equal(result.skips, 2);
});

test('same first-place n,w retain _v and exact body without PUT', async () => {
  const old = JSON.stringify({ _v: 'kept', n: 1, w: { a: [[1, 2]] } });
  const f = fixture({ texts: { 'first-place-winners.json': old } });
  const result = await run(f.deps);
  assert.equal(result.firstPlace.body, old);
  assert.equal(f.calls.put.some(([key]) => key === 'first-place-winners.json'), false);
});

test('partial chart failure leaves failed key and winner untouched; successful peers may publish and retry recollects', async () => {
  const charts = [ranking(1, 2, [publicRow('a')]), ranking(2, 2, [publicRow('b', 90)])];
  const winners = [{ song_id: 1, diff: 2, iidx_id: 'a' }, { song_id: 2, diff: 2, iidx_id: 'b' }];
  let fail = true, collections = 0;
  const oldWinners = JSON.stringify({ _v: 'old', n: 2, w: { a: [[1, 2]], b: [[2, 2]] } });
  const saved = new Map([['ranking/1-2.json', 'original-one'], ['ranking/2-2.json', 'original-two'], ['first-place-winners.json', oldWinners]]);
  const f = fixture({ charts, winners, loadInputs: async () => { collections++; return { users, histories: new Map(), fingerprint: {}, diagnostics: {} }; },
    putText: async (key, body) => { if (key === 'ranking/1-2.json' && fail) return { ok: false, msg: 'injected' }; saved.set(key, body); return { ok: true }; } });
  f.deps.getText = async (key) => saved.get(key) ?? null;
  const first = await run(f.deps);
  assert.equal(exitCodeForResult(first), 1);
  assert.equal(first.firstPlaceSkipped, true);
  assert.equal(saved.get('ranking/1-2.json'), 'original-one');
  assert.notEqual(saved.get('ranking/2-2.json'), 'original-two');
  assert.equal(saved.get('first-place-winners.json'), oldWinners);
  fail = false;
  const second = await run(f.deps);
  assert.equal(collections, 2);
  assert.equal(second.failures, 0);
  assert.equal(saved.has('ranking/1-2.json'), true);
  assert.equal(saved.has('ranking/2-2.json'), true);
});

test('observe never mutates; missing or misspelled mode fails', async () => {
  const f = fixture({ mode: 'observe' }); const result = await run(f.deps);
  assert.equal(result.puts + result.deletes, 0); assert.equal(f.calls.put.length + f.calls.del.length, 0);
  for (const mode of [undefined, 'publsh']) { const x = fixture({ mode }); x.deps.mode = mode; await assert.rejects(run(x.deps)); assert.equal(x.calls.put.length + x.calls.del.length, 0); }
});

test('production run uses injected fetch through actual R2/users helpers; forbidden legacy endpoints throw', async () => {
  const seen = [];
  const fakeFetch = async (input, init = {}) => {
    const url = String(input); const method = init.method ?? 'GET'; seen.push([url, method]);
    if (method === 'PUT' || method === 'DELETE') return new Response(null, { status: 200 });
    if (url.includes('/rest/v1/users')) return Response.json([{ iidx_id: 'a', dj_name: null, user_ohsorry_radars: [] }]);
    if (url.includes('/objects/?')) {
      const prefix = new URL(url).searchParams.get('prefix');
      const result = prefix === 'hist/' ? [{ key: 'hist/a.json', etag: '0123456789abcdef0123456789abcdef' }] : [];
      return Response.json({ success: true, result, result_info: { cursor: '' } });
    }
    if (url.includes('/objects/hist/a.json')) return new Response(JSON.stringify([[1, 2, 4, 100, 34, '2026-10-24T00:00:00.123456+00:00', '2026-10-24', 1, 2, 10]]));
    if (url.includes('song-aliases.json')) return new Response(JSON.stringify({ v: 1, rules: [] }));
    if (url.includes('/objects/songs.json')) return new Response('[]');
    if (url.includes('/objects/first-place-winners.json')) return new Response(null, { status: 404 });
    if (url.includes('/objects/ranking/')) return new Response(null, { status: 404 });
    if (/\/scores|rpc|cdn|data\.iidx\.in/.test(url)) throw new Error(`forbidden request ${url}`);
    throw new Error(`unexpected request ${method} ${url}`);
  };
  const result = await run({ mode: 'publish', log: quiet, buildRankings: async () => ({
    charts: [ranking(1, 2, [publicRow('a')])], winners: [{ song_id: 1, diff: 2, iidx_id: 'a' }],
  }), fetchImpl: fakeFetch, supabaseUrl: 'https://db.example', serviceKey: 'secret',
    r2Options: { token: 'token', base: 'https://api.cloudflare.com/client/v4/accounts/acct/r2/buckets/ohsorry-data/objects/' } });
  assert.equal(result.failures, 0);
  assert.ok(seen.some(([url, method]) => url.includes('/rest/v1/users') && method === 'GET'));
  assert.ok(seen.some(([url, method]) => url.includes('/objects/?') && method === 'GET'));
  assert.ok(seen.some(([url, method]) => url.includes('/objects/hist/a.json') && method === 'GET'));
  assert.ok(seen.some(([url, method]) => url.includes('/objects/ranking/1-2.json') && method === 'PUT'));
});

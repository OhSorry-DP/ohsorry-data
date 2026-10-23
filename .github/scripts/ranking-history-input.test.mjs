import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadHistoryInputs, verifyFingerprint } from './ranking-history-input.mjs';
import { listEntries as r2ListEntries, getText as r2GetText, conditionalR2Client } from './r2-client.mjs';
import { normalizeAliasInputs } from './song-aliases.mjs';

const ACCOUNT = 'test-account';
const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets/ohsorry-data/objects`;
const SUPABASE = 'https://supabase.example';
const TOKEN = 'test-token';
const hash = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const aliases = { v: 1, rules: [
  { from: 100, to: 200, scope: 'song' },
  { from: 300, to: 400, scope: 'chart-ac', diff: 3 },
] };
const songs = [{ song_id: 200 }, { song_id: 300 }, { song_id: 400 }, { song_id: 500 }];
const row8 = [100, 3, 5, 1900, 33, '2026-10-23T16:02:03.123456+00:00', '2026-10-24', 1];
const row10 = [300, 3, 6, 2000, 34, '2026-10-23T16:02:03.123457+00:00', '2026-10-24', 1, 12, 1400];
const users = [{ iidx_id: 'u1', dj_name: 'DJ One' }, { iidx_id: 'u2', dj_name: null }, { iidx_id: 'u3', dj_name: 'DJ Three' }];
const etag = (body) => `"${createHash('md5').update(body).digest('hex')}"`;
const jsonResponse = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });
const textResponse = (value, status = 200, headers = {}) => new Response(value, { status, headers });

function fixture(options = {}) {
  const state = {
    users: structuredClone(options.users ?? users), aliases: structuredClone(options.aliases ?? aliases),
    songs: structuredClone(options.songs ?? songs), histories: new Map(options.histories ?? [
      ['u1', JSON.stringify([row8, row10])], ['old9', '[]'],
    ]),
    etags: new Map(), listCalls: [], histCalls: [], userCalls: [], calls: [], cursorMode: 'initial',
  };
  const refreshEtags = () => {
    state.etags.clear();
    for (const [id, body] of state.histories) state.etags.set(`hist/${id}.json`, etag(body));
    state.etags.set('meta/song-aliases.json', etag(JSON.stringify(state.aliases)));
    state.etags.set('songs.json', etag(JSON.stringify(state.songs)));
  };
  refreshEtags();
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    state.calls.push({ url: url.href, method });
    assert.equal(method, 'GET', `unexpected method ${method}: ${url.href}`);
    assert.ok(!url.pathname.includes('/scores') && !url.pathname.includes('/rpc/'), `forbidden URL ${url.href}`);
    if (url.origin === new URL(BASE).origin && url.pathname === new URL(BASE).pathname) {
      assert.equal(method, 'GET');
      if (url.searchParams.has('prefix')) {
        state.listCalls.push(url.href);
        assert.equal(url.searchParams.get('prefix'), 'hist/');
        assert.equal(url.searchParams.get('per_page'), '1000');
        const entries = [...state.histories.keys()].map((id) => ({ key: `hist/${id}.json`, etag: state.etags.get(`hist/${id}.json`) }));
        const cut = Math.max(1, Math.ceil(entries.length / 2));
        if (url.searchParams.get('cursor') === 'next') return jsonResponse({ success: true, result: entries.slice(cut) });
        return jsonResponse({ success: true, result: entries.slice(0, cut), result_info: { cursor: entries.length > cut ? 'next' : undefined } });
      }
      throw new Error(`unexpected R2 LIST URL ${url.href}`);
    }
    if (url.origin === new URL(BASE).origin && url.pathname.startsWith(`${new URL(BASE).pathname}/`)) {
      const key = decodeURIComponent(url.pathname.slice(new URL(BASE).pathname.length + 1));
      if (key.startsWith('hist/')) {
        state.histCalls.push(key);
        if (options.histStatus?.[key]) return textResponse('missing', options.histStatus[key]);
      }
      if (key === 'meta/song-aliases.json') return textResponse(JSON.stringify(state.aliases));
      if (key === 'songs.json') return textResponse(JSON.stringify(state.songs));
      return state.histories.has(key.slice(5, -5)) && key.startsWith('hist/')
        ? textResponse(state.histories.get(key.slice(5, -5))) : textResponse('not found', 404);
    }
    if (url.origin === SUPABASE && url.pathname === '/rest/v1/users') {
      state.userCalls.push(url.href);
      assert.equal(url.searchParams.get('select'), 'iidx_id,dj_name,star,r_star,ereter_star,sp_rank,dp_rank,sp_cpi,sp_star,sp_r_star,sp_r_star_model_id,sp_r_star_formula_version,date,user_ohsorry_radars(play_style,notes,chord,peak,charge,scratch,soflan,phrase,jack,trill,rand)');
      assert.equal(url.searchParams.get('limit'), '1000');
      const offset = Number(url.searchParams.get('offset'));
      const rows = offset === 0 ? state.users.slice(0, 1000) : [];
      return jsonResponse(rows);
    }
    throw new Error(`unexpected URL ${url.href}`);
  };
  const depsFetch = async (input, init = {}) => {
    const u = new URL(input);
    if (u.origin === new URL(BASE).origin && u.pathname === new URL(BASE).pathname && u.searchParams.has('prefix')) {
      const cursor = u.searchParams.get('cursor');
      const keys = [...state.histories.keys()];
      const cut = Math.max(1, Math.ceil(keys.length / 2));
      const pageIds = cursor ? keys.slice(cut) : keys.slice(0, cut);
      return jsonResponse({ success: true, result: pageIds.map((id) => ({ key: `hist/${id}.json`, etag: state.etags.get(`hist/${id}.json`) })),
        ...(!cursor && keys.length > cut ? { result_info: { cursor: 'next' } } : {}) });
    }
    if (u.origin === new URL(BASE).origin && u.pathname.startsWith(`${new URL(BASE).pathname}/`)) {
      const key = decodeURIComponent(u.pathname.slice(new URL(BASE).pathname.length + 1));
      if (key.startsWith('hist/')) { state.histCalls.push(key); if (options.histStatus?.[key]) return textResponse('error', options.histStatus[key]); }
      if (key === 'meta/song-aliases.json') return textResponse(JSON.stringify(state.aliases));
      if (key === 'songs.json') return textResponse(JSON.stringify(state.songs));
      const id = key.startsWith('hist/') ? key.slice(5, -5) : '';
      return state.histories.has(id) ? textResponse(state.histories.get(id)) : textResponse('missing', 404);
    }
    return fetchImpl(input, init);
  };
  const deps = { account: ACCOUNT, token: TOKEN, fetchImpl, retry: true, sleep: async () => {},
    requestGate: { run: (fn) => fn(), defer() {} }, supabaseUrl: SUPABASE, serviceKey: 'service-key', log() {},
    listEntries: async (_prefix, opts) => r2ListEntries(_prefix, { ...opts, token: TOKEN, base: BASE, fetchImpl, sleep: async () => {} }),
    getText: async (key, opts) => r2GetText(key, { ...opts, token: TOKEN, base: `${BASE}/`, fetchImpl: depsFetch, sleep: async () => {} }) };
  return { state, deps, refreshEtags };
}

function listedFixture(extra = {}) {
  return fixture({ ...extra, users: extra.users ?? [users[0], users[1]], histories: extra.histories ?? [
    ['u1', JSON.stringify([row8, row10])], ['gone', '[]'],
  ] });
}

test('1 정상 수집: 실제 원문 8/10열, microseconds, empty history와 재수집', async () => {
  const f = listedFixture({ histories: [['u1', JSON.stringify([row8, row10])], ['u2', '[]'], ['gone', '[]']] });
  const first = await loadHistoryInputs(f.deps);
  assert.equal(first.histories.get('u1')[0][8], null);
  assert.equal(first.histories.get('u1')[0][9], null);
  assert.equal(first.histories.get('u1')[0][0], 200);
  assert.equal(first.histories.get('u1')[1][5], row10[5]);
  assert.deepEqual(first.histories.get('u2'), []);
  assert.equal(first.diagnostics.empty_hist, 2);
  const n = f.state.histCalls.length;
  await loadHistoryInputs(f.deps);
  assert.equal(f.state.histCalls.length - n, 3);
  assert.deepEqual(f.state.histCalls.slice(n).sort(), ['hist/gone.json', 'hist/u1.json', 'hist/u2.json']);
});

test('2 LIST/users 차이, 없는 키·중복·잘못된 키·빈 users와 누락 ETag', async () => {
  const f = listedFixture({ histories: [['gone', '[]']], users: [users[0], users[1]] });
  const out = await loadHistoryInputs(f.deps);
  assert.deepEqual(out.histories.get('u1'), []);
  assert.equal(out.diagnostics.users_without_hist.includes('u1'), true);
  assert.equal(out.diagnostics.deleted_user_ids.includes('gone'), true);
  assert.deepEqual(f.state.histCalls, ['hist/gone.json']);
  assert.equal(out.diagnostics.empty_hist, 1);

  const badUsers = fixture({ users: [] });
  await assert.rejects(loadHistoryInputs(badUsers.deps));
  const duplicateUsers = fixture({ users: [users[0], users[0]] });
  await assert.rejects(loadHistoryInputs(duplicateUsers.deps));
  const dup = listedFixture();
  dup.deps.listEntries = async () => [{ key: 'hist/u1.json', etag: 'a' }, { key: 'hist/u1.json', etag: 'b' }];
  await assert.rejects(loadHistoryInputs(dup.deps), /Duplicate/);
  const malformed = listedFixture();
  malformed.deps.listEntries = async () => [{ key: 'hist/not-valid!.json', etag: 'x' }];
  await assert.rejects(loadHistoryInputs(malformed.deps), /Invalid hist LIST key/);

  const noEtag = listedFixture();
  const nf = noEtag.deps.listEntries;
  noEtag.deps.listEntries = async (prefix, opts) => (await nf(prefix, opts)).map(({ key }) => ({ key }));
  const missing = await loadHistoryInputs(noEtag.deps);
  assert.equal(missing.fingerprint.etags_complete, false);
  assert.deepEqual(missing.fingerprint.missing_etag_keys, ['hist/gone.json', 'hist/u1.json']);
});

test('3 listed hist HTTP/JSON/행/date/KST 오류는 실패하고 []는 성공', async () => {
  for (const status of [404, 403, 500]) {
    const f = listedFixture({ histStatus: { 'hist/u1.json': status } });
    await assert.rejects(loadHistoryInputs(f.deps));
  }
  const network = listedFixture();
  const get0 = network.deps.getText;
  network.deps.getText = (key, opts) => key === 'hist/u1.json' ? Promise.reject(new Error('network')) : get0(key, opts);
  await assert.rejects(loadHistoryInputs(network.deps), /network/);
  for (const body of ['{bad', JSON.stringify([[...row8, 1]]), JSON.stringify([[...row8.slice(0, 5), 'bad', ...row8.slice(6)]]),
    JSON.stringify([[...row8.slice(0, 6), '2026-10-23', ...row8.slice(7)]])]) {
    const f = listedFixture(); const get0 = f.deps.getText;
    f.deps.getText = (key, opts) => key === 'hist/u1.json' ? Promise.resolve(body) : get0(key, opts);
    await assert.rejects(loadHistoryInputs(f.deps));
  }
  const empty = listedFixture({ histories: [['u1', '[]'], ['gone', '[]']] });
  assert.equal((await loadHistoryInputs(empty.deps)).diagnostics.empty_hist, 2);
});

test('4 생산 1회 수집과 명시적 fingerprint 대조는 요청 경계 및 ETag 무효 상태를 지킨다', async () => {
  const f = listedFixture();
  const first = await loadHistoryInputs(f.deps);
  assert.equal(f.state.listCalls.length, 2);
  assert.deepEqual(f.state.histCalls.sort(), ['hist/gone.json', 'hist/u1.json']);
  assert.equal(f.state.userCalls.length, 1);
  const before = { lists: f.state.listCalls.length, hist: f.state.histCalls.length, users: f.state.userCalls.length };
  f.state.histories.set('u2', '[]'); f.state.etags.set('hist/u1.json', 'new-etag');
  f.state.aliases = { v: 1, rules: [] }; f.state.songs.push({ song_id: 600 }); f.state.users[0].dj_name = 'Changed'; f.refreshEtags();
  assert.deepEqual({ lists: f.state.listCalls.length, hist: f.state.histCalls.length, users: f.state.userCalls.length }, before);
  assert.deepEqual(first.fingerprint.hist.map((x) => x.key), ['hist/gone.json', 'hist/u1.json']);
  assert.equal(first.fingerprint.users_hash, hash(JSON.stringify([['u1', 'DJ One'], ['u2', null]])));
  const verified = await verifyFingerprint(f.deps);
  assert.equal(f.state.histCalls.length, before.hist);
  assert.notEqual(verified.users_hash, first.fingerprint.users_hash);
  assert.notEqual(verified.songs_hash, first.fingerprint.songs_hash);
  assert.notEqual(verified.aliases_hash, first.fingerprint.aliases_hash);
  assert.deepEqual(verified.hist.map((x) => x.key), ['hist/gone.json', 'hist/u1.json', 'hist/u2.json']);
  const noEtag = listedFixture(); const baseList = noEtag.deps.listEntries;
  noEtag.deps.listEntries = async (prefix, opts) => (await baseList(prefix, opts)).map(({ key }) => ({ key }));
  const prod = await loadHistoryInputs(noEtag.deps);
  assert.equal(prod.fingerprint.etags_complete, false);
  const compared = await verifyFingerprint(noEtag.deps);
  assert.equal(compared.etags_complete, false);
});

test('5 alias 버전 범위, 충돌 결과가 기존 정규화와 일치하고 입력은 불변', () => {
  const source = [
    [100, 3, 5, 1900, 33, row8[5], row8[6], 1],
    [300, 3, 4, 1800, 0, row8[5], row8[6], 1],
    [300, 3, 6, 1800, 34, row8[5], row8[6], 1],
  ];
  const localAliases = { v: 1, rules: [...aliases.rules, { from: 500, to: 200, scope: 'song' }] };
  const localSongs = [...songs];
  const before = structuredClone({ source, localAliases, localSongs });
  const expected = normalizeAliasInputs({ histRows: source, restRows: [], aliases: localAliases, songs: localSongs }).histRows;
  const actual = normalizeAliasInputs({ histRows: source, restRows: [], aliases: localAliases, songs: localSongs }).histRows;
  assert.deepEqual(actual, expected);
  assert.equal(actual[0][0], 200);
  assert.equal(actual[1][0], 300);
  assert.equal(actual[2][0], 400);
  assert.deepEqual({ source, localAliases, localSongs }, before);
});

test('6 실제 R2 REST와 users fetch 계약: URL, GET, cursor, select, offset', async () => {
  const f = listedFixture({ users: Array.from({ length: 1000 }, (_, i) => ({ iidx_id: `x${i}`, dj_name: null })) });
  // Keep exactly 1000 users on page one so fetchAllUsers must request its empty second page.
  const result = await loadHistoryInputs(f.deps);
  assert.equal(result.users.length, 1000);
  assert.equal(f.state.listCalls.length, 2);
  assert.equal(f.state.listCalls[0], `${BASE}?prefix=hist%2F&per_page=1000`);
  assert.equal(new URL(f.state.listCalls[1]).searchParams.get('cursor'), 'next');
  assert.ok(f.state.histCalls.every((key) => key.startsWith('hist/')));
  assert.deepEqual(f.state.userCalls.map((u) => new URL(u).searchParams.get('offset')), ['0', '1000']);
  assert.ok(f.state.calls.every((c) => c.method === 'GET'));
});

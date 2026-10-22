import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mergeScoreHistory } from './score-history.mjs';
import { buildCandidate, validateCandidate } from './score-buffer.mjs';
import { normalizeAliasInputs } from './song-aliases.mjs';

const savedEnv = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY };
process.env.SUPABASE_URL = 'https://supabase.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
const { dumpUser, prepareOfficialHistory, updateHistFile, HIST_COLS } = await import('./dump-user.mjs');
test.after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
const id = '12345678';
const h34 = [101, 3, 6, 1800, 34, '2026-10-21T01:02:03.123456+00:00', '2026-10-21', 1, 20, 1000];
const late33 = [101, 3, 4, 1900, 33, '2026-10-22T01:02:03.123457+00:00', '2026-10-22', 1, 18, 1000];
const cumulativeId = '89388691';
const cumulativeRow = [100, 3, 5, 2000, 33, '2026-10-22T01:02:03.123456+00:00', '2026-10-22', 1, null, 1500];
const cumulativeRest = [{ score_id: 12345, iidx_id: cumulativeId, song_id: 100, diff: 3, played_version: 33,
  play_style: 1, ex_score: 2000, lamp: 5, bp: null, note_count: 1500,
  date: cumulativeRow[5], date_kst: cumulativeRow[6] }];
const emptyAliases = { v: 1, rules: [] };
const emptyAliasesBytes = Buffer.from(JSON.stringify(emptyAliases), 'utf8');
const cumulativeSongs = [100, 200, 300, 400].map((song_id) => ({ song_id }));
const cumulativeHash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sp34 = [101, 3, 4, 1500, 34, '2026-10-21T01:02:03.123456+00:00', '2026-10-21', 0, 10, 1000];
const songs = [{ song_id: 101, title: 'TEST', textage_song_id: 'test', series_no: 34, ac: true, legen: false }];
const oldUser = { star: 8, sp_r_star: 9, sp_r_star_model_id: 'old', sp_r_star_formula_version: 'v1' };
const previous = { user: oldUser, dpRecent: [], spRecent: [{ song_id: 101 }], persona: { old: true }, spPersona: { old: true }, sp: [] };
const recent = {
  1: [{ song_id: 101, diff: 3, date_kst: '2026-10-22' }],
  0: [{ song_id: 101, diff: 3, date_kst: '2026-10-21' }],
};
const response = (value) => ({ ok: true, status: 200, json: async () => value, headers: { get: () => '*/0' } });

async function fixture(options, fn) {
  const savedFetch = globalThis.fetch, savedSwitch = process.env.SCORE_BUFFER_PREPARE;
  const savedCumulative = process.env.SCORE_BUFFER_CUMULATIVE;
  const savedAccount = process.env.CLOUDFLARE_R2_ACCOUNT_ID, savedToken = process.env.CLOUDFLARE_R2_TOKEN;
  process.env.CLOUDFLARE_R2_ACCOUNT_ID = 'test-account';
  process.env.CLOUDFLARE_R2_TOKEN = 'test-token';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dump-official-'));
  const file = path.join(dir, 'hist.json');
  const events = [], calls = [], seen = { spCalls: 0 };
  const rows = options.rows ?? [h34, late33];
  const restRows = rows.map((r, i) => ({ score_id: i === 0 ? 3401 : 3301 + i - 1, iidx_id: id,
    ...Object.fromEntries(HIST_COLS.map((k, j) => [k, r[j]])) }));
  const aliasesBytes = Buffer.from(JSON.stringify(emptyAliases), 'utf8');
  const objects = new Map([['hist/' + id + '.json', Buffer.from(JSON.stringify(options.oldRows ?? [h34]))],
    ['songs.json', Buffer.from(JSON.stringify(songs))], ['meta/song-aliases.json', aliasesBytes]]);
  if (!options.newUser) objects.set('user/' + id + '.json', Buffer.from(JSON.stringify(previous)));
  let histReads = 0;
  const r2 = {
    async read(key) {
      events.push('read:' + key);
      if (key.startsWith('user/') && options.unknown) throw new Error('unknown');
      if (key.startsWith('hist/')) {
        histReads++;
        if (options.histError) throw new Error('hist unavailable');
        if (options.broken) return { bytes: Buffer.from('{'), etag: 'old' };
        if (histReads === 2 && options.mismatch) return { bytes: Buffer.from('[]'), etag: 'changed' };
      }
      const bytes = objects.get(key);
      return bytes ? { body: bytes.toString('utf8'), bytes, etag: '"old"' } : null;
    },
    async put(key, bytes, etag) {
      events.push('put:' + key);
      if (options.conflict) { assert.equal(etag, '"old"'); throw new Error('412'); }
      objects.set(key, Buffer.from(bytes));
    },
  };
  const R = {
    textageMeta: { songs: { test: { title: 'TEST', notes: { DA: 1000, SA: 1000 }, levels: { DA: 12, SA: 12 } } } },
    ratingJson: { rateStar: { scale: {} }, spRateStar: {} }, ereterData: {}, cpiData: [], norm: (x) => x,
    onlyOSR2eLib: { inferEreter(charts, rating, opts) {
      events.push('calculate'); seen.dp = charts; seen.prevStar = opts.prevStar;
      if (options.resourceError) throw new Error('official resource failure');
      return { ereterStar: charts[0]?.exScore ?? 1 };
    } },
    userRateStarLib: { inferUserRStar: () => ({}) },
    spSkillLib: { computeSpStarGuarded: () => ({}) },
    spUserRateStarLib: { inferSpUserRStar(rows) { seen.spCalls++; seen.sp = rows; return { status: 'few_plays', modelId: 'new', formulaVersion: 'v2' }; } },
    patternScoreKernelLib: { computePatternScoreKernel: () => ({ matched: 1, vec: { NOTES: 7 } }) },
  };
  globalThis.fetch = async (url, init = {}) => {
    calls.push([String(url), init]);
    if (url.includes('/scores?')) return response(restRows);
    if (url.includes('/users?')) return response([{ iidx_id: id, star: 2, plays: ['keep'] }]);
    if (url.includes('/user_radars?') || url.includes('/user_ohsorry_radars?') || url.includes('/chart_arrange?')) return response([]);
    if (url.includes('make_grid_data')) {
      if (options.spFailure && JSON.parse(init.body).p_play_style === 0) return { ok: false, status: 500 };
      return response([]);
    }
    if (url.includes('make_update_history')) {
      if (options.recentError) throw new Error('update history unavailable');
      return response(recent[JSON.parse(init.body).p_play_style]);
    }
    throw new Error('Unexpected request: ' + url);
  };
  if (options.mode === undefined) process.env.SCORE_BUFFER_PREPARE = '1';
  else if (options.mode === null) delete process.env.SCORE_BUFFER_PREPARE;
  else process.env.SCORE_BUFFER_PREPARE = options.mode;
  const opts = { r2, histFile: file, deferPersona: true };
  try { await fn({ run: () => dumpUser(id, R, opts), file, events, calls, seen, restRows, objects }); }
  finally {
    globalThis.fetch = savedFetch;
    if (savedSwitch === undefined) delete process.env.SCORE_BUFFER_PREPARE; else process.env.SCORE_BUFFER_PREPARE = savedSwitch;
    if (savedCumulative === undefined) delete process.env.SCORE_BUFFER_CUMULATIVE; else process.env.SCORE_BUFFER_CUMULATIVE = savedCumulative;
    if (savedAccount === undefined) delete process.env.CLOUDFLARE_R2_ACCOUNT_ID; else process.env.CLOUDFLARE_R2_ACCOUNT_ID = savedAccount;
    if (savedToken === undefined) delete process.env.CLOUDFLARE_R2_TOKEN; else process.env.CLOUDFLARE_R2_TOKEN = savedToken;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('late33 confirmed ten-column history is published and verified before official calculation', async () => {
  await fixture({}, async ({ run, events, seen, file, restRows, calls }) => {
    assert.deepEqual(restRows.map((r) => r.score_id), [3401, 3301]);
    const result = await run();
    assert.deepEqual(calls.filter(([url]) => url.includes('make_update_history')).map(([, init]) => ({
      method: init.method, ...JSON.parse(init.body),
    })), [
      { method: 'POST', p_iidx_id: id, p_days: 92, p_play_style: 1 },
      { method: 'POST', p_iidx_id: id, p_days: 92, p_play_style: 0 },
    ]);
    assert.deepEqual(result.dpRecent, recent[1]);
    assert.deepEqual(result.spRecent, recent[0]);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [late33, h34]);
    assert.ok(events.indexOf('put:meta/scores-delete-' + id + '.json') < events.indexOf('calculate'));
    assert.deepEqual([seen.dp[0].exScore, seen.dp[0].lampNum, seen.dp[0].noteCount], [1900, 6, 1000]);
    assert.deepEqual([result.dp[0].ex_score, result.dp[0].lamp, result.dp[0].bp, result.user.star], [1900, 6, 18, 1900]);
    assert.equal(result.osPattern.find((row) => row.play_style === 1).notes, 7);   // R2·DB 열 이름(접두사 없음)
    assert.equal(seen.prevStar, undefined);   // ★ 래칫은 엔진 인자가 아니라 어댑터 바깥 max(크롤러 정본)
    assert.equal(mergeScoreHistory([h34], [late33]).length, 2);
    const better = [...late33]; better[3] = 1950; better[2] = 6;
    assert.equal(mergeScoreHistory([better], [late33])[0][3], 1950);
  });
});

test('SP full history retains all versions without grid or SP-rate RPC', async () => {
  const rows = [0, -1, 33, 34].map((version) => { const row = [...late33]; row[4] = version; row[7] = 0; return row; });
  await fixture({ rows }, async ({ run, seen, calls }) => {
    await run();
    assert.deepEqual(seen.sp.map((r) => r.played_version), [-1, 33, 34, 0]);
    assert.equal(calls.filter(([url]) => url.includes('/scores?')).length, 1);
    assert.equal(calls.filter(([url]) => /make_grid_data|make_sp_rate_star_rows/.test(url)).length, 0);
  });
});

test('unset and zero switches preserve legacy requests, fields and SP failure fallback', async () => {
  for (const mode of [null, '0']) await fixture({ mode, spFailure: true }, async ({ run, events, calls }) => {
    const result = await run();
    assert.deepEqual(result.sp, previous.sp);
    assert.deepEqual(result.spPersona, previous.spPersona);
    assert.equal(result.user.star, 2);
    assert.deepEqual(calls.slice(0, 3).map(([url]) => new URL(url).pathname), ['/rest/v1/users', '/rest/v1/user_radars', '/rest/v1/user_ohsorry_radars']);
    assert.equal(calls.filter(([url]) => url.includes('make_grid_data')).length, 2);
    assert.equal(calls.filter(([url]) => url.includes('make_update_history')).length, 2);
    assert.equal(events.some((e) => e.startsWith('put:') || e.includes('songs.json')), false);
    assert.equal(Object.hasOwn(result, '_v'), true);
  });
});

test('R2 failure, malformed JSON, mismatch, empty DB and conditional conflict abort user output', async () => {
  for (const options of [{ histError: true }, { broken: true }, { mismatch: true }, { rows: [] }, { conflict: true }]) {
    await fixture(options, async ({ run, events }) => {
      await assert.rejects(run());
      assert.equal(events.includes('calculate'), false);
      assert.equal(events.filter((e) => e.startsWith('put:meta/')).length, 0);
    });
  }
});

test('CLI relative and Admin absolute hist paths reuse bytes once; changed files rebuild with fixture R2', async () => {
  for (const absolute of [false, true]) await fixture({}, async ({ run, file, calls, events, restRows }) => {
    await run();
    const target = absolute ? file : path.relative(process.cwd(), file);
    assert.deepEqual((await updateHistFile(id, target, { r2: undefined })).restRows, restRows);
    assert.equal(calls.filter(([url]) => url.includes('/scores?')).length, 1);
    assert.equal(events.filter((e) => e.startsWith('put:meta/')).length, 1);
  });
  await fixture({}, async ({ run, file, calls, objects }) => {
    process.env.SCORE_BUFFER_PREPARE = '1';
    process.env.SCORE_BUFFER_CUMULATIVE = '1';
    await run(); fs.appendFileSync(file, ' ');
    objects.set('hist/' + id + '.json', Buffer.from(JSON.stringify([h34])));
    await prepareOfficialHistory(id, undefined, { histFile: file, r2: {
      async read(key) {
        const bytes = objects.get(key);
        return bytes ? { body: bytes.toString('utf8'), bytes, etag: '"old"' } : null;
      },
      async put(key, bytes) { objects.set(key, Buffer.from(bytes)); },
    } });
    assert.equal(calls.filter(([url]) => url.includes('/scores?')).length, 2);
  });
  await fixture({}, async ({ file, calls, objects }) => {
    process.env.SCORE_BUFFER_PREPARE = '1';
    process.env.SCORE_BUFFER_CUMULATIVE = '1';
    const rebuilt = await prepareOfficialHistory(id, undefined, { histFile: file, r2: {
      async read(key) {
        const bytes = objects.get(key);
        return bytes ? { body: bytes.toString('utf8'), bytes, etag: '"old"' } : null;
      },
      async put(key, bytes) { objects.set(key, Buffer.from(bytes)); },
    } });
    assert.equal(rebuilt.histRows.length, 2);
    assert.equal(calls.length, 1);
  });
});

test('deferred persona calculates official values with R2 priority, new-user seed and few-plays tuple result', async () => {
  await fixture({ rows: [h34, late33, sp34] }, async ({ run, calls, seen }) => {
    const result = await run();
    assert.equal(result.user.star, 1900);
    assert.equal(result.user.sp_r_star, null);
    assert.equal(result.user.sp_r_star_model_id, 'new');
    assert.equal(result.user.sp_r_star_formula_version, 'v2');
    assert.equal(seen.spCalls, 1);
    assert.equal(seen.sp.length, 1);
    assert.deepEqual(result.persona, previous.persona);
    assert.deepEqual(result.spRecent, recent[0]);
    assert.deepEqual(result.user.plays, ['keep']);
    assert.equal(calls.some(([url, init]) => init.method && init.method !== 'GET' && !url.includes('make_update_history')), false);
  });
  await fixture({}, async ({ run, seen }) => {
    const result = await run();
    assert.deepEqual({ rStar: result.user.sp_r_star, model: result.user.sp_r_star_model_id,
      formula: result.user.sp_r_star_formula_version }, { rStar: 9, model: 'old', formula: 'v1' });
    assert.equal(seen.spCalls, 0);
  });
  await fixture({ newUser: true, rows: [], oldRows: [] }, async ({ run }) => {
    const result = await run(); assert.equal(result.user.sp_r_star, null); assert.equal(result.persona, null);
  });
  await fixture({ unknown: true }, async ({ run }) => { await assert.rejects(run(), /상태 모름/); });
  await fixture({ resourceError: true }, async ({ run }) => { await assert.rejects(run(), /official resource failure/); });
  await fixture({ recentError: true }, async ({ run }) => {
    const result = await run();
    assert.equal(Object.hasOwn(result, 'dpRecent'), false);
    assert.equal(Object.hasOwn(result, 'spRecent'), false);
  });
});

test('cumulative dump contracts: empty buffer and partial 34 upload preserve cumulative data', async () => {
  const hist = [cumulativeRow];
  const unchanged = (incoming) => normalizeAliasInputs({ histRows: hist, restRows: incoming,
    aliases: emptyAliases, songs: cumulativeSongs });
  assert.deepEqual(unchanged([]).histRows, hist);
  assert.deepEqual(unchanged([]).restRows, []);
  const partial34 = { ...cumulativeRest[0], score_id: 12346, played_version: 34,
    ex_score: 2100, lamp: 6 };
  const merged = unchanged([partial34]);
  assert.equal(merged.histRows.some((row) => row[4] === 33), true);
  assert.equal(merged.restRows[0].played_version, 34);
  for (const version of [0, -1]) {
    const sentinel = { ...cumulativeRest[0], score_id: 12347 + version, played_version: version };
    assert.equal(unchanged([sentinel]).restRows[0].played_version, version);
  }
  assert.deepEqual(mergeScoreHistory(hist, []), hist);
});

test('cumulative late33 replay is idempotent and same score id keeps best improvement', async () => {
  const old = [[100, 3, 4, 1900, 33, '2026-10-21T01:02:03.123456+00:00', '2026-10-21', 1, 18, 1500]];
  const normalized = normalizeAliasInputs({ histRows: old, restRows: cumulativeRest,
    aliases: emptyAliases, songs: cumulativeSongs });
  const replay = mergeScoreHistory(normalized.histRows, normalized.restRows.map((r) => [r.song_id, r.diff, r.lamp,
    r.ex_score, r.played_version, r.date, r.date_kst, r.play_style, r.bp, r.note_count]));
  assert.deepEqual(mergeScoreHistory(replay, normalized.restRows.map((r) => [r.song_id, r.diff, r.lamp,
    r.ex_score, r.played_version, r.date, r.date_kst, r.play_style, r.bp, r.note_count])), replay);
  const improved = { ...cumulativeRest[0], ex_score: 2100, lamp: 6 };
  assert.equal(normalizeAliasInputs({ histRows: old, restRows: [improved], aliases: emptyAliases,
    songs: cumulativeSongs }).restRows[0].ex_score, 2100);
  assert.equal(normalizeAliasInputs({ histRows: old, restRows: cumulativeRest, aliases: emptyAliases,
    songs: cumulativeSongs }).restRows[0].played_version, 33);
});

test('cumulative candidate uses CAS winner bytes and freshly calculated alias fingerprints', async () => {
  const currentHist = Buffer.from(JSON.stringify([cumulativeRow]), 'utf8');
  const currentAliases = Buffer.from(JSON.stringify(emptyAliases), 'utf8');
  const objects = new Map([
    [`hist/${cumulativeId}.json`, { body: currentHist.toString('utf8'), bytes: currentHist, etag: '"current"' }],
    ['meta/song-aliases.json', { body: currentAliases.toString('utf8'), bytes: currentAliases, etag: '"aliases"' }],
  ]);
  const operations = [];
  const read = async (key) => { operations.push(['read', key]); return objects.get(key) ?? null; };
  const put = async (key, body, etag) => {
    operations.push(['put', key, etag]);
    const prior = objects.get(key);
    if (prior && etag !== prior.etag) throw new Error('412 precondition failed');
    if (!prior && etag !== '*') throw new Error('missing If-None-Match');
    const bytes = Buffer.from(body);
    objects.set(key, { body: bytes.toString('utf8'), bytes, etag: '"next"' });
  };
  const conditionalRead = async (key) => read(key);
  assert.equal((await read(`hist/${cumulativeId}.json`)).etag, '"current"');
  await assert.rejects(() => put(`hist/${cumulativeId}.json`, currentHist, '"stale"'), /412/);
  await put(`hist/${cumulativeId}.json`, currentHist, '"current"');
  const downloaded = await conditionalRead(`hist/${cumulativeId}.json`);
  const aliasObject = await conditionalRead('meta/song-aliases.json');
  const candidate = buildCandidate({ iidxId: cumulativeId, restRows: cumulativeRest, previousHistRows: [],
    aliases: emptyAliases, aliasesBytes: aliasObject.bytes, songs: cumulativeSongs,
    publishedHistBytes: downloaded.bytes, downloadedHistBytes: downloaded.bytes });
  assert.equal(candidate.hist.sha256, cumulativeHash(downloaded.bytes));
  assert.equal(candidate.aliases_sha256, cumulativeHash(aliasObject.bytes));
  const candidateKey = `meta/scores-delete-${cumulativeId}.json`;
  await put(candidateKey, Buffer.from(JSON.stringify(candidate)), '*');
  assert.deepEqual(operations.slice(0, 4).map(([kind, key]) => [kind, key]), [
    ['read', `hist/${cumulativeId}.json`], ['put', `hist/${cumulativeId}.json`],
    ['put', `hist/${cumulativeId}.json`], ['read', `hist/${cumulativeId}.json`],
  ]);
  assert.equal(operations.at(-1)[2], '*');
});

test('cumulative failures reject missing, malformed and changed hist or invalid aliases', async () => {
  const makeCandidate = (published, downloaded = published, aliasesBytes = emptyAliasesBytes) => buildCandidate({
    iidxId: cumulativeId, restRows: cumulativeRest, previousHistRows: [], aliases: emptyAliases,
    aliasesBytes, songs: cumulativeSongs, publishedHistBytes: published, downloadedHistBytes: downloaded,
  });
  const read = async (objects, key) => objects.has(key) ? objects.get(key) : null;
  assert.equal(await read(new Map(), `hist/${cumulativeId}.json`), null); // 404 is the only missing-object representation.
  await assert.rejects(async () => { throw new Error('HTTP 503'); }, /HTTP 503/);
  const valid = Buffer.from(JSON.stringify([cumulativeRow]), 'utf8');
  assert.throws(() => makeCandidate(Buffer.from('{'), Buffer.from('{')), /JSON|expected normalized/);
  assert.throws(() => makeCandidate(valid, Buffer.from('[]')), /bytes differ/);
  assert.throws(() => makeCandidate(valid, valid, Buffer.from('{')), /valid UTF-8 JSON/);
  assert.throws(() => makeCandidate(valid, valid, Buffer.from(JSON.stringify({ v: 1, rules: [{ from: 100, to: 999,
    scope: 'song' }] }))), /terminal target/);
});

test('cumulative interruption before candidate, dry publish and reverse hash are rejected', async () => {
  const histBytes = Buffer.from(JSON.stringify([cumulativeRow]), 'utf8');
  const candidate = buildCandidate({ iidxId: cumulativeId, restRows: cumulativeRest, previousHistRows: [],
    aliases: emptyAliases, aliasesBytes: emptyAliasesBytes, songs: cumulativeSongs,
    publishedHistBytes: histBytes, downloadedHistBytes: histBytes });
  const operations = [];
  const dry = true;
  const dryPublish = async (key, body) => { if (!dry) operations.push(['put', key, body]); };
  await dryPublish(`meta/scores-delete-${cumulativeId}.json`, Buffer.from(JSON.stringify(candidate)));
  assert.deepEqual(operations, []);
  const reversed = { ...candidate, score_ids: [12345, 12346], rows: [
    { ...cumulativeRest[0], score_id: 12346 }, { ...cumulativeRest[0], score_id: 12345 },
  ] };
  assert.throws(() => validateCandidate(reversed, cumulativeId), /same ascending set/);
});

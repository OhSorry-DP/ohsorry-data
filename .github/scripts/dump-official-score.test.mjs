import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeScoreHistory } from './score-history.mjs';

const savedEnv = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY };
process.env.SUPABASE_URL = 'https://supabase.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
const { dumpUser, updateHistFile, HIST_COLS } = await import('./dump-user.mjs');
test.after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
const id = '12345678';
const h34 = [101, 3, 6, 1800, 34, '2026-10-21T01:02:03.123456+00:00', '2026-10-21', 1, 20, 1000];
const late33 = [101, 3, 4, 1900, 33, '2026-10-22T01:02:03.123457+00:00', '2026-10-22', 1, 18, 1000];
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dump-official-'));
  const file = path.join(dir, 'hist.json');
  const events = [], calls = [], seen = {};
  const rows = options.rows ?? [h34, late33];
  const restRows = rows.map((r, i) => ({ score_id: i === 0 ? 3401 : 3301 + i - 1, ...Object.fromEntries(HIST_COLS.map((k, j) => [k, r[j]])) }));
  const objects = new Map([['hist/' + id + '.json', Buffer.from(JSON.stringify(options.oldRows ?? [h34]))], ['songs.json', Buffer.from(JSON.stringify(songs))]]);
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
      return bytes ? { bytes, etag: 'old' } : null;
    },
    async put(key, bytes, etag) {
      events.push('put:' + key);
      if (options.conflict) { assert.equal(etag, 'old'); throw new Error('412'); }
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
    spUserRateStarLib: { inferSpUserRStar(rows) { seen.sp = rows; return { status: 'few_plays', modelId: 'new', formulaVersion: 'v2' }; } },
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
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [h34, late33]);
    assert.ok(events.indexOf('put:meta/scores-delete-' + id + '.json') < events.indexOf('calculate'));
    assert.deepEqual([seen.dp[0].exScore, seen.dp[0].lampNum, seen.dp[0].noteCount], [1900, 6, 1000]);
    assert.deepEqual([result.dp[0].ex_score, result.dp[0].lamp, result.dp[0].bp, result.user.star], [1900, 6, 18, 1900]);
    assert.equal(result.osPattern.find((row) => row.play_style === 1).os_notes, 7);
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
    assert.deepEqual(seen.sp.map((r) => r.played_version), [0, -1, 33, 34]);
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

test('CLI relative and Admin absolute hist paths reuse bytes once; changed files and standalone rebuild', async () => {
  for (const absolute of [false, true]) await fixture({}, async ({ run, file, calls, events, restRows }) => {
    await run();
    const target = absolute ? file : path.relative(process.cwd(), file);
    assert.deepEqual((await updateHistFile(id, target)).restRows, restRows);
    assert.equal(calls.filter(([url]) => url.includes('/scores?')).length, 1);
    assert.equal(events.filter((e) => e.startsWith('put:meta/')).length, 1);
  });
  await fixture({}, async ({ run, file, calls }) => {
    await run(); fs.appendFileSync(file, ' ');
    await updateHistFile(id, file);
    assert.equal(calls.filter(([url]) => url.includes('/scores?')).length, 2);
  });
  await fixture({}, async ({ file, calls }) => {
    assert.equal((await updateHistFile(id, file)).rows, 2);
    assert.equal(calls.length, 1);
  });
});

test('deferred persona calculates official values with R2 priority, new-user seed and few-plays tuple result', async () => {
  await fixture({}, async ({ run, calls }) => {
    const result = await run();
    assert.equal(result.user.star, 1900);
    assert.equal(result.user.sp_r_star, null);
    assert.equal(result.user.sp_r_star_model_id, 'new');
    assert.equal(result.user.sp_r_star_formula_version, 'v2');
    assert.deepEqual(result.persona, previous.persona);
    assert.deepEqual(result.spRecent, recent[0]);
    assert.deepEqual(result.user.plays, ['keep']);
    assert.equal(calls.some(([url, init]) => init.method && init.method !== 'GET' && !url.includes('make_update_history')), false);
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

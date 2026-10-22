import test from 'node:test';
import assert from 'node:assert/strict';
import { historyInputs, loadPersonaResources, chartsFromGridRows } from './persona-lib.mjs';
import { mergeScoreHistory } from './score-history.mjs';

const songs = [{ song_id: 101, title: 'TEST', textage_song_id: 'test', series_no: 34, ac: true, legen: false }];
const textageMeta = { songs: { test: { title: 'TEST', notes: { DA: 1000, SA: 1000 }, levels: { DA: 12, SA: 12 } } } };
const h34 = [101, 3, 6, 1800, 34, '2026-10-21T01:02:03.123456+00:00', '2026-10-21', 1, 20, 1000];
const late33 = [101, 3, 4, 1900, 33, '2026-10-22T01:02:03.123457+00:00', '2026-10-22', 1, 18, 1000];
const R = { textageMeta };

test('병합된 전체 hist로 DP grid와 persona 차트를 만든다', () => {
  const merged = mergeScoreHistory([h34], [late33]);
  const out = historyInputs('12345678', merged, songs, [], R);
  assert.equal(merged.length, 2);
  assert.deepEqual([out.dp[0].ex_score, out.dp[0].lamp, out.dp[0].bp], [1900, 6, 18]);
  assert.deepEqual([out.dpCharts[0].exScore, out.dpCharts[0].lampNum], [1900, 6]);
  const high33 = [...late33]; high33[3] = 1950; high33[2] = 6;
  const keptBest = mergeScoreHistory([h34, high33], [late33]);
  assert.equal(keptBest.length, 2);
  assert.equal(keptBest.find((row) => row[4] === 33)[3], 1950);
});

test('SP r-star 입력은 DBR을 빼고 전 시즌 원행과 note_count를 보존한다', () => {
  const s34 = [...h34]; s34[7] = 0;
  const s33 = [...late33]; s33[7] = 0;
  const old = [...s34]; old[4] = 0;
  const dbr = [...s34]; dbr[4] = -10;
  const out = historyInputs('12345678', [s34, s33, old, dbr], songs, [], R);
  assert.equal(out.sp.length, 1);
  assert.equal(out.spRateRows.length, 3);
  assert.deepEqual(out.spRateRows.map((r) => r.played_version), [34, 33, 0]);
  assert.ok(out.spRateRows.every((r) => r.note_count === 1000 && r.title === 'TEST'));
});

test('마이크로초 동률 tie 규칙과 8열 null 보충을 유지하고入力を変更しない', () => {
  const a = [...h34]; a[3] = 1900; a[2] = 6;
  const b = [...a]; b[4] = 33; b[5] = '2026-10-21T01:02:03.123457+00:00';
  const eight = [...a.slice(0, 8)]; eight[7] = 0;
  const input = [a, b, eight]; const before = structuredClone(input);
  const out = historyInputs('12345678', input, songs, [], R);
  assert.equal(out.dp[0].played_version, 34);
  assert.equal(out.spRateRows[0].bp, null);
  assert.equal(out.spRateRows[0].note_count, null);
  assert.deepEqual(input, before);
});

test('song join 후 차트 변환하고 미존재 song은 제외, timestamp 오류는 예외', () => {
  const missing = [...h34]; missing[0] = 999;
  const out = historyInputs('12345678', [h34, missing], songs, [], R);
  assert.equal(out.dpCharts.length, 1);
  assert.equal(out.dpCharts[0].title, 'TEST');
  const bad = [...h34]; bad[5] = 'not-a-date';
  assert.throws(() => historyInputs('12345678', [bad], songs, [], R), /timestamp/);
});

test('공식 로더는 wrapper·필수 모듈을 읽고 누락 자산을 실패시킨다', async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  const json = {
    'textage-meta.json': { songs: {} }, 'ohSorryRating.json': { ratings: {}, rateStar: { scale: 1 }, spRateStar: {} },
    'zasa-data.json': { charts: [] }, 'patterns-dp-0810.json': {}, 'patterns-dp-1112.json': {},
    'patterns-dp-rest.json': {}, 'feature-scores-slim.json': { scores: {} },
    'rate-reference-slim.json': { rates: {} }, 'sp-feature-scores-slim.json': { scores: {} },
    'sp-arrange.json': {}, 'sp-rate-reference.json': { byGameLevel: {} }, 'ereter-data.json': { charts: [], players: {} }, 'cpi.json': [],
  };
  const modules = new Set(['calcWeakness.js', 'persona.js', 'normTitle.js', 'reachNps.js', 'onlyOSR.js', 'OSR13.5+.js', 'onlyOSRtoEreter.js', 'userRateStar.js', 'spUserRateStar.js', 'spSkillCpi.js', 'cpiStar.js', 'patternScoreKernel.js']);
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const name = String(url).split('?')[0].split('/').at(-1);
    if (modules.has(name)) return { ok: true, text: async () => name === 'normTitle.js' ? 'exports.norm = (s) => s;' : 'module.exports = {};' };
    if (name in json) return { ok: true, text: async () => JSON.stringify(json[name]) };
    return { ok: false, status: 404, text: async () => '' };
  };
  try {
    const R = await loadPersonaResources({ official: true });
    for (const key of ['ratingJson', 'ereterData', 'cpiData', 'onlyOSR2eLib', 'userRateStarLib', 'spUserRateStarLib', 'spSkillLib', 'patternScoreKernelLib', 'spFeatScores']) assert.ok(key in R, key);
    assert.deepEqual(R.ratingJson.ratings, {});
    assert.deepEqual(R.ereterData.charts, []);
    assert.ok(urls.some((u) => u.includes('https://data.iidx.in/lib/spUserRateStar.js')));
    json['ohSorryRating.json'] = { ratings: {}, rateStar: { scale: 1 } };
    await assert.rejects(loadPersonaResources({ official: true }), /official resources missing/);
  } finally { globalThis.fetch = originalFetch; }
});

test('기본 로더 모드 시그니처와 기존 차트 변환은 호환된다', () => {
  const rows = [{ song_id: 101, diff: 3, lamp: 6, ex_score: 1900, title: 'TEST', textage_song_id: 'test', bp: 18 }];
  assert.equal(chartsFromGridRows(rows, textageMeta)[0].noteCount, 1000);
  assert.equal(loadPersonaResources.length, 0);
});

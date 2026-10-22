import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { mergeScoreHistory } from './score-history.mjs';
import { historyInputs, loadPersonaResources } from './persona-lib.mjs';
import { calculateOfficialScores } from './official-score.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const rating = (p) => require(path.join(ROOT, 'ohSorryRating', 'modules', p));
const norm = rating('normTitle.js').norm;
const dateA = '2026-10-21T01:02:03.123456+00:00', dateB = '2026-10-22T01:02:03.123457+00:00';
const song = { song_id: 101, title: 'TEST', textage_song_id: 'test', series_no: 34, ac: true, legen: false };
const hist = (version, ex, lamp, date, bp = 18) => [101, 3, lamp, ex, version, date, date.slice(0, 10), 1, bp, 1000];
const ratingJson = { ratings: [], rateStar: { scale: { unit: 1, star0: 0 } }, spRateStar: {} };

function baseR(overrides = {}) {
  return {
    ratingJson, ereterData: { charts: [], players: {} }, norm,
    onlyOSR2eLib: { inferEreter: () => ({}) },
    userRateStarLib: { inferUserRStar: () => ({ reason: 'few_plays' }) },
    spSkillLib: { computeSpStarGuarded: () => ({ reason: 'few_plays' }) }, cpiData: [],
    spUserRateStarLib: { inferSpUserRStar: () => ({ status: 'few_plays', modelId: 'm2', formulaVersion: 'v2' }) },
    textageMeta: { songs: {} },
    patternScoreKernelLib: { computePatternScoreKernel: () => ({ vec: null, matched: 0 }) },
    featureScores: { test: { DP_ANO: { NOTES: 90, HANDS: 20 } } }, spFeatScores: {},
    ...overrides,
  };
}

test('merge history → historyInputs → adapter forwards the late best and drops a worse score', () => {
  const merged = mergeScoreHistory([hist(34, 1800, 6, dateA)], [hist(33, 1900, 4, dateB)]);
  assert.equal(merged.length, 2);
  const inputs = historyInputs('12345678', merged, [song], [], { textageMeta: { songs: { test: { title: 'TEST', notes: { DA: 1000 }, levels: { DA: 12 } } } } });
  let seen;
  const R = baseR({ onlyOSR2eLib: { inferEreter: (...args) => { seen = args[0][0]; assert.equal(args.length, 3); assert.equal(Object.hasOwn(args[2], 'prevStar'), false); assert.deepEqual(Object.keys(args[0][0]).filter((k) => /textage|_sid/i.test(k)), []); return { ereterStar: 2, ohsorryStar: 1.23456 }; } },
    userRateStarLib: { inferUserRStar: (charts, data, opts) => { assert.equal(charts[0].exScore, 1900); assert.deepEqual(Object.keys(charts[0]).filter((k) => /textage|_sid/i.test(k)), []); assert.equal(opts.prevRStar, 4); return { rStar: 4 }; } } });
  const result = calculateOfficialScores({ id: '12345678', inputs, R, previousUser: { star: 3, r_star: 4 } });
  assert.equal(seen.exScore, 1900); assert.equal(seen.lampNum, 6); assert.equal(seen.noteCount, 1000);
  assert.equal(result.userFields.star, 3);
  const lowerPrevious = calculateOfficialScores({ id: '12345678', inputs, R, previousUser: { star: 1, r_star: 4 } });
  assert.equal(lowerPrevious.userFields.star, 2);
  assert.equal(lowerPrevious.userFields.native_star, 1.2346);
  assert.equal(result.userFields.r_star, 4);
  const worse = mergeScoreHistory([hist(33, 1950, 6, dateB)], [hist(33, 1900, 4, dateB)]);
  assert.equal(worse.length, 1); assert.equal(worse[0][3], 1950);
});

test('DP r-star matches direct Rating calculation for deterministic pairs', () => {
  const lib = rating('userRateStar.js');
  const charts = Array.from({ length: 8 }, (_, i) => ({ title: `Fixture ${i}`, diff: 'ANOTHER', exScore: 1200 + i * 100, lampNum: 6, noteCount: 1000, textageSongId: `f${i}` }));
  const rows = charts.map((c, i) => ({ title: c.title, diff: c.diff, rStarA: 2 + i, rStarAa: 3 + i, rStarAaa: 4 + i, rStarMaxm: 5 + i }));
  const data = { ratings: rows, rateStar: { scale: { unit: 1, star0: 0 } }, spRateStar: {} };
  const expected = lib.inferUserRStar(charts, data, { normFn: norm, scale: data.rateStar.scale, prevRStar: null });
  const actual = calculateOfficialScores({ id: 'x', inputs: { dpCharts: charts, dp: [], sp: [], spRateRows: [] }, R: baseR({ ratingJson: data, userRateStarLib: lib }), previousUser: null });
  assert.ok(expected.nPairs >= 5); assert.equal(actual.userFields.r_star, expected.rStar);
});

test('SP r-star preserves complete season rows and applies same-model ratchet or new-model result', () => {
  const lib = rating('spUserRateStar.js');
  const seed = { ratings: Array.from({ length: 8 }, (_, i) => ({ key: `${norm(`Song ${i}`)}|ANOTHER`, title: `Song ${i}`, diff: 'ANOTHER', gameLevel: 12, rStarA: 5 + i * 0.1, rStarAa: 6 + i * 0.1, rStarAaa: 7 + i * 0.1, rStarMaxm: 8 + i * 0.1 })),
    scale: { anchorStage: 'aa', star0: 0, star1: 1, unit: 1, bounds: [0, 20] }, modelId: 'fixture-model',
    userCalculator: { formulaVersion: 'sp-u1-v1', method: 'bin50+logistic', alpha: 1.5, bounds: [0, 20] } };
  const rows = seed.ratings.map((r, i) => ({ title: r.title, diff: 3, played_version: i === 0 ? 0 : 33, play_style: 0, ex_score: 1600 + i * 30, lamp: 6, note_count: 1000, textage_song_id: `id${i}` }));
  const textageSongs = Object.fromEntries(rows.map((r) => [r.textage_song_id, { title: r.title, notes: { SA: 1000 } }]));
  let received, direct;
  const R = baseR({ userRateStarLib: rating('userRateStar.js'), spUserRateStarLib: { inferSpUserRStar: (rs, s, opts) => { received = rs; return direct = lib.inferSpUserRStar(rs, s, { ...opts, textageSongs }); } },
    ratingJson: { ...ratingJson, spRateStar: seed }, textageMeta: { songs: textageSongs } });
  const inputs = { dpCharts: [], dp: [], sp: [], spRateRows: rows };
  const out = calculateOfficialScores({ id: 'x', inputs, R, previousUser: { sp_r_star: 10, sp_r_star_model_id: 'fixture-model', sp_r_star_formula_version: 'sp-u1-v1' } });
  assert.equal(direct.status, 'ok', JSON.stringify(direct));
  assert.equal(received.length, rows.length); assert.equal(received[0].played_version, 0);
  assert.equal(out.userFields.sp_r_star, Math.max(direct.rStarRaw, 10));
  const newModel = calculateOfficialScores({ id: 'x', inputs, R, previousUser: { sp_r_star: 20, sp_r_star_model_id: 'old-model', sp_r_star_formula_version: 'old-v' } });
  assert.equal(newModel.userFields.sp_r_star, direct.rStarRaw);
  assert.equal(newModel.userFields.sp_r_star_model_id, seed.modelId);
  assert.equal(newModel.userFields.sp_r_star_formula_version, direct.formulaVersion);
});

test('SP guarded star receives identity-preserving charts and maps finite CPI/star', () => {
  const sp = rating('spSkillCpi.js');
  // 기존 ohSorryRating/scripts/test/sp-skill-cpi.js의 cpiFixture 계약을 그대로 사용한다.
  const master = Array.from({ length: 10 }, (_, i) => ({ key: `k${i}`, textageId: `id${i}`, variant: 'ac', gameLevel: 12, title: `Song ${i}`, diff: 'ANOTHER', ec: 1500, cl: 1500, hc: 1500, ex: 1500, fc: 1500, estEc: 0, estCl: 0, estHc: 0, estExh: 0, estFc: 0, starConfig: { version: 'sp-song-star-v1', modelConfigHash: '1'.repeat(64), inputHash: '2'.repeat(64), fitHash: '3'.repeat(64), alphaByStage: { ec: 1, cl: 1, hc: 1, exh: 1, fc: 1 }, rawBounds: [0, 24] } }));
  let playsSeen, direct;
  const R = baseR({ cpiData: master, spSkillLib: { computeSpStarGuarded: (plays, rows, opts) => { playsSeen = plays; return direct = sp.computeSpStarGuarded(plays, rows, opts); } } });
  const inputs = { dpCharts: [], dp: [], sp: master.map((r) => ({ title: r.title, diff: 3, lamp: 7, textage_song_id: r.textageId, variant: r.variant, key: r.key, game_level: 12 })), spRateRows: [] };
  const out = calculateOfficialScores({ id: 'x', inputs, R, previousUser: {} });
  assert.equal(playsSeen[0].textageId, 'id0'); assert.equal(out.userFields.sp_cpi, direct.cpiInt); assert.equal(out.userFields.sp_star, direct.starRounded);
});

test('official DP/SP entries use kernel score rate and preserve style-specific nulls', () => {
  const kernel = rating('patternScoreKernel.js');
  let allEntries;
  const R = baseR({ patternScoreKernelLib: { computePatternScoreKernel: (es) => { allEntries = es; return kernel.computePatternScoreKernel(es); } },
    textageMeta: { songs: { test: { notes: { DA: 1000, SA: 1000 } } } },
    featScores: { test: { DP_ANO: { NOTES: 100, HANDS: 50 } } }, spFeatScores: { test: { SP_ANO: { NOTES: 100 } } } });
  const old = [{ iidx_id: 'old', play_style: 0, custom: true, updated_at: 'kept' }];
  const out = calculateOfficialScores({ id: 'x', inputs: { dpCharts: [], dp: [{ textage_song_id: 'test', diff: 3, ex_score: 1900 }], sp: [{ textage_song_id: 'test', diff: 3, ex_score: 1900 }], spRateRows: [] }, R, previousUser: {}, previousOsPattern: old });
  assert.equal(allEntries[0].scoreRate, 0.95);
  const dp = out.osPattern.find((r) => r.play_style === 1), sp = out.osPattern.find((r) => r.play_style === 0);
  assert.equal(dp.hands, 47.5); assert.equal(sp.hands, null); assert.equal(sp.notes, 95); assert.equal(sp.custom, true); assert.equal(sp.updated_at, 'kept');
  assert.ok(!Object.keys(dp).some((key) => key.startsWith('os_')));
  assert.ok(!Object.keys(sp).some((key) => key.startsWith('os_')));

  // loadPersonaResources의 official 반환 객체 키를 그대로 구성한 로컬 fixture (네트워크 fetch 금지).
  const actualR = { featScores: { test: { DP_ANO: { NOTES: 100, HANDS: 50 } } }, spFeatScores: {}, ratingJson,
    ereterData: { charts: [], players: {} }, cpiData: [], norm, textageMeta: { songs: { test: { notes: { DA: 1000 } } } },
    onlyOSR2eLib: { inferEreter: () => ({}) }, userRateStarLib: rating('userRateStar.js'),
    spUserRateStarLib: rating('spUserRateStar.js'), spSkillLib: { computeSpStarGuarded: () => ({}) },
    patternScoreKernelLib: rating('patternScoreKernel.js') };
  assert.deepEqual(['featScores', 'spFeatScores', 'ratingJson', 'ereterData', 'cpiData', 'norm', 'textageMeta', 'onlyOSR2eLib', 'userRateStarLib', 'spUserRateStarLib', 'spSkillLib', 'patternScoreKernelLib'].filter((key) => !(key in actualR)), []);
  const actual = calculateOfficialScores({ id: 'x', inputs: { dpCharts: [], dp: [{ textage_song_id: 'test', diff: 3, ex_score: 1900 }], sp: [], spRateRows: [] }, R: actualR, previousUser: {} });
  assert.ok(actual.osPattern.some((r) => r.play_style === 1));
});

test('few plays preserve prior tuples/features; missing engines, invalid numbers and throws remain failures', () => {
  const previous = { star: 1, native_star: 2, r_star: 3, sp_cpi: 4, sp_star: 5, sp_r_star: 6, sp_r_star_model_id: 'm', sp_r_star_formula_version: 'v' };
  const oldPattern = [{ iidx_id: 'x', play_style: 1, os_notes: 7 }];
  const inputs = { dpCharts: [], dp: [], sp: [], spRateRows: [] };
  const out = calculateOfficialScores({ id: 'x', inputs, R: baseR(), previousUser: previous, previousOsPattern: oldPattern });
  assert.deepEqual(out.userFields, previous);
  assert.deepEqual(out.osPattern, oldPattern);
  let spRateCalled = false;
  const noSpCrawl = calculateOfficialScores({ id: 'x', inputs, previousUser: previous, R: baseR({ spUserRateStarLib: { inferSpUserRStar: () => { spRateCalled = true; throw Error('must not run'); } } }) });
  assert.equal(spRateCalled, false);
  assert.deepEqual(['sp_r_star', 'sp_r_star_model_id', 'sp_r_star_formula_version'].map((key) => noSpCrawl.userFields[key]), [6, 'm', 'v']);
  assert.throws(() => calculateOfficialScores({ id: 'x', inputs, R: baseR({ userRateStarLib: null }), previousUser: previous }), /required official resource/);
  assert.throws(() => calculateOfficialScores({ id: 'x', inputs, R: baseR({ onlyOSR2eLib: { inferEreter: () => { throw Error('engine'); } } }), previousUser: previous }), /engine/);
  assert.throws(() => calculateOfficialScores({ id: 'x', inputs, R: baseR({ onlyOSR2eLib: { inferEreter: () => ({ ereterStar: Infinity }) } }), previousUser: previous }), /non-finite/);
  assert.deepEqual(calculateOfficialScores({ id: 'x', inputs, R: baseR(), previousUser: null }).userFields,
    { star: null, native_star: null, r_star: null, sp_cpi: null, sp_star: null, sp_r_star: null, sp_r_star_model_id: null, sp_r_star_formula_version: null });
  const source = JSON.stringify(inputs); calculateOfficialScores({ id: 'x', inputs, R: baseR(), previousUser: previous }); assert.equal(JSON.stringify(inputs), source);
});

const DP_DIFF = { 1: 'DP_NOR', 2: 'DP_HYP', 3: 'DP_ANO', 4: 'DP_LEG' };
const DP_NOTES = { 1: 'DN', 2: 'DH', 3: 'DA', 4: 'DX' };
const SP_DIFF = { 1: 'SP_NOR', 2: 'SP_HYP', 3: 'SP_ANO', 4: 'SP_LEG' };
const SP_NOTES = { 1: 'SN', 2: 'SH', 3: 'SA', 4: 'SX' };
const FEATS = ['notes', 'chord', 'peak', 'charge', 'scratch', 'soflan', 'phrase', 'jack', 'trill', 'rand',
  'stair_up_l', 'stair_up_r', 'stair_dn_l', 'stair_dn_r', 'k1_l', 'k1_r', 'k2_l', 'k2_r', 'k3_l', 'k3_r',
  'k4_l', 'k4_r', 'k5_l', 'k5_r', 'k6_l', 'k6_r', 'k7_l', 'k7_r', 'double_stair_l', 'double_stair_r',
  'keima_l', 'keima_r', 'hstair_onehand', 'hstair_sync', 'hstair_sameshape', 'hstair_diffshape', 'hands'];
const SP_FEATS = new Set(['notes', 'chord', 'peak', 'charge', 'scratch', 'soflan', 'phrase', 'jack', 'trill', 'rand']);
const own = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const assertNumericResult = (value, label) => {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError(`${label} returned a non-finite number`);
};
const round = (x, n) => Number(x.toFixed(n));
const required = (value, label) => { if (!value) throw new Error(`required official resource missing: ${label}`); return value; };

function entries(rows, scores, songs, style) {
  const diffMap = style === 1 ? DP_DIFF : SP_DIFF, noteMap = style === 1 ? DP_NOTES : SP_NOTES;
  const out = [];
  for (const row of rows || []) {
    if (!row || !row.ex_score || row.ex_score <= 0 || !row.textage_song_id) continue;
    const feature = diffMap[row.diff], note = noteMap[row.diff];
    const chartScores = feature && scores?.[row.textage_song_id]?.[feature];
    const noteCount = note && songs?.[row.textage_song_id]?.notes?.[note];
    if (!chartScores || !noteCount || noteCount <= 0) continue;
    out.push({ scoreRate: row.ex_score / (2 * noteCount), chartScores });
  }
  return out;
}

function featureRows(id, rows, style, R, previous) {
  const kernel = required(R.patternScoreKernelLib?.computePatternScoreKernel, 'patternScoreKernelLib.computePatternScoreKernel');
  const list = entries(rows, style === 1 ? R.featureScores : R.spFeatScores,
    R.textageMeta?.songs, style);
  const result = kernel(list);
  if (result.matched === 0) return null;
  const prev = (previous || []).find((x) => x?.play_style === style);
  const row = prev ? { ...prev } : { iidx_id: id, play_style: style };
  row.iidx_id = id;
  row.play_style = style;
  const vec = result.vec;
  for (const feat of FEATS) {
    const key = `os_${feat}`;
    const value = vec?.[feat.toUpperCase()];
    assertNumericResult(value, `computePatternScoreKernel.${feat}`);
    row[key] = style === 0 && !SP_FEATS.has(feat) ? null : (finite(value) ? value : null);
  }
  return row;
}

export function calculateOfficialScores({ id, inputs, R, previousUser, previousOsPattern }) {
  if (!inputs || typeof inputs !== 'object') throw new TypeError('inputs is required');
  const user = previousUser && typeof previousUser === 'object' ? previousUser : null;
  const userFields = {};
  for (const key of ['star', 'native_star', 'r_star', 'sp_cpi', 'sp_star', 'sp_r_star', 'sp_r_star_model_id', 'sp_r_star_formula_version']) {
    userFields[key] = user && own(user, key) ? user[key] : null;
  }
  const rating = required(R?.ratingJson, 'ratingJson');
  const inferEreter = required(R?.onlyOSR2eLib?.inferEreter, 'onlyOSR2eLib.inferEreter');
  const ereterData = required(R?.ereterData, 'ereterData');
  const er = inferEreter(inputs.dpCharts, rating, {
    charts: ereterData.charts || ereterData, players: ereterData.players || {}, prevStar: user?.star,
  });
  assertNumericResult(er?.ereterStar, 'inferEreter.ereterStar');
  assertNumericResult(er?.ohsorryStar, 'inferEreter.ohsorryStar');
  if (finite(er?.ereterStar)) userFields.star = round(er.ereterStar, 4);
  if (finite(er?.ohsorryStar)) userFields.native_star = round(er.ohsorryStar, 4);

  const userRate = required(R?.userRateStarLib?.inferUserRStar, 'userRateStarLib.inferUserRStar');
  const rResult = userRate(inputs.dpCharts, rating, {
    normFn: required(R.norm, 'norm'), scale: required(rating.rateStar?.scale, 'ratingJson.rateStar.scale'),
    prevRStar: user?.r_star,
  });
  assertNumericResult(rResult?.rStar, 'inferUserRStar.rStar');
  if (finite(rResult?.rStar)) userFields.r_star = round(rResult.rStar, 2);

  const spCharts = (inputs.sp || []).map((r) => {
    const chart = { title: r.title, diff: ({ 0: 'BEGINNER', 1: 'NORMAL', 2: 'HYPER', 3: 'ANOTHER', 4: 'LEGGENDARIA' })[r.diff], lampNum: r.lamp || 0 };
    if (r.textage_song_id != null) chart.textageId = String(r.textage_song_id);
    if (r.variant != null) chart.variant = r.variant;
    if (r.key != null) chart.key = r.key;
    const level = r.game_level ?? r.gameLevel;
    chart.gameLevel = level != null && Number.isFinite(Number(level)) ? Number(level) : 12;
    if (r.source != null) chart.source = r.source;
    return chart;
  });
  const guarded = required(R?.spSkillLib?.computeSpStarGuarded, 'spSkillLib.computeSpStarGuarded');
  const spResult = guarded(spCharts, required(R.cpiData, 'cpiData'), { normFn: required(R.norm, 'norm') });
  assertNumericResult(spResult?.cpiInt, 'computeSpStarGuarded.cpiInt');
  assertNumericResult(spResult?.starRounded, 'computeSpStarGuarded.starRounded');
  if (finite(spResult?.cpiInt)) userFields.sp_cpi = spResult.cpiInt;
  if (finite(spResult?.starRounded)) userFields.sp_star = spResult.starRounded;

  const inferSp = required(R?.spUserRateStarLib?.inferSpUserRStar, 'spUserRateStarLib.inferSpUserRStar');
  const seed = required(rating.spRateStar, 'ratingJson.spRateStar');
  const spRate = inferSp(inputs.spRateRows, seed, {
    textageSongs: required(R.textageMeta?.songs, 'textageMeta.songs'), normFn: required(R.norm, 'norm'),
    kernel: required(R.userRateStarLib, 'userRateStarLib'),
    prev: { rStar: user?.sp_r_star, modelId: user?.sp_r_star_model_id, formulaVersion: user?.sp_r_star_formula_version },
  });
  assertNumericResult(spRate?.rStar, 'inferSpUserRStar.rStar');
  if (spRate?.status === 'ok' && finite(spRate.rStar)) {
    userFields.sp_r_star = round(spRate.rStar, 2);
    userFields.sp_r_star_model_id = spRate.modelId;
    userFields.sp_r_star_formula_version = spRate.formulaVersion;
  }

  const osPattern = Array.isArray(previousOsPattern) ? previousOsPattern.map((x) => ({ ...x })) : [];
  for (const [style, rows] of [[1, inputs.dp], [0, inputs.sp]]) {
    const row = featureRows(id, rows, style, R, osPattern);
    if (!row) continue;
    const index = osPattern.findIndex((x) => x?.play_style === style);
    if (index < 0) osPattern.push(row); else osPattern[index] = row;
  }
  if (!user) {
    for (const key of ['star', 'native_star', 'r_star', 'sp_cpi', 'sp_star', 'sp_r_star', 'sp_r_star_model_id', 'sp_r_star_formula_version']) {
      if (!own(userFields, key)) userFields[key] = null;
    }
  }
  return { userFields, osPattern };
}

'use strict';

const AXES = ['STAIR_UP', 'STAIR_DN', 'DOUBLE_STAIR', 'KEIMA', 'SPIRAL_UP', 'SPIRAL_DN', 'JUMP_WIDE', 'HSTAIR_SYM', 'HSTAIR_ASYM', 'CN'];
const AXES_V2 = ['NOTES', 'CHORD', 'PEAK', 'CHARGE', 'SCRATCH', 'PHRASE', 'JACK', 'TRILL', 'RAND', 'STAIR_UP_L', 'STAIR_UP_R', 'STAIR_DN_L', 'STAIR_DN_R', 'K1_L', 'K1_R', 'K2_L', 'K2_R', 'K3_L', 'K3_R', 'K4_L', 'K4_R', 'K5_L', 'K5_R', 'K6_L', 'K6_R', 'K7_L', 'K7_R', 'DOUBLE_STAIR_L', 'DOUBLE_STAIR_R', 'KEIMA_L', 'KEIMA_R', 'HSTAIR_ONEHAND', 'HSTAIR_SYNC', 'HSTAIR_SAMESHAPE', 'HSTAIR_DIFFSHAPE'];
const UNIT_V2 = Object.freeze(Object.fromEntries(AXES_V2.map(axis => [axis, ['HSTAIR_SYNC', 'HSTAIR_SAMESHAPE', 'HSTAIR_DIFFSHAPE'].includes(axis) ? 'notes/s/both-hands' : 'notes/s/hand'])));
const LAMP_WEIGHT = Object.freeze({ 1: 0, 2: 0.66, 3: 0.77, 4: 0.77, 5: 0.88, 6: 0.95, 7: 1 });
const CONFIG = Object.freeze({ schema_version: 'phys-line-config/1', model_version: 'phys-line-v1', line_version: 'phys-line-v1', mean_version: 'mean-feature-span-v1', q_version: 'q-samehand-2s-v1', time_axis_version: 'ta-20261004', binWidth: 1.0, axes: AXES, lampWeight: LAMP_WEIGHT, section: 'Math.round(meanNps / binWidth) * binWidth', dbr: 'computeDbrLines' });
const CONFIG_V2 = Object.freeze({ schema_version: 'phys-line-config/1', model_version: 'phys-line-v2', line_version: 'phys-line-v2', mean_version: 'mean-os-pattern-span-v2', q_version: 'q-samehand-2s-v1', time_axis_version: 'ta-20261004', binWidth: 1, axes: AXES_V2, units: UNIT_V2, lampWeight: LAMP_WEIGHT, dbr: Object.freeze({ groupMinimum: 3, clearMinimum: 6, target: 0.5 }) });
const BASIS = 'dbr_weighted_clear×mean_nps';

function validateConfig(config = CONFIG) {
  const v2 = config?.model_version === 'phys-line-v2';
  const expected = v2 ? CONFIG_V2 : CONFIG;
  const axes = v2 ? AXES_V2 : AXES;
  const validDbr = v2
    ? config.dbr?.groupMinimum === 3 && config.dbr?.clearMinimum === 6 && config.dbr?.target === 0.5 && Object.keys(config.dbr).length === 3
    : config.section === CONFIG.section && config.dbr === CONFIG.dbr;
  if (!config || config.schema_version !== expected.schema_version || config.model_version !== expected.model_version || config.line_version !== expected.line_version || config.mean_version !== expected.mean_version || config.q_version !== expected.q_version || config.time_axis_version !== expected.time_axis_version || config.binWidth !== 1 || !Array.isArray(config.axes) || config.axes.length !== axes.length || config.axes.some((axis, i) => axis !== axes[i]) || Object.keys(config.lampWeight || {}).length !== 7 || Object.keys(LAMP_WEIGHT).some(k => config.lampWeight[k] !== LAMP_WEIGHT[k]) || !validDbr || (v2 && (Object.keys(config.units || {}).length !== AXES_V2.length || AXES_V2.some(axis => config.units[axis] !== UNIT_V2[axis])))) throw new TypeError('물리 실력선 설정 오류');
  return config;
}

const dbrPairWeight = p => p.weight ?? (p.cleared ? 1 : 0);
function quantileOfCleared(pairs) {
  const cl = (pairs || []).filter(p => p.cleared).map(p => p.level).sort((a, b) => a - b);
  return cl.length ? cl[Math.min(cl.length - 1, Math.floor(cl.length * 0.85))] : null;
}
function inflectionLevel(pairs, bin = 0.05, target = 0.85, minTotal = 6) {
  if (!pairs || pairs.length < minTotal) return quantileOfCleared(pairs);
  const bins = new Map();
  for (const p of pairs) { const k = Math.round(p.level / bin) * bin; if (!bins.has(k)) bins.set(k, { level: k, clear: 0, total: 0 }); const b = bins.get(k); b.total++; b.clear += dbrPairWeight(p); }
  const groups = []; let acc = null;
  for (const b of [...bins.values()].sort((a, b) => a.level - b.level)) { if (!acc) acc = { levelSum: 0, clear: 0, total: 0 }; acc.levelSum += b.level * b.total; acc.clear += b.clear; acc.total += b.total; if (acc.total >= 3) { groups.push(acc); acc = null; } }
  if (acc) { if (groups.length) { const g = groups[groups.length - 1]; g.levelSum += acc.levelSum; g.clear += acc.clear; g.total += acc.total; } else groups.push(acc); }
  const rates = groups.map(g => ({ level: g.levelSum / g.total, rate: g.clear / g.total }));
  if (rates.length < 2) return quantileOfCleared(pairs);
  for (let i = 0; i < rates.length - 1; i++) { const a = rates[i], b = rates[i + 1]; if (a.rate >= target && b.rate < target) { const t = (a.rate - target) / (a.rate - b.rate); return a.level + t * (b.level - a.level); } }
  return rates[rates.length - 1].rate >= target ? rates[rates.length - 1].level + bin : rates[0].level;
}
function inflectionLevelSec(pairs, target = 0.85, minTotal = 6) {
  if (!pairs || pairs.length < minTotal) return quantileOfCleared(pairs);
  const sections = new Map();
  for (const p of pairs) { if (!sections.has(p.level)) sections.set(p.level, { level: p.level, clear: 0, total: 0 }); const s = sections.get(p.level); s.total++; s.clear += dbrPairWeight(p); }
  const groups = []; let acc = null;
  for (const s of [...sections.values()].sort((a, b) => a.level - b.level)) { if (!acc) acc = { levelSum: 0, clear: 0, total: 0 }; acc.levelSum += s.level * s.total; acc.clear += s.clear; acc.total += s.total; if (acc.total >= 3) { groups.push(acc); acc = null; } }
  if (acc) { if (groups.length) { const g = groups[groups.length - 1]; g.levelSum += acc.levelSum; g.clear += acc.clear; g.total += acc.total; } else groups.push(acc); }
  const rates = groups.map(g => ({ level: g.levelSum / g.total, rate: g.clear / g.total }));
  if (rates.length < 2) return quantileOfCleared(pairs);
  for (let i = 0; i < rates.length - 1; i++) { const a = rates[i], b = rates[i + 1]; if (a.rate >= target && b.rate < target) { const t = (a.rate - target) / (a.rate - b.rate); return a.level + t * (b.level - a.level); } }
  return rates[rates.length - 1].rate >= target ? Math.max(...pairs.map(p => p.level)) : rates[0].level;
}
function computeUpperBase(zasaPairs, dbrPairs) {
  const zasaAsDbr = inflectionLevel(zasaPairs) == null ? null : inflectionLevel(zasaPairs) - 0.25;
  const dbrInflect = dbrPairs.every(p => dbrPairWeight(p) === 1) && dbrPairs.length > 0 ? Math.max(...dbrPairs.map(p => p.level)) : inflectionLevel(dbrPairs);
  return dbrPairs.filter(p => p.cleared).length > 5 ? (dbrInflect != null ? dbrInflect : zasaAsDbr != null ? zasaAsDbr : -Infinity) : (zasaAsDbr != null ? zasaAsDbr : dbrInflect != null ? dbrInflect : -Infinity);
}
function computeDbrLines({ zasaPairs = [], dbrPairs = [] }) {
  const dbrClearCount = dbrPairs.filter(p => p.cleared).length;
  const zasaAsDbr = inflectionLevel(zasaPairs) == null ? null : inflectionLevel(zasaPairs) - 0.25;
  if (dbrClearCount > 5) {
    const noFail = dbrPairs.length > 0 && dbrPairs.every(p => dbrPairWeight(p) === 1);
    if (noFail) { const maxLevel = Math.max(...dbrPairs.map(p => p.level)); return { path: 'dbr', line50: maxLevel, line85: maxLevel }; }
    const line85 = inflectionLevelSec(dbrPairs, 0.85), line50 = inflectionLevelSec(dbrPairs, 0.50);
    return { path: 'dbr', line50: line50 == null ? zasaAsDbr == null ? -Infinity : zasaAsDbr : line50, line85: line85 == null ? zasaAsDbr == null ? -Infinity : zasaAsDbr : line85 };
  }
  const line = computeUpperBase(zasaPairs, dbrPairs); return { path: 'zasa', line50: line, line85: line };
}
function computeDbrForPairs(pairs) { return computeDbrLines({ zasaPairs: [], dbrPairs: pairs }); }

function inflectionLevelV2(pairs) {
  if (pairs.length && pairs.every(p => p.weight === 1)) return Math.max(...pairs.map(p => p.level));
  const sections = new Map();
  for (const p of pairs) { if (!sections.has(p.level)) sections.set(p.level, { level: p.level, clear: 0, total: 0 }); const s = sections.get(p.level); s.total++; s.clear += p.weight; }
  const groups = []; let acc = null;
  for (const s of [...sections.values()].sort((a, b) => a.level - b.level)) { if (!acc) acc = { levelSum: 0, clear: 0, total: 0 }; acc.levelSum += s.level * s.total; acc.clear += s.clear; acc.total += s.total; if (acc.total >= 3) { groups.push(acc); acc = null; } }
  if (acc) { if (groups.length) { const g = groups[groups.length - 1]; g.levelSum += acc.levelSum; g.clear += acc.clear; g.total += acc.total; } else groups.push(acc); }
  const rates = groups.map(g => ({ level: g.levelSum / g.total, rate: g.clear / g.total }));
  if (rates.length < 2) return null;
  for (let i = 0; i < rates.length - 1; i++) { const a = rates[i], b = rates[i + 1]; if (a.rate >= 0.5 && b.rate < 0.5) { const t = (a.rate - 0.5) / (a.rate - b.rate); return a.level + t * (b.level - a.level); } }
  // DBR 원본(inflectionLevelSec)과 같이 전 구간이 50% 이상이면 최고 레벨을 쓴다.
  return rates[rates.length - 1].rate >= 0.5 ? Math.max(...pairs.map(p => p.level)) : rates[0].level;
}

function computePhysLineV1(selected, config) {
  const axes = {};
  for (const axis of AXES) {
    const randomExcluded = /RANDOM|R-RAN|S-RAN/i;
    const valid = selected.filter(row => Number.isFinite(row.features?.[axis]?.meanNps) && row.lampNum >= 1 && !(axis !== 'CN' && randomExcluded.test(String(row.arrange ?? row.arrange_assumed ?? ''))));
    const pairs = valid.map(row => ({ level: Math.round(row.features[axis].meanNps / config.binWidth) * config.binWidth, weight: LAMP_WEIGHT[row.lampNum], cleared: row.lampNum >= 2 }));
    const lines = computeDbrLines({ zasaPairs: [], dbrPairs: pairs });
    const clean = v => Number.isFinite(v) ? v : null;
    const line = clean(lines.line50), stable = clean(lines.line85);
    const reason = !valid.length ? 'no_charts' : !valid.some(row => row.lampNum >= 2) && line == null && stable == null ? 'no_cleared_charts' : line == null || stable == null ? 'insufficient_sample' : null;
    const top = valid.filter(row => row.lampNum >= 2).sort((a, b) => b.features[axis].meanNps - a.features[axis].meanNps || a.chartKey.localeCompare(b.chartKey)).slice(0, 3).map(row => ({ chartKey: row.chartKey, mean_nps: row.features[axis].meanNps, lamp: row.lampNum, weight: LAMP_WEIGHT[row.lampNum] }));
    axes[axis] = { line, stable_line: stable, basis: BASIS, n_charts: valid.length, n_failed: valid.filter(row => row.lampNum === 1).length, top_charts: top, reason };
  }
  return { model_version: 'phys-line-v1', line_version: 'phys-line-v1', mean_version: 'mean-feature-span-v1', q_version: 'q-samehand-2s-v1', time_axis_version: 'ta-20261004', axes };
}

function computePhysLineV2(selected) {
  const axes = {};
  for (const axis of AXES_V2) {
    const valid = selected.filter(row => Number.isFinite(row.features?.[axis]?.meanNps) && row.lampNum >= 1);
    const pairs = valid.map(row => ({ level: Math.round(row.features[axis].meanNps), weight: LAMP_WEIGHT[row.lampNum], cleared: row.lampNum >= 2 }));
    const cleared = pairs.filter(p => p.cleared).length;
    const line = cleared < 6 ? null : inflectionLevelV2(pairs);
    const reason = cleared < 6 ? 'insufficient_clears' : line == null ? 'insufficient_sample' : null;
    const top = valid.filter(row => row.lampNum >= 2).sort((a, b) => b.features[axis].meanNps - a.features[axis].meanNps || a.chartKey.localeCompare(b.chartKey)).slice(0, 3).map(row => ({ chartKey: row.chartKey, mean_nps: row.features[axis].meanNps, lamp: row.lampNum, weight: LAMP_WEIGHT[row.lampNum] }));
    const maximum = valid.filter(row => row.lampNum >= 3).sort((a, b) => b.features[axis].meanNps - a.features[axis].meanNps || a.chartKey.localeCompare(b.chartKey))[0];
    const max_chart = maximum ? { chartKey: maximum.chartKey, mean_nps: maximum.features[axis].meanNps, lamp: maximum.lampNum } : null;
    axes[axis] = { line, max_line: max_chart?.mean_nps ?? null, max_chart, basis: BASIS, n_charts: valid.length, n_failed: valid.filter(row => row.lampNum === 1).length, top_charts: top, reason, unit: UNIT_V2[axis] };
  }
  return { model_version: 'phys-line-v2', line_version: 'phys-line-v2', mean_version: 'mean-os-pattern-span-v2', q_version: 'q-samehand-2s-v1', time_axis_version: 'ta-20261004', axes };
}

function computePhysLine({ rows, config = CONFIG } = {}) {
  validateConfig(config);
  if (!Array.isArray(rows)) throw new TypeError('rows 배열 필요');
  const best = new Map();
  for (const row of rows) {
    if (!row || typeof row.chartKey !== 'string' || !row.chartKey || !Number.isInteger(row.lampNum) || row.lampNum < 0 || row.lampNum > 7) continue;
    const prior = best.get(row.chartKey);
    if (!prior || row.lampNum > prior.lampNum) best.set(row.chartKey, row);
  }
  const selected = [...best.values()];
  return config.model_version === 'phys-line-v2' ? computePhysLineV2(selected) : computePhysLineV1(selected, config);
}

const api = { AXES: Object.freeze(AXES), AXES_V2: Object.freeze(AXES_V2), UNIT_V2, CONFIG, CONFIG_V2, LAMP_WEIGHT, validateConfig, computeDbrForPairs, computePhysLine };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.physLine = api;

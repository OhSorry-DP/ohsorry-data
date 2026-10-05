'use strict';

const AXES = ['STAIR_UP', 'STAIR_DN', 'DOUBLE_STAIR', 'KEIMA', 'SPIRAL_UP', 'SPIRAL_DN', 'JUMP_WIDE', 'HSTAIR_SYM', 'HSTAIR_ASYM', 'CN'];
const LAMP_WEIGHT = Object.freeze({ 1: 0, 2: 0.66, 3: 0.77, 4: 0.77, 5: 0.88, 6: 0.95, 7: 1 });
const CONFIG = Object.freeze({ schema_version: 'phys-line-config/1', model_version: 'phys-line-v1', line_version: 'phys-line-v1', mean_version: 'mean-feature-span-v1', q_version: 'q-samehand-2s-v1', time_axis_version: 'ta-20261004', binWidth: 1.0, axes: AXES, lampWeight: LAMP_WEIGHT, section: 'Math.round(meanNps / binWidth) * binWidth', dbr: 'computeDbrLines' });
const BASIS = 'dbr_weighted_clear×mean_nps';

function validateConfig(config = CONFIG) {
  if (!config || config.schema_version !== 'phys-line-config/1' || config.model_version !== 'phys-line-v1' || config.line_version !== 'phys-line-v1' || config.mean_version !== 'mean-feature-span-v1' || config.q_version !== 'q-samehand-2s-v1' || config.time_axis_version !== 'ta-20261004' || config.binWidth !== 1.0 || !Array.isArray(config.axes) || config.axes.length !== AXES.length || config.axes.some((axis, i) => axis !== AXES[i]) || Object.keys(config.lampWeight || {}).length !== 7 || Object.keys(LAMP_WEIGHT).some(k => config.lampWeight[k] !== LAMP_WEIGHT[k])) throw new TypeError('물리 실력선 설정 오류');
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

const api = { AXES: Object.freeze(AXES), CONFIG, LAMP_WEIGHT, validateConfig, computeDbrForPairs, computePhysLine };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.physLine = api;

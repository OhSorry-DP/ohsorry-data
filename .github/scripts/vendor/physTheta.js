'use strict';

// T02 baseline-2s 물리 profile 추출본. 모집단과 표준화는 변경하지 않는다.
const AXES = ['STAIR_UP', 'STAIR_DN', 'DOUBLE_STAIR', 'KEIMA', 'SPIRAL_UP', 'SPIRAL_DN', 'JUMP_WIDE', 'HSTAIR_SYM', 'HSTAIR_ASYM', 'CN'];
const sigmoid = x => 1 / (1 + Math.exp(-Math.max(-40, Math.min(40, x))));
const q = (r, a) => r.features?.[a]?.maxQ ?? 0;

function context(fit, userId, rows, pool) {
  const initial = AXES.map(a => fit.logTheta[a][userId] ?? Math.log(Math.max(.1, pool[a])));
  const hi = AXES.map(a => Math.log(Math.max(.1, 4 * pool[a])));
  // nuisance 축의 수치 바닥을 검사 축의 그리드보다 충분히 낮춘다.
  // 공통 바닥 때문에 다른 축의 θ/a 이동이 막혀 가짜 양의 하한이 생기지 않게 한다.
  const lo = Math.log(1e-8);
  const data = rows.map(r => {
    const eta = predict(fit, r).eta;
    const logs = AXES.map(a => q(r, a) > 0 ? Math.log(Math.max(.01, q(r, a))) : -Infinity);
    const D = Math.max(0, ...logs.map((v, j) => v - initial[j]));
    return { logs, offset: eta - fit.a[userId] + 4 * D, y: r.lampNum - 1 };
  });
  let evaluations = 0;
  function loss(t, a) {
    let value = 0;
    for (const r of data) {
      let d = 0;
      for (let j = 0; j < 10; j++) d = Math.max(d, r.logs[j] - t[j]);
      const eta = r.offset + a - 4 * d;
      const lower = r.y === 0 ? 1 : sigmoid(eta - fit.kappa[r.y - 1]);
      const upper = r.y === 6 ? 0 : sigmoid(eta - fit.kappa[r.y]);
      value -= Math.log(Math.max(1e-12, lower - upper));
    }
    evaluations += data.length;
    return value;
  }
  function optimize(start, fixed = -1, value = null) {
    const t = start.t.slice(); let a = start.a;
    if (fixed >= 0) t[fixed] = value;
    function intercept() {
      const offsets = data.map(r => {
        let d = 0; for (let j = 0; j < 10; j++) d = Math.max(d, r.logs[j] - t[j]);
        return r.offset - 4 * d;
      });
      // 절편은 볼록 1차원 해를 Newton으로 구해 작은 θ에서의 가짜 하한을 피한다.
      for (let iteration = 0; iteration < 40; iteration++) {
        let gradient = 0, curvature = 0;
        for (let k = 0; k < data.length; k++) {
          const y = data[k].y, eta = offsets[k] + a;
          const lower = y === 0 ? 1 : sigmoid(eta - fit.kappa[y - 1]);
          const upper = y === 6 ? 0 : sigmoid(eta - fit.kappa[y]);
          gradient += lower + upper - 1;
          curvature += lower * (1 - lower) + upper * (1 - upper);
        }
        evaluations += data.length;
        if (Math.abs(gradient) < 1e-7 || curvature < 1e-12) break;
        a -= Math.max(-5, Math.min(5, gradient / curvature));
      }
    }
    intercept();
    let objective = loss(t, a), converged = true, passes = 0;
    for (const step of [.2, .1, .05, .025]) {
      let stable = false;
      for (let pass = 0; pass < 20; pass++) {
        const before = objective; passes++;
        for (let j = 0; j < 10; j++) {
          if (j === fixed) continue;
          const old = j === 10 ? a : t[j]; let best = old, bestLoss = objective;
          for (const sign of [-1, 1]) {
            const candidate = j === 10 ? old + sign * step : Math.max(lo, Math.min(hi[j], old + sign * step));
            if (j === 10) a = candidate; else t[j] = candidate;
            const l = loss(t, a);
            if (l < bestLoss - 1e-10) { best = candidate; bestLoss = l; }
          }
          if (j === 10) a = best; else t[j] = best;
          objective = bestLoss;
        }
        intercept(); objective = loss(t, a);
        if (before - objective < 1e-6) { stable = true; break; }
      }
      converged &&= stable;
    }
    return { t, a, objective, converged, passes };
  }
  return { initial, hi, lo, loss, optimize, get evaluations() { return evaluations; } };
}

function profileCell({ fitted, userId, axis, rows, pool, rules }) {
  const j = AXES.indexOf(axis);
  const positive = rows.filter(r => q(r, axis) > 0);
  const songs = new Set(positive.map(r => r.songId));
  const successes = new Set(positive.filter(r => r.lampNum > 1).map(r => r.songId)).size;
  const failures = new Set(positive.filter(r => r.lampNum === 1).map(r => r.songId)).size;
  const thin = songs.size < rules.minSongs || successes < rules.minSide || failures < rules.minSide;
  const base = fitted.theta[axis][userId];
  const Cu = positive.reduce((m, r) => Math.max(m, q(r, axis)), 0), Cf = pool[axis];
  const common = { userId, axis, modelTheta: base, supportSongs: songs.size, successes, failures, thin, C_u: Cu, C_f: Cf };
  if (!positive.length || !Number.isFinite(base)) return { ...common, estimate_kind: 'unidentified', theta: null, lower: null, upper: null, interval_status: 'unavailable', unobserved: true, pool_ceiling: false, support_ceiling: false, prior_driven: true, priorOnlyLower: false, width: null };
  const ctx = context(fitted, userId, rows, pool);
  const starts = [ctx.initial, ctx.hi, ctx.initial.map(v => Math.max(ctx.lo, v - 1)), ctx.initial.map(v => Math.max(ctx.lo, v - 8))];
  let best = starts.map((t, k) => ctx.optimize({ t, a: fitted.a[userId] + (k === 3 ? 32 : 0) })).sort((a, b) => a.objective - b.objective)[0];
  const gridLo = Math.log(.01);
  const count = Math.ceil((ctx.hi[j] - gridLo) / .05);
  const grid = Array.from({ length: count + 1 }, (_, k) => gridLo + (ctx.hi[j] - gridLo) * k / count);
  function atGrid(start, t) {
    const regular = ctx.optimize(start, j, t);
    const delta = t - start.t[j];
    // max(log q - log θ)의 공통 스케일 이동과 a의 보상을 함께 시작한다.
    // 한 좌표씩만 움직일 때 놓치는 비식별 능선이 숫자 하한으로 잘리지 않게 한다.
    const scaled = ctx.optimize({ t: start.t.map((v, k) => Math.max(ctx.lo, Math.min(ctx.hi[k], v + delta))), a: start.a - 4 * delta }, j, t);
    return scaled.objective < regular.objective ? scaled : regular;
  }
  // 양방향 warm start로 비볼록 max 병목 목적함수의 시작점 의존을 줄인다.
  const points = []; let warm = best;
  for (const t of grid) { warm = atGrid(warm, t); points.push(warm); if (warm.objective < best.objective) best = warm; }
  warm = best;
  for (let k = grid.length - 1; k >= 0; k--) {
    warm = atGrid(warm, grid[k]);
    if (warm.objective < points[k].objective) points[k] = warm;
    if (warm.objective < best.objective) best = warm;
  }
  const accepted = points.map((p, k) => p.objective <= best.objective + 1.92 ? k : -1).filter(k => k >= 0);
  const first = accepted[0], last = accepted.at(-1);
  const lowerConverged = first > 0 && best.converged && points[first].converged && points[first - 1].converged;
  const upperConverged = last != null && last < grid.length - 1 && best.converged && points[last].converged && points[last + 1].converged;
  const lower = lowerConverged ? Math.exp(grid[first]) : null;
  const upper = upperConverged ? Math.exp(grid[last]) : null;
  const poolCeiling = base >= .95 * Cf || (last != null && Math.exp(grid[last]) >= Cf);
  const supportCeiling = !poolCeiling && (base >= .95 * Cu || last != null && Math.exp(grid[last]) >= Cu);
  const profileTheta = Math.exp(best.t[j]);
  const components = accepted.reduce((n, k, i) => n + +(i === 0 || k !== accepted[i - 1] + 1), 0);
  const bounded = lower != null && upper != null && !poolCeiling && !supportCeiling && components === 1 && lower <= profileTheta && profileTheta <= upper;
  const kind = bounded ? 'point_estimate' : lower != null && last === grid.length - 1 ? 'lower_bound' : 'unidentified';
  // 이전의 bootstrap/prior 숫자가 하한처럼 보일 수 있는 셀을 별도 집계한다.
  const priorOnlyLower = (poolCeiling || supportCeiling) && lower == null;
  return { ...common, estimate_kind: kind, theta: kind === 'point_estimate' ? profileTheta : null,
    lower: kind === 'unidentified' ? null : lower, upper: kind === 'point_estimate' ? upper : null,
    interval_status: kind === 'point_estimate' ? 'bounded' : kind === 'lower_bound' ? 'one_sided' : 'unavailable',
    unobserved: false, pool_ceiling: poolCeiling, support_ceiling: supportCeiling, prior_driven: !bounded,
    priorOnlyLower, width: lower != null && upper != null ? upper - lower : null,
    profile: { lower, upper, lowerBoundary: first === 0, upperPlateau: last === grid.length - 1,
      minimumNll: best.objective, profileTheta, minimumConverged: best.converged, lowerConverged, upperConverged,
      cutoff: 1.92, stepLog: (ctx.hi[j] - gridLo) / count, gridLower: .01, nuisanceLower: 1e-8, scaleWarmStart: true,
      gridPoints: grid.length, unconvergedPoints: points.filter(p => !p.converged).length,
      acceptedComponents: components,
      nuisance: '나머지 9축 θ 및 유저 절편 재최적화; 모든 유저 사전항 없음', conditional: true },
    rowEvaluations: ctx.evaluations };
}

const RULES = Object.freeze({ minSongs: 20, minSide: 5, lrCutoff: 3.84 });
const IMPLEMENTATION = 'phys-theta-local/1';

// 표준화와 모집단만 사용하며 ★와 점수는 읽지 않는다.
function predict(fit, row) {
  const stats = fit.covariateStats;
  let D = 0;
  for (const axis of AXES) {
    const t = fit.logTheta[axis][String(row.userId)];
    const v = q(row, axis);
    if (v > 0 && t != null) D = Math.max(D, Math.log(Math.max(.01, v)) - t);
  }
  const notes = (Math.log(Math.max(1, row.notes || 1) / 1000) - stats.notes.mean) / stats.notes.sd;
  const duration = (Math.log(Math.max(1, row.duration || 120) / 120) - stats.duration.mean) / stats.duration.sd;
  return { eta: fit.a[String(row.userId)] + fit.b.b0 + fit.b.b2 * notes + fit.b.b3 * duration - 4 * D };
}

function validateModel(model) {
  if (!model || model.schema_version !== 'phys-model/1' || model.purpose !== 'clear' ||
      model.variant !== 'baseline-2s' || model.covariates !== 'physical') throw new TypeError('지원하지 않는 모델');
  if (!/^[a-f0-9]{64}$/.test(model.content_hash || '')) throw new TypeError('모델 콘텐츠 해시 필요');
  for (const field of ['model_version', 'q_version', 'time_axis_version']) {
    if (model[field] !== null && (typeof model[field] !== 'string' || !model[field])) throw new TypeError('버전 필드 오류');
  }
  for (const k of ['b0', 'b2', 'b3']) if (!Number.isFinite(model.b?.[k])) throw new TypeError('모집단 b 오류');
  if (model.b.b1 != null && model.b.b1 !== 0) throw new TypeError('★ 공변량 금지');
  if (!Array.isArray(model.kappa) || model.kappa.length !== 6 ||
      model.kappa.some((v, i, a) => !Number.isFinite(v) || i > 0 && v <= a[i - 1])) throw new TypeError('κ 오류');
  for (const key of ['notes', 'duration']) {
    const stat = model.covariateStats?.[key];
    if (!Number.isFinite(stat?.mean) || !Number.isFinite(stat?.sd) || stat.sd <= 0) throw new TypeError('표준화 오류');
  }
  for (const axis of AXES) if (!Number.isFinite(model.pool?.[axis]) || model.pool[axis] < 0) throw new TypeError('풀 천장 오류');
  return model;
}

function prepareUser({ model, userId, rows, initial = null }) {
  validateModel(model);
  if (typeof userId !== 'string' || !userId || !Array.isArray(rows)) throw new TypeError('유저 입력 오류');
  const valid = rows.filter(r => String(r.userId) === userId && Number.isInteger(r.lampNum) && r.lampNum >= 1 && r.lampNum <= 7);
  for (const row of valid) {
    if (!row.songId || !row.chartKey) throw new TypeError('곡과 채보 키 필요');
    for (const axis of AXES) {
      const v = row.features?.[axis]?.maxQ;
      if (v != null && (!Number.isFinite(v) || v < 0)) throw new TypeError('유효하지 않은 q');
    }
  }
  // RANDOM 계열은 배치 의존 축을 제외한다. CN은 유지한다.
  const prepared = valid.map(r => {
    const arrange = r.arrange ?? r.arrange_assumed ?? (r.arrangeAssumed ? 'unknown' : null);
    const random = typeof arrange === 'string' && /RANDOM|R-RAN|S-RAN/i.test(arrange);
    const features = Object.fromEntries(AXES.map(axis => [axis, random && axis !== 'CN' ? { maxQ: null } : { ...r.features?.[axis] }]));
    return { ...r, features, arrange_assumed: arrange };
  });
  const theta = {}, logTheta = {};
  for (const axis of AXES) {
    const value = initial?.theta?.[axis] ?? Math.max(.1, model.pool[axis]);
    if (!Number.isFinite(value) || value <= 0) throw new TypeError('초기 좌표 오류');
    theta[axis] = { [userId]: value }; logTheta[axis] = { [userId]: Math.log(value) };
  }
  const a = initial?.a ?? 0;
  if (!Number.isFinite(a)) throw new TypeError('초기 절편 오류');
  const fitted = { ...model, theta, logTheta, a: { [userId]: a } };
  return AXES.map(axis => ({ fitted, userId, axis, rows: prepared, pool: model.pool, rules: RULES }));
}

function fitAxis(task) {
  validateModel(task?.fitted);
  if (!AXES.includes(task.axis) || !Array.isArray(task.rows) ||
      task.rows.some(r => String(r.userId) !== task.userId)) throw new TypeError('단일 유저 축 작업 필요');
  return profileCell({ ...task, rules: RULES, pool: task.fitted.pool });
}

function projectAbsolute(model, cells, { source_revision, generated_at }) {
  if (typeof source_revision !== 'string' || !source_revision ||
      !/^\d{4}-\d\d-\d\dT.*Z$/.test(generated_at || '') || !Number.isFinite(Date.parse(generated_at))) throw new TypeError('입력 revision 및 UTC 시각 필요');
  const axes = {};
  for (const c of cells) {
    const arrangements = [...new Set(c.arrangements || [])];
    axes[c.axis] = {
      estimate_kind: c.estimate_kind, theta: c.theta, lower: c.lower, upper: c.upper,
      interval_status: c.interval_status, thin: c.thin, pool_ceiling: c.pool_ceiling,
      support_ceiling: c.support_ceiling, prior_driven: c.prior_driven, unobserved: c.unobserved,
      arrange_assumed: arrangements.length === 1 ? arrangements[0] : arrangements.length ? 'mixed' : null,
      provenance: { estimator: IMPLEMENTATION, fixed_population: true, conditional: true,
        model_hash: model.content_hash, support_songs: c.supportSongs, successes: c.successes,
        failures: c.failures, hand: c.axis.startsWith('HSTAIR') ? 'both' : 'per_hand',
        pool_max_q: c.C_f, support_max_q: c.C_u, observed_hands: c.hands || [] }
    };
  }
  return { status: 'ready', reason: null, purpose: 'clear', unit: 'notes/s',
    model_version: model.model_version, q_version: model.q_version, time_axis_version: model.time_axis_version,
    source_revision, generated_at, stale: false, axes };
}

// 호출자가 evaluate.poolMap 또는 브라우저 Worker 풀 및 해시 캐시를 주입한다.
async function fitUser(input, { poolMap, concurrency = 1, workerFile, cache, hash } = {}) {
  const tasks = prepareUser(input);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 1 && !poolMap) throw new TypeError('병렬 풀 필요');
  if (cache && typeof hash !== 'function') throw new TypeError('캐시 해시 함수 필요');
  const results = new Array(tasks.length), missing = [], indices = [], keys = [];
  for (let i = 0; i < tasks.length; i++) {
    keys[i] = cache ? await hash(JSON.stringify([IMPLEMENTATION, input.model.content_hash, tasks[i]])) : null;
    const found = cache ? await cache.get(keys[i]) : undefined;
    if (found != null) results[i] = found;
    else { missing.push(tasks[i]); indices.push(i); }
  }
  const completed = poolMap ? await poolMap(missing, concurrency, fitAxis, workerFile) : missing.map(fitAxis);
  for (let k = 0; k < completed.length; k++) {
    const i = indices[k]; results[i] = completed[k];
    if (cache) await cache.set(keys[i], completed[k]);
  }
  const cells = results.map((r, i) => ({ ...r,
    hands: [...new Set(tasks[i].rows.filter(row => q(row, r.axis) > 0).map(row => row.features[r.axis]?.hand).filter(v => v != null))],
    arrangements: [...new Set(tasks[i].rows.filter(row => q(row, r.axis) > 0).map(row => row.arrange_assumed))] }));
  return projectAbsolute(input.model, cells, input);
}

// 정확한 채보 요구와 공개 구간만 대조하며 하한을 θ로 대입하지 않는다.
function compareBottlenecks(absolute, chart) {
  if (absolute?.purpose !== 'clear' || !['ready', 'stale'].includes(absolute.status)) throw new TypeError('clear 결과 필요');
  const candidates = [];
  for (const axis of AXES) {
    const value = chart.features?.[axis]?.maxQ;
    const c = absolute.axes[axis];
    if (!(value > 0) || !c || c.unobserved || /RANDOM|R-RAN|S-RAN/i.test(chart.arrange || '') && axis !== 'CN') continue;
    const excess = theta => Math.max(0, Math.log(value / theta));
    candidates.push({ axis, q: value, hand: axis.startsWith('HSTAIR') ? 'both' : chart.features[axis].hand ?? null,
      estimate_kind: c.estimate_kind, excess: c.theta == null ? null : excess(c.theta),
      excess_lower: c.upper == null ? 0 : excess(c.upper),
      excess_upper: c.lower == null ? null : excess(c.lower),
      thin: c.thin, arrange_assumed: c.arrange_assumed, windows: (chart.worstWindows?.[axis] || []).slice(0, 3) });
  }
  candidates.sort((a, b) => (b.excess ?? b.excess_upper ?? -1) - (a.excess ?? a.excess_upper ?? -1) || AXES.indexOf(a.axis) - AXES.indexOf(b.axis));
  return candidates.slice(0, 3);
}

const api = { AXES: Object.freeze(AXES), RULES, IMPLEMENTATION, validateModel, prepareUser, fitAxis, fitUser, compareBottlenecks };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.physTheta = api;

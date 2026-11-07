import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { list, getText, pool, conditionalR2Client } from './r2-client.mjs';

const VARIANTS_URL = 'https://iidx.in/legacy/shared/variants.js';
const NORM_TITLE_URL = 'https://data.iidx.in/lib/normTitle.js';
const SOURCES = {
  songs: 'https://data.iidx.in/songs.json',
  textage: 'https://data.iidx.in/data/textage-meta.json',
  cpi: 'https://data.iidx.in/data/cpi.json',
  star: 'https://data.iidx.in/data/sp-clear-star.json',
};
const USER_KEY_RE = /^user\/([A-Za-z0-9]+)\.json$/;
const DIFFS = ['BEGINNER', 'NORMAL', 'HYPER', 'ANOTHER', 'LEGGENDARIA'];
const STAR_FIELDS = ['estEc', 'estHc', 'estExh', 'estFc'];
const GUARD_POLICY = null;
const ASSET_KEY = 'data/sp-clear-map.json';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: 객체 형식 오류`);
  return value;
}

function parseJson(raw, label) {
  if (typeof raw !== 'string') throw new Error(`${label}: 본문 없음`);
  try { return JSON.parse(raw); } catch (error) { throw new Error(`${label}: JSON 파싱 실패: ${error.message}`); }
}

export function loadNorm(source) {
  const module = { exports: {} };
  const window = {};
  Function('module', 'exports', 'window', source)(module, module.exports, window);
  const exported = module.exports && Object.keys(module.exports).length ? module.exports : window;
  const norm = exported.norm || exported.OhsorryNorm?.norm || window.OhsorryNorm?.norm;
  if (typeof norm !== 'function') throw new Error('normTitle UMD norm 함수 누락');
  return norm;
}

export async function loadVariants(source, importModule = (url) => import(url)) {
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  const variants = await importModule(moduleUrl);
  for (const name of ['resolveChartId', 'ratingKeyOf', 'variantChartKey']) {
    if (typeof variants[name] !== 'function') throw new Error(`variants ${name} 함수 누락`);
  }
  return variants;
}

async function fetchBody(fetchImpl, url) {
  const response = await fetchImpl(url);
  if (!response?.ok) throw new Error(`${url}: HTTP ${response?.status}`);
  const body = await response.text();
  if (!body || /^\s*</.test(body)) throw new Error(`${url}: 본문 형식 오류`);
  return body;
}

export async function loadInputs({ list: listFn = list, getText: read = getText, fetchImpl = fetch, importModule } = {}) {
  const userKeys = (await listFn('user/')).filter((key) => USER_KEY_RE.test(key)).sort();
  if (!userKeys.length) throw new Error('user/ 목록이 비어 있음');
  const raws = new Array(userKeys.length);
  await pool(userKeys, 8, async (key) => {
    const index = userKeys.indexOf(key);
    const raw = await read(key);
    if (raw == null) throw new Error(`R2 ${key}: 목록 이후 404`);
    raws[index] = raw;
  });
  const [songsRaw, textageRaw, cpiRaw, starRaw, variantsRaw, normRaw] = await Promise.all([
    ...Object.values(SOURCES).map((url) => fetchBody(fetchImpl, url)),
    fetchBody(fetchImpl, VARIANTS_URL), fetchBody(fetchImpl, NORM_TITLE_URL),
  ]);
  const dumps = raws.map((raw, index) => assertObject(parseJson(raw, userKeys[index]), userKeys[index]));
  const songs = parseJson(songsRaw, 'songs.json');
  const textage = parseJson(textageRaw, 'textage-meta.json');
  const cpiRows = parseJson(cpiRaw, 'cpi.json');
  const starData = parseJson(starRaw, 'sp-clear-star.json');
  if (!Array.isArray(songs)) throw new Error('songs.json: 배열 형식 오류');
  if (!Array.isArray(cpiRows)) throw new Error('cpi.json: 배열 형식 오류');
  if (!Array.isArray(starData?.rows)) throw new Error('sp-clear-star.json: rows 배열 형식 오류');
  if (!textage?.songs || typeof textage.songs !== 'object' || Array.isArray(textage.songs)) throw new Error('textage-meta.json: songs 객체 형식 오류');
  return { dumps, songs, textage, cpiRows, starRows: starData.rows,
    norm: loadNorm(normRaw), variants: await loadVariants(variantsRaw, importModule),
    hashes: { songs: sha256(songsRaw), textage: sha256(textageRaw), cpi: sha256(cpiRaw),
      'sp-clear-star': sha256(starRaw), variants: sha256(variantsRaw), normTitle: sha256(normRaw) } };
}

function validateRatingRows(rows, label) {
  if (!Array.isArray(rows)) throw new Error(`${label}: 배열 형식 오류`);
  for (const row of rows) {
    assertObject(row, label);
    for (const field of [...STAR_FIELDS, 'estCl']) if (row[field] !== null && row[field] !== undefined && (typeof row[field] !== 'number' || !Number.isFinite(row[field]))) {
      throw new Error(`${label}: ${field} 숫자 오류`);
    }
  }
}

function makeRatingKey(row, norm, variants) {
  return variants.ratingKeyOf(row, norm, { source: 'AC' });
}

export function collectObservations({ dumps, songs, textage, cpiRows, starRows, norm, variants }) {
  if (!Array.isArray(dumps) || !Array.isArray(songs) || !Array.isArray(cpiRows) || !Array.isArray(starRows)) throw new Error('입력 배열 형식 오류');
  validateRatingRows(cpiRows, 'cpi.json');
  validateRatingRows(starRows, 'sp-clear-star.json');
  const songsById = new Map(songs.map((song) => [song.song_id, song]));
  const stars = new Map();
  for (const row of starRows) {
    const key = makeRatingKey(row, norm, variants);
    if (key != null && [11, 12].includes(row.gameLevel)) stars.set(key, { gameLevel: row.gameLevel, ...Object.fromEntries(STAR_FIELDS.map((field) => [field, row[field] ?? null])) });
  }
  for (const row of cpiRows) {
    const key = makeRatingKey(row, norm, variants);
    if (key == null) continue;
    const previous = stars.get(key);
    if (previous && previous.gameLevel !== 12) continue;
    const merged = { ...row, ...previous, gameLevel: 12 };
    for (const field of STAR_FIELDS) if (Number.isFinite(row[field])) merged[field] = row[field];
    stars.set(key, { gameLevel: 12, ...Object.fromEntries(STAR_FIELDS.map((field) => [field, merged[field] ?? null])) });
  }
  const plays = new Map();
  const counts = { usersRead: 0, usersWithStar: 0, usersWithoutStar: 0, observations: 0, unresolved: 0, outOfScope: 0 };
  const userStar = [];
  for (const dump of dumps) {
    assertObject(dump?.user, 'user dump user');
    const userId = dump.user.iidx_id;
    if (typeof userId !== 'string' || !userId) throw new Error('user.iidx_id 누락');
    counts.usersRead++;
    const hasStar = dump.user.sp_star !== null && dump.user.sp_star !== undefined;
    if (hasStar) {
      if (typeof dump.user.sp_star !== 'number' || !Number.isFinite(dump.user.sp_star)) throw new Error(`user/${userId}: sp_star 숫자 오류`);
      counts.usersWithStar++; userStar.push([userId, dump.user.sp_star]);
    } else counts.usersWithoutStar++;
    if (!hasStar) continue;
    if (!Array.isArray(dump.sp)) throw new Error(`user/${userId}: sp 배열 오류`);
    const ownBest = new Map();
    for (const row of dump.sp) {
      assertObject(row, `user/${userId}: sp row`);
      if (row.played_version === -10 || row.__playedVersion === -10) continue;
      if (!Number.isInteger(row.song_id) || !Number.isInteger(row.diff)) throw new Error(`user/${userId}: 채보 식별 숫자 오류`);
      const rawLamp = row.lamp;
      if (rawLamp == null || rawLamp === 0) continue;
      if (typeof rawLamp !== 'number' || !Number.isFinite(rawLamp) || !Number.isInteger(rawLamp) || rawLamp < 1 || rawLamp > 7) throw new Error(`user/${userId}: lamp 값 오류`);
      const song = songsById.get(row.song_id);
      if (!song) { counts.unresolved++; continue; }
      const diff = DIFFS[row.diff];
      if (!diff) throw new Error(`user/${userId}: diff 값 오류`);
      const chart = { title: row.title ?? song.title, diff, __playedVersion: row.played_version,
        __textageSongId: variants.resolveChartId({ ...row, title: row.title ?? song.title,
          textage_song_id: row.textage_song_id ?? song.textage_song_id }, textage?.songs ?? {}, norm) };
      if (!chart.title) { counts.unresolved++; continue; }
      const resolvedId = variants.resolveChartId(chart, null, norm);
      const rowKey = variants.variantChartKey(chart.title, diff, resolvedId, norm);
      if (rowKey == null) { counts.unresolved++; continue; }
      const key = variants.ratingKeyOf(chart, norm);
      if (key == null) { counts.unresolved++; continue; }
      const star = stars.get(key);
      if (!star) { counts.outOfScope++; continue; }
      const previous = ownBest.get(key);
      if (!previous || rawLamp > previous) ownBest.set(key, rawLamp);
    }
    for (const [key, lampNum] of ownBest) {
      if (!plays.has(key)) plays.set(key, []);
      plays.get(key).push([userId, dump.user.sp_star, lampNum]);
      counts.observations++;
    }
  }
  for (const values of plays.values()) values.sort((a, b) => a[0].localeCompare(b[0]));
  const sortedStars = [...stars].sort(([a], [b]) => a.localeCompare(b));
  const hashes = {
    stars: sha256(JSON.stringify(sortedStars.map(([key, star]) => [key, star.gameLevel, ...STAR_FIELDS.map((field) => star[field])]))),
    users: sha256(JSON.stringify(userStar.sort(([a], [b]) => a.localeCompare(b)))),
  };
  return { stars, plays, counts, hashes };
}

const LAMP_THRESHOLDS = { ec: 3, hc: 5, ex: 6, fc: 7 };

export function balanceLine(plays, lamp) {
  if (!Array.isArray(plays) || plays.length < 8 || !LAMP_THRESHOLDS[lamp]) return null;
  const points = plays.map(([, star, value]) => [star, value >= LAMP_THRESHOLDS[lamp]]);
  const successes = points.filter(([, cleared]) => cleared).length;
  const top = Math.max(...points.map(([star]) => star));
  const bottom = Math.min(...points.map(([star]) => star));
  if (!successes) return { c: top, st: 'hard' };
  if (successes === points.length) return { c: bottom, st: 'easy' };
  const min = Math.floor(bottom * 10) / 10;
  const max = Math.ceil(top * 10) / 10;
  let best = Infinity;
  const tied = [];
  for (let s = min; s <= max + 1e-9; s = +(s + 0.1).toFixed(1)) {
    let errors = 0;
    for (const [star, cleared] of points) if ((star >= s && !cleared) || (star < s && cleared)) errors++;
    if (errors < best) { best = errors; tied.length = 0; tied.push(s); }
    else if (errors === best) tied.push(s);
  }
  if (tied[tied.length - 1] >= max) return { c: top, st: 'hard' };
  if (tied[0] <= min) return { c: bottom, st: 'easy' };
  return { c: (tied[0] + tied[tied.length - 1]) / 2, st: 'ok' };
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

export function tableOf(pairs) {
  const bins = new Map();
  for (const [x, y] of pairs) {
    const bin = Math.floor(x);
    if (!bins.has(bin)) bins.set(bin, []);
    bins.get(bin).push(y);
  }
  const table = [...bins.keys()].filter((bin) => bins.get(bin).length >= 5).sort((a, b) => a - b)
    .map((bin) => [bin + 0.5, median(bins.get(bin))]);
  for (let i = 1; i < table.length; i++) table[i][1] = Math.max(table[i][1], table[i - 1][1]);
  return table;
}

export function applyTable(x, points) {
  if (!points.length) return x;
  if (x <= points[0][0]) return points[0][1] + x - points[0][0];
  for (let i = 1; i < points.length; i++) if (x <= points[i][0]) {
    const [leftX, leftY] = points[i - 1], [rightX, rightY] = points[i];
    return leftY + (rightY - leftY) * (x - leftX) / (rightX - leftX);
  }
  const [lastX, lastY] = points[points.length - 1];
  return lastY + x - lastX;
}

const TABLE_KEYS = { '11': ['ec', 'hc', 'ex', 'fc'], '12': ['ec', 'ex', 'fc'] };

export function validateTables(tables) {
  assertObject(tables, 'tables');
  for (const [level, lamps] of Object.entries(TABLE_KEYS)) {
    assertObject(tables[level], `tables.${level}`);
    for (const lamp of lamps) {
      const points = tables[level][lamp];
      if (!Array.isArray(points) || points.length === 0) throw new Error(`tables.${level}.${lamp}: 필수 표가 비어 있음`);
      let previousX = -Infinity, previousY = -Infinity;
      for (const point of points) {
        if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) throw new Error(`tables.${level}.${lamp}: 유한한 절점이 아님`);
        if (point[0] <= previousX) throw new Error(`tables.${level}.${lamp}: x 중복 또는 역전`);
        if (point[1] < previousY) throw new Error(`tables.${level}.${lamp}: y 단조 위반`);
        previousX = point[0]; previousY = point[1];
      }
    }
  }
  return { valid: true };
}

function legacyCompareTables(currentTables, candidateTables, starPositions) {
  validateTables(currentTables); validateTables(candidateTables);
  const currentNodes = [], candidateNodes = [];
  for (const level of Object.keys(TABLE_KEYS)) for (const lamp of TABLE_KEYS[level]) {
    currentNodes.push(...currentTables[level][lamp].map(([x]) => x));
    candidateNodes.push(...candidateTables[level][lamp].map(([x]) => x));
  }
  const nodeUnion = [...new Set([...currentNodes, ...candidateNodes])].sort((a, b) => a - b);
  const actualPositions = [...new Set(starPositions)].sort((a, b) => a - b);
  const diffs = actualPositions.map((x) => applyTable(x, candidateTables['11'].ec) - applyTable(x, currentTables['11'].ec));
  const abs = diffs.map(Math.abs).sort((a, b) => a - b);
  const medianAbs = abs.length ? abs[Math.floor(abs.length / 2)] : 0;
  const p90Abs = abs.length ? abs[Math.min(abs.length - 1, Math.ceil(abs.length * 0.9) - 1)] : 0;
  let maxIndex = 0;
  for (let i = 1; i < diffs.length; i++) if (Math.abs(diffs[i]) > Math.abs(diffs[maxIndex])) maxIndex = i;
  return { medianAbs, p90Abs, maxAbs: abs.at(-1) ?? 0, direction: diffs.length ? Math.sign(diffs[maxIndex]) : 0,
    maxPosition: diffs.length ? actualPositions[maxIndex] : null, overPointOne: diffs.filter((value) => Math.abs(value) >= 0.1).length,
    currentNodeCount: currentNodes.length, candidateNodeCount: candidateNodes.length,
    currentIntervalCount: Math.max(0, currentNodes.length - 1), candidateIntervalCount: Math.max(0, candidateNodes.length - 1),
    lostNodes: Object.keys(TABLE_KEYS).flatMap((level) => TABLE_KEYS[level].flatMap((lamp) => currentTables[level][lamp]
      .filter(([x]) => !candidateTables[level][lamp].some(([candidateX]) => candidateX === x)).map(([x]) => ({ level, lamp, x })))), nodeUnion, actualPositions };
}

function legacyDecideGuard({ current, candidate, pending, policy, round, compare }) {
  const compareFn = compare ?? compareTables;
  const summary = compareFn(current.tables, candidate.tables, policy?.starPositions ?? []);
  if (!policy) return { action: 'publish', pending: null };
  const threshold = policy.maxChange ?? policy.generalMax ?? 0;
  if (summary.maxAbs <= threshold) return { action: 'publish', pending: null };
  const day = new Date(`${round}T00:00:00Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== round) throw new Error('round는 UTC 날짜 YYYY-MM-DD여야 함');
  const similar = (a, b) => {
    const result = compareFn(a.tables, b.tables, policy.starPositions ?? []);
    const candidateDirection = compareFn(current.tables, b.tables, policy.starPositions ?? []);
    return candidateDirection.direction === summary.direction && Math.abs(candidateDirection.maxAbs - summary.maxAbs) <= (policy.directionTolerance ?? 0) && result.medianAbs <= (policy.similarityDistance ?? 0);
  };
  const yesterday = new Date(day.getTime() - 86400000).toISOString().slice(0, 10);
  if (pending?.lastRound === round) return { action: 'hold', pending };
  const matches = pending && pending.lastRound === yesterday && pending.policyVersion === policy.version &&
    similar(pending.first, candidate) && similar(pending.last, candidate);
  const next = matches ? { ...pending, last: candidate, count: pending.count + 1, lastRound: round }
    : { first: candidate, last: candidate, count: 1, policyVersion: policy.version, lastRound: round };
  return next.count >= policy.consecutiveRounds ? { action: 'publish', pending: null } : { action: 'hold', pending: next };
}

export function compareTables(currentTables, candidateTables, positions) {
  validateTables(currentTables); validateTables(candidateTables);
  const tables = {};
  const summarize = (level, lamp, xs) => {
    const points = [...new Set(xs)].sort((a, b) => a - b);
    const diffs = points.map((x) => applyTable(x, candidateTables[level][lamp]) - applyTable(x, currentTables[level][lamp]));
    const abs = diffs.map(Math.abs).sort((a, b) => a - b);
    let maxIndex = 0;
    for (let i = 1; i < diffs.length; i++) if (Math.abs(diffs[i]) > Math.abs(diffs[maxIndex])) maxIndex = i;
    return { medianAbs: abs.length ? abs[Math.floor(abs.length / 2)] : 0,
      p90Abs: abs.length ? abs[Math.min(abs.length - 1, Math.ceil(abs.length * 0.9) - 1)] : 0,
      maxAbs: abs.at(-1) ?? 0, direction: diffs.length ? Math.sign(diffs[maxIndex]) : 0,
      maxPosition: diffs.length ? points[maxIndex] : null, overPointOne: diffs.filter((v) => Math.abs(v) >= 0.1).length };
  };
  for (const [level, lamps] of Object.entries(TABLE_KEYS)) for (const lamp of lamps) {
    const current = currentTables[level][lamp], candidate = candidateTables[level][lamp];
    const lostNodes = current.filter(([x]) => !candidate.some(([cx]) => cx === x)).map(([x]) => x);
    const addedNodes = candidate.filter(([x]) => !current.some(([cx]) => cx === x)).map(([x]) => x);
    tables[`${level}.${lamp}`] = { actual: summarize(level, lamp, positions?.[level]?.[lamp] ?? []),
      nodes: summarize(level, lamp, [...current.map(([x]) => x), ...candidate.map(([x]) => x)]),
      lostNodes, addedNodes, currentNodeCount: current.length, candidateNodeCount: candidate.length };
  }
  return { tables, worst: Math.max(0, ...Object.values(tables).flatMap((t) => [t.actual.maxAbs, t.nodes.maxAbs])) };
}

export function decideGuard({ current, candidate, pending, policy, round, positions, compare }) {
  if (!policy || typeof policy.version !== 'string' || !policy.version || !Number.isFinite(policy.maxChange) ||
      !Number.isFinite(policy.similarityDistance) || !Number.isFinite(policy.directionTolerance) ||
      !Number.isInteger(policy.consecutiveRounds) || policy.consecutiveRounds < 1) throw new Error('guard policy fields are invalid');
  const compareFn = compare ?? compareTables;
  const summary = compareFn(current.tables, candidate.tables, positions);
  if (summary.worst <= policy.maxChange) return { action: 'publish', pending: null };
  const day = new Date(`${round}T00:00:00Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== round) throw new Error('round must be UTC YYYY-MM-DD');
  if (pending?.lastRound === round) return { action: 'hold', pending };
  const sameMove = (a, b) => {
    if (compareFn(a.tables, b.tables, positions).worst > policy.similarityDistance) return false;
    const left = compareFn(current.tables, a.tables, positions).tables;
    const right = compareFn(current.tables, b.tables, positions).tables;
    return Object.keys(TABLE_KEYS).every((level) => TABLE_KEYS[level].every((lamp) => {
      const x = left[`${level}.${lamp}`].actual, y = right[`${level}.${lamp}`].actual;
      return (x.maxAbs <= policy.directionTolerance && y.maxAbs <= policy.directionTolerance) || x.direction === y.direction;
    }));
  };
  const yesterday = new Date(day.getTime() - 86400000).toISOString().slice(0, 10);
  const matches = pending && pending.lastRound === yesterday && pending.policyVersion === policy.version &&
    sameMove(pending.first, candidate) && sameMove(pending.last, candidate);
  const next = matches ? { ...pending, last: candidate, count: pending.count + 1, lastRound: round }
    : { first: candidate, last: candidate, count: 1, policyVersion: policy.version, lastRound: round };
  return next.count >= policy.consecutiveRounds ? { action: 'publish', pending: null } : { action: 'hold', pending: next };
}

export function buildTables({ stars, plays, measure = balanceLine }) {
  const tables = { '11': {}, '12': {} };
  const bins = { '11': {}, '12': {} };
  for (const level of [11, 12]) for (const lamp of Object.keys(LAMP_THRESHOLDS)) {
    if (level === 12 && lamp === 'hc') { tables[level][lamp] = null; bins[level][lamp] = {}; continue; }
    const pairs = [];
    for (const [key, star] of stars) {
      const field = { ec: 'estEc', hc: 'estHc', ex: 'estExh', fc: 'estFc' }[lamp];
      if (star.gameLevel !== level || !Number.isFinite(star[field])) continue;
      const line = measure(plays.get(key) || [], lamp);
      if (line) pairs.push([star[field], line.c, line.st]);
    }
    const grouped = new Map();
    for (const pair of pairs) {
      const bin = Math.floor(pair[0]);
      if (!grouped.has(bin)) grouped.set(bin, []);
      grouped.get(bin).push(pair);
    }
    const kept = pairs.filter((pair) => {
      const group = grouped.get(Math.floor(pair[0]));
      return group.filter((item) => item[2] === 'hard').length * 2 <= group.length;
    });
    bins[level][lamp] = Object.fromEntries([...grouped].map(([bin, group]) => [bin, group.length]));
    tables[level][lamp] = tableOf(kept.map(([x, y]) => [x, y]));
  }
  return { tables, bins };
}

function positionsOf(stars) {
  const positions = { '11': { ec: [], hc: [], ex: [], fc: [] }, '12': { ec: [], ex: [], fc: [] } };
  const fields = { ec: 'estEc', hc: 'estHc', ex: 'estExh', fc: 'estFc' };
  for (const star of stars.values()) for (const [lamp, field] of Object.entries(fields)) {
    if (positions[star.gameLevel]?.[lamp] && Number.isFinite(star[field])) positions[star.gameLevel][lamp].push(star[field]);
  }
  for (const lamps of Object.values(positions)) for (const values of Object.values(lamps)) values.sort((a, b) => a - b);
  return positions;
}

function candidateOf(tables, hashes, counts, bins, guard, now) {
  const generatedAt = now().toISOString();
  const meta = { formulaVersion: 'sp-clear-map-v1', inputHashes: hashes, counts, bins, guard };
  return { generation: sha256(JSON.stringify(tables)), generatedAt, tables, meta };
}

function validateGeneration(value, label) {
  assertObject(value, label);
  if (Object.keys(value).sort().join(',') !== 'generatedAt,generation,meta,tables') throw new Error(`${label}: 세대 필드 구조 오류`);
  if (typeof value.generation !== 'string' || !/^[a-f0-9]{64}$/.test(value.generation) ||
      typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt))) throw new Error(`${label}: 세대 식별 정보 오류`);
  if (Object.keys(value.tables ?? {}).sort().join(',') !== '11,12' ||
      Object.keys(value.tables['11'] ?? {}).sort().join(',') !== 'ec,ex,fc,hc' ||
      Object.keys(value.tables['12'] ?? {}).sort().join(',') !== 'ec,ex,fc') throw new Error(`${label}: 표 필드 구조 오류`);
  validateTables(value.tables);
  if (sha256(JSON.stringify(value.tables)) !== value.generation) throw new Error(`${label}: generation 해시 불일치`);
  assertObject(value.meta, `${label}.meta`);
  if (Object.keys(value.meta).sort().join(',') !== 'bins,counts,formulaVersion,guard,inputHashes') throw new Error(`${label}: meta 필드 구조 오류`);
  if (value.meta.formulaVersion !== 'sp-clear-map-v1' || !value.meta.inputHashes || typeof value.meta.inputHashes !== 'object' ||
      !value.meta.counts || typeof value.meta.counts !== 'object' || !value.meta.bins || typeof value.meta.bins !== 'object' ||
      !Object.hasOwn(value.meta, 'guard')) throw new Error(`${label}: meta 구조 오류`);
  return value;
}

function assertAsset(value) {
  assertObject(value, 'asset');
  if (Object.keys(value).sort().join(',') !== 'current,pending,previous,version') throw new Error('정본 필드 구조 오류');
  if (value.version !== 1 || !Object.hasOwn(value, 'previous') || !Object.hasOwn(value, 'pending')) throw new Error('정본 자산 구조 오류');
  validateGeneration(value.current, 'current');
  if (value.previous !== null) {
    validateGeneration(value.previous, 'previous');
    if (Object.hasOwn(value.previous, 'previous')) throw new Error('previous 중첩 오류');
  }
  if (value.pending !== null) {
    const pending = assertObject(value.pending, 'pending');
    if (Object.keys(pending).sort().join(',') !== 'count,first,last,lastRound,policyVersion') throw new Error('pending 필드 구조 오류');
    validateGeneration(pending.first, 'pending.first'); validateGeneration(pending.last, 'pending.last');
    if (!Number.isInteger(pending.count) || pending.count < 1 || typeof pending.policyVersion !== 'string' ||
        typeof pending.lastRound !== 'string') throw new Error('pending 구조 오류');
  }
  return value;
}

function summaryLine(value) {
  const text = JSON.stringify(value);
  return `SP_CLEAR_MAP_CANDIDATE_JSON ${text}`;
}

async function conditionalWriteAndVerify(client, body, etag) {
  let putError;
  try { await client.put(ASSET_KEY, body, etag); }
  catch (error) {
    putError = error;
    if (/\b412\b/.test(String(error?.message || error))) throw error;
  }
  const verified = await client.read(ASSET_KEY);
  if (verified?.body === body) return;
  if (putError) throw new Error(`조건부 PUT 응답 유실 후 정본 불일치: ${putError.message}`);
  throw new Error('저장 사후 본문 확인 불일치');
}

export async function recover({ client, generation = 'current', log = console } = {}) {
  if (!client || !['current', 'previous'].includes(generation)) throw new Error('복구 입력 오류');
  const stored = await client.read(ASSET_KEY);
  if (!stored) throw new Error('정본 자산 없음');
  const asset = assertAsset(parseJson(stored.body, ASSET_KEY));
  const promoted = generation === 'current' ? asset.current : asset.previous;
  if (!promoted) throw new Error('승격할 previous 세대 없음');
  const next = { version: 1, current: promoted, previous: generation === 'previous' ? asset.current : asset.previous, pending: null };
  await conditionalWriteAndVerify(client, JSON.stringify(next), stored.etag);
  log.log(`sp-clear-map 복구 완료: ${generation}`);
  return next;
}

export async function run({ mode = 'auto', env = process.env, client, loadInputsImpl = loadInputs, now = () => new Date(), log = console, policy = GUARD_POLICY } = {}) {
  if (!['auto', 'dry-run', 'initial'].includes(mode)) throw new Error(`실행 mode 오류: ${mode}`);
  const dryRun = mode === 'dry-run';
  const autoPublish = !dryRun && (mode === 'initial' || env.SP_CLEAR_MAP_AUTO_PUBLISH === 'true');
  const r2 = client ?? conditionalR2Client({ account: env.CLOUDFLARE_ACCOUNT_ID, token: env.CLOUDFLARE_API_TOKEN, retry: true });
  const summaryPath = env.GITHUB_STEP_SUMMARY;
  const addSummary = async (line) => {
    if (summaryPath) await (await import('node:fs/promises')).appendFile(summaryPath, `${line}\n`, 'utf8');
  };
  const stored = await r2.read(ASSET_KEY);
  if (!stored && !dryRun && autoPublish && mode !== 'initial') throw new Error('자동 게시 중 정본 자산 404');
  if (!stored && !dryRun && mode === 'initial') {
    // 최초 생성을 위해 404 상태를 보존하고 If-None-Match 조건으로 게시한다.
  }
  if (stored && mode === 'initial' && !dryRun) throw new Error('최초 게시 대상 정본이 이미 존재함');
  const inputs = await loadInputsImpl();
  const collected = collectObservations(inputs);
  const built = buildTables({ stars: collected.stars, plays: collected.plays });
  validateTables(built.tables);
  const tables = { '11': { ec: built.tables['11'].ec, hc: built.tables['11'].hc, ex: built.tables['11'].ex, fc: built.tables['11'].fc },
    '12': { ec: built.tables['12'].ec, ex: built.tables['12'].ex, fc: built.tables['12'].fc } };
  validateTables(tables);
  const positions = positionsOf(collected.stars);
  const round = now().toISOString().slice(0, 10);
  const current = stored ? assertAsset(parseJson(stored.body, ASSET_KEY)).current : null;
  const compare = current ? compareTables(current.tables, tables, positions) : null;
  const guard = { action: current ? 'observe' : 'initial', comparison: compare };
  const candidate = candidateOf(tables, { ...inputs.hashes, ...collected.hashes }, collected.counts, built.bins, guard, now);
  const fullCandidate = candidate;
  let decision = { action: 'observe', pending: stored ? assertAsset(parseJson(stored.body, ASSET_KEY)).pending : null };
  if (!dryRun && autoPublish && current) {
    if (!policy) throw new Error('자동 게시에 GUARD_POLICY가 필요함');
    decision = decideGuard({ current, candidate, pending: assertAsset(parseJson(stored.body, ASSET_KEY)).pending,
      policy, round, positions });
    candidate.meta.guard = { ...guard, action: decision.action };
    candidate.generation = sha256(JSON.stringify(candidate.tables));
  }
  log.log(summaryLine(fullCandidate));
  if (compare) {
    log.log(`sp-clear-map 변경 요약 ${JSON.stringify(compare)}`);
    await addSummary(`### SP clear map 변경 (${round})\n\n최대 변동: ${compare.worst}\n\n절점 변화: ${Object.entries(compare.tables).map(([key, item]) => `${key} +${item.addedNodes.length}/-${item.lostNodes.length}`).join(', ')}`);
  }
  if (dryRun || !autoPublish || decision.action === 'hold') {
    if (!dryRun && !autoPublish && !stored) return { action: 'observe', candidate };
    if (!stored) return { action: dryRun ? 'dry-run' : 'observe', candidate };
    if (!dryRun && autoPublish && decision.action === 'hold') {
      const asset = assertAsset(parseJson(stored.body, ASSET_KEY));
      const next = { version: 1, current: asset.current, previous: asset.previous, pending: decision.pending };
      await conditionalWriteAndVerify(r2, JSON.stringify(next), stored.etag);
    }
    return { action: dryRun ? 'dry-run' : decision.action === 'hold' ? 'hold' : 'observe', candidate };
  }
  const asset = current ? assertAsset(parseJson(stored.body, ASSET_KEY)) : null;
  const next = { version: 1, current: candidate, previous: asset?.current ?? null, pending: null };
  await conditionalWriteAndVerify(r2, JSON.stringify(next), stored ? stored.etag : null);
  await addSummary(`SP clear map 게시 완료: ${candidate.generation}`);
  return { action: 'publish', candidate };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const mode = process.argv.includes('--dry-run') ? 'dry-run' : process.argv.includes('--initial') ? 'initial' : 'auto';
  try { await run({ mode }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

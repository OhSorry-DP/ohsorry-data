import { createHash } from 'node:crypto';
import { list, getText, pool } from './r2-client.mjs';

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

export function collectObservations({ dumps, songs, cpiRows, starRows, norm, variants }) {
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
      const chart = { ...row, title: row.title ?? song.title, textage_song_id: row.textage_song_id ?? song.textage_song_id, diff };
      if (!chart.title) { counts.unresolved++; continue; }
      const source = chart.played_version === 0 ? 'INF' : 'AC';
      const resolvedId = variants.resolveChartId(chart, null, norm, { source });
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

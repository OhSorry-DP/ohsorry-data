import { pathToFileURL } from 'node:url';
import { getText, list, listEntries, md5, putText, del, pool } from './r2-client.mjs';
import { isEdgeSkeletonUser } from './dump-fast-publish.mjs';

const DP_KEYS = ['DB', 'DN', 'DH', 'DA', 'DX'];
const SP_KEYS = ['SB', 'SN', 'SH', 'SA', 'SX'];
const USER_KEY_RE = /^user\/[A-Za-z0-9]+\.json$/;

const TWO_HOURS = 2 * 60 * 60 * 1000;
const USER_LIMIT = 20 * 60 * 1000;

function strictSince(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : null;
}

function userState(value, now) {
  const rootObject = value !== null && typeof value === 'object' && !Array.isArray(value);
  if (rootObject && value.user !== null && typeof value.user === 'object' && !Array.isArray(value.user)) return 'ok';
  const since = rootObject && isEdgeSkeletonUser(value) ? strictSince(value._v) : null;
  if (since !== null && now - since >= 0 && now - since < TWO_HOURS) return 'pending';
  return 'bad';
}

function recoveryId(key) { return key.slice(5, -5); }

async function getUserState(key, read, now) {
  const raw = await read(key);
  if (raw === null) throw new Error(`R2 404: ${key}`);
  let value;
  try { value = JSON.parse(raw); }
  catch (error) { throw new Error(`JSON parse ${key}: ${error.message}`); }
  return { state: userState(value, now), value };
}

async function readUserSnapshot({ list: listFn, getText: read, now, poolFn = pool }) {
  const at = now();
  const keys = (await listFn('user/')).filter((key) => USER_KEY_RE.test(key));
  const entries = new Array(keys.length);
  await poolFn(keys, 8, async (key, index) => {
    const { state, value } = await getUserState(key, read, at);
    entries[index] = { key, id: recoveryId(key), state, since: strictSince(value?._v) };
  });
  return { at, entries };
}

function recoveryHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function githubJson(url, { fetchFn, headers, deadline, now }) {
  const remaining = deadline - now();
  if (remaining <= 0) throw new Error('대상 20분 제한 초과');
  const timeout = Math.min(30000, remaining);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetchFn(url, { headers, signal: controller.signal });
    if (!response || !response.ok) throw new Error(`GitHub HTTP ${response?.status ?? 'unknown'}`);
    return response.status === 204 ? null : await response.json();
  } finally { clearTimeout(timer); }
}

async function listWorkflowRuns(base, query, options) {
  const all = [];
  for (let page = 1; ; page++) {
    const params = new URLSearchParams(query);
    params.set('page', String(page));
    const data = await githubJson(`${base}?${params}`, options);
    if (!data || !Array.isArray(data.workflow_runs)) throw new Error('GitHub workflow_runs 형식 오류');
    if (data.workflow_runs.some((run) => !run || typeof run !== 'object' || Array.isArray(run))) throw new Error('GitHub workflow_runs 항목 형식 오류');
    all.push(...data.workflow_runs);
    if (data.workflow_runs.length < 100) return all;
  }
}

export async function runUserRecovery({ list: listFn = list, getText: read = getText, fetch: fetchFn = globalThis.fetch, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), env = process.env, log = console, pool: poolFn = pool } = {}) {
  const counts = { checked: 0, pending: 0, anomalies: 0, dispatched: 0, recovered: 0, remaining: 0 };
  const failures = [];
  let stopped = false;
  let posts = 0;
  let unprocessed = 0;
  const fail = (id, stage, error) => failures.push({ id, stage, error: String(error?.message ?? error) });
  let initial;
  try {
    initial = await readUserSnapshot({ list: listFn, getText: read, now, poolFn });
    counts.checked += initial.entries.length;
    counts.pending += initial.entries.filter((entry) => entry.state === 'pending').length;
    counts.anomalies += initial.entries.filter((entry) => entry.state === 'bad').length;
  } catch (error) {
    fail('-', 'initial-check', error);
    stopped = true;
    initial = { entries: [] };
  }
  const candidates = initial.entries.filter((entry) => entry.state === 'bad')
    .sort((a, b) => (b.since === null) - (a.since === null) ||(a.since ?? 0) - (b.since ?? 0) || a.id.localeCompare(b.id));
  const ownerRepo = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  if (!stopped && candidates.length && (!ownerRepo || !token)) { fail('-', 'configuration', 'GITHUB_REPOSITORY 또는 GITHUB_TOKEN 누락'); stopped = true; }
  const headers = recoveryHeaders(token ?? '');
  const [owner, repo] = (ownerRepo ?? '').split('/');
  const base = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/dump-user.yml/runs`;

  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
    const entry = candidates[candidateIndex];
    if (stopped) break;
    if (posts >= 3) { unprocessed = candidates.length - candidateIndex; break; }
    let state;
    try { state = (await getUserState(entry.key, read, now())).state; }
    catch (error) { fail(entry.id, 'pre-dispatch-read', error); stopped = true; break; }
    if (state !== 'bad') continue;
    const started = now();
    const deadline = started + USER_LIMIT;
    const isoT = new Date(Math.floor(started / 1000) * 1000).toISOString();
    const requestOptions = { fetchFn, headers, deadline, now };
    const dispatchUrl = `https://api.github.com/repos/${owner}/${repo}/dispatches`;
    try {
      if (deadline - now() <= 0) throw new Error('대상 20분 제한 초과');
      const remaining = deadline - now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(30000, remaining));
      let response;
      posts++;
      try {
        response = await fetchFn(dispatchUrl, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ event_type: 'dump-user', client_payload: { iidx_id: entry.id } }) });
      } finally { clearTimeout(timer); }
      if (response?.status !== 204) throw new Error(`dispatch HTTP ${response?.status ?? 'unknown'}`);
      counts.dispatched++;
    } catch (error) { fail(entry.id, 'dispatch', error); stopped = true; break; }

    let quiet = false;
    try {
      const createdQuery = { event: 'repository_dispatch', created: `>=${isoT}`, per_page: '100' };
      while (!quiet) {
        if (deadline - now() <= 0) throw new Error('대상 20분 제한 초과');
        const created = await listWorkflowRuns(base, createdQuery, requestOptions);
        if (created.length) {
          const queuedQuery = { event: 'repository_dispatch', status: 'queued', per_page: '100' };
          const activeQuery = { event: 'repository_dispatch', status: 'in_progress', per_page: '100' };
          const queued = await listWorkflowRuns(base, queuedQuery, requestOptions);
          const active = await listWorkflowRuns(base, activeQuery, requestOptions);
          if (!queued.length && !active.length) quiet = true;
        }
        if (!quiet) {
          if (deadline - now() <= 0) throw new Error('대상 20분 제한 초과');
          const delay = Math.min(15000, deadline - now());
          await sleep(delay);
        }
      }
    } catch (error) { fail(entry.id, 'workflow-wait', error); stopped = true; break; }

    try {
      const check = await getUserState(entry.key, read, now());
      if (check.state === 'ok') counts.recovered++;
      else fail(entry.id, 'recovery-verification', `user 상태 ${check.state}`);
    } catch (error) { fail(entry.id, 'recovery-read', error); stopped = true; break; }
  }

  try {
    const final = await readUserSnapshot({ list: listFn, getText: read, now, poolFn });
    counts.checked += final.entries.length;
    counts.pending += final.entries.filter((entry) => entry.state === 'pending').length;
    counts.remaining = final.entries.filter((entry) => entry.state === 'bad').length;
  } catch (error) { fail('-', 'final-check', error); stopped = true; }
  if (unprocessed) fail('-', 'dispatch-limit', `${unprocessed}개 후보 미처리`);
  const result = { ...counts, posts, unprocessed, failures, stopped, failed: Boolean(failures.length || counts.remaining) };
  const byId = failures.map(({ id, stage }) => `${id}:${stage}`).join(', ') || '없음';
  const summary = `유저 점검 ${counts.checked}, 유예 ${counts.pending}, 이상 ${counts.anomalies}, dispatch ${counts.dispatched}, 복구 ${counts.recovered}, 잔존 ${counts.remaining}, 실패 단계 ${byId}`;
  log.log(summary);
  if (result.failed) log.error(`::error::${summary}`);
  return result;
}

// 차트 분포 파일의 R2 키를 만든다.
export function distKey(style, songId, diff) { return `dist/${style}/${songId}-${diff}.json`; }

// 원천 행에서 분포 계산에 사용할 노트 수를 찾는다.
export function noteCountFor(row, style, songsById, textageMeta) {
  if (row.played_version === 0 && Number.isInteger(row.note_count) && row.note_count > 0) return row.note_count;
  const song = songsById.get(row.song_id);
  const textageId = song?.textage_song_id;
  const keys = style === 'dp' ? DP_KEYS : SP_KEYS;
  const noteKey = keys[row.diff];
  const notes = textageMeta?.songs?.[textageId]?.notes?.[noteKey];
  return Number.isInteger(notes) && notes > 0 ? notes : null;
}

// 유저 덤프를 차트별 익명 실력대 표본으로 집계한다.
export function buildDist({ users, rStarById, songsById, textageMeta }) {
  const charts = new Map();
  for (const userDump of users) {
    const id = userDump?.user?.iidx_id;
    if (!id) continue;
    const best = new Map();
    for (const style of ['dp', 'sp']) {
      const rows = userDump[style];
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (!Number.isInteger(row?.song_id) || !Number.isInteger(row?.diff)
          || !Number.isInteger(row?.ex_score) || row.ex_score <= 0) continue;
        const notes = noteCountFor(row, style, songsById, textageMeta);
        if (notes === null) continue;
        const rate = row.ex_score / (notes * 2);
        if (rate > 1) continue;
        const key = distKey(style, row.song_id, row.diff);
        if (!best.has(key) || rate > best.get(key)) best.set(key, rate);
      }
    }
    for (const [key, rawRate] of best) {
      if (!charts.has(key)) charts.set(key, []);
      const style = key.startsWith('dist/dp/') ? 'dp' : 'sp';
      const r = style === 'sp' ? null : rStarById.get(id) ?? null;
      charts.get(key).push([r === null ? null : Math.round(r * 100) / 100, Math.round(rawRate * 10000) / 10000]);
    }
  }
  return charts;
}

// 표본을 규정된 순서로 정렬해 JSON 문자열로 만든다.
export function serializeDist(samples) {
  const sorted = [...samples].sort((a, b) => b[1] - a[1]
    || (a[0] === null ? 1 : b[0] === null ? -1 : a[0] - b[0]));
  return JSON.stringify({ v: 1, samples: sorted });
}

// R2 원천을 검증하고 분포 파일을 원격 저장소와 동기화한다.
export async function run({ dryRun = false, list: listFn = list, getText: read = getText, listEntries: entriesFn = listEntries, putText: put = putText, del: remove = del, pool: runPool = pool, md5: hash = md5, log = console }) {
  const [usersListRaw, songsRaw, textageRaw] = await Promise.all([
    read('users-list-slim.json'), read('songs.json'), read('data/textage-meta.json'),
  ]);
  if (usersListRaw === null || songsRaw === null || textageRaw === null) throw new Error('분포 원천 파일이 없습니다');
  let slimUsers, songs, textageMeta;
  try {
    slimUsers = JSON.parse(usersListRaw);
    songs = JSON.parse(songsRaw);
    textageMeta = JSON.parse(textageRaw);
    if (!Array.isArray(slimUsers) || !Array.isArray(songs)) throw new Error('원천 형식 오류');
  } catch (error) { throw new Error(`분포 원천 JSON 파싱 실패: ${error.message}`); }

  const rStarById = new Map(slimUsers.map((user) => [user.iidx_id, user.r_star]));
  const songsById = new Map(songs.map((song) => [song.song_id, song]));
  const keys = (await listFn('user/')).filter((key) => USER_KEY_RE.test(key));
  const users = [];
  let missingUsers = 0, userErrors = 0;
  await runPool(keys, 8, async (key) => {
    try {
      const raw = await read(key);
      if (raw === null) { missingUsers++; return; }
      users.push(JSON.parse(raw));
    } catch (error) {
      userErrors++;
      log.error(`유저 덤프 읽기 실패 ${key}: ${error.message}`);
    }
  });
  if (userErrors) throw new Error(`유저 덤프 ${userErrors}건 읽기 또는 파싱 실패`);
  // 유저 0명이면 원격 dist/ 전부가 삭제 대상이 되므로 쓰기 전에 멈춘다.
  if (!users.length) throw new Error('읽은 유저 덤프가 없습니다');

  const dist = buildDist({ users, rStarById, songsById, textageMeta });
  const bodies = new Map([...dist].map(([key, samples]) => [key, serializeDist(samples)]));
  const remoteEntries = await entriesFn('dist/');
  const remote = new Map(remoteEntries.map(({ key, etag }) => [key, etag]));
  let puts = 0, skips = 0, deletes = 0, failures = 0, bytes = 0;
  for (const [key, body] of bodies) {
    bytes += Buffer.byteLength(body, 'utf8');
    if (remote.get(key) === hash(body)) { skips++; continue; }
    if (dryRun) { puts++; continue; }
    try {
      const result = await put(key, body);
      if (!result?.ok) { failures++; continue; }
      puts++;
    } catch (error) { failures++; log.error(`분포 PUT 실패 ${key}: ${error.message}`); }
  }
  for (const key of remote.keys()) {
    if (bodies.has(key)) continue;
    if (dryRun) { deletes++; continue; }
    try { if (await remove(key)) deletes++; else failures++; }
    catch (error) { failures++; log.error(`분포 삭제 실패 ${key}: ${error.message}`); }
  }
  const dp = [...bodies.keys()].filter((key) => key.startsWith('dist/dp/')).length;
  const sp = bodies.size - dp;
  log.log(`차트 ${bodies.size} (dp ${dp} · sp ${sp}), 유저 ${users.length} (404 ${missingUsers}), PUT ${puts}, skip ${skips}, 삭제 ${deletes}, 실패 ${failures}, 총 바이트 ${bytes}`);
  return { charts: bodies.size, puts, skips, deletes, failures, bytes };
}

// 명령행 옵션을 읽어 R2 동기화를 실행한다.
async function main() {
  if (process.argv.includes('--check-user-recovery')) {
    const result = await runUserRecovery();
    if (result.failed) process.exitCode = 1;
    return;
  }
  const result = await run({ dryRun: process.argv.includes('--dry-run') });
  if (result.failures > 0) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { await main(); }
  catch (error) {
    console.error(process.argv.includes('--check-user-recovery') ? `::error::${error.message}` : error.message);
    process.exitCode = 1;
  }
}

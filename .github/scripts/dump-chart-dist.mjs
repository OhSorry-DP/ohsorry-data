import { pathToFileURL } from 'node:url';
import { getText, list, listEntries, md5, putText, del, pool } from './r2-client.mjs';

const DP_KEYS = ['DB', 'DN', 'DH', 'DA', 'DX'];
const SP_KEYS = ['SB', 'SN', 'SH', 'SA', 'SX'];
const USER_KEY_RE = /^user\/[A-Za-z0-9]+\.json$/;

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
  const result = await run({ dryRun: process.argv.includes('--dry-run') });
  if (result.failures > 0) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { await main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

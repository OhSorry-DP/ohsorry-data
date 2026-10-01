// 유저 곡 조각 정본 — 원본 행과 순서를 바꾸지 않는다.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { listEntries, getText, putText, del, md5 } from './r2-client.mjs';

export const USLICE_SHARDS = 16;
const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9]+$/.test(id);
const digest = (etag) => String(etag || '').replace(/^W\//i, '').replace(/"/g, '').toLowerCase();

export function buildUserSlice(id, data, hist = []) {
  if (!validId(id) || !data?.user || !Array.isArray(data.dp) || !Array.isArray(data.sp)) throw new Error('slice 원본 형식 오류');
  const summary = { v: 1, id, date: data.user.date, u: { dj_name: data.user.dj_name },
    dpSeriesMax: null, shards: { r: { dp: [], sp: [] }, h: { dp: [], sp: [] } } };
  const objects = {};
  for (const mode of ['dp', 'sp']) {
    const buckets = new Map();
    for (const row of data[mode]) {
      const songId = row.song_id;
      if (!Number.isSafeInteger(songId) || songId < 0) throw new Error('slice song_id 정수 오류');
      const n = songId % USLICE_SHARDS;
      if (!buckets.has(n)) buckets.set(n, {});
      const songs = buckets.get(n);
      (songs[songId] ||= []).push(row);
      if (mode === 'dp' && typeof row.played_version === 'number' && Number.isFinite(row.played_version)) {
        summary.dpSeriesMax = summary.dpSeriesMax === null ? row.played_version : Math.max(summary.dpSeriesMax, row.played_version);
      }
    }
    for (const n of [...buckets.keys()].sort((a, b) => a - b)) {
      summary.shards.r[mode].push(n);
      objects[`uslice/${id}-r-${mode}-${String(n).padStart(2, '0')}.json`] = JSON.stringify({ v: 1, songs: buckets.get(n) });
    }
  }
  if (!Array.isArray(hist)) throw new Error('slice hist 배열 형식 오류');
  // HIST_COLS 정본: song_id=0, play_style=7. 과거 8열 행도 그대로 보존한다.
  const warnings = [];
  const missingMode = hist.some((row) => Array.isArray(row) && (row[7] === undefined || row[7] === null));
  const allMissingMode = hist.length > 0 && hist.every((row) => Array.isArray(row) && (row[7] === undefined || row[7] === null));
  if (missingMode && !allMissingMode) throw new Error('slice hist 모드 일부 누락 — 혼합 분류 불가');
  if (allMissingMode) warnings.push('hist 모드 정보 없음 — DP만 생성');
  for (const mode of ['dp', 'sp']) {
    const buckets = new Map();
    for (const row of hist) {
      if (!Array.isArray(row) || !Number.isSafeInteger(row[0]) || row[0] < 0) throw new Error('slice hist 행 형식 오류');
      const style = allMissingMode ? 1 : row[7];
      if (style !== 0 && style !== 1) throw new Error('slice hist play_style 오류');
      if (style !== (mode === 'dp' ? 1 : 0)) continue;
      const n = row[0] % USLICE_SHARDS;
      if (!buckets.has(n)) buckets.set(n, {});
      const songs = buckets.get(n);
      (songs[row[0]] ||= []).push(row);
    }
    for (const n of [...buckets.keys()].sort((a, b) => a - b)) {
      summary.shards.h[mode].push(n);
      objects[`uslice/${id}-h-${mode}-${String(n).padStart(2, '0')}.json`] = JSON.stringify({ v: 1, songs: buckets.get(n) });
    }
  }
  return { summary, objects, warnings };
}

// 계산 실패도 파일로 남겨 업로드 단계에서 rc=1로 드러낸다. user/hist 파일은 건드리지 않는다.
export function writeUserSliceFile(id, data, file, options = {}) {
  try {
    // hist 읽기도 실패 격리 범위 안이다. 파일이 없거나 깨지면 이력 없는 요약을 내보내지 않는다.
    const hist = options.histFile ? JSON.parse(fs.readFileSync(options.histFile, 'utf8')) : (options.hist || []);
    const bundle = (options.build || buildUserSlice)(id, data, hist);
    for (const warning of bundle.warnings || []) (options.log || console).warn(`::warning::slice(${id}): ${warning}`);
    fs.writeFileSync(file, JSON.stringify({ ok: true, ...bundle }));
    return { ok: true, rc: 0 };
  } catch (e) {
    (options.log || console).warn(`::warning::slice 계산 실패(${id}): ${e.message}`);
    try { fs.writeFileSync(file, JSON.stringify({ ok: false, error: e.message })); } catch (writeError) {
      (options.log || console).warn(`::warning::slice 실패 기록 불가(${id}): ${writeError.message}`);
    }
    return { ok: false, rc: 1 };
  }
}

// 목록은 유저 shard prefix 한 번만 읽는다. 요약은 별도 GET으로 본문 MD5를 비교한다.
export async function publishUserSlice(id, bundle, deps = {}) {
  // 1,200건/300초에서 250ms 간격을 산출한다. 다른 Actions와의 공용 한도는 429 대기로 양보한다.
  const wait = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const paced = (fn) => async (...args) => { await wait(300_000 / 1200); return fn(...args); };
  const io = { listEntries: paced(listEntries), getText: paced(getText), putText: paced(putText), del: paced(del), ...deps };
  const result = { ok: false, rc: 1, puts: 0, deletes: 0, skips: 0 };
  try {
    if (!validId(id) || !bundle?.ok || bundle.summary?.id !== id) throw new Error(bundle?.error || 'slice 계산 결과 없음');
    const shardRe = new RegExp(`^uslice/${id}-[rh]-(dp|sp)-(0[0-9]|1[0-5])\\.json$`);
    for (const key of Object.keys(bundle.objects)) if (!shardRe.test(key)) throw new Error('slice shard 키 오류');
    const entries = await io.listEntries(`uslice/${id}-`);
    const summaryKey = `uslice/${id}.json`;
    const previousSummary = await io.getText(summaryKey);
    const remote = new Map(entries.filter(({ key }) => shardRe.test(key)).map(({ key, etag }) => [key, digest(etag)]));
    for (const [key, body] of Object.entries(bundle.objects)) {
      if (remote.get(key) === md5(body)) { result.skips++; continue; }
      const r = await io.putText(key, body);
      if (!r.ok) throw new Error(`slice PUT ${key}: ${r.msg || '실패'}`);
      result.puts++;
    }
    const summaryBody = JSON.stringify(bundle.summary);
    if (previousSummary !== null && md5(previousSummary) === md5(summaryBody)) result.skips++;
    else {
      const r = await io.putText(summaryKey, summaryBody);
      if (!r.ok) throw new Error(`slice 요약 PUT: ${r.msg || '실패'}`);
      result.puts++;
    }
    // 빈 shard 삭제는 요약 PUT 뒤에 — 먼저 지우면 그 사이 옛 요약이 없는 shard 를 가리켜 소비처가 장애로 읽는다.
    for (const key of remote.keys()) {
      if (Object.hasOwn(bundle.objects, key)) continue;
      if (!await io.del(key)) throw new Error(`slice DELETE ${key} 실패`);
      result.deletes++;
    }
    result.ok = true;
    result.rc = 0;
  } catch (e) {
    result.error = e.message;
    (deps.log || console).warn(`::warning::slice 실패(${id}): ${e.message}`);
  }
  return result;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const id = process.argv[2];
  try {
    if (!validId(id)) throw new Error('iidx_id 형식 오류');
    const bundle = JSON.parse(fs.readFileSync(`user/${id}.uslice.json`, 'utf8'));
    const result = await publishUserSlice(id, bundle);
    console.log('slice 결과:', JSON.stringify(result));
    process.exitCode = result.rc;
  } catch (e) {
    console.warn(`::warning::slice 실행 실패: ${e.message}`);
    process.exitCode = 1;
  }
}

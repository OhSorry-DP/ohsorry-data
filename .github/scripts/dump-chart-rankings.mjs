import { pathToFileURL } from 'node:url';
import { getText, list, putIfChanged, del, pool } from './r2-client.mjs';

export function chartKey([song, diff]) { return `ranking/${song}-${diff}.json`; }
export function normalizeCharts(charts) {
  return [...new Map(charts.map(([s, d]) => [`${s}-${d}`, [Number(s), Number(d)]]).filter(([, p]) => Number.isInteger(p[0]) && Number.isInteger(p[1]))).values()]
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}
export function serializeRows(rows) {
  if (!Array.isArray(rows)) throw new Error('RPC 결과가 배열이 아님');
  // rank 오름차순, iidx_id 오름차순으로 고정해 결정적 직렬화를 유지한다.
  for (const r of rows) if (!r || !Number.isInteger(r.rank) || !Number.isInteger(r.ex_score) || typeof r.iidx_id !== 'string' || !r.iidx_id) throw new Error('랭킹 행 검증 실패');
  return JSON.stringify([...rows].sort((a, b) => a.rank - b.rank || a.iidx_id.localeCompare(b.iidx_id)));
}
function chartsFromMarker(raw) {
  const x = JSON.parse(raw);
  return Array.isArray(x.charts) ? x.charts : [];
}
function chartsFromWinners(raw) { const x = JSON.parse(raw); return Object.values(x.w || {}).flat(); }
function chartsFromRanking(keys) { return keys.map((k) => /^ranking\/(\d+)-(\d+)\.json$/.exec(k)).filter(Boolean).map((m) => [+m[1], +m[2]]); }

export async function run({ all = false, rpc, getText: read = getText, list: listFn = list, putIfChanged: put = putIfChanged, del: remove = del, log = console }) {
  const markerKeys = await listFn('ranking-state/dirty/');
  const charts = [], deletable = [];
  for (const key of markerKeys) {
    const raw = await read(key);
    try {
      // 목록에만 남고 본문이 삭제된 마커는 삭제 목록에 넣지 않는다.
      if (raw) {
        charts.push(...chartsFromMarker(raw));
        deletable.push(key);
      }
    } catch (e) {
      log.warn(`마커 파싱 실패 ${key}: ${e.message}`);
    }
  }
  if (all) { const winners = await read('first-place-winners.json'); if (!winners) throw new Error('first-place-winners.json 없음'); charts.push(...chartsFromWinners(winners)); charts.push(...chartsFromRanking(await listFn('ranking/'))); }
  const targets = normalizeCharts(charts); let puts = 0, skips = 0, deletes = 0, failures = 0;
  await pool(targets, 8, async (chart) => { try {
    const rows = await rpc(chart[0], chart[1]);
    const body = serializeRows(rows), key = chartKey(chart);
    // 0행은 공개 파일을 삭제해 웹에서 404를 빈 랭킹으로 사용하게 한다.
    if (rows.length === 0) {
      if (!await remove(key)) throw new Error(`삭제 실패 ${key}`);
      deletes++;
    }
    else { const r = await put(key, body); if (!r.ok) throw new Error(r.msg || `PUT 실패 ${key}`); r.skipped ? skips++ : puts++; }
  } catch (e) { failures++; log.error(`차트 실패 ${chart.join('-')}: ${e.message}`); } });
  if (!failures) for (const key of deletable) if (!await remove(key)) throw new Error(`마커 삭제 실패 ${key}`);
  log.log(`차트 ${targets.length}, PUT ${puts}, skip ${skips}, 삭제 ${deletes}, 실패 ${failures}`);
  return { charts: targets, puts, skips, deletes, failures, deletedMarkers: failures ? [] : deletable };
}

async function main() {
  const sb = process.env.SUPABASE_URL, token = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sb || !token) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 없음');
  const rpc = async (song, diff) => { const r = await fetch(`${sb}/rest/v1/rpc/get_chart_ranking_v2`, { method: 'POST', headers: { apikey: token, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_song_id: song, p_diff: diff, p_played_version: null }) }); if (!r.ok) throw new Error(`RPC HTTP ${r.status}`); return r.json(); };
  const result = await run({ all: process.argv.includes('--all'), rpc });
  process.exitCode = exitCodeForResult(result);
}
export function exitCodeForResult(result) {
  return result.failures > 0 ? 1 : 0;
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    await main();
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}

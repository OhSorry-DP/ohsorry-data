import { pathToFileURL } from 'node:url';
import { getText, listEntries, md5, putText, del, pool, createRequestGate } from './r2-client.mjs';
import { loadHistoryInputs } from './ranking-history-input.mjs';
import { buildHistoryRankings } from './ranking-from-history.mjs';
import { historyInstant } from './score-history.mjs';
import { validateRows, toOutput } from './dump-first-place.mjs';

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function chartKey([song, diff]) { return `ranking/${song}-${diff}.json`; }
export function normalizeCharts(charts) {
  return [...new Map(charts.map(([s, d]) => [`${s}-${d}`, [Number(s), Number(d)]]).filter(([, p]) => Number.isInteger(p[0]) && Number.isInteger(p[1]))).values()]
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}
export function serializeRows(rows) {
  if (!Array.isArray(rows)) throw new Error('랭킹 결과가 배열이 아님');
  for (const r of rows) if (!r || !Number.isInteger(r.rank) || !Number.isInteger(r.ex_score) || typeof r.iidx_id !== 'string' || !r.iidx_id) throw new Error('랭킹 행 검증 실패');
  const timed = rows.map(row => ({ row, time: historyInstant(row.date) }));
  return JSON.stringify(timed.sort((a, b) => b.row.ex_score - a.row.ex_score
    || compare(a.time, b.time) || compare(a.row.iidx_id, b.row.iidx_id)).map(({ row }) => row));
}
function chartsFromWinners(raw) { const x = JSON.parse(raw); return Object.values(x.w || {}).flat(); }
function chartsFromRanking(keys) { return keys.map((k) => /^ranking\/(\d+)-(\d+)\.json$/.exec(k)).filter(Boolean).map((m) => [+m[1], +m[2]]); }

// all/--all are accepted by legacy callers; every execution collects all histories.
export async function run({ mode = process.env.RANKING_HISTORY_MODE,
  loadInputs = loadHistoryInputs, buildRankings = buildHistoryRankings,
  getText: read = getText, listEntries: listEntriesFn = listEntries,
  putText: put = putText, del: remove = del, pool: runPool = pool,
  requestGate = createRequestGate(), log = console, now = () => new Date().toISOString(),
  ...inputDeps
} = {}) {
  if (mode !== 'observe' && mode !== 'publish') throw new Error('RANKING_HISTORY_MODE는 observe 또는 publish여야 함');
  const options = { ...inputDeps.r2Options, requestGate, retry: true };
  if (inputDeps.fetchImpl) options.fetchImpl = inputDeps.fetchImpl;

  // Collection and all public output preflight must finish before any mutation.
  const inputs = await loadInputs({ ...inputDeps, getText: read, listEntries: listEntriesFn,
    pool: runPool, requestGate, log });
  const computed = await buildRankings({ users: inputs.users, histories: inputs.histories });
  const current = new Map();
  for (const { song_id, diff, rows } of computed.charts) {
    if (!Number.isInteger(song_id) || !Number.isInteger(diff)) throw new Error('채보 검증 실패');
    const key = chartKey([song_id, diff]);
    if (current.has(key)) throw new Error(`중복 채보 ${key}`);
    current.set(key, { rows, body: serializeRows(rows) });
  }
  validateRows(computed.winners);
  const output = toOutput(computed.winners, now());
  const remote = new Map((await listEntriesFn('ranking/', options)).map(({ key, etag }) => [key, etag]));
  const oldWinnersBody = await read('first-place-winners.json', options);
  const oldWinners = oldWinnersBody === null ? null : JSON.parse(oldWinnersBody);
  if (oldWinners && oldWinners.n === output.n && JSON.stringify(oldWinners.w) === JSON.stringify(output.w)) output._v = oldWinners._v;
  const winnerBody = JSON.stringify(output);
  const targets = normalizeCharts([
    ...computed.charts.map(({ song_id, diff }) => [song_id, diff]),
    ...chartsFromRanking([...remote.keys()]),
  ]);
  const diagnosticCharts = normalizeCharts([...targets, ...(oldWinnersBody === null ? [] : chartsFromWinners(oldWinnersBody))]);
  const plan = [];
  await runPool(targets, 8, async chart => {
    const key = chartKey(chart), value = current.get(key);
    if (!value || value.rows.length === 0) {
      plan.push({ key, action: remote.has(key) ? 'delete' : 'skip' });
      return;
    }
    let digest = remote.get(key);
    if (remote.has(key) && !/^[a-f0-9]{32}$/i.test(digest ?? '')) {
      const body = await read(key, options);
      if (typeof body !== 'string') throw new Error(`기존 본문 없음 ${key}`);
      digest = md5(body);
    }
    plan.push({ key, action: digest?.toLowerCase() === md5(value.body) ? 'skip' : 'put', body: value.body });
  });
  plan.sort((a, b) => compare(a.key, b.key));
  const firstPlace = { key: 'first-place-winners.json', action: oldWinnersBody !== null && md5(oldWinnersBody) === md5(winnerBody) ? 'skip' : 'put', body: winnerBody };
  const expected = { puts: 0, deletes: 0, skips: 0 };
  for (const item of [...plan, firstPlace]) expected[item.action === 'put' ? 'puts' : item.action === 'delete' ? 'deletes' : 'skips']++;
  const result = { mode, charts: targets, diagnosticCharts,
    counts: { users: inputs.users.length, histories: inputs.histories.size, charts: computed.charts.length, winners: computed.winners.length },
    fingerprint: inputs.fingerprint, diagnostics: inputs.diagnostics,
    plan, firstPlace, expected, puts: 0, deletes: 0, skips: 0, failures: 0, failedKeys: [], firstPlaceSkipped: false };

  // Publication consumes only the fully validated collection and output plan.
  const publish = async item => {
    try {
      if (item.action === 'skip') result.skips++;
      else if (item.action === 'delete') {
        if (!await remove(item.key, options)) throw new Error(`삭제 실패 ${item.key}`);
        result.deletes++;
      } else {
        const response = await put(item.key, item.body, null, options);
        if (!response?.ok) throw new Error(response?.msg || `PUT 실패 ${item.key}`);
        result.puts++;
      }
    } catch (error) {
      result.failures++;
      result.failedKeys.push(item.key);
      log.error(`게시 실패 ${item.key}: ${error.message}`);
    }
  };
  if (mode === 'publish') {
    await runPool(plan, 8, publish);
    if (result.failures) result.firstPlaceSkipped = true;
    else await publish(firstPlace);
  }
  log.log(`${mode}: 채보 ${targets.length}, 예상 PUT ${expected.puts}, DELETE ${expected.deletes}, skip ${expected.skips}, 실패 ${result.failures}`);
  return result;
}

async function main() {
  const sb = process.env.SUPABASE_URL, token = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sb || !token) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 없음');
  const result = await run({ mode: process.env.RANKING_HISTORY_MODE });
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

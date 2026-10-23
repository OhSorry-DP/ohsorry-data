import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { loadHistoryInputs, verifyFingerprint } from './ranking-history-input.mjs';
import { buildHistoryRankings } from './ranking-from-history.mjs';
import { historyInstant } from './score-history.mjs';
import { validateRows, toOutput, parseContentRangeTotal } from './dump-first-place.mjs';
import { getText, listEntries, pool, createRequestGate } from './r2-client.mjs';

const FIELDS = ['rank', 'iidx_id', 'dj_name', 'ex_score', 'lamp', 'played_version', 'date', 'bp', 'note_count'];
const keyOf = (song, diff) => `${song}/${diff}`;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const compareEx = (a, b) => a === b ? 0 : a === null ? 1 : b === null ? -1 : compare(b, a);
const errorText = error => error instanceof Error ? error.message : String(error);

/** Keep this wrapper around every network reader, including injected fetch. */
export function createReadOnlyFetch(fetchImpl = fetch, { supabaseUrl = process.env.SUPABASE_URL,
  account = process.env.CLOUDFLARE_ACCOUNT_ID || '607eea1b073bea6747e6e9b76f2d7b41' } = {}) {
  const sb = supabaseUrl ? new URL(supabaseUrl) : null;
  const r2 = `/client/v4/accounts/${account}/r2/buckets/ohsorry-data/objects`;
  return async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = (init.method ?? input?.method ?? 'GET').toUpperCase();
    const path = decodeURIComponent(url.pathname);
    const sameSb = sb && url.origin === sb.origin;
    const users = sameSb && path === '/rest/v1/users' && method === 'GET';
    const rpc = sameSb && method === 'POST' &&
      ['/rest/v1/rpc/get_chart_ranking_v2', '/rest/v1/rpc/get_first_place_winners'].includes(path);
    const r2Get = url.origin === 'https://api.cloudflare.com' && method === 'GET' &&
      (path === r2 || path.startsWith(r2 + '/'));
    if ((!users && !rpc && !r2Get) || /(?:scores|refresh)/i.test(path)) {
      throw new Error(`Read-only network policy rejected ${method} ${url.origin}${path}`);
    }
    // Refuse redirects so a permitted URL cannot redirect credentials or requests.
    return fetchImpl(input, { ...init, redirect: 'error' });
  };
}

export function compareFingerprints(start, end) {
  const reasons = [];
  for (const [name, value] of [['start', start], ['end', end]]) {
    if (!value || value.version !== 1 || !Array.isArray(value.hist) ||
      !Array.isArray(value.missing_etag_keys) || value.etags_complete !== true ||
      value.missing_etag_keys.length || value.hist.some(x => !x?.key || typeof x.etag !== 'string' || !x.etag) ||
      new Set(value.hist.map(x => x?.key)).size !== value.hist.length ||
      ['aliases_hash', 'songs_hash', 'users_hash'].some(k => typeof value[k] !== 'string' || !value[k])) {
      reasons.push(`${name}: incomplete fingerprint or missing object ETag`);
    }
  }
  if (!reasons.length) {
    for (const field of ['version', 'hist', 'aliases_hash', 'songs_hash', 'users_hash']) {
      const canonical = value => field === 'hist' ? [...value].map(({ key, etag }) => ({ key, etag }))
        .sort((a, b) => compare(a.key, b.key)) : value;
      if (JSON.stringify(canonical(start[field])) !== JSON.stringify(canonical(end[field]))) reasons.push(`changed: ${field}`);
    }
  }
  return { valid: reasons.length === 0, reasons };
}

/** SQL representative candidates retain every actual highest-EX source row. */
export function buildSqlCandidates({ users, histories }) {
  const names = new Map(users.map(u => [u.iidx_id, u.dj_name]));
  const charts = new Map();
  for (const [id, rows] of histories) {
    if (!names.has(id)) continue;
    for (const row of rows) {
      if (row[7] !== 1 || row[4] === -10) continue;
      const key = keyOf(row[0], row[1]);
      if (!charts.has(key)) charts.set(key, { song_id: row[0], diff: row[1], users: new Map(), originals: [] });
      const chart = charts.get(key);
      chart.originals.push({ id, row });
      const old = chart.users.get(id);
      if (!old || compareEx(row[3], old.ex_score) < 0) chart.users.set(id, { ex_score: row[3], rows: [row], dj_name: names.get(id) });
      else if (row[3] === old.ex_score) old.rows.push(row);
    }
  }
  for (const chart of charts.values()) {
    const candidates = [...chart.users.values()].sort((a, b) => compareEx(a.ex_score, b.ex_score));
    let rank = 0;
    for (let index = 0; index < candidates.length; index++) {
      if (index === 0 || candidates[index].ex_score !== candidates[index - 1].ex_score) rank = index + 1;
      candidates[index].rank = rank;
    }
    const originals = chart.originals.filter(x => x.row[3] !== null).sort((a, b) =>
      compareEx(a.row[3], b.row[3]) || compare(historyInstant(a.row[5]), historyInstant(b.row[5])));
    const first = originals[0];
    chart.winner_ids = new Set(first ? originals.filter(x => x.row[3] === first.row[3] &&
      historyInstant(x.row[5]) === historyInstant(first.row[5])).map(x => x.id) : []);
  }
  return charts;
}

function rowFrom(candidate, id, row) {
  return { rank: candidate.rank, iidx_id: id, dj_name: candidate.dj_name, ex_score: row[3],
    lamp: row[2], played_version: row[4], date: row[5], bp: row[8], note_count: row[9] };
}

export function compareRankingRow(expected, actual) {
  const differences = [], dateRepresentations = [];
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return { equal: false, differences: ['invalid row'], dateRepresentations };
  for (const field of FIELDS) {
    if (field === 'date') {
      try {
        if (historyInstant(expected.date) !== historyInstant(actual.date)) differences.push(field);
        else if (expected.date !== actual.date) dateRepresentations.push({ expected: expected.date, actual: actual.date });
      } catch { differences.push(field); }
    } else if (expected[field] !== actual[field]) differences.push(field);
  }
  return { equal: differences.length === 0, differences, dateRepresentations };
}

/** Validate the complete SQL top-100 set, not independent row membership alone. */
export function judgeSqlRanking(chart, rows) {
  const errors = [], users = [], dateRepresentations = [];
  if (!Array.isArray(rows)) return { valid: false, errors: ['response is not an array'], users, dateRepresentations };
  const candidates = chart?.users ?? new Map();
  if (rows.length !== Math.min(100, candidates.size)) errors.push('top-100 row count mismatch');
  const seen = new Set();
  let previous;
  for (const row of rows) {
    const id = row?.iidx_id;
    const issues = [];
    if (seen.has(id)) issues.push('duplicate user');
    seen.add(id);
    const candidate = candidates.get(id);
    if (!candidate) issues.push('user is not a source candidate');
    else {
      const matches = candidate.rows.map(source => compareRankingRow(rowFrom(candidate, id, source), row));
      const match = matches.find(x => x.equal);
      if (!match) issues.push('nine fields do not match any actual highest-EX row');
      else dateRepresentations.push(...match.dateRepresentations.map(x => ({ iidx_id: id, ...x })));
    }
    if (row && previous !== undefined && compareEx(previous, row.ex_score) > 0) issues.push('EX order is invalid');
    previous = row?.ex_score;
    if (row?.ex_score === null) issues.push('NULL EX cannot be published');
    users.push({ iidx_id: id, status: issues.length ? 'different' : 'candidate_match', reasons: issues });
    errors.push(...issues.map(issue => `${id}: ${issue}`));
  }
  if (rows.length && rows.every(row => candidates.has(row?.iidx_id))) {
    const boundary = rows.reduce((min, row) => compareEx(row.ex_score, min) > 0 ? row.ex_score : min, rows[0].ex_score);
    for (const [id, candidate] of candidates) {
      if (compareEx(candidate.ex_score, boundary) < 0 && !seen.has(id)) errors.push(`missing user above boundary: ${id}`);
    }
  }
  return { valid: errors.length === 0, errors, users, dateRepresentations };
}

export function judgeSqlWinner(chart, winner) {
  const ids = chart?.winner_ids ?? new Set();
  const valid = winner == null ? ids.size === 0 : ids.has(winner);
  return { valid, winner: winner ?? null, candidates: [...ids].sort(), status: valid ? 'candidate_match' : 'different' };
}

function compareRows(expected, actual, allowSql = false, candidate = null) {
  if (!Array.isArray(actual)) return { status: 'incomparable', errors: ['ranking is not an array'], users: [] };
  const byId = new Map(expected.map(row => [row.iidx_id, row]));
  const seen = new Set(), users = [], dates = [];
  let equal = actual.length === expected.length;
  for (const [index, row] of actual.entries()) {
    const target = byId.get(row?.iidx_id);
    const verdict = target ? compareRankingRow(target, row) : { equal: false, differences: ['membership'], dateRepresentations: [] };
    if (seen.has(row?.iidx_id)) {
      verdict.equal = false;
      verdict.differences.push('duplicate');
    }
    if (row?.iidx_id !== expected[index]?.iidx_id) {
      verdict.equal = false;
      verdict.differences.push('order_or_membership');
    }
    seen.add(row?.iidx_id);
    equal &&= verdict.equal;
    dates.push(...verdict.dateRepresentations);
    users.push({ iidx_id: row?.iidx_id, status: verdict.equal ? 'identical' : 'different', fields: verdict.differences });
  }
  for (const row of expected) if (!seen.has(row.iidx_id)) users.push({ iidx_id: row.iidx_id, status: 'different', fields: ['missing'] });
  const sql = allowSql ? judgeSqlRanking(candidate, actual) : null;
  const mine = allowSql ? judgeSqlRanking(candidate, expected) : null;
  const status = sql && !sql.valid ? 'different' : equal ? 'identical' : sql?.valid && mine.valid ? 'sql_undetermined_match' : 'different';
  if (status === 'sql_undetermined_match') for (const user of users) if (user.status === 'different') user.status = status;
  return { status, users, dateRepresentations: dates, ...(sql ? { sql, expected_judgement: { valid: mine.valid, errors: mine.errors } } : {}) };
}

function parsePublicWinners(body) {
  if (body === null) return new Map();
  const value = JSON.parse(body);
  if (!value || !Number.isInteger(value.n) || !value.w || typeof value.w !== 'object' || Array.isArray(value.w)) throw new Error('invalid public first-place body');
  const rows = [];
  for (const [id, pairs] of Object.entries(value.w)) {
    if (!Array.isArray(pairs)) throw new Error('invalid public first-place pairs');
    for (const pair of pairs) {
      if (!Array.isArray(pair) || pair.length !== 2) throw new Error('invalid public first-place chart');
      rows.push({ song_id: pair[0], diff: pair[1], iidx_id: id });
    }
  }
  if (rows.length) validateRows(rows);
  if (rows.length !== value.n) throw new Error('public first-place count mismatch');
  return new Map(rows.map(row => [keyOf(row.song_id, row.diff), row.iidx_id]));
}

async function rpcRequest(deps, name, body, query = '') {
  const url = deps.supabaseUrl.replace(/\/$/, '') + '/rest/v1/rpc/' + name + query;
  const res = await deps.fetchImpl(url, { method: 'POST', headers: {
    apikey: deps.serviceKey, Authorization: `Bearer ${deps.serviceKey}`, 'Content-Type': 'application/json', Prefer: 'count=exact',
  }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res;
}

export async function fetchSqlWinners(deps) {
  const rows = [];
  let offset = 0, total = null;
  do {
    const res = await rpcRequest(deps, 'get_first_place_winners', {}, `?limit=1000&offset=${offset}&order=song_id.asc,diff.asc`);
    const header = res.headers.get('content-range');
    const count = parseContentRangeTotal(header);
    const page = await res.json();
    if (!Number.isSafeInteger(count) || count < 0 || !Array.isArray(page) || page.length > 1000) throw new Error('invalid first-place page/Content-Range');
    if (total !== null && total !== count) throw new Error('first-place total changed between pages');
    total = count;
    const range = /^(\d+)-(\d+)\//.exec(header);
    if (!range || Number(range[1]) !== offset || Number(range[2]) !== offset + page.length - 1 || !page.length) throw new Error('first-place page range mismatch');
    rows.push(...page);
    offset += page.length;
    if (offset > total || (offset < total && page.length !== 1000)) throw new Error('first-place page count mismatch');
    deps.log?.(`first-place: ${offset}/${total}`);
  } while (offset < total);
  if (rows.length !== total) throw new Error('first-place total mismatch');
  validateRows(rows);
  return rows;
}

/** All readers may be injected; no writer dependency is accepted or invoked. */
export async function compareHistoryRankings(deps = {}) {
  for (const name of ['putText', 'put', 'del', 'delete', 'refresh', 'mutationFetch', 'mutationFetchImpl']) {
    if (deps[name] !== undefined) throw new Error(`Mutation dependency rejected: ${name}`);
  }
  const concurrency = deps.rpcConcurrency ?? 2;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) throw new Error('rpcConcurrency must be 1 or 2');
  const log = typeof deps.log === 'function' ? deps.log : message => console.error(typeof message === 'string' ? message : JSON.stringify(message));
  const supabaseUrl = deps.supabaseUrl ?? process.env.SUPABASE_URL;
  const serviceKey = deps.serviceKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  const fetchImpl = createReadOnlyFetch(deps.fetchImpl ?? fetch, { supabaseUrl, account: deps.account });
  const requestGate = deps.requestGate ?? createRequestGate();
  const token = deps.r2Options?.token ?? process.env.CLOUDFLARE_R2_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;
  const options = { ...deps.r2Options, ...(token ? { token } : {}), fetchImpl, requestGate, retry: true };
  const read = deps.getText ?? getText, list = deps.listEntries ?? listEntries;
  if ((!deps.getText || !deps.listEntries) && !token) throw new Error('R2 REST token required; wrangler fallback is disabled');
  const inputDeps = { ...deps, fetchImpl, supabaseUrl, serviceKey, requestGate, r2Options: options, log };
  const rpcDeps = { fetchImpl, supabaseUrl, serviceKey, log };
  const report = { version: 1, valid: false, passed: false, exitCode: 1, scope_complete: false,
    production_possible: false, sql_definition: { status: 'unverified', reason: 'Remote SQL definition was not queried; candidate semantics are contractual.' },
    fingerprints: { start: null, end: null, valid: false, reasons: [] }, diagnostics: null, charts: [], failures: [],
    summary: { identical: 0, sql_undetermined_match: 0, different: 0, query_failed: 0, incomparable: 0 },
    public_summary: { identical: 0, sql_undetermined_match: 0, different: 0, query_failed: 0, incomparable: 0 } };
  let inputs;
  try {
    log('Collecting history inputs');
    inputs = await (deps.loadInputs ?? deps.loadHistoryInputs ?? loadHistoryInputs)(inputDeps);
    report.fingerprints.start = inputs.fingerprint;
    report.diagnostics = inputs.diagnostics;
    const candidates = buildSqlCandidates(inputs);
    let computed = null;
    try {
      computed = await (deps.buildRankings ?? buildHistoryRankings)(inputs);
      validateRows(computed.winners);
      toOutput(computed.winners);
      report.production_possible = true;
    } catch (error) { report.failures.push({ stage: 'production', error: errorText(error) }); }
    const expectedCharts = new Map((computed?.charts ?? []).map(chart => [keyOf(chart.song_id, chart.diff), chart.rows]));
    const expectedWinners = new Map((computed?.winners ?? []).map(row => [keyOf(row.song_id, row.diff), row.iidx_id]));
    const scope = new Map([...candidates].map(([key, chart]) => [key, [chart.song_id, chart.diff]]));
    const remoteKeys = new Set();
    let publicWinners = null, sqlWinners = null, discoveryComplete = true;
    try {
      const entries = await list('ranking/', options);
      if (!Array.isArray(entries)) throw new Error('ranking LIST is not an array');
      for (const entry of entries) {
        const match = /^ranking\/(\d+)-(\d+)\.json$/.exec(entry?.key);
        if (!match || remoteKeys.has(entry.key)) throw new Error('invalid or duplicate ranking key');
        remoteKeys.add(entry.key);
        scope.set(keyOf(+match[1], +match[2]), [+match[1], +match[2]]);
      }
    } catch (error) { discoveryComplete = false; report.failures.push({ stage: 'ranking_list', error: errorText(error) }); }
    try {
      publicWinners = parsePublicWinners(await read('first-place-winners.json', options));
      for (const key of publicWinners.keys()) scope.set(key, key.split('/').map(Number));
    } catch (error) { discoveryComplete = false; report.failures.push({ stage: 'public_winners', error: errorText(error) }); }
    try {
      const rows = await fetchSqlWinners(rpcDeps);
      sqlWinners = new Map(rows.map(row => [keyOf(row.song_id, row.diff), row.iidx_id]));
      for (const row of rows) scope.set(keyOf(row.song_id, row.diff), [row.song_id, row.diff]);
    } catch (error) { discoveryComplete = false; report.failures.push({ stage: 'sql_winners', error: errorText(error) }); }
    let completed = 0;
    const targets = [...scope].sort((a, b) => a[1][0] - b[1][0] || a[1][1] - b[1][1]);
    await pool(targets, concurrency, async ([key, [song, diff]], index) => {
      const result = { song_id: song, diff, public_ranking: null, sql_ranking: null, public_winner: null, sql_winner: null };
      const expected = expectedCharts.get(key) ?? [];
      try {
        const path = `ranking/${song}-${diff}.json`;
        const body = remoteKeys.has(path) ? await read(path, options) : null;
        if (remoteKeys.has(path) && body === null) throw new Error('listed ranking body missing');
        result.public_ranking = computed ? compareRows(expected, body === null ? [] : JSON.parse(body)) : { status: 'incomparable' };
      } catch (error) { result.public_ranking = { status: 'query_failed', error: errorText(error) }; }
      try {
        const res = await rpcRequest(rpcDeps, 'get_chart_ranking_v2', { p_song_id: song, p_diff: diff, p_played_version: null });
        const rows = await res.json();
        result.sql_ranking = computed ? compareRows(expected, rows, true, candidates.get(key)) :
          { status: 'incomparable', sql: judgeSqlRanking(candidates.get(key), rows) };
      } catch (error) { result.sql_ranking = { status: 'query_failed', error: errorText(error) }; }
      const expectedWinner = expectedWinners.get(key) ?? null;
      result.public_winner = { status: !publicWinners || !computed ? 'incomparable' :
        (publicWinners.get(key) ?? null) === expectedWinner ? 'identical' : 'different', actual: publicWinners?.get(key) ?? null, expected: expectedWinner };
      const sqlWinner = sqlWinners?.get(key) ?? null;
      const judged = judgeSqlWinner(candidates.get(key), sqlWinner);
      result.sql_winner = { ...judged, status: !sqlWinners || !computed ? 'incomparable' : !judged.valid ? 'different' :
        sqlWinner === expectedWinner ? 'identical' : judgeSqlWinner(candidates.get(key), expectedWinner).valid ? 'sql_undetermined_match' : 'different' };
      report.charts[index] = result;
      log(`ranking: ${++completed}/${targets.length} (${key})`);
    });
    report.scope_complete = discoveryComplete && report.charts.every(chart => chart.sql_ranking.status !== 'query_failed');
  } catch (error) { report.failures.push({ stage: 'inputs_or_comparison', error: errorText(error) }); }
  finally {
    if (inputs) {
      try {
        log('Verifying input fingerprint');
        report.fingerprints.end = await (deps.verifyFingerprint ?? inputs.verifyFingerprint ?? verifyFingerprint)(inputDeps);
        Object.assign(report.fingerprints, compareFingerprints(inputs.fingerprint, report.fingerprints.end));
      } catch (error) { report.fingerprints.reasons.push(`verification failed: ${errorText(error)}`); }
    }
  }
  for (const chart of report.charts) for (const part of ['sql_ranking', 'sql_winner']) report.summary[chart[part].status]++;
  for (const chart of report.charts) for (const part of ['public_ranking', 'public_winner']) report.public_summary[chart[part].status]++;
  report.valid = report.fingerprints.valid && report.scope_complete;
  report.passed = report.valid && report.production_possible && report.failures.length === 0 &&
    report.summary.different === 0 && report.summary.query_failed === 0 && report.summary.incomparable === 0;
  report.exitCode = report.passed ? 0 : 1;
  return report;
}

export function parseCliOptions(argv) {
  const result = { rpcConcurrency: 2, out: null };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--out') {
      if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('--out requires a file');
      result.out = argv[++index];
    } else if (arg === '--rpc-concurrency') {
      result.rpcConcurrency = Number(argv[++index]);
      if (![1, 2].includes(result.rpcConcurrency)) throw new Error('--rpc-concurrency must be 1 or 2');
    } else if (arg === '--help') result.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return result;
}

async function main() {
  let options, timer;
  try {
    options = parseCliOptions(process.argv.slice(2));
    if (options.help) {
      console.log('Usage: node .github/scripts/compare-history-rankings.mjs [--rpc-concurrency 1|2] [--out <file>]');
      return;
    }
    for (const name of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) if (!process.env[name]) throw new Error(`${name} is required`);
    if (!(process.env.CLOUDFLARE_R2_TOKEN || process.env.CLOUDFLARE_API_TOKEN)) throw new Error('CLOUDFLARE_R2_TOKEN or CLOUDFLARE_API_TOKEN is required');
    timer = setInterval(() => console.error(`Comparison still running: ${new Date().toISOString()}`), 15000);
    const report = await compareHistoryRankings(options);
    const body = JSON.stringify(report, null, 2) + '\n';
    if (options.out) await writeFile(options.out, body, 'utf8');
    else process.stdout.write(body);
    process.exitCode = report.exitCode;
  } catch (error) {
    const report = { version: 1, valid: false, passed: false, exitCode: 1, failures: [{ stage: 'cli', error: errorText(error) }] };
    const body = JSON.stringify(report, null, 2) + '\n';
    if (options?.out) await writeFile(options.out, body, 'utf8');
    else process.stdout.write(body);
    console.error(errorText(error));
    process.exitCode = 1;
  } finally { if (timer) clearInterval(timer); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();

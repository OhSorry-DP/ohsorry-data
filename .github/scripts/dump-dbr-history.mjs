import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DBR_HISTORY_COLS, normalizeDbrHistory, extendDbrPayload } from './dbr-history.mjs';
import { conditionalR2Client } from './r2-client.mjs';

const sha256 = (body) => createHash('sha256').update(body).digest('hex');
const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id);
function scoreId(value) {
  if ((typeof value === 'number' && !Number.isSafeInteger(value))
    || !/^[1-9]\d*$/.test(String(value))) throw new Error('안전하지 않은 score_id');
  const id = BigInt(value);
  if (id > 9223372036854775807n) throw new Error('score_id bigint 범위 초과');
  return id;
}

// offset 없이 마지막 score_id 다음부터 읽는다. 서버의 페이지 상한이 작아도 빈 페이지까지 계속한다.
export async function readDbrRows({ supabaseUrl, token, fetchImpl = fetch, pageSize = 1000 }) {
  if (!supabaseUrl || !token) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 없음');
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new Error('잘못된 pageSize');
  const rows = [];
  let cursor = 0n;
  while (true) {
    const url = new URL(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/scores`);
    url.search = new URLSearchParams({
      select: ['iidx_id', ...DBR_HISTORY_COLS].join(','), played_version: 'eq.-10',
      play_style: 'eq.1', order: 'score_id.asc', limit: String(pageSize), score_id: `gt.${cursor}`,
    }).toString();
    const r = await fetchImpl(url.href, { method: 'GET',
      headers: { apikey: token, Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Supabase scores HTTP ${r.status}`);
    const page = await r.json();
    if (!Array.isArray(page)) throw new Error('Supabase scores 응답이 배열이 아님');
    if (!page.length) break;
    for (const row of page) {
      if (!row || !validId(row.iidx_id)) throw new Error('잘못된 iidx_id');
      if (row.played_version !== -10 || row.play_style !== 1) throw new Error('DBR 필터 위반');
      const next = scoreId(row.score_id);
      if (next <= cursor) throw new Error('score_id 중복 또는 페이징 순서 위반');
      // 필수 날짜·수치 검증은 기존 계약에 맡긴다. 잘못된 행을 조용히 빼지 않는다.
      normalizeDbrHistory([row]);
      cursor = next;
      rows.push(row);
    }
  }
  return rows;
}

export async function run({ supabaseUrl, token, fetchImpl = fetch, pageSize = 1000,
  r2, apply = false, log = console } = {}) {
  if (!r2) throw new Error('R2 클라이언트 없음');
  const entries = await r2.listEntries('dbr/');
  const owners = new Set();
  for (const { key } of entries) {
    const match = /^dbr\/([A-Za-z0-9_-]+)\.json$/.exec(key);
    if (!match) throw new Error(`잘못된 DBR 객체 키: ${key}`);
    if (owners.has(match[1])) throw new Error(`중복 DBR 객체 키: ${key}`);
    owners.add(match[1]);
  }
  const rows = await readDbrRows({ supabaseUrl, token, fetchImpl, pageSize });
  const byUser = new Map([...owners].map((id) => [id, []]));
  for (const row of rows) {
    if (!byUser.has(row.iidx_id)) byUser.set(row.iidx_id, []);
    byUser.get(row.iidx_id).push(row);
  }
  const prepared = [];
  let duplicateKeys = 0;
  // 전체 대상을 검증한 뒤 저장한다. 기존 보유자의 404도 객체 소실로 보고 중단한다.
  for (const id of [...byUser.keys()].sort()) {
    const key = `dbr/${id}.json`, source = byUser.get(id);
    const previous = await r2.read(key);
    if (!previous && owners.has(id)) throw new Error(`목록에 있던 DBR 객체가 사라짐: ${key}`);
    const payload = previous ? JSON.parse(previous.body) : { scores: {} };
    duplicateKeys += source.length - normalizeDbrHistory(source).rows.length;
    const body = JSON.stringify(extendDbrPayload(payload, source, { complete: true }));
    prepared.push({ key, body, etag: previous?.etag ?? null,
      bytes: Buffer.byteLength(body, 'utf8'), sha256: sha256(body) });
  }
  const sizes = prepared.map((p) => p.bytes).sort((a, b) => a - b), middle = sizes.length >> 1;
  const objects = prepared.map(({ key, bytes, sha256: hash }) => ({ key, bytes, sha256: hash }));
  const report = { dryRun: !apply, users: prepared.length, rows: rows.length, duplicateKeys,
    bytes: { total: sizes.reduce((a, b) => a + b, 0), max: sizes.at(-1) ?? 0,
      median: sizes.length ? (sizes.length % 2 ? sizes[middle] : (sizes[middle - 1] + sizes[middle]) / 2) : 0 },
    sha256: sha256(JSON.stringify(objects)), objects, puts: 0 };
  // apply에서도 통계와 대상별 해시를 PUT보다 먼저 출력한다.
  log.log(JSON.stringify(report, null, 2));
  if (apply) for (const { key, body, etag } of prepared) {
    await r2.put(key, body, etag);
    report.puts++;
  }
  return report;
}

export function parseArgs(args) {
  if (args.some((arg) => !['--dry-run', '--apply'].includes(arg))
    || (args.includes('--dry-run') && args.includes('--apply'))) throw new Error('사용법: dump-dbr-history.mjs [--dry-run | --apply]');
  return { apply: args.includes('--apply') };
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const r2 = conditionalR2Client({
    account: process.env.CLOUDFLARE_ACCOUNT_ID,
    token: process.env.CLOUDFLARE_R2_TOKEN || process.env.CLOUDFLARE_API_TOKEN,
  });
  const report = await run({ ...options, r2, supabaseUrl: process.env.SUPABASE_URL,
    token: process.env.SUPABASE_SERVICE_ROLE_KEY });
  console.log(`완료: 사용자 ${report.users}, 원천 행 ${report.rows}, PUT ${report.puts}`);
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { await main(); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}

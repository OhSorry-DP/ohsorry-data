import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { conditionalR2Client } from './r2-client.mjs';
import { producePhysUser } from './phys-lib.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VALID_ID = /^[A-Za-z0-9_-]+$/;
const CHECKPOINT_SCHEMA = 'phys-backfill-checkpoint/1';
const RETRY_LIMIT = 10;

export function parseArgs(args) {
  const options = { limit: 50, dryRun: true, only: null };
  const values = new Map();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--help', '-h'].includes(arg)) { options.help = true; continue; }
    if (['--dry-run', '--write'].includes(arg)) {
      const key = arg === '--write' ? 'write' : 'dryRun';
      if (options[key === 'write' ? 'write' : 'dryRun'] === true && key === 'dryRun' && values.has(key)) throw new Error('중복 옵션');
      if (values.has(key)) throw new Error('중복 옵션');
      values.set(key, true); options[key] = true; continue;
    }
    if (!['--users-list', '--manifest', '--model-version', '--q-version', '--time-axis-version', '--only', '--limit', '--resume'].includes(arg)) throw new Error(`알 수 없는 옵션: ${arg}`);
    if (values.has(arg)) throw new Error(`중복 옵션: ${arg}`);
    const value = args[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`옵션 값 누락: ${arg}`);
    values.set(arg, value);
  }
  if (options.help) return options;
  if (!values.has('--users-list') || !values.has('--manifest')) throw new Error('--users-list와 --manifest가 필요합니다');
  options.usersList = values.get('--users-list'); options.manifestPath = values.get('--manifest');
  options.versions = { model_version: values.get('--model-version') || null, q_version: values.get('--q-version') || null,
    time_axis_version: values.get('--time-axis-version') || null };
  if (values.has('--only')) options.only = [...new Set(values.get('--only').split(',').filter(Boolean))];
  if (options.only?.some(id => !VALID_ID.test(id))) throw new Error('--only에 유효하지 않은 ID가 있습니다');
  if (values.has('--limit')) {
    const n = Number(values.get('--limit'));
    if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error('--limit은 1..50 정수여야 합니다');
    options.limit = n;
  }
  options.resume = values.get('--resume') || null;
  if (values.has('--write') && values.has('--dry-run')) throw new Error('--write와 --dry-run은 함께 쓸 수 없습니다');
  options.dryRun = !values.has('--write');
  return options;
}

export function extractUserIds(list) {
  if (!Array.isArray(list)) throw new Error('users-list는 배열이어야 합니다');
  const ids = new Set();
  for (const row of list) {
    const id = String(row?.iidx_id ?? '');
    if (!VALID_ID.test(id)) throw new Error('users-list iidx_id 형식 오류');
    ids.add(id);
  }
  return [...ids].sort();
}

const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
const atomicJson = async (file, value) => {
  const absolute = path.resolve(file), dir = path.dirname(absolute);
  await fs.mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try { await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }); await fs.rename(temp, absolute); }
  catch (error) { await fs.rm(temp, { force: true }).catch(() => {}); throw error; }
};
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const versionsEqual = (a, b) => ['model_version', 'q_version', 'time_axis_version'].every(k => (a?.[k] ?? null) === (b?.[k] ?? null));

export async function runBackfill(options, deps = {}) {
  const now = deps.now || (() => new Date());
  const wallStart = now().getTime(), cpuStart = process.cpuUsage();
  const readFile = deps.readFile || (file => fs.readFile(file, 'utf8'));
  const listText = await readFile(options.usersList), manifestText = await readFile(options.manifestPath);
  const manifestHash = sha256(manifestText);
  const idsAll = extractUserIds(JSON.parse(listText));
  const manifest = JSON.parse(manifestText);
  let ids = options.only ? idsAll.filter(id => options.only.includes(id)) : idsAll;
  const versions = options.versions;
  const summary = { attempted: 0, ready: 0, skipped: 0, failed: 0, next_cursor: 0, versions, manifest_hash: manifestHash, failures: [] };
  const checkpointPath = options.resume;
  let checkpoint = { schema: CHECKPOINT_SCHEMA, versions, manifest_hash: manifestHash, cursor: 0, success: {}, failures: {} };
  if (checkpointPath) {
    try {
      const previous = await readJson(checkpointPath);
      if (previous.schema === CHECKPOINT_SCHEMA && previous.manifest_hash === manifestHash && versionsEqual(previous.versions, versions)) checkpoint = previous;
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (checkpoint.schema !== CHECKPOINT_SCHEMA || checkpoint.manifest_hash !== manifestHash || !versionsEqual(checkpoint.versions, versions)) {
      checkpoint = { schema: CHECKPOINT_SCHEMA, versions, manifest_hash: manifestHash, cursor: 0, success: {}, failures: {} };
    }
  }
  const target = new Set(ids);
  const retryIds = Object.keys(checkpoint.failures || {}).filter(id => target.has(id)).sort().slice(0, RETRY_LIMIT);
  let cursor = Number.isInteger(checkpoint.cursor) && checkpoint.cursor >= 0 ? checkpoint.cursor : 0;
  if (options.only) cursor = 0;
  let visited = 0, index = cursor;
  const attempts = [];
  const r2 = deps.r2 || null;
  const produce = deps.produce || producePhysUser;
  const io = deps.io || r2;
  const loader = deps.loadAssets || (async (v, m, client) => {
    const { loadPhysAssets } = await import('./phys-assets.mjs');
    return loadPhysAssets({ versions: v, manifest: m, getText: async key => {
      const value = await client.read(key); return value == null ? null : (typeof value === 'string' ? value : value.body);
    } });
  });
  const fitUser = deps.fitUser || require('./vendor/physTheta.js').fitUser;
  const max = Math.min(options.limit, ids.length);
  const startIndex = index;
  while (index < ids.length && visited < max) {
    const id = ids[index++]; visited++; attempts.push({ id, retry: false });
  }
  for (const id of retryIds) {
    if (attempts.length >= options.limit) break;
    attempts.push({ id, retry: true });
  }
  // Failed IDs rejoin only after the current normal traversal reaches its end.
  if (startIndex >= ids.length && attempts.length < options.limit) {
    for (const id of retryIds) if (attempts.length < options.limit && !attempts.some(item => item.id === id)) attempts.push({ id, retry: true });
  }
  if (!versions.model_version || !versions.q_version || !versions.time_axis_version || manifest?.publishable !== true) {
    summary.skipped = attempts.length; summary.next_cursor = index;
    for (const { id } of attempts) summary.failures.push({ id, reason: !versions.model_version || !versions.q_version || !versions.time_axis_version ? 'versions_unset' : 'assets_unpublished' });
  } else {
    for (const { id } of attempts) {
      summary.attempted++;
      try {
        const dumpText = await (deps.getDump ? deps.getDump(id) : readFile(path.resolve(options.userDir || '.', 'user', `${id}.json`)));
        if (dumpText == null) throw Object.assign(new Error('source_missing'), { reason: 'source_missing' });
        const dump = typeof dumpText === 'string' ? JSON.parse(dumpText) : dumpText;
        if (!dump || typeof dump !== 'object' || !Array.isArray(dump.dp)) throw Object.assign(new Error('source_invalid'), { reason: 'source_invalid' });
        const sourceRevision = sha256(typeof dumpText === 'string' ? dumpText : JSON.stringify(dumpText));
        const prior = checkpoint.success?.[id];
        const currentRemote = deps.readRemoteRevision ? await deps.readRemoteRevision(id) : (io?.read ? await (async () => {
          const value = await io.read(`phys/user/${encodeURIComponent(id)}.json`);
          if (value == null) return null;
          const body = typeof value === 'string' ? value : value.body;
          return JSON.parse(body)?.absolute?.source_revision ?? null;
        })() : null);
        if (prior?.source_revision === sourceRevision && currentRemote != null && currentRemote === prior.remote_revision) { summary.ready++; continue; }
        const result = await produce({ id, dump, versions, manifest, io, fitUser, loadAssets: loader, dryRun: options.dryRun });
        if (['ready', 'planned'].includes(result.status)) {
          summary.ready++;
          if (!options.dryRun && result.status === 'ready' && result.changed) {
            const verify = deps.verifyPut ? await deps.verifyPut(id, result) : await io.read(result.key);
            const body = typeof verify === 'string' ? verify : verify?.body;
            const record = body ? JSON.parse(body) : null;
            if (record?.absolute?.source_revision !== result.source_revision || record?.absolute?.status !== 'ready') throw Object.assign(new Error('put_verification_failed'), { reason: 'put_verification_failed' });
          }
          if (!options.dryRun && result.status === 'ready') checkpoint.success[id] = { source_revision: sourceRevision, remote_revision: result.source_revision };
          delete checkpoint.failures[id];
        } else if (result.status === 'skipped') { summary.skipped++; checkpoint.failures[id] = { attempts: (checkpoint.failures?.[id]?.attempts || 0) + 1, reason: result.reason }; }
        else throw Object.assign(new Error(result.reason || result.status), { reason: result.reason || result.status });
      } catch (error) {
        summary.failed++; const reason = error.reason || error.code || 'generation_failed';
        const attemptsSoFar = (checkpoint.failures?.[id]?.attempts || 0) + 1;
        checkpoint.failures[id] = { attempts: attemptsSoFar, reason };
        summary.failures.push({ id, reason });
      }
    }
  }
  summary.next_cursor = index >= ids.length ? 0 : index;
  checkpoint.cursor = summary.next_cursor;
  checkpoint.versions = versions; checkpoint.manifest_hash = manifestHash;
  if (checkpointPath && !options.dryRun) await atomicJson(checkpointPath, checkpoint);
  const cpu = process.cpuUsage(cpuStart), wallMs = Math.max(0, now().getTime() - wallStart);
  summary.timing = { wall_ms: wallMs, cpu_user_ms: Math.round(cpu.user / 1000), cpu_system_ms: Math.round(cpu.system / 1000) };
  if (summary.failed) summary.exitCode = 1;
  return summary;
}

export const HELP = `사용법: node backfill-phys.mjs --users-list <local JSON> --manifest <local T04 JSON> [옵션]\n\n옵션:\n  --model-version <값> --q-version <값> --time-axis-version <값>\n  --only <ID,ID> --limit <1..50> --resume <checkpoint path>\n  --dry-run (기본값) | --write\n`;

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) { console.log(HELP); return; }
    const result = await runBackfill(options, { userDir: process.cwd(), r2: options.dryRun ? null : await (async () => {
      const client = conditionalR2Client({ account: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_R2_TOKEN || process.env.CLOUDFLARE_API_TOKEN });
      return { read: client.read, put: client.put };
    })() });
    console.log(JSON.stringify(result)); process.exitCode = result.exitCode || 0;
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();

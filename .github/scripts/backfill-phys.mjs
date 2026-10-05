import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { conditionalR2Client } from './r2-client.mjs';
import { producePhysUser } from './phys-lib.mjs';
import os from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VALID_ID = /^[A-Za-z0-9_-]+$/;
const CHECKPOINT_SCHEMA = 'phys-backfill-checkpoint/2';
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
    if (!['--users-list', '--manifest', '--model-version', '--q-version', '--time-axis-version', '--only', '--limit', '--resume', '--shard', '--shards'].includes(arg)) throw new Error(`알 수 없는 옵션: ${arg}`);
    if (values.has(arg)) throw new Error(`중복 옵션: ${arg}`);
    const value = args[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`옵션 값 누락: ${arg}`);
    values.set(arg, value);
  }
  if (options.help) return options;
  if (!values.has('--users-list') || !values.has('--manifest')) throw new Error('--users-list와 --manifest가 필요합니다');
  options.usersList = values.get('--users-list'); options.manifestPath = values.get('--manifest');
  const modelVersion = values.get('--model-version') || null;
  const v2 = modelVersion === 'phys-line-v2';
  options.versions = { model_version: modelVersion,
    ...(v2 ? { line_version: modelVersion, mean_version: 'mean-os-pattern-span-v2' } : {}),
    q_version: values.get('--q-version') || null, time_axis_version: values.get('--time-axis-version') || null };
  if (values.has('--only')) options.only = [...new Set(values.get('--only').split(',').filter(Boolean))];
  if (options.only?.some(id => !VALID_ID.test(id))) throw new Error('--only에 유효하지 않은 ID가 있습니다');
  if (values.has('--shard') || values.has('--shards')) {
    options.shard = Number(values.get('--shard'));
    options.shards = Number(values.get('--shards'));
    validateShard(options.shard, options.shards);
  }
  if (values.has('--limit')) {
    const n = Number(values.get('--limit'));
    if (!Number.isSafeInteger(n) || (options.shards == null ? n < 1 || n > 50 : n < 0)) throw new Error('--limit은 단일 실행에서 1..50, shard 실행에서 0 이상 정수여야 합니다');
    options.limit = n;
  }
  options.resume = values.get('--resume') || null;
  if (values.has('write') && values.has('dryRun')) throw new Error('--write와 --dry-run은 함께 쓸 수 없습니다');
  options.dryRun = !values.has('write');
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

function validateShard(shard, shards) {
  if (!Number.isInteger(shards) || shards < 1 || shards > 256 || !Number.isInteger(shard) || shard < 0 || shard >= shards) throw new Error('shard 형식 오류: 0 <= shard < shards <= 256');
}

export function shardUserIds(ids, shard, shards) {
  if (shards == null && shard == null) return ids;
  validateShard(shard, shards);
  return ids.filter((id, index) => index % shards === shard);
}

export function checkpointKey(model, shard, shards) {
  if (shards == null && shard == null) return `phys/backfill/checkpoint-${model}.json`;
  validateShard(shard, shards);
  return `phys/backfill/checkpoint-${model}-s${shard}of${shards}.json`;
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
const versionsEqual = (a, b) => ['model_version', 'line_version', 'mean_version', 'q_version', 'time_axis_version'].every(k => (a?.[k] ?? null) === (b?.[k] ?? null));

export async function runBackfill(options, deps = {}) {
  const now = deps.now || (() => new Date());
  const wallStart = now().getTime(), cpuStart = process.cpuUsage();
  const readFile = deps.readFile || (file => fs.readFile(file, 'utf8'));
  const listText = await readFile(options.usersList), manifestText = await readFile(options.manifestPath);
  const manifestHash = sha256(manifestText);
  const idsAll = extractUserIds(JSON.parse(listText));
  const manifest = JSON.parse(manifestText);
  const contentHash = sha256(JSON.stringify({ model: manifest.model ?? null, charts: manifest.charts ?? manifest.assets ?? [], bundle: manifest.bundle ?? null }));
  const shardIds = shardUserIds(idsAll, options.shard, options.shards);
  const ids = options.only ? shardIds.filter(id => options.only.includes(id)) : shardIds;
  const limit = options.shards != null && options.limit === 0 ? ids.length : Math.min(options.limit, ids.length);
  const versions = options.versions;
  const summary = { attempted: 0, ready: 0, skipped: 0, failed: 0, next_cursor: 0, versions, manifest_hash: manifestHash, failures: [] };
  const checkpointPath = options.resume;
  let checkpoint = { schema: CHECKPOINT_SCHEMA, versions, manifest_hash: manifestHash, content_hash: contentHash, cursor: 0, success: {}, failures: {} };
  if (checkpointPath) {
    try {
      const previous = await readJson(checkpointPath);
      if (previous.schema === CHECKPOINT_SCHEMA && previous.manifest_hash === manifestHash && previous.content_hash === contentHash && versionsEqual(previous.versions, versions) &&
          (previous.shard ?? null) === (options.shard ?? null) && (previous.shards ?? null) === (options.shards ?? null)) checkpoint = previous;
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (checkpoint.schema !== CHECKPOINT_SCHEMA || checkpoint.manifest_hash !== manifestHash || checkpoint.content_hash !== contentHash || !versionsEqual(checkpoint.versions, versions)) {
      checkpoint = { schema: CHECKPOINT_SCHEMA, versions, manifest_hash: manifestHash, content_hash: contentHash, cursor: 0, success: {}, failures: {} };
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
  let songsPromise, assetsPromise;
  const loader = deps.loadAssets || (async (v, m, client) => {
    const { loadPhysAssets } = await import('./phys-assets.mjs');
    return loadPhysAssets({ versions: v, manifest: m, getText: async key => {
      const value = await client.read(key); return value == null ? null : (typeof value === 'string' ? value : value.body);
    } });
  });
  const computePhysLine = deps.computePhysLine;
  const max = limit;
  const startIndex = index;
  while (index < ids.length && visited < max) {
    const id = ids[index++]; visited++; attempts.push({ id, retry: false });
  }
  for (const id of retryIds) {
    if (attempts.length >= limit) break;
    if (attempts.some(item => item.id === id)) continue;
    attempts.push({ id, retry: true });
  }
  // 일반 순회가 끝난 뒤 남은 회차 용량으로 실패 ID를 재시도한다.
  if (startIndex >= ids.length && attempts.length < limit) {
    for (const id of retryIds) if (attempts.length < limit && !attempts.some(item => item.id === id)) attempts.push({ id, retry: true });
  }
  if (!versions.model_version || !versions.q_version || !versions.time_axis_version || manifest?.publishable !== true ||
      (versions.model_version === 'phys-line-v2' && (versions.line_version !== 'phys-line-v2' || versions.mean_version !== 'mean-os-pattern-span-v2'))) {
    summary.skipped = attempts.length; summary.next_cursor = index;
    for (const { id } of attempts) summary.failures.push({ id, reason: !versions.model_version || !versions.q_version || !versions.time_axis_version ? 'versions_unset' : 'assets_unpublished' });
  } else {
    const concurrency = options.concurrency ?? os.availableParallelism();
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('유저 병렬 수는 양의 정수여야 합니다');
    let attemptIndex = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, attempts.length) }, async () => {
    while (attemptIndex < attempts.length) {
      const { id } = attempts[attemptIndex++];
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
        if (!dump.songMap && !dump.songs && io?.read) {
          // 회차 내에서 동일한 곡 매핑을 공유하며 실패한 조회는 다음 유저에서 재시도한다.
          songsPromise ||= (async () => {
            const value = await io.read('songs.json');
            if (value == null) throw new Error('songs_missing');
            return JSON.parse(typeof value === 'string' ? value : value.body);
          })().catch(error => { songsPromise = null; throw error; });
          dump.songs = await songsPromise;
        }
        // 병렬 유저도 같은 로딩 Promise를 공유하며 실패해도 회차 내에서 재조회하지 않는다.
        assetsPromise ||= Promise.resolve().then(() => loader(versions, manifest, io));
        const assets = await assetsPromise;
        const result = await produce({ id, dump, versions, manifest, io, computePhysLine, assets, loadAssets: () => assetsPromise, dryRun: options.dryRun });
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
        else throw Object.assign(new Error(result.error_message || result.reason || result.status), { reason: result.reason || result.status });
      } catch (error) {
        summary.failed++; const reason = error.reason || error.code || 'generation_failed';
        const attemptsSoFar = (checkpoint.failures?.[id]?.attempts || 0) + 1;
        const error_message = String(error.message || error).slice(0, 200);
        checkpoint.failures[id] = { attempts: attemptsSoFar, reason, error_message };
        summary.failures.push({ id, reason, error_message });
      }
    }
    }));
  }
  summary.next_cursor = index >= ids.length ? 0 : index;
  checkpoint.cursor = summary.next_cursor;
  checkpoint.versions = versions; checkpoint.manifest_hash = manifestHash; checkpoint.content_hash = contentHash;
  if (options.shards != null) { checkpoint.shard = options.shard; checkpoint.shards = options.shards; }
  if (checkpointPath && !options.dryRun) await atomicJson(checkpointPath, checkpoint);
  const cpu = process.cpuUsage(cpuStart), wallMs = Math.max(0, now().getTime() - wallStart);
  summary.timing = { wall_ms: wallMs, cpu_user_ms: Math.round(cpu.user / 1000), cpu_system_ms: Math.round(cpu.system / 1000) };
  if (summary.failed) summary.exitCode = 1;
  return summary;
}

export const HELP = `사용법: node backfill-phys.mjs --users-list <local JSON> --manifest <local T04 JSON> [옵션]\n\n옵션:\n  --model-version <값> --q-version <값> --time-axis-version <값>\n  --only <ID,ID> --limit <1..50> --resume <checkpoint path>\n  --shard <0부터 시작하는 번호> --shards <1..256>\n  shard 실행의 --limit은 0 이상이며 0은 shard 전체를 처리합니다.\n  --dry-run (기본값) | --write\n`;

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

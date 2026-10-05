import fs from 'node:fs/promises';
import os from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, runBackfill, checkpointKey } from './backfill-phys.mjs';
import { conditionalR2Client } from './r2-client.mjs';

export async function run(env = process.env, deps = {}) {
  const model = env.MODEL_VERSION || 'phys-line-v1';
  const contracts = {
    'phys-line-v1': { q: 'q-samehand-2s-v1', timeAxis: 'ta-20261004' },
    'phys-line-v2': { q: 'q-samehand-2s-v1', timeAxis: 'ta-20261004' },
  };
  if (!contracts[model]) throw new Error('MODEL_VERSION 형식 또는 계약 오류');
  const q = model === 'phys-line-v2' ? 'q-samehand-2s-v1' : (env.Q_VERSION || contracts[model].q);
  const timeAxis = model === 'phys-line-v2' ? 'ta-20261004' : (env.TIME_AXIS_VERSION || contracts[model].timeAxis);
  if (![model, q, timeAxis].every(v => /^[A-Za-z0-9_-]+$/.test(v))) throw new Error('버전 형식 오류');
  const dryRun = env.DRY_RUN ?? 'true';
  if (!['true', 'false'].includes(dryRun)) throw new Error('dry_run 형식 오류');
  const shardConfigured = env.SHARDS != null || env.SHARD != null;
  const shard = env.SHARD ?? '0', shards = env.SHARDS ?? '2';
  const options = parseArgs(['--users-list', 'users-list.json', '--manifest', `phys/manifest/${model}.json`, // 모델 버전마다 manifest 가 따로 있다
    '--model-version', model, '--q-version', q, '--time-axis-version', timeAxis,
    ...(shardConfigured ? ['--shard', shard, '--shards', shards] : []),
    '--limit', env.LIMIT || (shardConfigured ? '0' : '50'), dryRun === 'true' ? '--dry-run' : '--write']);
  options.backfillGateMs = Number(env.BACKFILL_GATE_MS ?? '1000');
  if (!Number.isSafeInteger(options.backfillGateMs) || options.backfillGateMs < 0) throw new Error('backfill gate 형식 오류');
  options.concurrency = (deps.cores || os.availableParallelism)();
  const r2 = deps.r2 || conditionalR2Client({ account: env.CLOUDFLARE_ACCOUNT_ID, token: env.CLOUDFLARE_API_TOKEN });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'phys-backfill-run-'));
  options.resume = path.join(dir, 'checkpoint.json');
  try {
    let manifestText;
    if (deps.manifestHash) manifestText = null;
    else {
      const manifest = await r2.read(options.manifestPath);
      if (!manifest) throw new Error(`R2 원천 없음: ${options.manifestPath}`);
      manifestText = typeof manifest === 'string' ? manifest : manifest.body;
    }
    const manifestHash = deps.manifestHash || createHash('sha256').update(manifestText, 'utf8').digest('hex');
    const key = checkpointKey(model, options.shard, options.shards).replace('.json', `-${manifestHash}.json`);
    // R2를 선택하면 artifact 실행 이력 조회 없이 다음 회차에서 바로 복원할 수 있다.
    const previous = await r2.read(key);
    if (previous) await fs.writeFile(options.resume, previous.body, 'utf8');
    const result = await (deps.runBackfill || runBackfill)(options, {
      r2,
      readFile: async key => {
        if (key === options.manifestPath && manifestText !== null) return manifestText;
        const value = await r2.read(key);
        if (!value) throw new Error(`R2 원천 없음: ${key}`);
        return value.body;
      },
      getDump: async id => (await r2.read(`user/${id}.json`))?.body ?? null,
    });
    if (!options.dryRun) {
      const body = await fs.readFile(options.resume, 'utf8');
      await r2.put(key, body, previous?.etag ?? null);
      if ((await r2.read(key))?.body !== body) throw new Error('checkpoint 게시 검증 실패');
    }
    return result;
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { const result = await run(); console.log(JSON.stringify(result)); process.exitCode = result.exitCode || 0; }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}

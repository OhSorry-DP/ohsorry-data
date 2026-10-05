import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, runBackfill, checkpointKey } from './backfill-phys.mjs';
import { conditionalR2Client } from './r2-client.mjs';

export async function run(env = process.env, deps = {}) {
  const model = env.MODEL_VERSION || 'phys-line-v1';
  const q = env.Q_VERSION || 'q-samehand-2s-v1';
  const timeAxis = env.TIME_AXIS_VERSION || 'ta-20261004';
  if (![model, q, timeAxis].every(v => /^[A-Za-z0-9_-]+$/.test(v))) throw new Error('버전 형식 오류');
  const dryRun = env.DRY_RUN ?? 'true';
  if (!['true', 'false'].includes(dryRun)) throw new Error('dry_run 형식 오류');
  const options = parseArgs(['--users-list', 'users-list.json', '--manifest', `phys/manifest/${model}.json`, // 모델 버전마다 manifest 가 따로 있다
    '--model-version', model, '--q-version', q, '--time-axis-version', timeAxis,
    ...(env.SHARDS != null || env.SHARD != null ? ['--shard', env.SHARD ?? '0', '--shards', env.SHARDS ?? '1'] : []),
    '--limit', env.LIMIT || (env.SHARDS != null ? '0' : '50'), dryRun === 'true' ? '--dry-run' : '--write']);
  options.concurrency = (deps.cores || os.availableParallelism)();
  const r2 = deps.r2 || conditionalR2Client({ account: env.CLOUDFLARE_ACCOUNT_ID, token: env.CLOUDFLARE_API_TOKEN });
  const key = checkpointKey(model, options.shard, options.shards);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'phys-backfill-run-'));
  options.resume = path.join(dir, 'checkpoint.json');
  try {
    // R2를 선택하면 artifact 실행 이력 조회 없이 다음 회차에서 바로 복원할 수 있다.
    const previous = await r2.read(key);
    if (previous) await fs.writeFile(options.resume, previous.body, 'utf8');
    const result = await (deps.runBackfill || runBackfill)(options, {
      r2,
      readFile: async key => {
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

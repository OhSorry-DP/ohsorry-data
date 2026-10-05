import assert from 'node:assert/strict';
import test from 'node:test';
import { checkpointKey, extractUserIds, parseArgs, runBackfill, shardUserIds } from '../backfill-phys.mjs';
import { run } from '../backfill-phys-run.mjs';

test('shard 합집합은 전체 ID이며 중복이 없고 입력 순서·중복에 영향받지 않는다', () => {
  const list = Array.from({ length: 494 }, (_, i) => ({ iidx_id: `U${i}` }));
  const ids = extractUserIds([...list.reverse(), list[0]]);
  const parts = Array.from({ length: 8 }, (_, shard) => shardUserIds(ids, shard, 8));
  const union = parts.flat();
  assert.equal(union.length, ids.length);
  assert.equal(new Set(union).size, ids.length);
  assert.deepEqual(union.sort(), ids);
  assert.ok(parts.every(part => part.length >= 61 && part.length <= 62));
  assert.equal(checkpointKey('m'), 'phys/backfill/checkpoint-m.json');
  assert.equal(new Set(parts.map((_, shard) => checkpointKey('m', shard, 8))).size, 8);
  assert.equal(checkpointKey('m', 3, 8), 'phys/backfill/checkpoint-m-s3of8.json');
});

test('shard 전체 회차는 50명 상한을 넘어 완료하며 only는 분할 뒤 적용된다', async () => {
  const options = parseArgs(['--users-list', 'u', '--manifest', 'm', '--shard', '0', '--shards', '2', '--limit', '0',
    '--model-version', 'm', '--q-version', 'q', '--time-axis-version', 't']);
  const list = Array.from({ length: 130 }, (_, i) => ({ iidx_id: `U${i}` })), seen = [];
  const deps = {
    readFile: async key => JSON.stringify(key === 'u' ? list : { publishable: true }),
    getDump: async () => ({ dp: [] }), loadAssets: async () => ({ status: 'ready' }),
    produce: async ({ id }) => { seen.push(id); return { status: 'planned' }; },
  };
  const result = await runBackfill(options, deps);
  assert.equal(result.ready, 65); assert.equal(result.next_cursor, 0);
  assert.deepEqual(seen, shardUserIds(extractUserIds(list), 0, 2));
  seen.length = 0;
  await runBackfill({ ...options, only: extractUserIds(list).slice(0, 2) }, deps);
  assert.deepEqual(seen, [extractUserIds(list)[0]]);
  assert.throws(() => parseArgs(['--users-list', 'u', '--manifest', 'm', '--limit', '51']), /1\.\.50/);
  for (const [shard, shards] of [[-1, 8], [8, 8], [0, 0], [0, 257]]) assert.throws(() => shardUserIds([], shard, shards), /형식/);
});

test('runner는 shard별 R2 checkpoint를 복원하고 저장한다', async () => {
  for (const shard of [0, 1]) {
    const key = checkpointKey('phys-line-v1', shard, 8), reads = [];
    let stored = null;
    const fs = await import('node:fs/promises');
    await run({ SHARD: String(shard), SHARDS: '8', DRY_RUN: 'false' }, {
      cores: () => 2,
      r2: { read: async k => { reads.push(k); return stored == null ? null : { body: stored }; },
        put: async (k, body) => { assert.equal(k, key); stored = body; } },
      runBackfill: async options => {
        assert.equal(options.limit, 0); assert.equal(options.shard, shard); assert.equal(options.shards, 8);
        await fs.writeFile(options.resume, JSON.stringify({ shard }), 'utf8'); return { ready: 1 };
      },
    });
    assert.deepEqual(reads, [key, key]);
  }
});

test('운영 병렬 경로는 fit pool 없이 순수 실력선 계산과 유저 producer를 실행한다', async () => {
  const fs = await import('node:fs/promises');
  const [backfill, refresh, producer, runner] = await Promise.all([
    fs.readFile(new URL('../backfill-phys.mjs', import.meta.url), 'utf8'),
    fs.readFile(new URL('../refresh-coach-user.mjs', import.meta.url), 'utf8'),
    fs.readFile(new URL('../phys-lib.mjs', import.meta.url), 'utf8'),
    fs.readFile(new URL('../backfill-phys-run.mjs', import.meta.url), 'utf8'),
  ]);
  assert.match(backfill, /import \{ producePhysUser \} from '\.\/phys-lib\.mjs'/);
  assert.match(backfill, /const produce = deps\.produce \|\| producePhysUser/);
  assert.match(backfill, /computePhysLine, assets, loadAssets: \(\) => assetsPromise/);
  assert.match(refresh, /import \{ producePhysUser \} from '\.\/phys-lib\.mjs'/);
  assert.match(refresh, /producePhysUser \}\s+from '\.\/phys-lib\.mjs'/);
  assert.match(refresh, /\(deps\.producePhysUser \|\| producePhysUser\)\(/);
  assert.match(producer, /require\('\.\/vendor\/physLine\.js'\)\.computePhysLine/);
  assert.doesNotMatch(`${backfill}\n${refresh}\n${runner}`, /createFitPool|phys-fit-pool|physTheta\.js/);
  assert.match(runner, /runBackfill\)\(options/);
});

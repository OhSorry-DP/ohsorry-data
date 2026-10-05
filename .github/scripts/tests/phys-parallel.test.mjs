import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createFitPool } from '../phys-fit-pool.mjs';
import { checkpointKey, extractUserIds, parseArgs, runBackfill, shardUserIds } from '../backfill-phys.mjs';
import { run } from '../backfill-phys-run.mjs';

const require = createRequire(import.meta.url);
const { AXES, fitUser } = require('../vendor/physTheta.js');

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
    const key = checkpointKey('phys-clear-v1', shard, 8), reads = [];
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

test('재사용 워커 풀의 fit 결과는 직렬 결과와 동일하다', async () => {
  const model = { schema_version: 'phys-model/1', purpose: 'clear', variant: 'baseline-2s', covariates: 'physical',
    content_hash: 'a'.repeat(64), model_version: 'm', q_version: 'q', time_axis_version: 't',
    b: { b0: 0, b1: 0, b2: 0, b3: 0 }, kappa: [-3, -2, -1, 0, 1, 2],
    covariateStats: { notes: { mean: 0, sd: 1 }, duration: { mean: 0, sd: 1 } },
    pool: Object.fromEntries(AXES.map(axis => [axis, 2])) };
  const inputs = Array.from({ length: 4 }, (_, i) => ({ model, userId: `U${i}`, source_revision: 'b'.repeat(64),
    generated_at: '2026-10-05T00:00:00.000Z', rows: Array.from({ length: 3 }, (_, j) => ({
      userId: `U${i}`, songId: `S${j}`, chartKey: `S${j}|ANOTHER`, lampNum: 3 + j,
      notes: 100, duration: 10, features: { STAIR_UP: { maxQ: 1 + j } },
    })) }));
  const serial = [];
  for (const input of inputs) serial.push(await fitUser(input, { concurrency: 1 }));
  const pool = createFitPool(model, 2);
  try {
    assert.deepEqual(await Promise.all(inputs.map(input => pool.fitUser(input))), serial);
    await assert.rejects(pool.fitUser({ ...inputs[0], userId: null }), /유저 입력 오류/);
    assert.deepEqual(await pool.fitUser(inputs[0]), serial[0]);
  }
  finally { await pool.close(); }
  await assert.rejects(pool.fitUser(inputs[0]), /종료/);
});

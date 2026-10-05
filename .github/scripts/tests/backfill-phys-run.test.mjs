import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { run } from '../backfill-phys-run.mjs';
import { runBackfill } from '../backfill-phys.mjs';

test('기본 dry-run은 REST 원천과 코어 수를 주입하고 checkpoint를 쓰지 않음', async () => {
  const reads = [];
  const result = await run({}, { cores: () => 3, r2: {
    read: async key => { reads.push(key); return key.includes('checkpoint-') ? null : { body: '{}' }; },
    put: async () => { throw new Error('dry PUT'); },
  }, runBackfill: async (options, deps) => {
    assert.equal(options.dryRun, true); assert.equal(options.limit, 50); assert.equal(options.concurrency, 3);
    await deps.readFile(options.usersList); await deps.readFile(options.manifestPath); await deps.getDump('A');
    return { ready: 1 };
  } });
  assert.equal(result.ready, 1);
  assert.deepEqual(reads, ['phys/backfill/checkpoint-phys-line-v1.json', 'users-list.json', 'phys/manifest/phys-line-v1.json', 'user/A.json']);
  let active = 0, peak = 0;
  const parallel = await runBackfill({ usersList: 'users', manifestPath: 'manifest', limit: 50, dryRun: true,
    versions: { model_version: 'm', q_version: 'q', time_axis_version: 't' }, concurrency: 3 }, {
    readFile: async key => JSON.stringify(key === 'users' ? ['A', 'B', 'C', 'D'].map(iidx_id => ({ iidx_id })) : { publishable: true }),
    getDump: async () => ({ dp: [] }),
    loadAssets: async () => ({ status: 'ready' }), // 회차당 1회 자산 로드(묶음) — 이 테스트는 병렬도만 본다
    produce: async () => {
      active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 2)); active--;
      return { status: 'planned' };
    },
  });
  assert.equal(peak, 3); assert.equal(parallel.ready, 4);
});

test('쓰기 회차는 checkpoint를 복원하고 조건부 저장 및 본문 검증', async () => {
  let body = '{"cursor":1}', puts = 0;
  const r2 = { read: async () => ({ body, etag: '"old"' }), put: async (key, value, etag) => {
    assert.equal(key, 'phys/backfill/checkpoint-phys-line-v1.json'); assert.equal(etag, '"old"'); body = value; puts++;
  } };
  await run({ DRY_RUN: 'false' }, { r2, cores: () => 2, runBackfill: async options => {
    assert.equal(await fs.readFile(options.resume, 'utf8'), body);
    await fs.writeFile(options.resume, '{"cursor":2}', 'utf8'); return { failed: 1, exitCode: 1 };
  } });
  assert.equal(puts, 1); assert.equal(body, '{"cursor":2}');
});

test('잘못된 입력은 R2 접근 전에 거부', async () => {
  for (const env of [{ MODEL_VERSION: '../bad' }, { LIMIT: '51' }, { DRY_RUN: 'yes' }]) {
    await assert.rejects(run(env, { r2: { read: () => { throw new Error('unexpected'); } } }), /형식|1\.\.50/);
  }
});

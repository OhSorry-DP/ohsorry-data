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
  assert.deepEqual(reads, ['phys/manifest/phys-line-v1.json', 'phys/backfill/checkpoint-phys-line-v1-44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a.json', 'users-list.json', 'user/A.json']);
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
  const manifest = '{}';
  const manifestHash = (await import('node:crypto')).createHash('sha256').update(manifest).digest('hex');
  const r2 = { read: async key => key === 'phys/manifest/phys-line-v1.json' ? { body: manifest } : { body, etag: '"old"' }, put: async (key, value, etag) => {
    assert.equal(key, `phys/backfill/checkpoint-phys-line-v1-${manifestHash}.json`); assert.equal(etag, '"old"'); body = value; puts++;
  } };
  await run({ DRY_RUN: 'false' }, { r2, cores: () => 2, runBackfill: async options => {
      assert.equal(await fs.readFile(options.resume, 'utf8'), body);
    await fs.writeFile(options.resume, '{"cursor":2}', 'utf8'); return { failed: 1, exitCode: 1 };
  } });
  assert.equal(puts, 1); assert.equal(body, '{"cursor":2}');
});

test('잘못된 입력은 R2 접근 전에 거부', async () => {
  for (const env of [{ MODEL_VERSION: '../bad' }, { LIMIT: '51' }, { DRY_RUN: 'yes' }]) {
    await assert.rejects(run(env, { r2: { read: () => { throw new Error('unexpected'); } } }), /형식|지원하지 않음|1\.\.50/);
  }
});

test('버전 계약, gate, shard checkpoint hash와 dry-run mock을 연결', async () => {
  const manifest = JSON.stringify({ publishable: true, model: { content_hash: 'm' }, charts: [] });
  const hash = (await import('node:crypto')).createHash('sha256').update(manifest).digest('hex');
  const puts = [], reads = [];
  const r2 = {
    read: async key => { reads.push(key); return key === 'phys/manifest/phys-line-v2.json' ? { body: manifest } : null; },
    put: async (...args) => puts.push(args),
  };
  let captured;
  await run({ MODEL_VERSION: 'phys-line-v2', Q_VERSION: 'wrong', TIME_AXIS_VERSION: 'wrong', SHARDS: '2' }, {
    r2, cores: () => 1,
    runBackfill: async (options, deps) => {
      captured = options;
      assert.equal(options.modelVersion, undefined);
      assert.equal(options.versions.model_version, 'phys-line-v2');
      assert.equal(options.versions.line_version, 'phys-line-v2');
      assert.equal(options.versions.mean_version, 'mean-os-pattern-span-v2');
      assert.equal(options.versions.q_version, 'q-samehand-2s-v1');
      assert.equal(options.versions.time_axis_version, 'ta-20261004');
      assert.equal(options.manifestPath, 'phys/manifest/phys-line-v2.json');
      assert.equal(options.backfillGateMs, 1000);
      assert.equal(options.shards, 2);
      assert.equal(options.manifestPath, 'phys/manifest/phys-line-v2.json');
      assert.match(options.resume, /checkpoint\.json$/);
      assert.equal(await deps.readFile(options.manifestPath), manifest);
      return {};
    },
  });
  assert.ok(reads.includes(`phys/backfill/checkpoint-phys-line-v2-s0of2-${hash}.json`));
  assert.equal(puts.length, 0);
  assert.equal(captured.dryRun, true);

  await run({ MODEL_VERSION: 'phys-line-v1', Q_VERSION: 'q-v1-custom', TIME_AXIS_VERSION: 'ta-v1-custom', SHARDS: '2' }, {
    manifestHash: 'a'.repeat(64), r2: { read: async () => null, put: async () => assert.fail('dry PUT') },
    runBackfill: async options => {
      assert.equal(options.versions.model_version, 'phys-line-v1');
      assert.equal(options.versions.q_version, 'q-v1-custom');
      assert.equal(options.versions.time_axis_version, 'ta-v1-custom');
      return {};
    },
  });
});

test('resume의 manifest hash mismatch는 runner가 checkpoint를 분리한다', async () => {
  const manifest = '{"publishable":true}';
  const hash = (await import('node:crypto')).createHash('sha256').update(manifest).digest('hex');
  const reads = [];
  await run({ MODEL_VERSION: 'phys-line-v2', SHARD: '1', SHARDS: '2' }, {
    r2: { read: async key => { reads.push(key); return key === 'phys/manifest/phys-line-v2.json' ? { body: manifest } : null; }, put: async () => assert.fail('dry PUT') },
    runBackfill: async (options, deps) => {
      assert.match(reads[1], new RegExp(`checkpoint-phys-line-v2-s1of2-${hash}\\.json$`));
      assert.equal(await fs.readFile(options.resume, 'utf8').catch(() => null), null);
      await deps.readFile(options.manifestPath);
      return {};
    },
  });
});

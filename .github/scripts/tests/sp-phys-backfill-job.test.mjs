import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { run } from '../backfill-phys-run.mjs';

// SP 백필은 기존 러너·워크플로를 그대로 쓰고 model_version 입력만 phys-line-sp-v1 로 준다.
test('sp-phys-backfill-job/1 — runner accepts phys-line-sp-v1 with fixed tuple, SP manifest and model checkpoint', async () => {
  const manifest = JSON.stringify({ publishable: true, model: { content_hash: 'm' }, charts: [] });
  const hash = createHash('sha256').update(manifest).digest('hex');
  const reads = [];
  const r2 = { read: async key => { reads.push(key); return key === 'phys/manifest/phys-line-sp-v1.json' ? { body: manifest } : null; }, put: async () => {} };
  let captured;
  await run({ MODEL_VERSION: 'phys-line-sp-v1', Q_VERSION: 'wrong', TIME_AXIS_VERSION: 'wrong', SHARDS: '2' }, {
    r2, cores: () => 1,
    runBackfill: async (options) => { captured = options; return {}; },
  });
  assert.equal(captured.versions.model_version, 'phys-line-sp-v1');
  assert.equal(captured.versions.mean_version, 'mean-os-pattern-span-sp-v1');
  assert.equal(captured.versions.q_version, 'q-samehand-2s-v1');
  assert.equal(captured.versions.time_axis_version, 'ta-20261004');
  assert.equal(captured.manifestPath, 'phys/manifest/phys-line-sp-v1.json');
  assert.ok(reads.includes(`phys/backfill/checkpoint-phys-line-sp-v1-s0of2-${hash}.json`));
});

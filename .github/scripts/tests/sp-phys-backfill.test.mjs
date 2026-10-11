import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { checkpointKey, parseArgs, runBackfill } from '../backfill-phys.mjs';

const V = { model_version: 'phys-line-sp-v1', line_version: 'phys-line-sp-v1', mean_version: 'mean-os-pattern-span-sp-v1', q_version: 'q-samehand-2s-v1', time_axis_version: 'ta-20261004' };
const manifest = JSON.stringify({ publishable: true, model: { content_hash: 'm' }, charts: [] });
const hash = createHash('sha256').update(manifest, 'utf8').digest('hex');
const opts = (overrides = {}) => ({ usersList: 'users', manifestPath: 'manifest', versions: V, limit: 50, dryRun: true, only: null, resume: null, ...overrides });
const fixture = async (deps = {}) => ({ readFile: async f => f === 'users' ? '[{"iidx_id":"A"}]' : manifest, getDump: async () => ({ sp: [] }), loadAssets: async () => ({ status: 'ready' }), ...deps });

test('sp-phys-backfill/1 prefix=probe/produceSP', async () => {
  const parsed = parseArgs(['--users-list','u','--manifest','m','--model-version','phys-line-sp-v1','--q-version','ignored','--time-axis-version','ignored']);
  assert.deepEqual(parsed.versions, V);
  assert.equal(checkpointKey(V.model_version), 'phys/backfill/checkpoint-phys-line-sp-v1.json');
  const seen = [];
  await runBackfill(opts(), await fixture({ io: { read: async key => { seen.push(key); return null; } }, produce: async a => { assert.equal(a.playStyle, 'SP'); return { status: 'planned' }; } }));
  assert.ok(seen.includes('phys/user-sp/A.json'));
});

test('sp-phys-backfill/2 checkpoint=DP와다름', () => {
  assert.notEqual(checkpointKey('phys-line-sp-v1'), checkpointKey('phys-line-v1'));
});

test('sp-phys-backfill/3 resume=일치성공', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-phys-'));
  const file = path.join(dir, 'checkpoint.json');
  await fs.writeFile(file, JSON.stringify({ schema: 'phys-backfill-checkpoint/2', versions: V, manifest_hash: hash,
    content_hash: createHash('sha256').update(JSON.stringify({ model: { content_hash: 'm' }, charts: [], bundle: null })).digest('hex'), cursor: 1, success: {}, failures: {} }), 'utf8');
  const r = await runBackfill(opts({ resume: file, dryRun: false }), await fixture());
  assert.equal(r.attempted, 0);
  await fs.rm(dir, { recursive: true, force: true });
});

test('sp-phys-backfill/4 mismatch=거부', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-phys-'));
  const file = path.join(dir, 'checkpoint.json');
  await fs.writeFile(file, JSON.stringify({ schema: 'wrong', versions: { ...V, model_version: 'phys-line-v1' }, manifest_hash: 'x', content_hash: 'x', cursor: 1, success: {}, failures: {} }), 'utf8');
  let called = 0;
  const r = await runBackfill(opts({ resume: file, dryRun: false }), await fixture({ produce: async () => { called++; return { status: 'planned' }; } }));
  assert.equal(called, 1); assert.equal(r.attempted, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test('sp-phys-backfill/5 CAS=기존재시도상한', async () => {
  assert.equal((await fs.readFile(new URL('../backfill-phys.mjs', import.meta.url), 'utf8')).includes('const RETRY_LIMIT = 10'), true);
  const r = await runBackfill(opts(), await fixture({ produce: async () => ({ status: 'planned' }) }));
  assert.equal(r.ready, 1);
});

test('sp-phys-backfill/6 dp-cli=기존동일', () => {
  assert.deepEqual(parseArgs(['--users-list','u','--manifest','m','--model-version','phys-line-v2']).versions,
    { model_version: 'phys-line-v2', line_version: 'phys-line-v2', mean_version: 'mean-os-pattern-span-v2', q_version: null, time_axis_version: null });
});

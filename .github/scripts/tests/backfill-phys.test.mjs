import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { extractUserIds, parseArgs, runBackfill } from '../backfill-phys.mjs';

const versions = { model_version: 'm1', q_version: 'q1', time_axis_version: 't1' };
const options = (overrides = {}) => ({ usersList: 'users.json', manifestPath: 'manifest.json', versions, limit: 50, dryRun: true, only: null, resume: null, ...overrides });
const fixture = async ids => ({ readFile: async file => file === 'users.json' ? JSON.stringify(ids.map(iidx_id => ({ iidx_id }))) : JSON.stringify({ publishable: true }),
  getDump: async id => JSON.stringify({ id, dp: [{ song_id: 1 }] }), loadAssets: async () => ({ status: 'ready' }), fitUser: async () => ({ status: 'ready' }) });

test('limit/only 및 users-list 중복 ID 필터', async () => {
  assert.deepEqual(extractUserIds([{ iidx_id: 'B' }, { iidx_id: 'A' }, { iidx_id: 'A' }]), ['A', 'B']);
  const f = await fixture(['A', 'B', 'C', 'B']), seen = [];
  const result = await runBackfill(options({ only: ['B', 'C'], limit: 1 }), { ...f, produce: async ({ id }) => { seen.push(id); return { status: 'planned' }; } });
  assert.deepEqual(seen, ['B']); assert.equal(result.attempted, 1);
});

test('기본 dry-run 및 버전 null은 PUT 없이 skipped', async () => {
  assert.equal(parseArgs(['--users-list', 'u', '--manifest', 'm']).dryRun, true);
  let puts = 0;
  const f = await fixture(['A']);
  const result = await runBackfill(options({ versions: { ...versions, q_version: null }, dryRun: false }), { ...f, r2: { async read() { return null; }, async put() { puts++; } } });
  assert.equal(result.skipped, 1); assert.equal(puts, 0);
});

test('resume 동일 hash에서 이미 성공한 remote revision은 no-op', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'phys-backfill-'));
  const checkpoint = path.join(dir, 'checkpoint.json');
  const f = await fixture(['A']);
  const dumpText = await f.getDump('A');
  const sourceRevision = (await import('node:crypto')).createHash('sha256').update(dumpText, 'utf8').digest('hex');
  const remoteRevision = 'producer-derived-revision';
  await fs.writeFile(checkpoint, JSON.stringify({ schema: 'phys-backfill-checkpoint/1', versions, manifest_hash: 'unused', cursor: 0,
    success: { A: { source_revision: sourceRevision } }, failures: {} }));
  // Pin the manifest hash through a first dry run, then store a matching checkpoint.
  const first = await runBackfill(options({ dryRun: false, resume: checkpoint }), { ...f,
    produce: async () => ({ status: 'ready', changed: false, source_revision: remoteRevision }) });
  const saved = JSON.parse(await fs.readFile(checkpoint, 'utf8'));
  assert.equal(first.attempted, 1);
  assert.deepEqual(saved.success.A, { source_revision: sourceRevision, remote_revision: remoteRevision });
  const result = await runBackfill(options({ dryRun: false, resume: checkpoint }), { ...f, readRemoteRevision: async () => remoteRevision,
    produce: async () => { throw new Error('unexpected'); } });
  assert.equal(result.ready, 1); assert.equal(result.failed, 0);
  await fs.rm(dir, { recursive: true, force: true });
});

test('source revision 변경은 checkpoint 성공이 있어도 재계산', async () => {
  const f = await fixture(['A']); let calls = 0;
  const result = await runBackfill(options({ dryRun: false }), { ...f, readRemoteRevision: async () => 'old',
    produce: async () => { calls++; return { status: 'ready', changed: false, source_revision: 'new' }; } });
  assert.equal(calls, 1); assert.equal(result.ready, 1);
});

test('실패 재시도 큐가 limit=1 일반 순회를 독점하지 않음', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'phys-backfill-'));
  const checkpoint = path.join(dir, 'checkpoint.json'), f = await fixture(['A', 'B']);
  const initial = await runBackfill(options(), f);
  await fs.writeFile(checkpoint, JSON.stringify({ schema: 'phys-backfill-checkpoint/1', versions, manifest_hash: initial.manifest_hash,
    cursor: 0, success: {}, failures: { A: { attempts: 1, reason: 'old' } } }));
  const seen = [];
  await runBackfill(options({ limit: 1, resume: checkpoint, dryRun: false }), { ...f,
    produce: async ({ id }) => { seen.push(id); return { status: 'planned' }; } });
  assert.deepEqual(seen, ['A']);
  const next = await runBackfill(options({ limit: 1, resume: checkpoint, dryRun: false }), { ...f,
    produce: async ({ id }) => { seen.push(id); return { status: 'planned' }; } });
  assert.deepEqual(seen, ['A', 'B']); assert.equal(next.next_cursor, 0);
  await fs.rm(dir, { recursive: true, force: true });
});

test('중단 전 atomic checkpoint와 tuple 변경 epoch 초기화', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'phys-backfill-'));
  const checkpoint = path.join(dir, 'checkpoint.json'), f = await fixture(['A']);
  const first = await runBackfill(options({ dryRun: false, resume: checkpoint }), { ...f, produce: async () => ({ status: 'planned' }) });
  const saved = JSON.parse(await fs.readFile(checkpoint, 'utf8'));
  assert.equal(saved.schema, 'phys-backfill-checkpoint/1'); assert.equal(saved.manifest_hash, first.manifest_hash);
  await runBackfill(options({ dryRun: false, resume: checkpoint, versions: { ...versions, model_version: 'm2' } }), { ...f, produce: async () => ({ status: 'planned' }) });
  assert.equal(JSON.parse(await fs.readFile(checkpoint, 'utf8')).versions.model_version, 'm2');
  await fs.rm(dir, { recursive: true, force: true });
});

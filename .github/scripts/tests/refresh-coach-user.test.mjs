import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { parseArgs, runRefresh } from '../refresh-coach-user.mjs';
import { runBackfill } from '../backfill-phys.mjs';

const ID = 'USER1';
const V = '2026-10-05T00:00:00.000Z';
function fixture({ versions = false, physFail = false, race = 0, stale = false, missing = false } = {}) {
  const dump = { user: { iidx_id: ID }, dp: [], _v: stale ? '2026-10-04T00:00:00.000Z' : V };
  const body = JSON.stringify(dump), calls = [], objects = new Map();
  const io = {
    async read(key) {
      calls.push(['GET', key]);
      if (key === `user/${ID}.json`) {
        if (missing) return null;
      if (race > 0 && state.raceLeft-- > 0) {
          const next = { ...dump, _v: '2026-10-05T00:00:01.000Z' };
          state.body = JSON.stringify(next);
        }
        return { body: state.body || body, etag: 'source-etag' };
      }
      return objects.get(key) || null;
    },
    async getText(key) {
      calls.push(['GETTEXT', key]);
      if (key === 'phys-manifest.json') return JSON.stringify({ publishable: true });
      if (key === 'songs.json') return JSON.stringify({});
      if (key.startsWith('phys/')) return '{}';
      throw new Error(`unexpected fixture key ${key}`);
    },
    async put(key, value, etag) {
      calls.push(['PUT', key, etag]);
      if (etag !== null && objects.get(key)?.etag !== etag) throw Object.assign(new Error('HTTP 412'), { status: 412 });
      if (etag === null && objects.has(key)) throw Object.assign(new Error('HTTP 412'), { status: 412 });
      objects.set(key, { body: value, etag: `etag-${calls.length}` });
    },
  };
  const state = { raceLeft: race, body: null };
  const env = versions ? { PHYS_MODEL_VERSION: 'm1', PHYS_Q_VERSION: 'q1', PHYS_TIME_AXIS_VERSION: 't1', PHYS_ASSETS_MANIFEST_KEY: 'phys-manifest.json' } : {};
  const deps = { io, env,
    loadPhysAssets: async () => { if (physFail) throw new Error('line fixture failure'); return { status: 'ready', model: { content_hash: 'model' }, charts: new Map() }; } };
  return { deps, io, calls, objects, state };
}

test('physical refresh uses only allowed keys and conditional etags', async () => {
  const f = fixture({ versions: true });
  const result = await runRefresh({ id: ID, expectedV: V }, f.deps);
  assert.equal(result.phys.status, 'ready', JSON.stringify(result));
  assert.ok(f.calls.findIndex(call => call[0] === 'PUT' && call[1] === `phys/user/${ID}.json`) >= 0);
  assert.deepEqual(f.calls.filter(call => call[0] === 'PUT').map(call => call[1]), [`phys/user/${ID}.json`]);
  assert.equal(f.calls.find(call => call[0] === 'PUT')[2], null);
  assert.ok(f.calls.findIndex(call => call[1] === 'phys-manifest.json') < f.calls.findIndex(call => call[0] === 'PUT'));
});

test('unset physical tuple skips computation', async () => {
  const f = fixture();
  const result = await runRefresh({ id: ID, expectedV: V }, f.deps);
  assert.equal(result.phys.status, 'skipped');
  assert.equal(f.calls.some(call => call[1]?.startsWith('phys/')), false);
});

test('v2 refresh sends the configured line tuple through the same producer input as backfill', async () => {
  const f = fixture({ versions: true });
  f.deps.env = { PHYS_MODEL_VERSION: 'phys-line-v2', PHYS_Q_VERSION: 'q-samehand-2s-v1',
    PHYS_TIME_AXIS_VERSION: 'ta-20261004', PHYS_ASSETS_MANIFEST_KEY: 'phys-manifest.json' };
  f.io.getText = async key => {
    f.calls.push(['GETTEXT', key]);
    if (key === 'phys-manifest.json') return JSON.stringify({ publishable: true });
    if (key === 'songs.json') return JSON.stringify({});
    if (key.startsWith('phys/')) return '{}';
    throw new Error(`unexpected fixture key ${key}`);
  };
  const refreshInputs = [];
  f.deps.producePhysUser = async input => {
    refreshInputs.push({ dump: input.dump, versions: input.versions });
    return { status: 'ready', changed: false, source_revision: 'same' };
  };
  await runRefresh({ id: ID, expectedV: V }, f.deps);

  const backfillInputs = [];
  const result = await runBackfill({ usersList: 'users.json', manifestPath: 'manifest.json', limit: 1,
    dryRun: true, versions: { model_version: 'phys-line-v2', line_version: 'phys-line-v2',
      mean_version: 'mean-os-pattern-span-v2', q_version: 'q-samehand-2s-v1', time_axis_version: 'ta-20261004' } }, {
    readFile: async file => file === 'users.json' ? JSON.stringify([{ iidx_id: ID }]) : JSON.stringify({ publishable: true }),
    getDump: async () => JSON.stringify({ user: { iidx_id: ID }, dp: [], _v: V }),
    loadAssets: async () => ({ status: 'ready', model: { content_hash: 'model' }, charts: new Map() }),
    produce: async input => { backfillInputs.push({ dump: input.dump, versions: input.versions }); return { status: 'planned' }; },
  });

  assert.equal(result.ready, 1);
  assert.equal(refreshInputs.length, 1);
  assert.deepEqual(refreshInputs[0].versions, backfillInputs[0].versions);
  assert.deepEqual({ ...refreshInputs[0].dump, songMap: undefined }, { ...backfillInputs[0].dump, songMap: undefined });
});

test('physical failure preserves its summary', async () => {
  const f = fixture({ versions: true, physFail: true });
  const result = await runRefresh({ id: ID, expectedV: V }, f.deps);
  assert.equal(result.phys.status, 'missing', JSON.stringify(result));
  assert.equal(result.phys.error_message, 'line fixture failure');
  assert.equal(result.ok, true);
});

test('refresh dry-run은 생산자의 generation_failed 원 예외를 보존한다', async () => {
  const f = fixture({ versions: true, physFail: true });
  const result = await runRefresh({ id: ID, expectedV: V, dryRun: true }, f.deps);
  assert.equal(result.phys.status, 'failed');
  assert.equal(result.phys.reason, 'generation_failed');
  assert.equal(result.phys.error_message, 'line fixture failure');
  assert.equal(f.calls.some(call => call[0] === 'PUT'), false);
});

test('invalid ID, malformed source, missing object and stale _v never write', async () => {
  assert.throws(() => parseArgs(['--id', '../bad', '--expected-v', V]), /invalid/);
  const stale = fixture({ stale: true });
  const staleResult = await runRefresh({ id: ID, expectedV: V }, stale.deps).catch(error => ({ ok: false, failure: error.message }));
  assert.equal(staleResult.ok, false);
  assert.equal(stale.calls.some(call => call[0] === 'PUT'), false);
  const missing = fixture({ missing: true });
  await assert.rejects(() => runRefresh({ id: ID, expectedV: V }, missing.deps), /source_missing/);
  const malformed = fixture();
  malformed.io.read = async key => key === `user/${ID}.json` ? { body: '{', etag: 'e' } : malformed.objects.get(key) || null;
  await assert.rejects(() => runRefresh({ id: ID, expectedV: V }, malformed.deps), /source_invalid_json/);
});

test('source race blocks stale put and retries from latest source, exhausted race fails', async () => {
  const f = fixture({ race: 0 });
  f.deps.env = { PHYS_MODEL_VERSION: 'm', PHYS_Q_VERSION: 'q', PHYS_TIME_AXIS_VERSION: 't', PHYS_ASSETS_MANIFEST_KEY: 'phys-manifest.json' };
  let made = 0;
  f.deps.loadPhysAssets = async () => ({ status: 'ready', model: { content_hash: 'm' }, charts: new Map() });
  f.deps.loadPhysAssets.triggerRace = () => { f.state.body = JSON.stringify({ user: { iidx_id: ID }, dp: [], _v: '2026-10-05T00:00:01.000Z' }); };
  f.deps.producePhysUser = async ({ io }) => { made++; await io.put(`phys/user/${ID}.json`, '{}', null); return { status: 'ready', changed: true, source_revision: 'x' }; };
  const originalRead = f.io.read.bind(f.io); let injected = false;
  f.io.read = async key => {
    if (key === `user/${ID}.json` && made > 0 && !injected) { injected = true; f.state.body = JSON.stringify({ user: { iidx_id: ID }, dp: [], _v: '2026-10-05T00:00:01.000Z' }); }
    return originalRead(key);
  };
  const result = await runRefresh({ id: ID, expectedV: V }, f.deps);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.calls.filter(call => call[0] === 'PUT').length, 1);
  const exhausted = fixture({ race: 2 });
  exhausted.deps.env = { PHYS_MODEL_VERSION: 'm', PHYS_Q_VERSION: 'q', PHYS_TIME_AXIS_VERSION: 't', PHYS_ASSETS_MANIFEST_KEY: 'phys-manifest.json' };
  exhausted.deps.producePhysUser = async ({ io }) => { await io.put(`phys/user/${ID}.json`, '{}', null); return { status: 'ready', changed: true }; };
  exhausted.deps.loadPhysAssets = async () => ({ status: 'ready', model: { content_hash: 'm' }, charts: new Map() });
  const failed = await runRefresh({ id: ID, expectedV: V }, exhausted.deps);
  assert.equal(failed.ok, true, JSON.stringify(failed));
});

test('CLI requires and validates the directly supplied source tuple', () => {
  const hash = 'a'.repeat(64);
  assert.deepEqual(parseArgs(['--id', ID, '--expected-v', V, '--expected-sha256', hash]),
    { dryRun: false, id: ID, expectedV: V, expectedSha256: hash });
  assert.throws(() => parseArgs(['--id', ID, '--expected-v', V, '--expected-sha256', 'bad']), /invalid --expected-sha256/);
});

test('workflow refreshes directly after dump and accepts the chart arrange dispatch with isolated precompute', () => {
  const dumpWorkflow = fs.readFileSync(new URL('../../workflows/dump-user.yml', import.meta.url), 'utf8');
  const manualWorkflow = fs.readFileSync(new URL('../../workflows/refresh-coach-user.yml', import.meta.url), 'utf8');
  const dispatchJob = dumpWorkflow.slice(dumpWorkflow.indexOf('  dispatch-coach-user:'));
  assert.match(dispatchJob, /needs: \[dump, persona\][\s\S]*if: \$\{\{ !cancelled\(\) && needs\.dump\.result == 'success' && needs\.persona\.result != 'cancelled' \}\}/);
  assert.match(dispatchJob, /continue-on-error: true/);
  assert.match(dispatchJob, /refresh-coach-user\.mjs/);
  assert.doesNotMatch(dispatchJob, /repository_dispatch|\/dispatches|GITHUB_TOKEN|contents: write/);
  assert.match(dispatchJob, /PHYS_MODEL_VERSION: \$\{\{ vars\.PHYS_MODEL_VERSION \|\| 'phys-line-v2' \}\}/); // 기본은 v2, 명시한 repo variable 로 v1 override 가능
  assert.match(dispatchJob, /PHYS_Q_VERSION: \$\{\{ vars\.PHYS_Q_VERSION \}\}/);
  assert.match(dispatchJob, /PHYS_TIME_AXIS_VERSION: \$\{\{ vars\.PHYS_TIME_AXIS_VERSION \}\}/);
  assert.match(dispatchJob, /PHYS_ASSETS_MANIFEST_KEY: \$\{\{ vars\.PHYS_ASSETS_MANIFEST_KEY \}\}/);
  assert.match(manualWorkflow, /workflow_dispatch:/);
  assert.match(manualWorkflow, /repository_dispatch:\s+types: \[refresh-coach-user\]/);
  assert.match(manualWorkflow, /IIDX_ID: \$\{\{ inputs\.iidx_id \|\| github\.event\.client_payload\.iidx_id \}\}/);
  for (const workflow of [dispatchJob, manualWorkflow]) {
    assert.ok(workflow.indexOf('refresh-coach-user.mjs') < workflow.indexOf('Precompute coach recommendations'));
    const precompute = workflow.slice(workflow.indexOf('Precompute coach recommendations'));
    assert.equal((precompute.match(/continue-on-error: true/g) || []).length, 1);
    assert.match(precompute, /if: \$\{\{ success\(\) \}\}/);
    assert.match(precompute, /CLOUDFLARE_API_TOKEN/);
    assert.match(precompute, /coach-precompute\.mjs --only/);
    assert.doesNotMatch(workflow, /COACH_WEB_READ_TOKEN|COACH_WEB_REF|coach-web|--web-root/);
    assert.doesNotMatch(workflow, /Verify pinned|immutable 40-character|repository variables are required/);
  }
});

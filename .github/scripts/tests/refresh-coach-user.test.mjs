import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { parseArgs, runRefresh } from '../refresh-coach-user.mjs';
import { buildRelativeRegistry } from '../coach-relative-input.mjs';
import { stableJson, sha256, buildEntries, selectDpRegistry } from '../dump-coach-relative.mjs';

const ID = 'USER1';
const V = '2026-10-05T00:00:00.000Z';
const feature = { _meta: { feats: ['NOTES'] }, scores: {} };
const meta = { songs: {} };
const relativeVersion = (() => {
  const registry = selectDpRegistry(buildRelativeRegistry({ featureMeta: feature._meta }));
  const hashes = { 'data/feature-scores-slim.json': sha256(JSON.stringify(feature)), 'data/textage-meta.json': sha256(JSON.stringify(meta)) };
  const codeHashes = { kernel: sha256(fs.readFileSync(new URL('../vendor/patternScoreKernel.js', import.meta.url))), buildEntries: sha256(buildEntries.toString()),
    mapping: sha256(stableJson({ DP_FEATURE_KEY: { 1: 'DP_NOR', 2: 'DP_HYP', 3: 'DP_ANO', 4: 'DP_LEG' }, DP_NOTES_KEY: { 1: 'DN', 2: 'DH', 3: 'DA', 4: 'DX' } })) };
  return sha256({ assets: hashes, registry, codeHashes });
})();
const manifest = { schema_version: 'coach-relative-manifest/1', rank_version: 'coach-relative/1', feature_version: relativeVersion,
  population_version: 'pop-1', population_key: 'coach/relative/population/pop-1.json' };
const population = { schema_version: 'coach-relative-population/1', rank_version: 'coach-relative/1', feature_version: relativeVersion,
  population_version: 'pop-1', registry: [], membership: [], source_revisions: [], membership_hash: sha256([]),
  source_hash: sha256({ membership: [], source_revisions: [], feature_version: relativeVersion, registry: [] }),
  calculation: { rank_version: 'coach-relative/1', feature_version: relativeVersion, population_version: 'pop-1', registry: [], features: {} } };

function fixture({ versions = false, physFail = false, race = 0, stale = false, missing = false, relativeRace = false } = {}) {
  const dump = { user: { iidx_id: ID }, dp: [], _v: stale ? '2026-10-04T00:00:00.000Z' : V };
  const body = JSON.stringify(dump), calls = [], objects = new Map([
    ['coach/relative/current.json', { body: JSON.stringify(manifest), etag: 'manifest-1' }],
    ['coach/relative/population/pop-1.json', { body: JSON.stringify(population), etag: 'population-1' }],
  ]);
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
      if (key === 'coach/relative/current.json' && relativeRace && calls.filter(call => call[0] === 'GET' && call[1] === key).length === 2) {
        return { body: JSON.stringify({ ...manifest, generated_at: 'raced' }), etag: 'manifest-2' };
      }
      return objects.get(key) || null;
    },
    async getText(key) {
      calls.push(['GETTEXT', key]);
      if (key === 'data/feature-scores-slim.json') return JSON.stringify(feature);
      if (key === 'data/textage-meta.json') return JSON.stringify(meta);
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
  const deps = { io, env, fitUser: async () => ({ status: 'ready', generated_at: V, axes: {} }),
    loadPhysAssets: async () => { if (physFail) throw new Error('theta fixture failure'); return { status: 'ready', model: { content_hash: 'model' }, charts: new Map() }; },
    produceRelativeUser: async args => {
      if (args.assets.featureVersion !== relativeVersion) throw new Error('feature tuple mismatch');
      const manifestRead = await args.io.read('coach/relative/current.json');
      assert.ok(manifestRead);
      if (relativeRace) return { status: 'ready', reason: null, changed: false, attempts: 3, population_version: 'pop-1' };
      return { status: 'ready', reason: null, changed: false, attempts: 1, population_version: 'pop-1' };
    } };
  return { deps, io, calls, objects, state };
}

test('theta then relative uses only allowed keys and conditional etags', async () => {
  const f = fixture({ versions: true });
  const result = await runRefresh({ id: ID, expectedV: V }, f.deps);
  assert.equal(result.phys.status, 'ready', JSON.stringify(result));
  assert.ok(f.calls.findIndex(call => call[0] === 'PUT' && call[1] === `phys/user/${ID}.json`) >= 0);
  assert.deepEqual(f.calls.filter(call => call[0] === 'PUT').map(call => call[1]), [`phys/user/${ID}.json`]);
  assert.equal(f.calls.find(call => call[0] === 'PUT')[2], null);
  assert.ok(f.calls.findIndex(call => call[1] === 'phys-manifest.json') < f.calls.findIndex(call => call[0] === 'PUT'));
});

test('unset theta tuple skips theta and still attempts relative', async () => {
  const f = fixture();
  const result = await runRefresh({ id: ID, expectedV: V }, f.deps);
  assert.equal(result.phys.status, 'skipped');
  assert.equal(f.calls.some(call => call[1]?.startsWith('phys/')), false);
  assert.equal(result.relative.status, 'ready');
});

test('theta failure is summarized independently and relative continues', async () => {
  const f = fixture({ versions: true, physFail: true });
  const result = await runRefresh({ id: ID, expectedV: V }, f.deps);
  assert.equal(result.phys.status, 'missing', JSON.stringify(result));
  assert.ok(['ready', 'missing'].includes(result.relative.status));
  assert.equal(result.ok, true);
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
  f.deps.produceRelativeUser = async () => ({ status: 'ready', changed: false, attempts: 1 });
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
  exhausted.deps.produceRelativeUser = async () => ({ status: 'ready', changed: false });
  exhausted.deps.producePhysUser = async ({ io }) => { await io.put(`phys/user/${ID}.json`, '{}', null); return { status: 'ready', changed: true }; };
  exhausted.deps.loadPhysAssets = async () => ({ status: 'ready', model: { content_hash: 'm' }, charts: new Map() });
  const failed = await runRefresh({ id: ID, expectedV: V }, exhausted.deps);
  assert.equal(failed.ok, true, JSON.stringify(failed));
});

test('relative feature tuple and manifest race policy are retained; dry run avoids writes', async () => {
  const f = fixture({ relativeRace: true });
  const result = await runRefresh({ id: ID, expectedV: V, dryRun: true }, f.deps);
  assert.equal(result.relative.status, 'ready');
  assert.equal(f.calls.some(call => call[0] === 'PUT'), false);
  assert.equal(result.relative.attempts, 3);
  assert.equal(typeof relativeVersion, 'string');
});

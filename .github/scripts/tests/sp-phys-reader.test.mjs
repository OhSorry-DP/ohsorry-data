import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPhysAssets, sha256 } from '../phys-assets.mjs';

const axes = ['NOTES', 'CHORD', 'PEAK', 'CHARGE', 'SCRATCH', 'PHRASE', 'JACK', 'TRILL', 'RAND', 'STAIR_UP', 'STAIR_DN', 'K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7', 'DOUBLE_STAIR'];
const versions = { model_version: 'phys-line-sp-v1', q_version: 'q-samehand-2s-v1', time_axis_version: 'ta-20261004' };
const units = Object.fromEntries(axes.map(axis => [axis, 'notes/s/side']));

function makeFixture({ duration = 1, meanNps = 1, arrange = 'OFF' } = {}) {
  const config = { schema_version: 'phys-line-config/1', ...versions, line_version: 'phys-line-sp-v1', mean_version: 'mean-os-pattern-span-sp-v1', axes, units };
  config.content_hash = sha256(config);
  const model = hashed({ schema_version: 'phys-model/1', purpose: 'clear', variant: 'baseline-2s', covariates: 'physical', ...versions,
    line_config: config, mean: Object.fromEntries(axes.map(axis => [axis, { meanNps: 1 }])) });
  const chartKey = 'song-1|ANOTHER';
  const chart = hashed({ schema_version: 'phys-chart/1', chartKey, ...versions, songId: 'song-1', diff: 'ANOTHER', hand: 1, arrange,
    features: Object.fromEntries(axes.map(axis => [axis, { meanNps, duration, notes: duration < 1 ? 0 : 1 }])) });
  const modelKey = `phys/model/${versions.model_version}.json`;
  const chartAsset = { chartKey, key: `phys/chart/${versions.model_version}/${encodeURIComponent(chartKey)}.json`, content_hash: chart.content_hash, ...versions };
  const files = new Map([[modelKey, raw(model)], [chartAsset.key, raw(chart)]]);
  const modelEntry = { key: modelKey, content_hash: model.content_hash, file_sha256: sha256(files.get(modelKey)) };
  chartAsset.file_sha256 = sha256(files.get(chartAsset.key));
  const manifest = { schema_version: 'phys-assets-manifest/1', publishable: true, ...versions, model: modelEntry, charts: [chartAsset], assets: [chartAsset] };
  return { versions, manifest, files, chartKey, chartAsset };
}

function hashed(value) { return { ...value, content_hash: sha256(value) }; }
function raw(value) { return `${JSON.stringify(value, null, 2)}\n`; }
async function load(f) { return loadPhysAssets({ versions: f.versions, manifest: f.manifest, getText: async key => f.files.get(key) ?? null }); }
function refreshChart(f, chart) {
  const body = { ...chart };
  delete body.content_hash;
  const asset = hashed(body);
  const text = raw(asset);
  f.files.set(f.chartAsset.key, text);
  f.chartAsset.content_hash = asset.content_hash;
  f.chartAsset.file_sha256 = sha256(text);
}

test('sp-phys-reader/1 sp-ready=ready', async () => {
  const f = makeFixture();
  assert.equal((await load(f)).status, 'ready');
});

test('sp-phys-reader/2 wrong-axis-unit=거부', async () => {
  const f = makeFixture();
  const model = JSON.parse(f.files.get(f.manifest.model.key));
  model.line_config.units.NOTES = 'notes/s/hand';
  model.line_config.content_hash = sha256(Object.fromEntries(Object.entries(model.line_config).filter(([key]) => key !== 'content_hash')));
  const modelBody = { ...model }; delete modelBody.content_hash;
  const updated = hashed(modelBody); const text = raw(updated);
  f.files.set(f.manifest.model.key, text); f.manifest.model.content_hash = updated.content_hash; f.manifest.model.file_sha256 = sha256(text);
  await assert.rejects(load(f), /immutable line units mismatch/);
});

test('sp-phys-reader/3 tamper=hash거부', async () => {
  const f = makeFixture();
  f.files.set(f.chartAsset.key, f.files.get(f.chartAsset.key).replace('ANOTHER', 'HYPER'));
  await assert.rejects(load(f), /file_sha256 mismatch/);
});

test('sp-phys-reader/4 short-span=.75null허용/1null거부', async () => {
  const short = makeFixture({ duration: 0.75, meanNps: null });
  assert.equal((await load(short)).status, 'ready');
  const invalid = makeFixture({ duration: 1, meanNps: null });
  await assert.rejects(load(invalid), /features invalid/);
});

test('sp-phys-reader/5 arrange=MIRROR거부', async () => {
  const f = makeFixture({ arrange: 'MIRROR' });
  await assert.rejects(load(f), /arrange invalid/);
});

test('sp-phys-reader/6 dp-fixtures=기존동일', async () => {
  // Importing the established suite runs its DP and v2 fixtures through Node's test runner.
  await import('./phys-assets.test.mjs');
});

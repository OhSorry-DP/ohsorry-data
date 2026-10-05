import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPhysAssets, sha256 } from '../phys-assets.mjs';

const versions = { model_version: 'm 1', q_version: 'q1', time_axis_version: 't1' };

function hashed(value) {
  const content_hash = sha256(value);
  const asset = { ...value, content_hash };
  const raw = JSON.stringify(asset);
  return JSON.parse(raw);
}

function rawAsset(value) {
  const clean = { ...value };
  delete clean.file_sha256;
  delete clean.content_hash;
  const content_hash = sha256(clean);
  const withoutFileHash = { ...clean, content_hash };
  return `${JSON.stringify(withoutFileHash, null, 2)}\n`;
}

function fixture() {
  const chartKey = 'song/a|ANOTHER';
  const model = hashed({ schema_version: 'phys-model/1', purpose: 'clear', variant: 'baseline-2s', covariates: 'physical',
    ...versions, source_revision: 'local', generated_at: '2026-10-05T00:00:00Z', b: { b0: 1, b1: 0, b2: 1, b3: 1 },
    kappa: [1, 2, 3, 4, 5, 6], covariateStats: { notes: { mean: 100, sd: 10 }, duration: { mean: 10, sd: 1 } }, pool: {} });
  const chart = hashed({ schema_version: 'phys-chart/1', chartKey, ...versions, songId: 'song/a', diff: 'ANOTHER', notes: 100,
    duration: 10, features: { STAIR_UP: { maxQ: 2 } }, arrange: 'MIRROR', worstWindows: { STAIR_UP: [{ start: 1 }] } });
  const chartAsset = { chartKey, key: `phys/chart/${versions.model_version}/${encodeURIComponent(chartKey)}.json`,
    content_hash: chart.content_hash, ...versions };
  const manifest = { schema_version: 'phys-assets-manifest/1', publishable: true, ...versions,
    model: { key: `phys/model/${versions.model_version}.json`, content_hash: model.content_hash }, charts: [chartAsset], assets: [chartAsset] };
  const objects = new Map([[manifest.model.key, rawAsset(model)], [chartAsset.key, rawAsset(chart)]]);
  manifest.model.file_sha256 = sha256(objects.get(manifest.model.key));
  chartAsset.file_sha256 = sha256(objects.get(chartAsset.key));
  const calls = [];
  const getText = async (key) => { calls.push(key); if (!objects.has(key)) throw Object.assign(new Error(`HTTP 404 ${key}`), { status: 404 }); return objects.get(key); };
  return { manifest, model, chart, chartKey, chartAsset, objects, calls, getText };
}

test('unset version skips without GET', async () => {
  let calls = 0;
  const result = await loadPhysAssets({ versions: { ...versions, q_version: null }, manifest: { publishable: true }, getText: async () => { calls++; } });
  assert.deepEqual(result, { status: 'skipped', reason: 'versions_unset' });
  assert.equal(calls, 0);
});

test('unpublished assets skip without GET', async () => {
  let calls = 0;
  const result = await loadPhysAssets({ versions, manifest: { publishable: false }, getText: async () => { calls++; } });
  assert.deepEqual(result, { status: 'skipped', reason: 'assets_unpublished' });
  assert.equal(calls, 0);
});

test('loads encoded chart key and validates both hashes', async () => {
  const f = fixture();
  const result = await loadPhysAssets({ versions, manifest: f.manifest, getText: f.getText });
  assert.equal(result.status, 'ready');
  assert.deepEqual(f.calls, [f.manifest.model.key, f.chartAsset.key]);
  assert.equal(result.charts.get(f.chartKey).features.STAIR_UP.maxQ, 2);
  assert.equal(result.charts.get(f.chartKey).notes, 100);
  assert.equal(result.charts.get(f.chartKey).arrange, 'MIRROR');
  assert.deepEqual(result.charts.get(f.chartKey).worstWindows.STAIR_UP, [{ start: 1 }]);
});

test('rejects changed model content hash', async () => {
  const f = fixture();
  const changed = { ...f.model, b: { ...f.model.b, b0: 2 } };
  f.objects.set(f.manifest.model.key, rawAsset(changed));
  f.manifest.model.file_sha256 = sha256(f.objects.get(f.manifest.model.key));
  await assert.rejects(loadPhysAssets({ versions, manifest: f.manifest, getText: f.getText }), /manifest model declaration mismatch/);
});

test('rejects chart tuple, hash, and key mismatches', async () => {
  const f = fixture();
  f.objects.set(f.chartAsset.key, rawAsset({ ...f.chart, q_version: 'wrong' }));
  f.chartAsset.file_sha256 = sha256(f.objects.get(f.chartAsset.key));
  await assert.rejects(loadPhysAssets({ versions, manifest: f.manifest, getText: f.getText }), /chart declaration mismatch/);
  const g = fixture();
  g.manifest.charts[0] = { ...g.manifest.charts[0], key: 'other/location.json' };
  g.manifest.assets[0] = { ...g.manifest.assets[0], key: 'other/location.json' };
  await assert.rejects(loadPhysAssets({ versions, manifest: g.manifest, getText: g.getText }), /chart key mismatch/);
  const h = fixture();
  h.manifest.assets[0] = { ...h.manifest.assets[0], q_version: 'wrong' };
  await assert.rejects(loadPhysAssets({ versions, manifest: h.manifest, getText: h.getText }), /manifest chart declaration mismatch/);
});

test('preserves not found and authentication failures as distinct errors', async () => {
  const f = fixture();
  await assert.rejects(loadPhysAssets({ versions, manifest: f.manifest, getText: async () => null }), /not found/);
  await assert.rejects(loadPhysAssets({ versions, manifest: f.manifest, getText: async () => { throw new Error('HTTP 401 unauthorized'); } }), /HTTP 401/);
});

test('매니페스트 파일 해시는 원문 공백까지 검증하고 중첩 버전 tuple을 검사한다', async () => {
  const f = fixture();
  f.manifest.versions = versions;
  delete f.manifest.q_version;
  delete f.manifest.time_axis_version;
  f.chartAsset.version_tuple = versions;
  assert.equal((await loadPhysAssets({ versions, manifest: f.manifest, getText: f.getText })).status, 'ready');
  f.objects.set(f.chartAsset.key, f.objects.get(f.chartAsset.key) + ' ');
  await assert.rejects(loadPhysAssets({ versions, manifest: f.manifest, getText: f.getText }), /file_sha256 mismatch/);
  f.chartAsset.version_tuple = { ...versions, q_version: 'wrong' };
  await assert.rejects(loadPhysAssets({ versions, manifest: f.manifest, getText: f.getText }), /chart q_version mismatch/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPhysAssets, sha256 } from '../phys-assets.mjs';

const versions = { model_version: 'phys-line-v1', q_version: 'q1', time_axis_version: 't1' };
const axes = ['STAIR_UP', 'STAIR_DN', 'DOUBLE_STAIR', 'KEIMA', 'SPIRAL_UP', 'SPIRAL_DN', 'JUMP_WIDE', 'HSTAIR_SYM', 'HSTAIR_ASYM', 'CN'];
const axesV2 = ['NOTES', 'CHORD', 'PEAK', 'CHARGE', 'SCRATCH', 'PHRASE', 'JACK', 'TRILL', 'RAND', 'STAIR_UP_L', 'STAIR_UP_R', 'STAIR_DN_L', 'STAIR_DN_R', 'K1_L', 'K1_R', 'K2_L', 'K2_R', 'K3_L', 'K3_R', 'K4_L', 'K4_R', 'K5_L', 'K5_R', 'K6_L', 'K6_R', 'K7_L', 'K7_R', 'DOUBLE_STAIR_L', 'DOUBLE_STAIR_R', 'KEIMA_L', 'KEIMA_R', 'HSTAIR_ONEHAND', 'HSTAIR_SYNC', 'HSTAIR_SAMESHAPE', 'HSTAIR_DIFFSHAPE'];
test('불변 게시본 원문을 묶음과 개별 파일에서 그대로 검증한다', async (t) => {
  const root = new URL('../../../../ohSorryRating/experiments/phys-proto/out/phys-assets/phys-line-v1/', import.meta.url);
  let raw;
  try { raw = await fs.readFile(new URL('manifest.json', root), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return t.skip('로컬 게시본 없음'); throw error; }
  const manifest = JSON.parse(raw);
  const files = new Map([manifest.model, ...manifest.assets, manifest.bundle].filter(Boolean).map(entry => [entry.key, entry.path]));
  const getText = key => fs.readFile(path.join(fileURLToPath(root), files.get(key)), 'utf8');
  const bundled = await loadPhysAssets({ versions: manifest.versions, manifest, getText });
  const { bundle, ...individualManifest } = manifest;
  const individual = await loadPhysAssets({ versions: manifest.versions, manifest: individualManifest, getText });
  assert.equal(bundled.status, 'ready');
  assert.equal(bundled.model.schema_version, 'phys-line-config/1');
  assert.equal(bundled.charts.size, manifest.assets.length);
  assert.deepEqual(individual.model, bundled.model);
  assert.deepEqual(individual.charts, bundled.charts);
});
function lineModel() {
  const config = { schema_version: 'phys-line-config/1', model_version: 'phys-line-v1', line_version: 'phys-line-v1', mean_version: 'mean-feature-span-v1',
    purpose: 'clear', unit: 'notes/s', axes, ...versions };
  config.content_hash = sha256(config);
  return { line_config: config, mean: Object.fromEntries(axes.map(axis => [axis, { meanNps: 0, meanDuration: null }])) };
}

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
    ...lineModel(), kappa: [1, 2, 3, 4, 5, 6], covariateStats: { notes: { mean: 100, sd: 10 }, duration: { mean: 10, sd: 1 } }, pool: {} });
  const chart = hashed({ schema_version: 'phys-chart/1', chartKey, ...versions, songId: 'song/a', diff: 'ANOTHER', notes: 100,
    duration: 10, features: Object.fromEntries(axes.map(axis => [axis, { maxQ: 2, meanNps: null }])), arrange: 'MIRROR', worstWindows: { STAIR_UP: [{ start: 1 }] } });
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

function bundleFixture() {
  const f = fixture();
  const assets = [f.manifest.model, f.chartAsset].map(entry => ({ key: entry.key, content_hash: entry.content_hash,
    file_sha256: entry.file_sha256, raw: f.objects.get(entry.key) }));
  f.bundle = { schema_version: 'phys-assets-bundle/1', versions, assets };
  f.writeBundle = () => {
    const raw = `${JSON.stringify(f.bundle)}\n`;
    f.manifest.bundle = { key: `phys/bundle/${versions.model_version}.json`, file_sha256: sha256(raw), bytes: Buffer.byteLength(raw) };
    f.objects.set(f.manifest.bundle.key, raw);
  };
  f.writeBundle();
  return f;
}

test('묶음 하나만 GET하고 기존 채보 로딩 결과를 유지한다', async () => {
  const f = bundleFixture();
  const loaded = await loadPhysAssets({ versions, manifest: f.manifest, getText: f.getText });
  assert.deepEqual(f.calls, [f.manifest.bundle.key]);
  assert.equal(loaded.status, 'ready');
  assert.deepEqual(loaded.model, f.model);
  assert.deepEqual(loaded.charts.get(f.chartKey), f.chart);
});

test('묶음 파일 해시와 바이트 수 변조를 거부하며 개별 GET으로 우회하지 않는다', async () => {
  for (const mutate of [f => f.objects.set(f.manifest.bundle.key, f.objects.get(f.manifest.bundle.key) + ' '), f => f.manifest.bundle.bytes++]) {
    const f = bundleFixture(); mutate(f);
    await assert.rejects(loadPhysAssets({ versions, manifest: f.manifest, getText: f.getText }), /bundle (file_sha256|bytes) mismatch/);
    assert.deepEqual(f.calls, [f.manifest.bundle.key]);
  }
});

test('묶음 해시가 맞아도 채보 원문·내용 해시와 누락·중복·버전 오류를 거부한다', async () => {
  const cases = [
    [f => { f.bundle.assets[1].raw += ' '; }, /file_sha256 mismatch/],
    [f => {
      const chart = JSON.parse(f.bundle.assets[1].raw); chart.notes++;
      const raw = JSON.stringify(chart), hash = sha256(raw);
      f.bundle.assets[1].raw = raw; f.bundle.assets[1].file_sha256 = hash; f.chartAsset.file_sha256 = hash;
    }, /content_hash mismatch/],
    [f => { f.bundle.assets.pop(); }, /assets missing/],
    [f => { f.bundle.assets.push(f.bundle.assets[1]); }, /declaration mismatch/],
    [f => { f.bundle.versions = { ...versions, q_version: 'wrong' }; }, /schema\/version mismatch/],
    [f => { f.bundle.assets[1].file_sha256 = '0'.repeat(64); }, /declaration mismatch/],
  ];
  for (const [mutate, expected] of cases) {
    const f = bundleFixture(); mutate(f); f.writeBundle();
    await assert.rejects(loadPhysAssets({ versions, manifest: f.manifest, getText: f.getText }), expected);
  }
});

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

function v2Fixture() {
  const v = { model_version: 'phys-line-v2', q_version: 'q-samehand-2s-v1', time_axis_version: 'ta-20261004' };
  const units = Object.fromEntries(axesV2.map(axis => [axis, ['HSTAIR_SYNC', 'HSTAIR_SAMESHAPE', 'HSTAIR_DIFFSHAPE'].includes(axis) ? 'notes/s/both-hands' : 'notes/s/hand']));
  const config = { schema_version: 'phys-line-config/1', ...v, line_version: 'phys-line-v2', mean_version: 'mean-os-pattern-span-v2', axes: axesV2, units };
  config.content_hash = sha256(config);
  const model = hashed({ schema_version: 'phys-model/1', purpose: 'clear', variant: 'baseline-2s', covariates: 'physical', ...v,
    source_revision: 'local', generated_at: '2026-10-05T00:00:00Z', line_config: config,
    mean: Object.fromEntries(axesV2.map(axis => [axis, { meanNps: 0 }])) });
  const chartKey = 'song/v2|ANOTHER';
  const features = Object.fromEntries(axesV2.map(axis => [axis, { meanNps: null, duration: 0, notes: 0 }]));
  const chart = hashed({ schema_version: 'phys-chart/1', chartKey, ...v, notes: 0, duration: 0, features });
  const entry = { chartKey, key: `phys/chart/${v.model_version}/${encodeURIComponent(chartKey)}.json`, content_hash: chart.content_hash, ...v };
  const manifest = { schema_version: 'phys-assets-manifest/1', publishable: true, ...v,
    model: { key: `phys/model/${v.model_version}.json`, content_hash: model.content_hash }, charts: [entry], assets: [entry] };
  const objects = new Map([[manifest.model.key, rawAsset(model)], [entry.key, rawAsset(chart)]]);
  manifest.model.file_sha256 = sha256(objects.get(manifest.model.key)); entry.file_sha256 = sha256(objects.get(entry.key));
  return { v, manifest, chart, chartKey, objects, getText: async key => objects.get(key) };
}

test('v2 35축·単位メタと空特徴をロードし、窓なしを許す', async () => {
  const f = v2Fixture();
  const loaded = await loadPhysAssets({ versions: f.v, manifest: f.manifest, getText: f.getText });
  assert.equal(loaded.status, 'ready');
  assert.equal(Object.keys(loaded.charts.get(f.chartKey).features).length, 35);
  assert.equal(loaded.charts.get(f.chartKey).features.NOTES.meanNps, null);
  assert.equal('worstWindows' in loaded.charts.get(f.chartKey), false);
});

test('v2 rejects mixed axis sets, extra feature fields, and inconsistent span ratios', async () => {
  for (const mutate of [
    f => { f.chart.features.BAD = { meanNps: 0, duration: 0, notes: 0 }; delete f.chart.features.NOTES; },
    f => { f.chart.features.NOTES.reason = 'empty'; },
    f => { f.chart.features.NOTES = { meanNps: 2, duration: 2, notes: 3 }; },
    f => { f.chart.features.NOTES = { meanNps: 0, duration: 1, notes: 0 }; },
    f => { f.chart.features.NOTES = { meanNps: null, duration: 1, notes: 0 }; },
  ]) {
    const f = v2Fixture(); mutate(f);
    const raw = rawAsset(f.chart); f.objects.set(f.manifest.assets[0].key, raw);
    f.manifest.assets[0].file_sha256 = sha256(raw); f.manifest.charts[0].file_sha256 = sha256(raw);
    f.manifest.assets[0].content_hash = JSON.parse(raw).content_hash; f.manifest.charts[0].content_hash = JSON.parse(raw).content_hash;
    await assert.rejects(loadPhysAssets({ versions: f.v, manifest: f.manifest, getText: f.getText }), /features invalid/);
  }
});

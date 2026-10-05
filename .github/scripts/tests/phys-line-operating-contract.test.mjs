import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { producePhysUser } from '../phys-lib.mjs';
import { runBackfill } from '../backfill-phys.mjs';
import { loadPhysAssets, sha256 } from '../phys-assets.mjs';

const require = createRequire(import.meta.url);
const { AXES, AXES_V2, CONFIG_V2, UNIT_V2, computePhysLine } = require('../vendor/physLine.js');
const versions = { model_version: 'phys-line-v2', line_version: 'phys-line-v2', mean_version: 'mean-os-pattern-span-v2',
  q_version: 'q-samehand-2s-v1', time_axis_version: 'ta-20261004' };
const id = 'OPERATING-USER';
const contractFiles = [
  '../refresh-coach-user.mjs', '../backfill-phys.mjs', '../backfill-phys-run.mjs',
  '../phys-lib.mjs', '../vendor/physLine.js', '../phys-fit-pool.mjs',
  '../../../.github/workflows/backfill-phys.yml', '../../../.github/workflows/refresh-coach-user.yml',
];
const readContracts = async () => Promise.all(contractFiles.map(file => fs.readFile(new URL(file, import.meta.url), 'utf8')));
const memoryIO = (seed = {}) => {
  const objects = new Map(Object.entries(seed).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]));
  const puts = [];
  return { objects, puts, async read(key) { return objects.has(key) ? { body: objects.get(key), etag: '"old"' } : null; },
    async put(key, body) { puts.push(key); objects.set(key, String(body)); } };
};
function rows() {
  return Array.from({ length: 10 }, (_, index) => ({ chartKey: `song-${index}|ANOTHER`, lampNum: index < 8 ? 7 : 1,
    features: Object.fromEntries(AXES.map(axis => [axis, { meanNps: 10 + index }])) }));
}
function assetFixture() {
  const config = { schema_version: 'phys-line-config/1', model_version: versions.model_version, line_version: versions.line_version,
    mean_version: versions.mean_version, q_version: versions.q_version, time_axis_version: versions.time_axis_version,
    purpose: 'clear', unit: 'notes/s', axes: AXES_V2, units: UNIT_V2, binWidth: 1,
    lampWeight: { 1: 0, 2: 0.66, 3: 0.77, 4: 0.77, 5: 0.88, 6: 0.95, 7: 1 },
    dbr: { groupMinimum: 3, clearMinimum: 6, target: 0.5 } };
  config.content_hash = sha256(config);
  const model = { schema_version: 'phys-model/1', purpose: 'clear', variant: 'baseline-2s', covariates: 'physical',
    ...versions, line_config: config, mean: Object.fromEntries(AXES_V2.map(axis => [axis, { meanNps: 12 }])) };
  const v1Config = { schema_version: 'phys-line-config/1', model_version: 'phys-line-v1', line_version: 'phys-line-v1',
    mean_version: 'mean-feature-span-v1', q_version: versions.q_version, time_axis_version: versions.time_axis_version,
    binWidth: 1, axes: AXES, lampWeight: config.lampWeight, section: 'Math.round(meanNps / binWidth) * binWidth', dbr: 'computeDbrLines' };
  v1Config.content_hash = sha256(v1Config);
  const v1Model = { schema_version: 'phys-model/1', purpose: 'clear', variant: 'baseline-2s', covariates: 'physical',
    model_version: 'phys-line-v1', line_version: 'phys-line-v1', mean_version: 'mean-feature-span-v1',
    q_version: versions.q_version, time_axis_version: versions.time_axis_version, line_config: v1Config,
    mean: Object.fromEntries(AXES.map(axis => [axis, { meanNps: 12, meanDuration: 10 }])) };
  v1Model.content_hash = sha256(v1Model);
  model.content_hash = sha256(model);
  const chart = { schema_version: 'phys-chart/1', chartKey: 'song-1|ANOTHER', songId: 'song-1', diff: 'ANOTHER', textage_song_id: 'T1',
    ...versions, notes: 100, duration: 10, features: Object.fromEntries(AXES_V2.map(axis => [axis, { meanNps: 10, duration: 10, notes: 100 }])) };
  chart.content_hash = sha256(chart);
  const modelRaw = `${JSON.stringify(model, null, 2)}\n`, v1ModelRaw = `${JSON.stringify(v1Model, null, 2)}\n`, chartRaw = `${JSON.stringify(chart, null, 2)}\n`;
  const chartKey = `phys/chart/${versions.model_version}/${encodeURIComponent(chart.chartKey)}.json`;
  const manifest = { schema_version: 'phys-assets-manifest/1', publishable: true, versions,
    model: { key: `phys/model/${versions.model_version}.json`, content_hash: model.content_hash, file_sha256: sha256(modelRaw) },
    charts: [{ chartKey: chart.chartKey, key: chartKey, content_hash: chart.content_hash, file_sha256: sha256(chartRaw), ...versions }] };
  manifest.assets = manifest.charts;
  const bundleRaw = `${JSON.stringify({ schema_version: 'phys-assets-bundle/1', versions,
    assets: [{ key: manifest.model.key, content_hash: model.content_hash, file_sha256: manifest.model.file_sha256, raw: modelRaw },
      { key: chartKey, content_hash: chart.content_hash, file_sha256: sha256(chartRaw), raw: chartRaw }] })}\n`;
  manifest.bundle = { key: `phys/bundle/${versions.model_version}.json`, file_sha256: sha256(bundleRaw), bytes: Buffer.byteLength(bundleRaw) };
  const texts = new Map([[manifest.bundle.key, bundleRaw]]);
  const v1Versions = { model_version: 'phys-line-v1', q_version: versions.q_version, time_axis_version: versions.time_axis_version };
  const v1Manifest = { ...manifest, versions: v1Versions,
    model: { key: 'phys/model/phys-line-v1.json', content_hash: v1Model.content_hash, file_sha256: sha256(v1ModelRaw) },
    bundle: undefined };
  delete v1Manifest.bundle;
  return { manifest, model, chart, texts, v1Manifest, v1Model, v1ModelRaw, getText: async key => key === 'phys/model/phys-line-v1.json' ? v1ModelRaw : texts.get(key) ?? null };
}

test('정본 physLine v2와 vendor의 버전·축·단위 계약이 일치한다', async () => {
  const [source] = await readContracts();
  const ratingVendor = await fs.readFile(new URL('../../../../ohSorryRating/modules/physLine.js', import.meta.url)).catch(() => null);
  const dataVendor = await fs.readFile(new URL('../vendor/physLine.js', import.meta.url));
  if (ratingVendor) assert.deepEqual(ratingVendor, dataVendor);
  assert.match(source, /producePhysUser/);
  assert.deepEqual(AXES_V2, CONFIG_V2.axes);
  assert.deepEqual(CONFIG_V2.units, UNIT_V2);
  assert.deepEqual([CONFIG_V2.model_version, CONFIG_V2.line_version, CONFIG_V2.mean_version, CONFIG_V2.q_version, CONFIG_V2.time_axis_version],
    ['phys-line-v2', 'phys-line-v2', 'mean-os-pattern-span-v2', 'q-samehand-2s-v1', 'ta-20261004']);
});

test('v1/v2 config는 서로 다른 축 집합으로 dispatch한다', () => {
  const v1 = computePhysLine({ rows: [], config: { schema_version: 'phys-line-config/1', model_version: 'phys-line-v1', line_version: 'phys-line-v1',
    mean_version: 'mean-feature-span-v1', q_version: CONFIG_V2.q_version, time_axis_version: CONFIG_V2.time_axis_version,
    binWidth: 1, axes: AXES, lampWeight: CONFIG_V2.lampWeight, section: 'Math.round(meanNps / binWidth) * binWidth', dbr: 'computeDbrLines' } });
  const v2 = computePhysLine({ rows: [], config: CONFIG_V2 });
  assert.deepEqual(Object.keys(v1.axes), AXES);
  assert.deepEqual(Object.keys(v2.axes), AXES_V2);
  assert.equal(v2.axes.NOTES.line, null);
  assert.equal(v2.axes.NOTES.reason, 'insufficient_clears');
  assert.ok(Object.values(v2.axes).every(axis => !Object.hasOwn(axis, 'stable_line') && !Object.hasOwn(axis, 'line85')));
});

test('v2 asset producer는 35축과 축별 insufficient_clears를 저장한다', async () => {
  const f = assetFixture(), assets = await loadPhysAssets({ versions, manifest: f.manifest, getText: f.getText });
  assert.equal(assets.status, 'ready');
  const inputRows = rows();
  for (const lampNum of [7, 1]) {
    for (const row of inputRows) row.lampNum = lampNum;
    const io = memoryIO();
    const dp = inputRows.map((row, index) => ({ song_id: index + 1, diff: 3, lamp: lampNum }));
    const songMap = Object.fromEntries(dp.map((row, index) => [row.song_id, `T${index + 1}`]));
    const chartEntries = new Map();
    const chartDocs = [];
    for (let index = 0; index < dp.length; index++) {
      const chart = { ...f.chart, chartKey: `song-${index}|ANOTHER`, songId: `song-${index}`, textage_song_id: `T${index + 1}` };
      chartEntries.set(chart.chartKey, chart);
    }
    const producerAssets = { ...assets, charts: chartEntries };
    const result = await producePhysUser({ id, dump: { dp, songs: songMap }, versions, manifest: f.manifest, io, assets: producerAssets,
      computePhysLine, generatedAt: '2026-10-05T00:00:00.000Z', dryRun: false });
    assert.equal(result.status, 'ready');
    const record = JSON.parse(io.objects.get(`phys/user/${encodeURIComponent(id)}.json`));
    assert.deepEqual(Object.keys(record.absolute.axes).sort(), [...AXES_V2].sort());
    if (lampNum === 7) assert.ok(AXES_V2.every(axis => record.absolute.axes[axis].n_charts === 10 && record.absolute.axes[axis].basis === 'dbr_weighted_clear×mean_nps'));
    if (lampNum === 1) assert.ok(AXES_V2.every(axis => record.absolute.axes[axis].reason === 'insufficient_clears'));
  }
});

test('refresh와 backfill에 주입한 동일 producer는 같은 v2 레코드를 생성한다', async () => {
  const f = assetFixture(), assets = await loadPhysAssets({ versions, manifest: f.manifest, getText: f.getText });
  const dump = { dp: Array.from({ length: 10 }, (_, index) => ({ song_id: index + 1, diff: 3, lamp: index < 8 ? 7 : 1 })),
    songs: Object.fromEntries(Array.from({ length: 10 }, (_, index) => [index + 1, `T${index + 1}`])) };
  const charts = new Map(Array.from({ length: 10 }, (_, index) => {
    const chart = { ...f.chart, chartKey: `song-${index}|ANOTHER`, songId: `song-${index}`, textage_song_id: `T${index + 1}` };
    return [chart.chartKey, chart];
  }));
  const resolvedAssets = { ...assets, charts }, generatedAt = '2026-10-05T00:00:00.000Z';
  const refreshIO = memoryIO();
  const refresh = await producePhysUser({ id, dump, versions, manifest: f.manifest, io: refreshIO, assets: resolvedAssets, computePhysLine, generatedAt });
  const backfillIO = memoryIO();
  const result = await runBackfill({ usersList: 'users.json', manifestPath: 'manifest.json', limit: 1, dryRun: false, only: [id], versions }, {
    readFile: async file => file === 'users.json' ? JSON.stringify([{ iidx_id: id }]) : JSON.stringify(f.manifest),
    getDump: async () => dump,
    io: backfillIO,
    loadAssets: async () => resolvedAssets,
    produce: input => producePhysUser({ ...input, computePhysLine, generatedAt }),
    verifyPut: async () => ({ body: backfillIO.objects.get(`phys/user/${encodeURIComponent(id)}.json`) }),
  });
  assert.equal(refresh.status, 'ready');
  assert.equal(result.ready, 1);
  assert.deepEqual(JSON.parse(refreshIO.objects.get(`phys/user/${encodeURIComponent(id)}.json`)),
    JSON.parse(backfillIO.objects.get(`phys/user/${encodeURIComponent(id)}.json`)));
});

test('refresh 단일 실행과 backfill은 동일 producer 함수를 쓰고 운영 fit import/call이 없다', async () => {
  const [refresh, backfill, runner, producer] = await readContracts();
  assert.match(refresh, /producePhysUser \}\s+from '\.\/phys-lib\.mjs'/);
  assert.match(refresh, /\(deps\.producePhysUser \|\| producePhysUser\)\(/);
  assert.match(backfill, /const produce = deps\.produce \|\| producePhysUser/);
  assert.match(backfill, /await produce\(/);
  assert.match(producer, /computePhysLine \|\| require\('\.\/vendor\/physLine\.js'\)\.computePhysLine/);
  assert.doesNotMatch(`${refresh}\n${backfill}\n${runner}`, /createFitPool|phys-fit-pool|physTheta\.js|fitUser\(/);
});

test('dump 후 직접 CLI, continue-on-error, 수동 refresh와 v2 기본 버전을 유지한다', async () => {
  const [refresh, backfill, runner, , , , backfillWorkflow, refreshWorkflow] = await readContracts();
  assert.match(refreshWorkflow, /node \.github\/scripts\/refresh-coach-user\.mjs --id/);
  assert.match(refreshWorkflow, /EXPECTED_V/);
  assert.match(refreshWorkflow, /PHYS_MODEL_VERSION: \$\{\{ vars\.PHYS_MODEL_VERSION \|\| 'phys-line-v2' \}\}/);
  assert.match(refreshWorkflow, /PHYS_Q_VERSION: q-samehand-2s-v1/);
  assert.match(refreshWorkflow, /PHYS_TIME_AXIS_VERSION: ta-20261004/);
  assert.match(refresh, /PHYS_MODEL_VERSION/);
  assert.match(backfillWorkflow, /run: node \.github\/scripts\/backfill-phys-run\.mjs/);
  assert.match(backfillWorkflow, /MODEL_VERSION: \$\{\{ inputs\.model_version \}\}/);
  assert.match(runner, /runBackfill\)\(options/);
  assert.match(backfill, /conditionalR2Client/);
});

test('users-list 03:05 설정과 checkout의 물리 vendor 경로를 보장한다', async () => {
  const [refresh, backfill, runner, , , , backfillWorkflow, refreshWorkflow] = await readContracts();
  const nightly = await fs.readFile(new URL('../../../.github/workflows/dump-users-list.yml', import.meta.url), 'utf8');
  const workflowSource = `${nightly}\n${backfillWorkflow}\n${refreshWorkflow}`;
  assert.match(workflowSource, /schedule:[\s\S]*cron: ['"]5 18 \* \* \*['"]/);
  assert.match(runner, /phys\/manifest\/\$\{model\}\.json/);
  assert.match(refresh, /phys\/user/);
  const dataPath = new URL('../vendor/physLine.js', import.meta.url);
  assert.ok((await fs.stat(dataPath)).isFile());
});

test('Web reader·병목 경로와 새 평균 자산 운영 계약이 맞는다', async () => {
  const [physReader, songReader, consumerContract, knowledge, apiDocs] = await Promise.all([
    fs.readFile(new URL('../../../../ohSorryWeb/functions/_shared/coach-phys.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../../../../ohSorryWeb/functions/_shared/coach-song-phys.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../../../../ohSorryWeb/tests/coach-producer-reader-contract.test.mjs', import.meta.url), 'utf8'),
    fs.readFile(new URL('../../../../ohSorryWeb/docs/customGPT-coach/knowledge.md', import.meta.url), 'utf8'),
    fs.readFile(new URL('../../../../ohSorryWeb/docs/coach-api.md', import.meta.url), 'utf8'),
  ]);
  assert.match(physReader, /line_version/);
  assert.match(songReader, /OPERATING_VERSIONS/);
  assert.match(consumerContract, /producePhysUser/);
  assert.match(`${knowledge}\n${apiDocs}`, /실력선/);
  assert.match(apiDocs, /phys\/manifest/);
});

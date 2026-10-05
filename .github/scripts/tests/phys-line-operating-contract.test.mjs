import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { producePhysUser } from '../phys-lib.mjs';
import { loadPhysAssets, sha256 } from '../phys-assets.mjs';

const require = createRequire(import.meta.url);
const { AXES, computePhysLine } = require('../vendor/physLine.js');
const versions = { model_version: 'phys-line-v1', line_version: 'phys-line-v1', mean_version: 'mean-feature-span-v1',
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
    purpose: 'clear', unit: 'notes/s', axes: AXES };
  config.content_hash = sha256(config);
  const model = { schema_version: 'phys-model/1', purpose: 'clear', variant: 'baseline-2s', covariates: 'physical',
    ...versions, line_config: config, mean: Object.fromEntries(AXES.map(axis => [axis, { meanNps: 12, meanDuration: 10 }])) };
  model.content_hash = sha256(model);
  const chart = { schema_version: 'phys-chart/1', chartKey: 'song-1|ANOTHER', songId: 'song-1', diff: 'ANOTHER', textage_song_id: 'T1',
    ...versions, notes: 100, duration: 10, features: Object.fromEntries(AXES.map(axis => [axis, { meanNps: 11, meanDuration: 10 }])) };
  chart.content_hash = sha256(chart);
  const modelRaw = `${JSON.stringify(model, null, 2)}\n`, chartRaw = `${JSON.stringify(chart, null, 2)}\n`;
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
  return { manifest, model, chart, texts, getText: async key => texts.get(key) ?? null };
}

test('Rating/vendor Buffer 값과 로컬 Data vendor 순수 계산 결과가 같다', async () => {
  const [source] = await readContracts();
  const ratingVendor = await fs.readFile(new URL('../../../../ohSorryRating/modules/physLine.js', import.meta.url));
  const dataVendor = await fs.readFile(new URL('../vendor/physLine.js', import.meta.url));
  assert.deepEqual(ratingVendor, dataVendor);
  assert.match(source, /producePhysUser/);
});

test('실제 평균 자산을 읽은 producer는 10축 50·85 선과 FAILED·NO PLAY 입력 상태를 저장한다', async () => {
  const f = assetFixture(), assets = await loadPhysAssets({ versions, manifest: f.manifest, getText: f.getText });
  assert.equal(assets.status, 'ready');
  const inputRows = rows();
  for (const lampNum of [7, 1, 0]) {
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
    assert.deepEqual(Object.keys(record.absolute.axes).sort(), [...AXES].sort());
    if (lampNum === 7) assert.ok(AXES.every(axis => record.absolute.axes[axis].n_charts === 10 && record.absolute.axes[axis].basis === 'dbr_weighted_clear×mean_nps'));
    if (lampNum === 1) assert.ok(AXES.every(axis => record.absolute.axes[axis].reason === 'no_cleared_charts'));
    if (lampNum === 0) assert.ok(AXES.every(axis => record.absolute.axes[axis].reason === 'no_charts'));
  }
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

test('dump 후 직접 CLI, continue-on-error, 수동 refresh와 버전 환경 입력을 유지한다', async () => {
  const [refresh, backfill, runner, , , , backfillWorkflow, refreshWorkflow] = await readContracts();
  assert.match(refreshWorkflow, /node \.github\/scripts\/refresh-coach-user\.mjs --id/);
  assert.match(refreshWorkflow, /EXPECTED_V/);
  assert.match(refreshWorkflow, /PHYS_MODEL_VERSION: \$\{\{ vars\.PHYS_MODEL_VERSION \}\}/);
  assert.match(refresh, /PHYS_MODEL_VERSION/);
  assert.match(backfillWorkflow, /run: node \.github\/scripts\/backfill-phys-run\.mjs/);
  assert.match(backfillWorkflow, /MODEL_VERSION: \$\{\{ inputs\.model_version \}\}/);
  assert.match(runner, /runBackfill\)\(options/);
  assert.match(backfill, /conditionalR2Client/);
});

test('야간 2 req/s·03:05 설정과 Rating/Data 상대 경로의 독립 실행을 보장한다', async () => {
  const [refresh, backfill, runner, , , , backfillWorkflow, refreshWorkflow] = await readContracts();
  const nightly = await fs.readFile(new URL('../../../.github/workflows/dump-users-list.yml', import.meta.url), 'utf8');
  const workflowSource = `${nightly}\n${backfillWorkflow}\n${refreshWorkflow}`;
  assert.match(workflowSource, /schedule:[\s\S]*cron: ['"]5 18 \* \* \*['"]/);
  assert.match(workflowSource, /--request-rate 2/);
  assert.match(runner, /phys\/manifest\/\$\{model\}\.json/);
  assert.match(refresh, /phys\/user/);
  const ratingPath = new URL('../../../../ohSorryRating/modules/phys-line-v1.js', import.meta.url);
  const dataPath = new URL('../vendor/physLine.js', import.meta.url);
  assert.notEqual(ratingPath.href, dataPath.href);
  assert.ok(!(await fs.stat(ratingPath).then(() => true, () => false)));
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

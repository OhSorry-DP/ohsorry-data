import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { producePhysUser } from '../phys-lib.mjs';
import { loadPhysAssets } from '../phys-assets.mjs';
import { createFitPool } from '../phys-fit-pool.mjs';
import os from 'node:os';

// 로컬 입력만 사용하고 생성 결과는 메모리에 저장한다. 환경 변수 대신 명시 인자로 checkout을 고른다.
const args = process.argv.slice(2);
const options = {};
for (let index = 0; index < args.length; index++) {
  const token = args[index];
  if (token === '--benchmark-8') { options.benchmark = true; continue; }
  if (token.startsWith('--')) {
    const key = token.slice(2);
    if (!['version', 'dump', 'songs', 'manifest', 'model', 'bundle', 'asset-root', 'fixture-root', 'web-root'].includes(key)) throw new Error(`알 수 없는 옵션: ${token}`);
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${token} 값 필요`);
    options[key] = args[++index];
    continue;
  }
  // 기존 v1 positional 호출 형식도 허용한다.
  const key = ['dump', 'songs', 'asset-root', 'web-root'][Object.keys(options).filter(name => ['dump', 'songs', 'asset-root', 'web-root'].includes(name)).length];
  if (!key || options[key]) throw new Error(`예상하지 못한 인자: ${token}`);
  options[key] = token;
}
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const version = options.version || 'phys-line-v1';
if (!['phys-line-v1', 'phys-line-v2'].includes(version)) throw new Error(`지원하지 않는 버전: ${version}`);
const fixtureRoot = path.resolve(options['fixture-root'] || path.join(repoRoot, 'fixtures', 'phys-line-v1'));
const assetRoot = path.resolve(options['asset-root'] || path.join(repoRoot, '..', 'ohSorryRating', 'experiments', 'phys-proto', 'out', 'phys-assets', version));
const manifestPath = path.resolve(options.manifest || path.join(assetRoot, 'manifest.json'));
const dumpPath = options.dump ? path.resolve(options.dump) : null;
const songsPath = path.resolve(options.songs || path.join(fixtureRoot, 'songs.json'));
const webRoot = path.resolve(options['web-root'] || path.join(repoRoot, '..', 'ohSorryWeb'));
console.log(JSON.stringify({ selected_model: version, repo_root: repoRoot, data_worktree: repoRoot,
  rating_worktree: path.resolve(repoRoot, '..', 'ohSorryRating'), web_worktree: webRoot,
  fixture_root: fixtureRoot, asset_root: assetRoot, manifest_path: manifestPath, dump_path: dumpPath }));
if (!dumpPath) {
  console.error('부족 입력: --dump <로컬 dump.json> 필요. 덤프 데이터나 수치를 추정하지 않습니다.');
  process.exitCode = 2;
} else if (!await fs.stat(dumpPath).then(() => true, () => false)) {
  console.error(`부족 입력: dump 없음 (${dumpPath})`);
  process.exitCode = 2;
} else if (!await fs.stat(songsPath).then(() => true, () => false)) {
  console.error(`부족 입력: 곡 매핑 없음 (${songsPath})`);
  process.exitCode = 2;
} else if (!await fs.stat(manifestPath).then(() => true, () => false)) {
  console.error(`부족 입력: ${version} manifest/model/bundle 없음 (${manifestPath})`);
  process.exitCode = 2;
}
const require = createRequire(import.meta.url);
if (process.exitCode === 2) {
  // 선택한 checkout과 누락 입력을 출력하고 정상 평가 경로에는 진입하지 않는다.
} else {
// 다섯 번째 인자가 --benchmark-8이면 첫 경로의 실유저 덤프 8개를 비교한다.
if (options.benchmark) {
  const songs = JSON.parse(await fs.readFile(songsPath, 'utf8'));
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (manifest.bundle && options.bundle) manifest.bundle.path = path.resolve(options.bundle);
  if (options.model && manifest.model) manifest.model.path = path.resolve(options.model);
  const files = new Map([[manifest.model.key, manifest.model.path], ...manifest.assets.map(entry => [entry.key, entry.path])]);
  if (manifest.bundle) files.set(manifest.bundle.key, manifest.bundle.path);
  let assetGets = 0;
  const assets = await loadPhysAssets({ versions: manifest.versions, manifest, getText: async key => {
    assetGets++;
    return files.has(key) ? fs.readFile(path.join(assetRoot, files.get(key)), 'utf8') : null;
  } });
  assert.equal(assets.status, 'ready');
  const dumps = [];
  for (const name of (await fs.readdir(dumpPath)).filter(name => name.endsWith('.json')).sort()) {
    const dump = JSON.parse(await fs.readFile(path.join(dumpPath, name), 'utf8'));
    if (dump.user?.iidx_id == null || !Array.isArray(dump.dp)) continue;
    const id = String(dump.user.iidx_id);
    if (dumps.some(item => item.id === id)) continue;
    dumps.push({ id, dump: { ...dump, songs } });
    if (dumps.length === 8) break;
  }
  assert.equal(dumps.length, 8, '서로 다른 실유저 덤프 8개 필요');
  const generatedAt = '2026-10-05T00:00:00.000Z';
  const evaluate = async fitUser => Promise.all(dumps.map(async ({ id, dump }) => {
    let record;
    const result = await producePhysUser({ id, dump, versions: manifest.versions, manifest, assets, fitUser, generatedAt,
      io: { read: async () => null, put: async (key, body) => { record = JSON.parse(body); } } });
    assert.equal(result.status, 'ready', JSON.stringify(result));
    // 벤치마크 표본에는 대상 채보가 0개인 유저도 있다(정상 결손) — 직렬·병렬 동등성만 본다.
    return record;
  }));
  let started = performance.now();
  const serial = await evaluate(require('../vendor/physTheta.js').fitUser);
  const serialMs = performance.now() - started;
  const workers = os.availableParallelism();
  started = performance.now();
  const pool = createFitPool(assets.model, workers);
  let parallel;
  try { parallel = await evaluate(pool.fitUser); }
  finally { await pool.close(); }
  const poolMs = performance.now() - started;
  assert.deepEqual(parallel, serial);
  console.log(JSON.stringify({ ids: dumps.map(item => item.id), workers, serial_ms: Math.round(serialMs),
    pool_ms: Math.round(poolMs), speedup: serialMs / poolMs, equal: true, asset_gets: assetGets }));
} else {
const dump = JSON.parse(await fs.readFile(dumpPath, 'utf8'));
const songs = JSON.parse(await fs.readFile(songsPath, 'utf8'));
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
if (manifest.bundle && options.bundle) manifest.bundle.path = path.resolve(options.bundle);
if (options.model && manifest.model) manifest.model.path = path.resolve(options.model);
const versions = manifest.versions;
const files = new Map([[manifest.model.key, manifest.model.path], ...manifest.assets.map(entry => [entry.key, entry.path])]);
if (manifest.bundle) files.set(manifest.bundle.key, manifest.bundle.path);
const id = String(dump.user.iidx_id);
let record, assetGets = 0, totalGets = 0;
const io = {
  async read(key) { totalGets++; if (!files.has(key)) return null; assetGets++; return { body: await fs.readFile(path.join(assetRoot, files.get(key)), 'utf8') }; },
  async put(key, body) { assert.equal(key, `phys/user/${encodeURIComponent(id)}.json`); record = JSON.parse(body); },
};
const started = performance.now();
const result = await producePhysUser({ id, dump: { ...dump, songs }, versions, manifest, io,
  fitUser: require('../vendor/physTheta.js').fitUser,
  loadAssets: (v, m, client) => loadPhysAssets({ versions: v, manifest: m, getText: async key => (await client.read(key))?.body ?? null }),
});
const productionMs = performance.now() - started;
assert.equal(result.status, 'ready', JSON.stringify(result));
assert.ok(result.counts.included > 0);
assert.deepEqual(Object.fromEntries(Object.keys(versions).map(key => [key, record.absolute[key]])), versions);
const readerPath = path.join(webRoot, 'functions/_shared/coach-phys.js');
if (!await fs.stat(readerPath).then(() => true, () => false)) throw new Error(`Web reader 정본 없음: ${readerPath}`);
const { readPhysicalEvidence } = await import(pathToFileURL(readerPath).href);
const evidence = await readPhysicalEvidence({ bucket: { get: async () => ({ json: async () => record }) }, id, versions, sourceRevision: result.source_revision });
assert.equal(evidence.status, 'ready', JSON.stringify(evidence));
for (const axis of Object.values(evidence.axes)) {
  if (axis.estimate_kind === 'unidentified') {
    assert.equal(axis.theta, null); assert.equal(axis.lower, null); assert.equal(axis.upper, null);
    assert.equal(axis.interval_status, 'unavailable');
  }
}
console.log(JSON.stringify({ id, dump_version: dump._v, production_status: result.status, reader_status: evidence.status,
  production_ms: Math.round(productionMs), asset_gets: assetGets, total_gets: totalGets, bundle_bytes: manifest.bundle?.bytes ?? null, counts: result.counts, versions,
  axes: Object.fromEntries(Object.entries(evidence.axes).map(([axis, value]) => [axis, { estimate_kind: value.estimate_kind,
    support_songs: value.provenance.support_songs, successes: value.provenance.successes, failures: value.provenance.failures,
    unobserved: value.unobserved, prior_driven: value.prior_driven }])) }));
}
}

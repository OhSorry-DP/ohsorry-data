import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { producePhysUser } from '../phys-lib.mjs';
import { loadPhysAssets } from '../phys-assets.mjs';
import { createFitPool } from '../phys-fit-pool.mjs';
import os from 'node:os';

// 로컬 업로드 원본과 덤프만 사용하며 생성 결과는 메모리에 저장한다.
const [dumpPath, songsPath, assetRoot, webRoot] = process.argv.slice(2);
if (![dumpPath, songsPath, assetRoot, webRoot].every(Boolean)) throw new Error('덤프·곡 매핑·자산 디렉터리·Web 디렉터리 경로 필요');
const require = createRequire(import.meta.url);
// 다섯 번째 인자가 --benchmark-8이면 첫 경로의 실유저 덤프 8개를 비교한다.
if (process.argv[6] === '--benchmark-8') {
  const songs = JSON.parse(await fs.readFile(songsPath, 'utf8'));
  const manifest = JSON.parse(await fs.readFile(path.join(assetRoot, 'manifest.json'), 'utf8'));
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
const manifest = JSON.parse(await fs.readFile(path.join(assetRoot, 'manifest.json'), 'utf8'));
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
const { readPhysicalEvidence } = await import(pathToFileURL(path.join(webRoot, 'functions/_shared/coach-phys.js')).href);
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

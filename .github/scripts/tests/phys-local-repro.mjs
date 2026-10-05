import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { producePhysUser } from '../phys-lib.mjs';
import { loadPhysAssets } from '../phys-assets.mjs';

// 로컬 업로드 원본과 덤프만 사용하며 생성 결과는 메모리에 저장한다.
const [dumpPath, songsPath, assetRoot, webRoot] = process.argv.slice(2);
if (![dumpPath, songsPath, assetRoot, webRoot].every(Boolean)) throw new Error('덤프·곡 매핑·자산 디렉터리·Web 디렉터리 경로 필요');
const require = createRequire(import.meta.url);
const dump = JSON.parse(await fs.readFile(dumpPath, 'utf8'));
const songs = JSON.parse(await fs.readFile(songsPath, 'utf8'));
const manifest = JSON.parse(await fs.readFile(path.join(assetRoot, 'manifest.json'), 'utf8'));
const versions = manifest.versions;
const files = new Map([[manifest.model.key, manifest.model.path], ...manifest.assets.map(entry => [entry.key, entry.path])]);
const id = String(dump.user.iidx_id);
let record;
const io = {
  async read(key) { return files.has(key) ? { body: await fs.readFile(path.join(assetRoot, files.get(key)), 'utf8') } : null; },
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
  production_ms: Math.round(productionMs), counts: result.counts, versions,
  axes: Object.fromEntries(Object.entries(evidence.axes).map(([axis, value]) => [axis, { estimate_kind: value.estimate_kind,
    support_songs: value.provenance.support_songs, successes: value.provenance.successes, failures: value.provenance.failures,
    unobserved: value.unobserved, prior_driven: value.prior_driven }])) }));

import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { conditionalR2Client } from './r2-client.mjs';
import { producePhysUser } from './phys-lib.mjs';
import { loadPhysAssets } from './phys-assets.mjs';
import { produceRelativeUser } from './coach-relative-lib.mjs';
import { buildEntries, selectDpRegistry, stableJson, sha256 as relativeSha256 } from './dump-coach-relative.mjs';
import { buildRelativeRegistry } from './coach-relative-input.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ID_RE = /^[A-Za-z0-9]+$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const USER_KEY = id => `user/${id}.json`;
const ALLOWED_KEYS = id => new Set([`phys/user/${id}.json`, `coach/relative/user/${id}.json`]);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

export function parseArgs(args) {
  const out = { dryRun: false }, seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') { if (seen.has(arg)) throw new Error('duplicate option'); seen.add(arg); out.dryRun = true; continue; }
    if (arg !== '--id' && arg !== '--expected-v' && arg !== '--expected-sha256') throw new Error(`unknown option: ${arg}`);
    if (seen.has(arg)) throw new Error(`duplicate option: ${arg}`);
    seen.add(arg);
    const value = args[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value: ${arg}`);
    out[arg === '--id' ? 'id' : arg === '--expected-v' ? 'expectedV' : 'expectedSha256'] = value;
  }
  if (!out.id || !ID_RE.test(out.id)) throw new Error('invalid --id');
  if (!out.expectedV || !Number.isFinite(Date.parse(out.expectedV)) || new Date(out.expectedV).toISOString() !== out.expectedV) throw new Error('invalid --expected-v');
  if (out.expectedSha256 && !HASH_RE.test(out.expectedSha256)) throw new Error('invalid --expected-sha256');
  return out;
}

function snapshot(text, id) {
  if (typeof text !== 'string') throw new Error('source_missing');
  let dump;
  try { dump = JSON.parse(text); } catch { throw new Error('source_invalid_json'); }
  if (!dump || typeof dump !== 'object' || Array.isArray(dump) || String(dump.user?.iidx_id ?? '') !== id
    || !Array.isArray(dump.dp) || typeof dump._v !== 'string' || !Number.isFinite(Date.parse(dump._v))) throw new Error('source_invalid');
  return { text, dump, version: dump._v, hash: sha(text) };
}

async function readSource(io, id, expectedV, attempts = 3, expectedSha256 = null) {
  let current;
  for (let i = 0; i < attempts; i++) {
    const value = await io.read(USER_KEY(id));
    current = snapshot(value == null ? null : typeof value === 'string' ? value : value.body, id);
    current.etag = typeof value === 'object' && value ? value.etag ?? null : null;
    if (Date.parse(current.version) >= Date.parse(expectedV)
      && (current.version !== expectedV || !expectedSha256 || current.hash === expectedSha256)) return current;
  }
  throw new Error(current?.version === expectedV && expectedSha256 && current.hash !== expectedSha256
    ? 'source_hash_mismatch' : `source_stale: ${current?.version || 'missing'} < ${expectedV}`);
}

function relativeAssets() {
  const fs = require('node:fs');
  const kernelPath = path.join(HERE, 'vendor', 'patternScoreKernel.js');
  const kernelBytes = fs.readFileSync(kernelPath);
  const kernel = require(kernelPath);
  if (typeof kernel.countPatternScoreRecords !== 'function') throw new Error('kernel_invalid');
  return { kernel, kernelBytes };
}

async function loadRelativeAssets(io) {
  const [featureText, metaText] = await Promise.all([io.getText('data/feature-scores-slim.json'), io.getText('data/textage-meta.json')]);
  if (typeof featureText !== 'string' || typeof metaText !== 'string') throw new Error('relative_assets_missing');
  const hashes = { 'data/feature-scores-slim.json': sha(Buffer.from(featureText, 'utf8')),
    'data/textage-meta.json': sha(Buffer.from(metaText, 'utf8')) };
  let featureFile, metaFile;
  try { featureFile = JSON.parse(featureText); metaFile = JSON.parse(metaText); } catch { throw new Error('relative_assets_invalid_json'); }
  if (!featureFile?.scores || typeof featureFile.scores !== 'object' || !metaFile?.songs || typeof metaFile.songs !== 'object') throw new Error('relative_assets_invalid');
  const { kernel, kernelBytes } = relativeAssets();
  const sourceRegistry = selectDpRegistry(buildRelativeRegistry({ featureMeta: featureFile._meta || {} }));
  const codeHashes = { kernel: sha(kernelBytes), buildEntries: relativeSha256(buildEntries.toString()),
    mapping: relativeSha256(stableJson({ DP_FEATURE_KEY: { 1: 'DP_NOR', 2: 'DP_HYP', 3: 'DP_ANO', 4: 'DP_LEG' },
      DP_NOTES_KEY: { 1: 'DN', 2: 'DH', 3: 'DA', 4: 'DX' } })) };
  const featureVersion = relativeSha256({ assets: hashes, registry: sourceRegistry, codeHashes });
  return { featureFile, metaFile, hashes, codeHashes, sourceRegistry, featureVersion, kernel };
}

function configuredVersions(env) {
  return { model_version: env.PHYS_MODEL_VERSION || null, q_version: env.PHYS_Q_VERSION || null,
    time_axis_version: env.PHYS_TIME_AXIS_VERSION || null };
}

export async function runRefresh(options, deps = {}) {
  const id = String(options.id ?? '');
  if (!ID_RE.test(id)) throw new Error('invalid --id');
  const expectedV = options.expectedV;
  if (typeof expectedV !== 'string' || !Number.isFinite(Date.parse(expectedV)) || new Date(expectedV).toISOString() !== expectedV) throw new Error('invalid --expected-v');
  const env = deps.env || process.env;
  const expectedSha256 = options.expectedSha256 ?? env.SOURCE_SHA256 ?? null;
  if (expectedSha256 !== null && (typeof expectedSha256 !== 'string' || !HASH_RE.test(expectedSha256))) throw new Error('invalid --expected-sha256');
  const io = deps.io || await (async () => {
    const client = conditionalR2Client({ account: env.CLOUDFLARE_ACCOUNT_ID || '607eea1b073bea6747e6e9b76f2d7b41', token: env.CLOUDFLARE_R2_TOKEN || env.CLOUDFLARE_API_TOKEN });
    return { read: client.read, put: client.put, getText: async key => { const item = await client.read(key); return item?.body ?? null; } };
  })();
  if (typeof io?.read !== 'function' || typeof io?.put !== 'function' || typeof io?.getText !== 'function') throw new Error('conditional R2 REST IO required');
  const allowed = ALLOWED_KEYS(id), originalPut = io.put.bind(io);
  let source, sourceChanged = false, phase = 'input';
  const summary = { id, expected_v: expectedV, dry_run: !!options.dryRun, source: null, phys: null, relative: null, attempts: 0 };
  async function sourceCheck() {
    const latest = await readSource(io, id, expectedV, 3, expectedSha256);
    if (!source || latest.version !== source.version || latest.hash !== source.hash) { sourceChanged = true; throw Object.assign(new Error('source_changed'), { code: 'source_changed' }); }
  }
  io.put = async (key, body, etag) => {
    if (!allowed.has(key)) throw new Error(`write_key_forbidden: ${key}`);
    if (phase === 'phys' && deps.loadPhysAssets && deps.loadPhysAssets.triggerRace) deps.loadPhysAssets.triggerRace();
    await sourceCheck();
    if (key === `phys/user/${id}.json` && phase !== 'phys') throw new Error('unexpected_phys_write');
    if (key === `coach/relative/user/${id}.json` && phase !== 'relative') throw new Error('unexpected_relative_write');
    return originalPut(key, body, etag);
  };
  const runOne = async () => {
    sourceChanged = false;
    source = await readSource(io, id, expectedV, 3, expectedSha256);
    summary.attempts++;
    summary.source = { _v: source.version, sha256: source.hash, etag: source.etag };
    const dump = JSON.parse(source.text);
    const versions = configuredVersions(env);
    if (!versions.model_version || !versions.q_version || !versions.time_axis_version) {
      summary.phys = { status: 'skipped', reason: 'versions_unset', gets: 0, puts: 0 };
    } else {
      try {
        const manifestKey = env.PHYS_ASSETS_MANIFEST_KEY;
        if (!manifestKey) throw new Error('manifest_key_unset');
        const manifestText = await io.getText(manifestKey);
        if (manifestText == null) throw new Error('manifest_missing');
        const manifest = JSON.parse(manifestText);
        if (typeof dump.songMap !== 'object' && typeof dump.songs !== 'object') {
          const songsText = await io.getText('songs.json');
          if (songsText == null) throw new Error('songs_missing');
          const songs = JSON.parse(songsText);
          dump.songMap = Array.isArray(songs) ? Object.fromEntries(songs.filter(row => row?.song_id != null && row?.textage_song_id != null).map(row => [row.song_id, row.textage_song_id])) : songs;
        }
        phase = 'phys';
        const result = await (deps.producePhysUser || producePhysUser)({ id, dump, versions, manifest, io,
          loadAssets: deps.loadPhysAssets ? (v, m, client) => deps.loadPhysAssets(v, m, client) : (v, m, client) => loadPhysAssets({ versions: v, manifest: m, getText: async key => { const value = await client.read(key); return value == null ? null : typeof value === 'string' ? value : value.body; } }),
          generatedAt: source.version, dryRun: !!options.dryRun });
        summary.phys = { status: result.status, reason: result.reason || null, source_revision: result.source_revision || null,
          ...(result.error_message ? { error_message: result.error_message } : {}),
          attempts: 1, puts: result.changed && result.status === 'ready' && !options.dryRun ? 1 : 0 };
        if (result.status === 'failed' || result.status === 'conflict' || result.status === 'stale') throw Object.assign(new Error(result.error_message || result.reason || result.status), { phaseFailure: 'phys', reason: result.reason || result.status });
      } catch (error) {
        if (error.code === 'source_changed') throw error;
        summary.phys = { status: 'failed', reason: error.reason || String(error.message || error), error_message: String(error.message || error).slice(0, 200), attempts: 1, puts: 0 };
      }
    }
    try {
      const assets = await loadRelativeAssets(io);
      phase = 'relative';
      const relative = await (deps.produceRelativeUser || produceRelativeUser)({ id, dump, io, assets,
        generatedAt: source.version, dryRun: !!options.dryRun });
      summary.relative = { status: relative.status, reason: relative.reason || null, attempts: relative.attempts || 0,
        population_version: relative.population_version || null, puts: relative.changed && relative.status === 'ready' && !options.dryRun ? 1 : 0 };
      if (['failed', 'conflict', 'stale'].includes(relative.status)) summary.relativeFailure = relative.reason || relative.status;
    } catch (error) { if (error.code === 'source_changed') throw error; summary.relative = { status: 'failed', reason: String(error.message || error), attempts: 1, puts: 0 }; summary.relativeFailure = summary.relative.reason; }
    await sourceCheck();
  };
  for (let retry = 0; retry <= 2; retry++) {
    try { await runOne(); break; }
    catch (error) {
      if (error.code !== 'source_changed') { summary.failure = String(error.message || error); break; }
      if (summary.phys?.status === 'failed') summary.phys = { ...summary.phys, status: 'source_changed', reason: 'source_changed' };
      if (summary.relative?.status === 'failed') summary.relative = { ...summary.relative, status: 'source_changed', reason: 'source_changed' };
      summary.source = { ...(summary.source || {}), changed: true };
      if (retry === 2) { summary.failure = 'source_changed_retry_exhausted'; break; }
    }
  }
  io.put = originalPut;
  if (summary.failure && !summary.source) throw new Error(summary.failure);
  if (summary.attempts >= 3 && summary.source?.changed) summary.failure = 'source_changed_retry_exhausted';
  summary.ok = !summary.failure && !summary.relativeFailure && !['failed', 'conflict', 'stale'].includes(summary.phys?.status);
  return summary;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  const summary = await runRefresh(options);
  console.log(JSON.stringify(summary));
  if (!summary.ok) process.exitCode = 1;
  return summary;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(JSON.stringify({ status: 'failed', reason: String(error.message || error) })); process.exitCode = 1; });
}

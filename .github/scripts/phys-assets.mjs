import { createHash } from 'node:crypto';

const VERSION_FIELDS = ['model_version', 'q_version', 'time_axis_version'];
const MODEL_FIELDS = {
  schema_version: 'phys-model/1', purpose: 'clear', variant: 'baseline-2s', covariates: 'physical',
};
const CHART_SCHEMA = 'phys-chart/1';

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  const input = typeof value === 'string' ? value : canonical(value);
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function contentHash(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('asset must be an object');
  const { content_hash, file_sha256, ...withoutHash } = value;
  return sha256(withoutHash);
}

function versionsReady(versions) {
  return VERSION_FIELDS.every((field) => typeof versions?.[field] === 'string' && versions[field].length > 0);
}

function parseAsset(raw, label) {
  if (typeof raw !== 'string') throw new Error(`${label}: not found`);
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected JSON object');
    return { parsed, fileHash: sha256(raw) };
  } catch (error) {
    throw new Error(`${label}: invalid JSON (${error.message})`);
  }
}

function sameValue(a, b) {
  return canonical(a) === canonical(b);
}

function validateHash(asset, raw, label) {
  if (typeof asset.file_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.file_sha256)) {
    throw new Error(`${label}: file_sha256 missing or invalid`);
  }
  const fileView = { ...asset };
  delete fileView.file_sha256;
  if (sha256(canonical(fileView)) !== asset.file_sha256) throw new Error(`${label}: file_sha256 mismatch`);
  if (typeof asset.content_hash !== 'string' || !/^[a-f0-9]{64}$/.test(asset.content_hash)) {
    throw new Error(`${label}: content_hash missing or invalid`);
  }
  if (contentHash(asset) !== asset.content_hash) throw new Error(`${label}: content_hash mismatch`);
}

function chartEntries(manifest, modelVersion) {
  const bySource = new Map();
  for (const source of ['charts', 'assets']) {
    if (manifest[source] === undefined) continue;
    if (!Array.isArray(manifest[source])) throw new Error(`manifest.${source} must be an array`);
    const sourceEntries = new Map();
    for (const entry of manifest[source]) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`manifest.${source} entry must be an object`);
      const chartKey = entry.chartKey;
      if (typeof chartKey !== 'string' || !chartKey.length) throw new Error(`manifest.${source} chartKey missing`);
      if (sourceEntries.has(chartKey)) throw new Error(`duplicate chartKey: ${chartKey}`);
      sourceEntries.set(chartKey, entry);
    }
    bySource.set(source, sourceEntries);
  }
  if (bySource.has('charts') && bySource.has('assets')) {
    const charts = bySource.get('charts'), assets = bySource.get('assets');
    if (charts.size !== assets.size) throw new Error('manifest charts/assets declaration mismatch');
    for (const [chartKey, entry] of charts) {
      if (!assets.has(chartKey) || !sameValue(entry, assets.get(chartKey))) throw new Error(`manifest chart declaration mismatch: ${chartKey}`);
    }
  }
  const byChart = bySource.get('assets') || bySource.get('charts') || new Map();
  const result = [];
  for (const [chartKey, entry] of byChart) {
    if (typeof entry.key !== 'string' || !entry.key) throw new Error(`chart key missing: ${chartKey}`);
    const expectedKey = `phys/chart/${modelVersion}/${encodeURIComponent(chartKey)}.json`;
    if (entry.key !== expectedKey) throw new Error(`chart key mismatch: ${chartKey}`);
    if (entry.model_version !== undefined && entry.model_version !== modelVersion) throw new Error(`chart model version mismatch: ${chartKey}`);
    if (entry.q_version !== undefined && entry.q_version !== manifest.q_version) throw new Error(`chart q version mismatch: ${chartKey}`);
    if (entry.time_axis_version !== undefined && entry.time_axis_version !== manifest.time_axis_version) throw new Error(`chart time axis version mismatch: ${chartKey}`);
    result.push([chartKey, entry]);
  }
  return result;
}

async function defaultGetText(key) {
  const client = await import('./r2-client.mjs');
  if (!client.useRest) throw new Error('R2 REST credentials required for physical asset loading');
  try {
    const raw = await client.getText(key);
    if (raw === null) throw Object.assign(new Error(`R2 GET ${key}: 404 not found`), { status: 404 });
    return raw;
  } catch (error) {
    if (error?.status === 404 || /HTTP 404/.test(String(error?.message))) throw error;
    throw new Error(`R2 GET ${key} failed: ${error.message}`, { cause: error });
  }
}

export async function loadPhysAssets({ versions, manifest, getText } = {}) {
  if (!versionsReady(versions)) return { status: 'skipped', reason: 'versions_unset' };
  if (manifest?.publishable !== true) return { status: 'skipped', reason: 'assets_unpublished' };
  const source = getText || defaultGetText;
  const modelVersion = versions.model_version;
  const manifestVersions = manifest.versions || manifest;
  for (const field of VERSION_FIELDS) {
    if (manifestVersions[field] !== versions[field]) throw new Error(`manifest ${field} mismatch`);
  }

  const charts = chartEntries(manifest, modelVersion);
  const modelKey = `phys/model/${modelVersion}.json`;
  const modelRaw = await source(modelKey);
  const { parsed: model } = parseAsset(modelRaw, `model ${modelKey}`);
  validateHash(model, modelRaw, `model ${modelKey}`);
  for (const [field, expected] of Object.entries(MODEL_FIELDS)) {
    if (model[field] !== expected) throw new Error(`model ${field} mismatch`);
  }
  for (const field of VERSION_FIELDS) {
    if (model[field] !== versions[field]) throw new Error(`model ${field} mismatch`);
  }
  const modelEntry = manifest.model;
  if (!modelEntry || modelEntry.key !== modelKey || modelEntry.content_hash !== model.content_hash) {
    throw new Error('manifest model declaration mismatch');
  }

  const loadedCharts = new Map();
  for (const [chartKey, entry] of charts) {
    const raw = await source(entry.key);
    const { parsed: chart } = parseAsset(raw, `chart ${chartKey} (${entry.key})`);
    validateHash(chart, raw, `chart ${chartKey}`);
    if (chart.schema_version !== CHART_SCHEMA) throw new Error(`chart schema mismatch: ${chartKey}`);
    if (chart.chartKey !== chartKey || entry.content_hash !== chart.content_hash) throw new Error(`chart declaration mismatch: ${chartKey}`);
    for (const field of VERSION_FIELDS) {
      if (chart[field] !== versions[field]) throw new Error(`chart ${field} mismatch: ${chartKey}`);
    }
    loadedCharts.set(chartKey, chart);
  }
  return { status: 'ready', model, charts: loadedCharts, manifest };
}

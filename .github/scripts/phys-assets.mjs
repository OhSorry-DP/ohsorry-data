import { createHash } from 'node:crypto';

const VERSION_FIELDS = ['model_version', 'q_version', 'time_axis_version'];
const LINE_VERSIONS = { model_version: 'phys-line-v1', line_version: 'phys-line-v1', mean_version: 'mean-feature-span-v1' };
const LINE_AXES = ['STAIR_UP', 'STAIR_DN', 'DOUBLE_STAIR', 'KEIMA', 'SPIRAL_UP', 'SPIRAL_DN', 'JUMP_WIDE', 'HSTAIR_SYM', 'HSTAIR_ASYM', 'CN'];
const LINE_V2_VERSIONS = { model_version: 'phys-line-v2', line_version: 'phys-line-v2', mean_version: 'mean-os-pattern-span-v2' };
const LINE_V2_AXES = ['NOTES', 'CHORD', 'PEAK', 'CHARGE', 'SCRATCH', 'PHRASE', 'JACK', 'TRILL', 'RAND', 'STAIR_UP_L', 'STAIR_UP_R', 'STAIR_DN_L', 'STAIR_DN_R', 'K1_L', 'K1_R', 'K2_L', 'K2_R', 'K3_L', 'K3_R', 'K4_L', 'K4_R', 'K5_L', 'K5_R', 'K6_L', 'K6_R', 'K7_L', 'K7_R', 'DOUBLE_STAIR_L', 'DOUBLE_STAIR_R', 'KEIMA_L', 'KEIMA_R', 'HSTAIR_ONEHAND', 'HSTAIR_SYNC', 'HSTAIR_SAMESHAPE', 'HSTAIR_DIFFSHAPE'];
const LINE_V2_UNITS = Object.freeze(Object.fromEntries(LINE_V2_AXES.map(axis => [axis, ['HSTAIR_SYNC', 'HSTAIR_SAMESHAPE', 'HSTAIR_DIFFSHAPE'].includes(axis) ? 'notes/s/both-hands' : 'notes/s/hand'])));
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
  const { content_hash, ...withoutHash } = value;
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

function validateHash(asset, raw, entry, label) {
  if (typeof entry?.file_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.file_sha256)) {
    throw new Error(`${label}: file_sha256 missing or invalid`);
  }
  // 파일 해시는 매니페스트에 있으며 직렬화 전 객체가 아닌 업로드 원문을 검증한다.
  if (sha256(raw) !== entry.file_sha256) throw new Error(`${label}: file_sha256 mismatch`);
  if (typeof asset.content_hash !== 'string' || !/^[a-f0-9]{64}$/.test(asset.content_hash)) {
    throw new Error(`${label}: content_hash missing or invalid`);
  }
  if (contentHash(asset) !== asset.content_hash) throw new Error(`${label}: content_hash mismatch`);
}

function validateLineModel(model, label, modelVersion) {
  // 게시된 모델은 실력선 설정 자체이며 기존 중첩 설정도 읽을 수 있다.
  const config = model.schema_version === 'phys-line-config/1' ? model : model.line_config;
  if (!config || config.schema_version !== 'phys-line-config/1') throw new Error(`${label}: line config mismatch`);
  const v2 = modelVersion === 'phys-line-v2';
  const expectedVersions = v2 ? LINE_V2_VERSIONS : LINE_VERSIONS;
  const axes = v2 ? LINE_V2_AXES : LINE_AXES;
  for (const [field, expected] of Object.entries(expectedVersions)) if (config[field] !== expected) throw new Error(`${label}: ${field} mismatch`);
  if (!Array.isArray(config.axes) || !sameValue(config.axes, axes)) throw new Error(`${label}: immutable line config mismatch`);
  if (v2 && !sameValue(config.units, LINE_V2_UNITS)) throw new Error(`${label}: immutable line units mismatch`);
  for (const field of ['q_version', 'time_axis_version']) if (config[field] !== model[field]) throw new Error(`${label}: ${field} mismatch`);
  if (typeof config.content_hash !== 'string' || !/^[a-f0-9]{64}$/.test(config.content_hash) || contentHash(config) !== config.content_hash) throw new Error(`${label}: line config content_hash mismatch`);
  if (model.schema_version === 'phys-line-config/1') return;
  if (!model.mean || typeof model.mean !== 'object') throw new Error(`${label}: mean assets missing`);
  for (const axis of axes) {
    const mean = model.mean[axis];
    if (v2) {
      if (!mean || !Number.isFinite(mean.meanNps) || mean.meanNps < 0 || Object.keys(mean).some(field => !['meanNps'].includes(field))) throw new Error(`${label}: invalid mean ${axis}`);
    } else if (!mean || !['meanNps', 'meanDuration'].every(field => mean[field] === null || (typeof mean[field] === 'number' && Number.isFinite(mean[field]) && mean[field] >= 0))) throw new Error(`${label}: invalid mean ${axis}`);
  }
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
    for (const field of VERSION_FIELDS) {
      const declared = entry.version_tuple?.[field] ?? entry[field];
      if (declared !== undefined && declared !== (manifest.versions || manifest)[field]) throw new Error(`chart ${field} mismatch: ${chartKey}`);
    }
    result.push([chartKey, entry]);
  }
  return result;
}

async function defaultGetText(key) {
  const client = await import('./r2-client.mjs');
  if (!client.useRest) throw new Error('R2 REST credentials required for physical asset loading');
  try {
    // 키에 포함된 리터럴 %도 HTTP 경로에서 인코딩해야 실제 업로드 키를 조회한다.
    const reader = client.conditionalR2Client({ account: process.env.CLOUDFLARE_ACCOUNT_ID || '607eea1b073bea6747e6e9b76f2d7b41',
      token: process.env.CLOUDFLARE_R2_TOKEN || process.env.CLOUDFLARE_API_TOKEN });
    const raw = (await reader.read(key))?.body ?? null;
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
  let bundled;
  if (manifest.bundle !== undefined) {
    const entry = manifest.bundle;
    if (entry?.key !== `phys/bundle/${modelVersion}.json` || !/^[a-f0-9]{64}$/.test(entry.file_sha256 || '') || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1) throw new Error('manifest bundle declaration invalid');
    const raw = await source(entry.key);
    const { parsed: bundle } = parseAsset(raw, `bundle ${entry.key}`);
    if (sha256(raw) !== entry.file_sha256) throw new Error('bundle file_sha256 mismatch');
    if (Buffer.byteLength(raw, 'utf8') !== entry.bytes) throw new Error('bundle bytes mismatch');
    // 실제 빌더 번들은 자산 버전 3종(model·q·time_axis)만 담는다. 번들이 가진 키는 전부 일치해야 하고 3종은 필수다.
    const bundleVersions = bundle.versions && typeof bundle.versions === 'object' ? bundle.versions : null;
    const versionsOkay = bundleVersions && ['model_version', 'q_version', 'time_axis_version'].every((key) => Object.hasOwn(bundleVersions, key))
      && Object.keys(bundleVersions).every((key) => sameValue(bundleVersions[key], versions[key]));
    if (bundle.schema_version !== 'phys-assets-bundle/1' || !versionsOkay || !Array.isArray(bundle.assets)) throw new Error('bundle schema/version mismatch');
    bundled = new Map();
    const declared = new Map([[modelKey, manifest.model], ...charts.map(([, asset]) => [asset.key, asset])]);
    for (const asset of bundle.assets) {
      const expected = declared.get(asset?.key);
      if (!expected || bundled.has(asset.key) || typeof asset.raw !== 'string' || asset.file_sha256 !== expected.file_sha256 || asset.content_hash !== expected.content_hash) throw new Error('bundle asset declaration mismatch');
      bundled.set(asset.key, asset.raw);
    }
    if (bundled.size !== declared.size) throw new Error('bundle assets missing');
  }
  // 묶음에서도 개별 파일 원문을 사용해 기존 해시 검증을 그대로 유지한다.
  const readAsset = bundled ? async key => bundled.get(key) : source;
  const modelRaw = await readAsset(modelKey);
  const { parsed: model } = parseAsset(modelRaw, `model ${modelKey}`);
  validateHash(model, modelRaw, manifest.model, `model ${modelKey}`);
  for (const [field, expected] of Object.entries(model.schema_version === 'phys-line-config/1' ? {} : MODEL_FIELDS)) {
    if (model[field] !== expected) throw new Error(`model ${field} mismatch`);
  }
  for (const field of VERSION_FIELDS) {
    if (model[field] !== versions[field]) throw new Error(`model ${field} mismatch`);
  }
  validateLineModel(model, `model ${modelKey}`, modelVersion);
  const modelEntry = manifest.model;
  if (!modelEntry || modelEntry.key !== modelKey || modelEntry.content_hash !== model.content_hash) {
    throw new Error('manifest model declaration mismatch');
  }

  const loadedCharts = new Map();
  for (const [chartKey, entry] of charts) {
    const raw = await readAsset(entry.key);
    const { parsed: chart } = parseAsset(raw, `chart ${chartKey} (${entry.key})`);
    validateHash(chart, raw, entry, `chart ${chartKey}`);
    if (chart.schema_version !== CHART_SCHEMA) throw new Error(`chart schema mismatch: ${chartKey}`);
    if (chart.textage_song_id != null && (typeof chart.textage_song_id !== 'string' || !chart.textage_song_id)) throw new Error(`chart Textage identity invalid: ${chartKey}`);
    if (chart.chartKey !== chartKey || entry.content_hash !== chart.content_hash) throw new Error(`chart declaration mismatch: ${chartKey}`);
    for (const field of VERSION_FIELDS) {
      if (chart[field] !== versions[field]) throw new Error(`chart ${field} mismatch: ${chartKey}`);
    }
    const v2 = modelVersion === 'phys-line-v2';
    const axes = v2 ? LINE_V2_AXES : LINE_AXES;
    if (!chart.features || Object.keys(chart.features).length !== axes.length || axes.some(axis => {
      const feature = chart.features[axis];
      if (!feature || !(feature.meanNps === null || typeof feature.meanNps === 'number' && Number.isFinite(feature.meanNps) && feature.meanNps >= 0)) return true;
      if (!v2) return false;
      if (Object.keys(feature).length !== 3 || !['meanNps', 'duration', 'notes'].every(field => Object.hasOwn(feature, field))) return true;
      if (typeof feature.duration !== 'number' || !Number.isFinite(feature.duration) || feature.duration < 0 || !Number.isInteger(feature.notes) || feature.notes < 0) return true;
      // 빌더는 유효 구간 1초 미만이면 노트·시간은 그대로 두고 meanNps 만 null 로 낸다(insufficient_span).
      if (feature.meanNps === null) return feature.duration >= 1;
      return feature.duration < 1 || feature.notes < 1 || Math.abs(feature.meanNps - feature.notes / feature.duration) > 1e-9 * Math.max(1, feature.meanNps);
    })) throw new Error(`chart mean features invalid: ${chartKey}`);
    loadedCharts.set(chartKey, chart);
  }
  return { status: 'ready', model, charts: loadedCharts, manifest };
}

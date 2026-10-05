import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const KEY = (id) => `phys/user/${encodeURIComponent(id)}.json`;
const IMPLEMENTATION = 'phys-user-producer/4';
const DIFFS = { 1: 'NORMAL', 2: 'HYPER', 3: 'ANOTHER', 4: 'LEGGENDARIA' };

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonical(value), 'utf8').digest('hex');
}

function versionsReady(versions) {
  return ['model_version', 'q_version', 'time_axis_version'].every((k) => typeof versions?.[k] === 'string' && versions[k]);
}

function songMapOf(dump) {
  const source = dump?.songMap || dump?.songs;
  if (source instanceof Map) return source;
  if (Array.isArray(source)) return new Map(source.filter((s) => s && s.song_id != null && s.textage_song_id != null)
    .map((s) => [String(s.song_id), String(s.textage_song_id)]));
  if (source && typeof source === 'object') return new Map(Object.entries(source).map(([k, v]) => [String(k),
    String(typeof v === 'object' ? (v.textage_song_id ?? v.songId ?? '') : v)]));
  return new Map();
}

function arrangeMapOf(dump) {
  const values = dump?.chart_arrange || dump?.arrange || [];
  const map = new Map();
  for (const row of Array.isArray(values) ? values : []) {
    if (row?.play_style === 1 && row.song_id != null && Number.isInteger(row.diff)) {
      map.set(`${row.song_id}|${row.diff}`, row.arrange);
    }
  }
  return map;
}

function makeRows(id, dump, charts, counts) {
  if (!Array.isArray(dump?.dp)) throw new TypeError('dump.dp 배열 필요');
  if (!(charts instanceof Map)) throw new TypeError('검증된 채보 Map 필요');
  const songMap = songMapOf(dump), arrangeMap = arrangeMapOf(dump), best = new Map();
  // 정규화 곡명 키와 Textage ID를 구분하고 자산이 선언한 일대일 조인만 허용한다.
  const aliases = new Map();
  for (const chart of charts.values()) {
    if (!chart.textage_song_id) continue;
    const key = `${chart.textage_song_id}|${chart.diff}`;
    if (aliases.has(key) && aliases.get(key)?.chartKey !== chart.chartKey) aliases.set(key, null);
    else if (!aliases.has(key)) aliases.set(key, chart);
  }
  for (const row of dump.dp) {
    if (!row || !Number.isInteger(row.song_id) || !Number.isInteger(row.diff)) { counts.invalid_row++; continue; }
    const diff = DIFFS[row.diff];
    if (!diff) { counts.unsupported_diff++; continue; }
    const textageId = songMap.get(String(row.song_id));
    if (!textageId) { counts.song_mapping_missing++; continue; }
    const lookupKey = `${textageId}|${diff}`;
    const chart = aliases.has(lookupKey) ? aliases.get(lookupKey) : charts.get(lookupKey);
    const chartKey = chart?.chartKey;
    if (!chart || chart.diff !== diff || chartKey !== `${chart.songId}|${diff}` ||
        (chart.textage_song_id ? String(chart.textage_song_id) !== textageId : String(chart.songId) !== textageId)) {
      counts.chart_missing++;
      continue;
    }
    // persona-lib.chartsFromGridRows: numeric lamp passes through; non-numeric becomes 0.
    const lampNum = typeof row.lamp === 'number' ? row.lamp : 0;
    if (!Number.isInteger(lampNum) || lampNum < 1 || lampNum > 7) { counts.invalid_lamp++; continue; }
    const arrange = arrangeMap.get(`${row.song_id}|${row.diff}`) ?? chart.arrange ?? chart.arrange_assumed ?? null;
    const meanFeatures = Object.fromEntries(Object.entries(chart.features || {}).map(([axis, value]) => [axis,
      { meanNps: value?.meanNps ?? null, meanDuration: value?.meanDuration ?? null }]));
    const out = { userId: String(id), songId: String(chart.songId), chartKey, lampNum,
      notes: chart.notes, duration: chart.duration, features: chart.features,
      meanNps: chart.meanNps ?? chart.mean_nps ?? null, meanDuration: chart.meanDuration ?? chart.mean_duration ?? chart.duration ?? null, meanFeatures,
      ...(arrange != null ? { arrange, arrange_assumed: arrange } : { arrangeAssumed: true, arrange_assumed: 'unknown' }),
      ...(chart.provenance ? { chartProvenance: chart.provenance } : {}),
      ...(chart.excludedHands ? { excludedHands: chart.excludedHands } : {}) };
    const previous = best.get(chartKey);
    if (!previous || lampNum > previous.lampNum) best.set(chartKey, out);
  }
  return [...best.values()].sort((a, b) => a.chartKey.localeCompare(b.chartKey));
}

function isReadyFor(previous, id, versions, revision) {
  const absolute = previous?.absolute;
  return previous?.schema_version === 'coach-skill-evidence/1' && previous?.iidx_id === id && previous?.play_style === 'DP' &&
    absolute?.status === 'ready' && absolute.source_revision === revision &&
    absolute.model_version === 'phys-line-v1' && absolute.line_version === 'phys-line-v1' && absolute.mean_version === 'mean-feature-span-v1' &&
    ['q_version', 'time_axis_version'].every((k) => absolute[k] === versions[k]);
}

function staleRecord(previous, id, generatedAt) {
  if (previous?.schema_version === 'coach-skill-evidence/1' && previous?.iidx_id === id && previous?.play_style === 'DP' &&
      previous.absolute && ['ready', 'stale'].includes(previous.absolute.status)) {
    return { ...previous, absolute: { ...previous.absolute, status: 'stale', reason: 'generation_failed', stale: true } };
  }
  return { schema_version: 'coach-skill-evidence/1', iidx_id: id, play_style: 'DP',
    absolute: { status: 'missing', reason: 'not_generated', purpose: 'clear', unit: 'notes/s',
      model_version: null, line_version: null, mean_version: null, q_version: null, time_axis_version: null, source_revision: null,
      generated_at: generatedAt, stale: false, axes: {} } };
}

async function defaultIO() {
  const r2 = await import('./r2-client.mjs');
  if (!r2.useRest) throw new Error('조건부 R2 REST client 설정 없음');
  const client = r2.conditionalR2Client({ account: process.env.CLOUDFLARE_ACCOUNT_ID || '607eea1b073bea6747e6e9b76f2d7b41',
    token: process.env.CLOUDFLARE_R2_TOKEN || process.env.CLOUDFLARE_API_TOKEN });
  return { read: (key) => client.read(key), put: (key, body, etag) => client.put(key, body, etag) };
}

async function loadAssets(versions, manifest, io) {
  const { loadPhysAssets } = await import('./phys-assets.mjs');
  return loadPhysAssets({ versions, manifest, getText: async (key) => {
    const result = await io.read(key);
    return result == null ? null : (typeof result === 'string' ? result : result.body);
  } });
}

export async function producePhysUser({ id, dump, versions, manifest, io, computePhysLine, assets, loadAssets: loadAssetsFn, generatedAt = new Date().toISOString(), dryRun = false }) {
  const key = KEY(String(id));
  const counts = { input_dp: Array.isArray(dump?.dp) ? dump.dp.length : 0, included: 0, invalid_row: 0,
    unsupported_diff: 0, song_mapping_missing: 0, chart_missing: 0, invalid_lamp: 0 };
  if (!versionsReady(versions)) return { status: 'skipped', reason: 'versions_unset', key, source_revision: null, generated_at: generatedAt, changed: false, counts };
  if (manifest?.publishable !== true) return { status: 'skipped', reason: 'assets_unpublished', key, source_revision: null, generated_at: generatedAt, changed: false, counts };
  const client = io || await defaultIO();
  let previousRead;
  try { previousRead = await client.read(key); }
  catch { return { status: 'failed', reason: 'previous_read_failed', key, source_revision: null, generated_at: generatedAt, changed: false, counts }; }
  let previous;
  try { previous = previousRead == null ? null : JSON.parse(typeof previousRead === 'string' ? previousRead : previousRead.body); }
  catch { return { status: 'failed', reason: 'previous_read_failed', key, source_revision: null, generated_at: generatedAt, changed: false, counts }; }
  const etag = previousRead == null ? null : previousRead.etag;
  try {
    const loaded = assets ?? await (loadAssetsFn || loadAssets)(versions, manifest, client);
    if (loaded?.status !== 'ready') throw new Error(loaded?.reason || 'assets_unavailable');
    const rows = makeRows(String(id), dump, loaded.charts, counts);
    counts.included = rows.length;
    const modelHash = loaded.model.content_hash;
    const source_revision = sha256({ rows, versions, assets: [...loaded.charts].filter(([chartKey]) => rows.some((r) => r.chartKey === chartKey))
      .map(([chartKey, chart]) => [chartKey, chart.content_hash]), modelHash, configHash: loaded.model.line_config?.content_hash,
      line_version: loaded.model.line_config?.line_version, mean_version: loaded.model.line_config?.mean_version,
      implementation: 'phys-line-v1', producer: IMPLEMENTATION });
    if (isReadyFor(previous, String(id), versions, source_revision)) return { status: 'ready', reason: null, key, source_revision,
      generated_at: previous.absolute.generated_at, changed: false, counts };
    if (dryRun) return { status: 'planned', reason: null, key, source_revision, generated_at: generatedAt, changed: true, counts };
    const compute = computePhysLine || require('./vendor/physLine.js').computePhysLine;
    const result = compute({ rows });
    // 계산값에 리더 계약의 단위·배치 가정·검증된 자산 출처를 붙인다.
    const axes = Object.fromEntries(Object.entries(result.axes ?? {}).map(([axis, value]) => [axis, {
      ...value,
      unit: value.unit ?? (axis.startsWith('HSTAIR') ? 'notes/s/both-hands' : 'notes/s/hand'),
      arrange_assumed: value.arrange_assumed ?? (rows.length && rows.every(row => row.arrange_assumed === rows[0].arrange_assumed)
        ? rows[0].arrange_assumed : 'unknown'),
      provenance: value.provenance ?? { source: 'phys-assets', model_hash: modelHash, source_revision },
    }]));
    const absolute = { ...result, status: 'ready', purpose: 'clear', unit: 'notes/s', source_revision, generated_at: generatedAt, stale: false,
      axes,
      model_version: result.model_version || loaded.model.line_config.model_version,
      line_version: result.line_version || loaded.model.line_config.line_version, mean_version: result.mean_version || loaded.model.line_config.mean_version };
    const record = { schema_version: 'coach-skill-evidence/1', iidx_id: String(id), play_style: 'DP', absolute };
    await client.put(key, JSON.stringify(record), etag);
    return { status: 'ready', reason: null, key, source_revision, generated_at: generatedAt, changed: true, counts };
  } catch (error) {
    const error_message = String(error?.message || error).slice(0, 200);
    if (error?.status === 412 || /HTTP 412/.test(String(error?.message))) return { status: 'conflict', reason: 'precondition_failed', key, source_revision: null, generated_at: generatedAt, changed: false, counts };
    if (dryRun) return { status: 'failed', reason: 'generation_failed', error_message, key, source_revision: null, generated_at: generatedAt, changed: false, counts };
    const stale = staleRecord(previous, String(id), generatedAt);
    try { await client.put(key, JSON.stringify(stale), etag); }
    catch (writeError) {
      if (writeError?.status === 412 || /HTTP 412/.test(String(writeError?.message))) return { status: 'conflict', reason: 'precondition_failed', key, source_revision: null, generated_at: generatedAt, changed: false, counts };
      return { status: 'failed', reason: 'generation_failed', error_message, key, source_revision: null, generated_at: generatedAt, changed: false, counts };
    }
    return { status: stale.absolute.status, reason: stale.absolute.reason, error_message, key, source_revision: stale.absolute.source_revision,
      generated_at: stale.absolute.generated_at, changed: true, counts };
  }
}

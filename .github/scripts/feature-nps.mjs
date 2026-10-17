import { getText as defaultGetText } from './r2-client.mjs';

export const NPS_FEATS = Object.freeze(['NOTES', 'CHORD', 'PEAK', 'CHARGE', 'SCRATCH', 'PHRASE', 'JACK', 'TRILL', 'RAND']);
const UNITS = Object.freeze({ DP: 'notes/s/hand', SP: 'notes/s/side' });
const VERSIONS = Object.freeze({
  DP: { model_version: 'phys-line-v2', line_version: 'phys-line-v2', mean_version: 'mean-os-pattern-span-v2', key: 'phys/user/' },
  SP: { model_version: 'phys-line-sp-v1', line_version: 'phys-line-sp-v1', mean_version: 'mean-os-pattern-span-sp-v1', key: 'phys/user-sp/' },
});

const empty = () => Object.fromEntries(NPS_FEATS.map(feat => [feat, null]));
const validNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Read one style's stored physical lines and project the nine NPS feature values. */
export function projectFeatureNps(record, id, mode) {
  const style = mode === 'DP' || mode === 'SP' ? mode : null;
  const versions = style && VERSIONS[style];
  if (!versions || !record || typeof record !== 'object' || Array.isArray(record)) return null;
  if (record.schema_version !== 'coach-skill-evidence/1' || record.iidx_id !== String(id) ||
      record.play_style !== style || !record.absolute || typeof record.absolute !== 'object' ||
      record.absolute.status !== 'ready' || record.absolute.stale === true ||
      record.absolute.model_version !== versions.model_version || record.absolute.line_version !== versions.line_version ||
      record.absolute.mean_version !== versions.mean_version || !record.absolute.axes || typeof record.absolute.axes !== 'object') return null;

  const out = empty();
  for (const feat of NPS_FEATS) {
    const axis = record.absolute.axes[feat];
    if (axis?.unit !== UNITS[style]) continue;
    if (validNumber(axis.line)) out[feat] = axis.line;
  }
  return out;
}

/** Load DP and SP evidence sequentially; missing objects map to null. */
export async function loadFeatureNps(id, { getText = defaultGetText } = {}) {
  const result = { DP: null, SP: null };
  for (const style of ['DP', 'SP']) {
    const { key } = VERSIONS[style];
    const raw = await getText(`${key}${encodeURIComponent(String(id))}.json`);
    if (raw == null) continue;
    const record = JSON.parse(raw);
    result[style] = projectFeatureNps(record, id, style);
  }
  return result;
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const FEATURES = ['notes', 'chord', 'peak', 'charge', 'scratch', 'soflan', 'phrase', 'jack', 'trill', 'rand',
  'stair_up_l', 'stair_up_r', 'stair_dn_l', 'stair_dn_r', 'k1_l', 'k1_r', 'k2_l', 'k2_r', 'k3_l', 'k3_r',
  'k4_l', 'k4_r', 'k5_l', 'k5_r', 'k6_l', 'k6_r', 'k7_l', 'k7_r', 'double_stair_l', 'double_stair_r',
  'keima_l', 'keima_r', 'hstair_onehand', 'hstair_sync', 'hstair_sameshape', 'hstair_diffshape', 'hands'];
const SP_FEATURES = new Set(FEATURES.slice(0, 10));
const USER_COLUMNS = ['iidx_id', 'dj_name', 'star', 'native_star', 'r_star', 'ereter_star', 'sp_rank', 'dp_rank',
  'plays', 'sp_cpi', 'sp_star', 'sp_r_star', 'sp_r_star_model_id', 'sp_r_star_formula_version'];
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const numeric = (value, label) => {
  if (value === null) return;
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim() !== '')) throw new TypeError(`${label} must be a finite number or null`);
  if (!Number.isFinite(Number(value))) throw new TypeError(`${label} must be a finite number or null`);
};
const norm = (value) => value === null ? null : Number(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function validate(id, dump) {
  if (typeof id !== 'string' || !id || !dump || typeof dump !== 'object' || Array.isArray(dump) ||
      !dump.user || typeof dump.user !== 'object' || Array.isArray(dump.user) || !Array.isArray(dump.osPattern)) {
    throw new TypeError('dump must contain user object and osPattern array');
  }
  if (String(dump.user.iidx_id) !== id) throw new TypeError('dump user iidx_id does not match id');
  for (const key of ['star', 'native_star', 'r_star', 'sp_cpi', 'sp_star', 'sp_r_star']) {
    if (!own(dump.user, key)) throw new TypeError(`dump user missing ${key}`);
    numeric(dump.user[key], `user.${key}`);
  }
  for (const key of ['sp_r_star_model_id', 'sp_r_star_formula_version']) {
    if (!own(dump.user, key) || (dump.user[key] !== null && typeof dump.user[key] !== 'string')) throw new TypeError(`user.${key} must be a string or null`);
  }
  const tuple = [dump.user.sp_r_star, dump.user.sp_r_star_model_id, dump.user.sp_r_star_formula_version];
  if (!(tuple.every((x) => x === null) || (typeof tuple[1] === 'string' && tuple[1] && typeof tuple[2] === 'string' && tuple[2]))) {
    throw new TypeError('sp_r_star tuple must be all NULL or include model and formula versions');
  }
  const seen = new Set();
  for (const row of dump.osPattern) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || String(row.iidx_id) !== id || ![0, 1].includes(Number(row.play_style))) {
      throw new TypeError('osPattern row has invalid iidx_id or play_style');
    }
    const style = Number(row.play_style);
    if (seen.has(style)) throw new TypeError(`duplicate osPattern play_style ${style}`);
    seen.add(style);
    for (const feat of FEATURES) {
      const key = feat;
      if (!own(row, key)) throw new TypeError(`osPattern missing ${key}`);
      numeric(row[key], `osPattern.${key}`);
    }
  }
}

function finiteRow(row, keys) {
  for (const key of keys) {
    if (!(key in row)) throw new TypeError(`database row missing ${key}`);
    if (['plays', 'dj_name', 'iidx_id', 'sp_r_star_model_id', 'sp_r_star_formula_version'].includes(key)) continue;
    numeric(row[key], `database.${key}`);
  }
}

function userPayload(id, current, user) {
  return {
    p_iidx_id: id, p_dj_name: current.dj_name, p_star: user.star, p_ereter_star: current.ereter_star,
    p_sp_rank: current.sp_rank, p_dp_rank: current.dp_rank, p_native_star: user.native_star,
    p_sp_cpi: user.sp_cpi, p_sp_star: user.sp_star, p_r_star: user.r_star, p_plays: current.plays,
    p_sp_r_star: user.sp_r_star, p_sp_r_star_model_id: user.sp_r_star_model_id,
    p_sp_r_star_formula_version: user.sp_r_star_formula_version,
  };
}

function effectiveUser(current, payload) {
  const out = {};
  for (const [key, arg] of [['star', 'p_star'], ['dj_name', 'p_dj_name'], ['ereter_star', 'p_ereter_star'],
    ['sp_rank', 'p_sp_rank'], ['dp_rank', 'p_dp_rank'], ['native_star', 'p_native_star'], ['sp_cpi', 'p_sp_cpi'],
    ['sp_star', 'p_sp_star'], ['r_star', 'p_r_star'], ['plays', 'p_plays']]) {
    out[key] = payload[arg] === null ? current[key] : payload[arg];
  }
  const nullTuple = payload.p_sp_r_star === null && payload.p_sp_r_star_model_id === null && payload.p_sp_r_star_formula_version === null;
  if (nullTuple) {
    for (const k of ['sp_r_star', 'sp_r_star_model_id', 'sp_r_star_formula_version']) out[k] = current[k];
  } else {
    const same = current.sp_r_star_model_id === payload.p_sp_r_star_model_id && current.sp_r_star_formula_version === payload.p_sp_r_star_formula_version;
    const oldVal = norm(current.sp_r_star), nextVal = norm(payload.p_sp_r_star);
    out.sp_r_star = same && oldVal !== null && nextVal !== null ? Math.max(oldVal, nextVal) : nextVal;
    out.sp_r_star_model_id = payload.p_sp_r_star_model_id;
    out.sp_r_star_formula_version = payload.p_sp_r_star_formula_version;
  }
  return out;
}

async function request(fetchImpl, url, init, target) {
  let response;
  try { response = await fetchImpl(url, init); } catch (error) { throw Object.assign(new Error(`${target}: ${error.message}`), { cause: error }); }
  if (!response.ok) {
    let body = '';
    try { body = (await response.text()).slice(0, 1000); } catch {}
    throw new Error(`${target} HTTP ${response.status}${body ? `: ${body}` : ''}`);
  }
  if (response.status === 204) return null;
  const body = await response.text();
  if (!body) return null;
  try { return JSON.parse(body); } catch (error) { throw new Error(`${target} returned invalid JSON: ${error.message}`); }
}

export async function writeOfficialUser(id, dump, { fetchImpl = globalThis.fetch, supabaseUrl, serviceRoleKey,
  preparing = process.env.SCORE_BUFFER_PREPARE === '1' } = {}) {
  if (!preparing) return { skipped: true };
  validate(id, dump);
  const base = (supabaseUrl ?? process.env.SUPABASE_URL)?.replace(/\/$/, '');
  const key = serviceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const errors = [], stylesWritten = [];
  let usersWritten = false;
  let current = null, radarRows = null;
  try {
    const rows = await request(fetchImpl, `${base}/rest/v1/users?iidx_id=eq.${encodeURIComponent(id)}&select=${USER_COLUMNS.join(',')}`,
      { headers }, 'users GET');
    if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== 'object' || Array.isArray(rows[0])) throw new TypeError('users GET must return exactly one object row');
    finiteRow(rows[0], USER_COLUMNS);
    current = rows[0];
  } catch (error) { errors.push(error); }
  try {
    const rows = await request(fetchImpl, `${base}/rest/v1/user_ohsorry_radars?iidx_id=eq.${encodeURIComponent(id)}&select=iidx_id,play_style,${FEATURES.join(',')}`,
      { headers }, 'user_ohsorry_radars GET');
    if (!Array.isArray(rows)) throw new TypeError('radars GET must return an array');
    for (const row of rows) {
      if (!row || typeof row !== 'object' || ![0, 1].includes(Number(row.play_style))) throw new TypeError('radars GET returned invalid row');
      for (const feat of FEATURES) numeric(row[feat], `radars.${feat}`);
    }
    radarRows = rows;
  } catch (error) { errors.push(error); }

  if (current) {
    const payload = userPayload(id, current, dump.user);
    const desired = effectiveUser(current, payload);
    const changed = Object.keys(desired).some((k) => ['plays', 'dj_name', 'sp_r_star_model_id', 'sp_r_star_formula_version'].includes(k)
      ? !equal(desired[k], current[k]) : norm(desired[k]) !== norm(current[k]));
    if (changed) {
      try {
        await request(fetchImpl, `${base}/rest/v1/rpc/upsert_user`, { method: 'POST', headers, body: JSON.stringify(payload) }, 'upsert_user');
        usersWritten = true;
      } catch (error) { errors.push(error); }
    }
  }

  if (radarRows) {
    for (const row of dump.osPattern) {
      const style = Number(row.play_style), prior = radarRows.find((x) => Number(x.play_style) === style);
      const values = Object.fromEntries(FEATURES.map((f) => [f, style === 0 && !SP_FEATURES.has(f) ? null : row[f]]));
      const changed = prior ? FEATURES.some((f) => values[f] !== null && norm(values[f]) !== norm(prior[f])) : FEATURES.some((f) => values[f] !== null);
      if (!changed) continue;
      const args = { p_iidx_id: id, ...Object.fromEntries(FEATURES.map((f) => [`p_os_${f}`, values[f]])), p_play_style: style };
      try {
        await request(fetchImpl, `${base}/rest/v1/rpc/upsert_user_feature_score`, { method: 'POST', headers, body: JSON.stringify(args) }, `upsert_user_feature_score style ${style}`);
        stylesWritten.push(style);
      } catch (error) { errors.push(error); }
    }
  }
  if (errors.length) throw new AggregateError(errors, `Official user write failed for ${id}`);
  return { skipped: false, usersWritten, stylesWritten };
}

async function main() {
  const [id, dumpPath] = process.argv.slice(2);
  if (!id || !dumpPath || !path.isAbsolute(dumpPath)) throw new Error('usage: write-official-user.mjs <id> <absolute dump JSON path>');
  if (process.env.SCORE_BUFFER_PREPARE !== '1') return { skipped: true };
  let dump;
  try { dump = JSON.parse(await fs.readFile(dumpPath, 'utf8')); } catch (error) { throw new Error(`dump read: ${error.message}`); }
  const result = await writeOfficialUser(id, dump, { preparing: true });
  console.log(JSON.stringify(result));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`write-official-user id=${process.argv[2] ?? ''} stage=write error=${error.message}`); process.exitCode = 1; });
}

const FAST_FIELDS = ['dp', 'sp', 'dpRecent', 'spRecent'];
const FAST_KEYS = [...FAST_FIELDS, 'fastGeneration'];
const SLOW_FIELDS = ['_v', 'user', 'radars', 'osPattern', 'persona', 'spPersona', 'reachNps'];
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function generationOf(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return null;
  try { return BigInt(value); } catch { return null; }
}

function copyFields(target, source, fields) {
  for (const field of fields) if (own(source, field)) target[field] = source[field];
  return target;
}

/** Merge an Edge fast patch only when the current generation permits it. */
export function mergeEdgeUser(current, patch, generation) {
  if (!object(current) || !object(patch)) return { ok: false, reason: 'invalid-user' };
  const incoming = generationOf(generation);
  if (incoming === null || patch.fastGeneration !== generation
    || FAST_KEYS.some((key) => !own(patch, key))
    || Object.keys(patch).some((key) => !FAST_KEYS.includes(key))) return { ok: false, reason: 'invalid-patch' };
  const existing = own(current, 'fastGeneration') ? generationOf(current.fastGeneration) : null;
  if (own(current, 'fastGeneration') && existing === null) return { ok: false, reason: 'invalid-current-generation' };
  if (existing !== null && existing > incoming) return { ok: false, reason: 'newer-generation' };
  if (existing === incoming) {
    const same = FAST_FIELDS.every((key) => JSON.stringify(current[key]) === JSON.stringify(patch[key]));
    return same ? { ok: true, changed: false, value: current } : { ok: false, reason: 'generation-conflict' };
  }
  return { ok: true, changed: true, value: copyFields({ ...current }, patch, FAST_KEYS) };
}

/** Keep newer origin fast values while applying the captured Actions result. */
export function mergeActionsUser(current, local, capturedGeneration) {
  if (!object(current) || !object(local)) throw new TypeError('user must be objects');
  const captured = generationOf(capturedGeneration);
  const currentGeneration = own(current, 'fastGeneration') ? generationOf(current.fastGeneration) : null;
  if (own(current, 'fastGeneration') && currentGeneration === null) throw new TypeError('invalid current fastGeneration');
  const out = copyFields({ ...current }, local, SLOW_FIELDS);
  if (captured === null) {
    if (currentGeneration === null) copyFields(out, local, FAST_FIELDS);
    return out;
  }
  if (currentGeneration !== null && currentGeneration >= captured) return out;
  copyFields(out, local, FAST_FIELDS);
  out.fastGeneration = capturedGeneration;
  return out;
}

/** Apply only the established slow-field allowlist; preserve fast and unknown data. */
export function mergeSlowUser(current, local) {
  if (!object(current) || !object(local)) throw new TypeError('user must be objects');
  const out = { ...current };
  for (const field of SLOW_FIELDS) {
    if (!own(local, field)) continue;
    if (field === 'user' && object(current.user) && object(local.user)) out.user = { ...current.user, ...local.user };
    else out[field] = local[field];
  }
  return out;
}

function parseBody(source) {
  if (!source || typeof source.body !== 'string' || typeof source.etag !== 'string'
    || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(source.etag)) return null;
  try {
    const value = JSON.parse(source.body);
    return object(value) ? value : null;
  } catch { return null; }
}

/** Publish against injected read/put primitives. Each object receives at most one PUT. */
export async function publishUserPatch({ r2, id, patch, generation, since, now = () => new Date().toISOString(), validateSnapshots = () => true }) {
  if (!r2 || typeof r2.read !== 'function' || typeof r2.put !== 'function') throw new TypeError('r2 read/put required');
  const userKey = `user/${encodeURIComponent(String(id))}.json`;
  const pendingKey = `pending/${encodeURIComponent(String(id))}.json`;
  let source, pendingSource;
  try { [source, pendingSource] = await Promise.all([r2.read(userKey), r2.read(pendingKey)]); }
  catch { return { ok: false, reason: 'read-failed' }; }
  const current = parseBody(source), pending = parseBody(pendingSource);
  const g = generationOf(generation);
  if (!current || !pending || g === null || pending.generation !== generation || pending.since !== since
    || !validateSnapshots()) return { ok: false, reason: 'invalid-snapshot' };
  const merged = mergeEdgeUser(current, patch, generation);
  if (!merged.ok) return merged;
  let changed = merged.changed;
  if (changed) {
    try { await r2.put(userKey, JSON.stringify(merged.value), source.etag); }
    catch { return { ok: false, reason: 'user-put-failed' }; }
  }
  let latestSource;
  try { latestSource = await r2.read(pendingKey); } catch { return { ok: true, changed, done: false, reason: 'pending-reread-failed' }; }
  const latest = parseBody(latestSource);
  if (!latest || latest.generation !== generation || latest.since !== since) return { ok: true, changed, done: false, reason: 'pending-changed' };
  const serverTime = Date.parse(now()), sinceTime = Date.parse(since);
  if (!Number.isFinite(serverTime) || !Number.isFinite(sinceTime)) return { ok: true, changed, done: false, reason: 'invalid-time' };
  const done = new Date(Math.max(serverTime, sinceTime)).toISOString();
  const doneBody = JSON.stringify({ ...latest, done });
  try { await r2.put(pendingKey, doneBody, latestSource.etag); }
  catch { return { ok: true, changed, done: false, reason: 'done-put-failed' }; }
  return { ok: true, changed, done: true, value: merged.value };
}

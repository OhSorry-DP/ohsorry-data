import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
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

const ACCOUNT = '607eea1b073bea6747e6e9b76f2d7b41';
const BUCKET = 'ohsorry-data';
const validSince = (value) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const validGeneration = (value) => generationOf(value) !== null;
const validEtag = (value) => typeof value === 'string' && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value);

export const HIST_LEASE_MS = 15000;
const validRevision = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const revisionOf = (body) => createHash('sha256').update(body, 'utf8').digest('hex');
const leaseKey = (id) => {
  if (typeof id !== 'string' || !/^[A-Za-z0-9]+$/.test(id)) throw new TypeError('invalid hist ID');
  return `meta/fast-hist-lease-${id}.json`;
};
const isConflict = (error) => error?.status === 412 || /\b412\b/.test(String(error?.message || error));
const clock = (now) => {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('invalid lease clock');
  return value;
};

/** Callers opt in explicitly; importing this module never enables history writes. */
export function histGuardEnabled(env = {}) {
  return env.FAST_DUMP_HIST_GUARD === '1';
}

/** One acquisition attempt, with no polling or retries on a busy/uncertain lease. */
export async function acquireHistLease({ r2, id, enabled = false, now = Date.now, token = randomUUID() }) {
  if (enabled !== true) return { ok: false, reason: 'disabled' };
  const key = leaseKey(id);
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(token)) throw new TypeError('invalid lease token');
  try {
    const source = await r2.read(key);
    const current = source === null ? {} : parseBody(source);
    if (!current || (source !== null && (typeof current.token !== 'string' || !validSince(current.expiresAt))))
      return { ok: false, reason: 'invalid-lease' };
    const time = clock(now);
    if (source !== null && Date.parse(current.expiresAt) > time) return { ok: false, reason: 'lease-busy' };
    const expiresAt = new Date(time + HIST_LEASE_MS).toISOString();
    await r2.put(key, JSON.stringify({ ...current, token, expiresAt }), source === null ? null : source.etag);
    return { ok: true, lease: Object.freeze({ key, token, expiresAt }) };
  } catch (error) {
    return { ok: false, reason: isConflict(error) ? 'lease-conflict' : 'lease-failed' };
  }
}

/** This check is not atomic with another object's PUT; history CAS is the fence. */
export async function assertHistLease({ r2, id, lease, now = Date.now }) {
  if (!lease || lease.key !== leaseKey(id) || !validSince(lease.expiresAt)
    || Date.parse(lease.expiresAt) <= clock(now)) throw new Error('hist lease expired or lost');
  const source = await r2.read(lease.key);
  const current = parseBody(source);
  if (!current || current.token !== lease.token || current.expiresAt !== lease.expiresAt
    || Date.parse(current.expiresAt) <= clock(now)) throw new Error('hist lease expired or lost');
  return { source, current };
}

/** Release only our still-live token, using the latest lease ETag. Never delete. */
export async function releaseHistLease({ r2, id, lease, now = Date.now }) {
  try {
    const { source, current } = await assertHistLease({ r2, id, lease, now });
    await r2.put(lease.key, JSON.stringify({ ...current, expiresAt: new Date(clock(now)).toISOString() }), source.etag);
    return { ok: true };
  } catch { return { ok: false, reason: 'lease-release-failed' }; }
}

/**
 * r2 must be an S3 identity-GET/conditional-PUT adapter: null means only GET 404;
 * put(key, body, null) means If-None-Match:*, otherwise If-Match. PUT retries=0.
 * prepare must use the canonical alias normalization and replay, without I/O.
 * On 412 rebuild from current history and the original buffer, never stale bytes.
 * Success retains the lease for user/pending publication; failure leaves it to expire.
 */
export async function publishHistWithLease({ r2, id, restRows, prepare, enabled = false,
  allowCreate = false, now = Date.now, token = randomUUID() }) {
  if (enabled !== true) return { ok: false, reason: 'disabled' };
  if (!Array.isArray(restRows) || typeof prepare !== 'function') throw new TypeError('hist inputs required');
  const originalRows = structuredClone(restRows);
  const acquired = await acquireHistLease({ r2, id, enabled, now, token });
  if (!acquired.ok) return acquired;
  const { lease } = acquired;
  const key = `hist/${id}.json`;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      await assertHistLease({ r2, id, lease, now });
      const source = await r2.read(key);
      if (source === null && !allowCreate) throw new Error('hist missing');
      if (source !== null && (typeof source.body !== 'string' || !validEtag(source.etag))) throw new Error('invalid hist origin');
      const previousHistRows = source === null ? [] : JSON.parse(source.body);
      if (!Array.isArray(previousHistRows)) throw new Error('invalid hist rows');
      await assertHistLease({ r2, id, lease, now });
      const prepared = await prepare({ previousHistRows, restRows: structuredClone(originalRows) });
      if (!prepared || !Array.isArray(prepared.histRows) || !(prepared.histBytes instanceof Uint8Array))
        throw new Error('invalid prepared hist');
      const body = new TextDecoder('utf-8', { fatal: true }).decode(prepared.histBytes);
      if (body !== JSON.stringify(prepared.histRows)) throw new Error('prepared hist bytes differ');
      const histRevision = revisionOf(body);
      await assertHistLease({ r2, id, lease, now });
      const changed = source === null || source.body !== body;
      if (changed) {
        try { await r2.put(key, body, source === null ? null : source.etag); }
        catch (error) {
          if (!isConflict(error)) return { ok: false, reason: 'hist-put-uncertain' };
          if (attempt === 2) return { ok: false, reason: 'hist-conflict-exhausted' };
          continue;
        }
      }
      await assertHistLease({ r2, id, lease, now });
      const downloaded = await r2.read(key);
      if (!downloaded || !validEtag(downloaded.etag) || downloaded.body !== body)
        return { ok: false, reason: 'hist-readback-mismatch' };
      await assertHistLease({ r2, id, lease, now });
      return { ok: true, changed, lease, histRevision, histEtag: downloaded.etag,
        histRows: prepared.histRows, histBytes: new TextEncoder().encode(body), prepared };
    }
  } catch { return { ok: false, reason: 'hist-validation-failed' }; }
}

/** Only a caller holding a live lease and verified current hist may use this merge. */
export function mergeHistUser(current, patch, generation, histRevision) {
  const keys = [...FAST_KEYS, 'histRevision'];
  if (!object(current) || !object(patch)) return { ok: false, reason: 'invalid-user' };
  const incoming = generationOf(generation);
  if (incoming === null || !validRevision(histRevision) || patch.histRevision !== histRevision
    || patch.fastGeneration !== generation || keys.some((key) => !own(patch, key))
    || Object.keys(patch).some((key) => !keys.includes(key))) return { ok: false, reason: 'invalid-patch' };
  const existing = own(current, 'fastGeneration') ? generationOf(current.fastGeneration) : null;
  if (own(current, 'fastGeneration') && existing === null) return { ok: false, reason: 'invalid-current-generation' };
  if (existing !== null && existing > incoming) return { ok: false, reason: 'newer-generation' };
  if (existing === incoming && current.histRevision === histRevision) {
    const same = FAST_FIELDS.every((key) => JSON.stringify(current[key]) === JSON.stringify(patch[key]));
    return same ? { ok: true, changed: false, value: current } : { ok: false, reason: 'generation-conflict' };
  }
  return { ok: true, changed: true, value: copyFields({ ...current }, patch, keys) };
}

/** Completion is evidence of both verified hist and user, never hist PUT alone. */
export function mergeHistPending(current, { generation, since, histRevision, done }) {
  if (!object(current) || !validGeneration(generation) || !validSince(since) || !validSince(done)
    || !validRevision(histRevision)) return { ok: false, reason: 'invalid-completion' };
  if (current.generation !== generation || current.since !== since) return { ok: false, reason: 'pending-changed' };
  const completedAt = new Date(Math.max(Date.parse(since), Date.parse(done),
    validSince(current.done) ? Date.parse(current.done) : 0)).toISOString();
  return { ok: true, value: { ...current, done: completedAt, viewGeneration: generation, histRevision } };
}

/** Actions publisher with generation capture and bounded compare-and-swap retries. */
export async function publishActionsUser({ r2, id, local, generation }) {
  const key = `user/${id}.json`;
  let source;
  for (let attempt = 0; attempt < 4; attempt++) {
    source = await r2.read(key);
    if (source === null) {
      if (attempt !== 0) throw new Error('user disappeared during CAS');
      const value = { ...local };
      delete value.fastGeneration;
      if (generation !== null) value.fastGeneration = generation;
      try { await r2.put(key, JSON.stringify(value), null); return value; }
      catch (error) { if (String(error?.message || error).includes('412')) continue; throw error; }
    }
    const current = parseBody(source);
    if (!current) throw new Error('invalid origin user or ETag');
    const merged = mergeActionsUser(current, local, generation);
    try { await r2.put(key, JSON.stringify(merged), source.etag); return merged; }
    catch (error) { if (String(error?.message || error).includes('412') && attempt < 3) continue; throw error; }
  }
  throw new Error('user CAS conflict exhausted');
}

export async function runCli(argv, dependencies = {}) {
  const [command, id, ...extra] = argv;
  if (!['capture-generation', 'publish-actions-user', 'complete-actions-pending'].includes(command)
    || !id || extra.length || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return 2;
  const env = dependencies.env || process.env;
  if (!env.CLOUDFLARE_R2_ACCESS_KEY_ID || !env.CLOUDFLARE_R2_SECRET_ACCESS_KEY) return 2;
  const append = dependencies.appendFile || ((file, data) => import('node:fs/promises').then(m => m.appendFile(file, data)));
  const readFile = dependencies.readFile || ((file) => import('node:fs/promises').then(m => m.readFile(file, 'utf8')));
  const createClient = dependencies.createClient || (async () => {
    const { s3R2Client } = await import('./r2-client.mjs');
    return s3R2Client({ account: ACCOUNT, bucket: BUCKET, accessKeyId: env.CLOUDFLARE_R2_ACCESS_KEY_ID,
      secretAccessKey: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY, retries: 0 });
  });
  const r2 = await createClient({ account: ACCOUNT, bucket: BUCKET,
    accessKeyId: env.CLOUDFLARE_R2_ACCESS_KEY_ID, secretAccessKey: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY, retries: 0 });
  const pendingKey = `pending/${id}.json`;
  const get = async (key) => {
    const response = await r2.request(key);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`R2 GET HTTP ${response.status}`);
    return { body: await response.text(), etag: response.headers.get('etag') };
  };
  const put = async (key, body, etag) => {
    const response = await r2.request(key, { method: 'PUT', body,
      headers: { 'Content-Type': 'application/json', ...(etag === null ? { 'If-None-Match': '*' } : { 'If-Match': etag }) } });
    if (response.status !== 412 && !response.ok) throw new Error(`R2 PUT HTTP ${response.status}`);
    if (response.status === 412) throw new Error('HTTP 412');
  };
  if (command === 'capture-generation') {
    if (!env.GITHUB_ENV) return 2;
    const source = await get(pendingKey);
    let generation = '', since = '', captured = '0';
    if (source !== null) {
      let marker;
      try { marker = JSON.parse(source.body); } catch { return 2; }
      if (!object(marker) || (own(marker, 'generation') && !validGeneration(marker.generation))
        || (own(marker, 'since') && !validSince(marker.since))) return 2;
      captured = '1'; generation = marker.generation || ''; since = marker.since || '';
    }
    await append(env.GITHUB_ENV, `FAST_DUMP_MARKER_CAPTURED=${captured}\nFAST_DUMP_GENERATION=${generation}\nFAST_DUMP_SINCE=${since}\n`);
    return 0;
  }
  if (command === 'publish-actions-user') {
    let local;
    try { local = JSON.parse(await readFile(`user/${id}.json`)); } catch { return 2; }
    if (!object(local)) return 2;
    const generation = env.FAST_DUMP_MARKER_CAPTURED === '1' && validGeneration(env.FAST_DUMP_GENERATION) ? env.FAST_DUMP_GENERATION : null;
    await publishActionsUser({ r2: { read: get, put }, id, local, generation });
    return 0;
  }
  if (env.FAST_DUMP_MARKER_CAPTURED !== '1' || !validSince(env.FAST_DUMP_SINCE)) return 0;
  const source = await get(pendingKey);
  if (!source) return 0;
  if (!validEtag(source.etag)) throw new Error('pending ETag missing');
  let marker;
  try { marker = JSON.parse(source.body); } catch { throw new Error('invalid pending JSON'); }
  if (!object(marker) || (own(marker, 'generation') && !validGeneration(marker.generation)) || !validSince(marker.since)) throw new Error('invalid pending marker');
  const capturedG = env.FAST_DUMP_GENERATION || null;
  if (marker.generation !== (capturedG || undefined) || marker.since !== env.FAST_DUMP_SINCE) return 0;
  const now = (dependencies.now || (() => new Date().toISOString()))();
  if (!validSince(now)) throw new Error('invalid completion time');
  const old = validSince(marker.done) ? marker.done : '';
  const done = Date.parse(old) > Date.parse(now) ? old : (Date.parse(now) > Date.parse(marker.since) ? now : marker.since);
  await put(pendingKey, JSON.stringify({ ...marker, done }), source.etag);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error?.message || String(error)); process.exitCode = 1;
  });
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

import { createHash } from 'node:crypto';
import { fetchAllUsers } from './dump-users-list.mjs';
import { createRequestGate, getText, listEntries, pool } from './r2-client.mjs';
import { normalizeAliasInputs, validateAliases } from './song-aliases.mjs';

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sha256 = (body) => createHash('sha256').update(body, 'utf8').digest('hex');

// All injected R2 readers receive the same gate, including helper retries.
// getText(key, options) -> string|null; listEntries(prefix, options) -> all pages.
// pool(items, concurrency, callback), hash(UTF8 body) -> digest string.
function dependencies(deps) {
  const requestGate = deps.requestGate ?? createRequestGate();
  const options = { ...deps.r2Options, requestGate, retry: true };
  if (deps.fetchImpl) options.fetchImpl = deps.fetchImpl;
  const read = deps.getText ?? getText;
  const list = deps.listEntries ?? listEntries;
  return {
    users: () => (deps.fetchAllUsers ?? fetchAllUsers)({
      fetchImpl: deps.fetchImpl, supabaseUrl: deps.supabaseUrl, serviceKey: deps.serviceKey,
    }),
    read: (key) => read(key, options),
    list: () => list('hist/', options),
    pool: deps.pool ?? pool,
    hash: deps.hash ?? sha256,
    log: deps.log,
  };
}

async function readJson(source, key) {
  const body = await source.read(key);
  if (typeof body !== 'string') throw new Error(`Missing or invalid R2 body: ${key}`);
  let value;
  try { value = JSON.parse(body); }
  catch { throw new Error(`Invalid JSON: ${key}`); }
  return { body, value, bytes: Buffer.byteLength(body, 'utf8') };
}

function validateUsers(users) {
  if (!Array.isArray(users) || users.length === 0) throw new Error('Current users must be nonempty');
  const ids = new Set();
  for (const user of users) {
    const id = user?.iidx_id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9]+$/.test(id)) throw new Error('Invalid current user ID');
    if (ids.has(id)) throw new Error(`Duplicate current user ID: ${id}`);
    if (user.dj_name !== null && typeof user.dj_name !== 'string') throw new Error(`Invalid DJ name: ${id}`);
    ids.add(id);
  }
  return ids;
}

function validateEntries(entries) {
  if (!Array.isArray(entries)) throw new Error('hist LIST must return an array');
  const keys = new Set(), ids = new Set();
  const result = entries.map((entry) => {
    const match = typeof entry?.key === 'string' && /^hist\/([A-Za-z0-9]+)\.json$/.exec(entry.key);
    if (!match) throw new Error('Invalid hist LIST key');
    const id = match[1];
    if (keys.has(entry.key) || ids.has(id)) throw new Error(`Duplicate hist key or ID: ${entry.key}`);
    keys.add(entry.key);
    ids.add(id);
    if (entry.etag != null && typeof entry.etag !== 'string') throw new Error(`Invalid hist ETag: ${entry.key}`);
    return { key: entry.key, id, etag: entry.etag || null };
  });
  return result.sort((a, b) => compare(a.key, b.key));
}

async function snapshot(source) {
  const [users, listed, aliases, songs] = await Promise.all([
    source.users(), source.list(), readJson(source, 'meta/song-aliases.json'), readJson(source, 'songs.json'),
  ]);
  const userIds = validateUsers(users);
  const entries = validateEntries(listed);
  validateAliases(aliases.value, songs.value);
  const usersIdentity = users.map(({ iidx_id, dj_name }) => [iidx_id, dj_name])
    .sort((a, b) => compare(a[0], b[0]));
  const missingEtags = entries.filter(({ etag }) => etag === null).map(({ key }) => key);
  const fingerprint = {
    version: 1,
    hist: entries.map(({ key, etag }) => ({ key, etag })),
    aliases_hash: await source.hash(aliases.body),
    songs_hash: await source.hash(songs.body),
    users_hash: await source.hash(JSON.stringify(usersIdentity)),
    missing_etag_keys: missingEtags,
    etags_complete: missingEtags.length === 0,
  };
  return { users, userIds, entries, aliases, songs, fingerprint };
}

/** P17 only: refresh metadata and shared bodies, never GET hist bodies.
 * Compare the returned fingerprint with the production fingerprint; either
 * etags_complete=false makes the comparison invalid. No comparison runs here.
 */
export async function verifyFingerprint(deps = {}) {
  return (await snapshot(dependencies(deps))).fingerprint;
}

/** Collect once, validate every listed history, and perform no public writes. */
export async function loadHistoryInputs(deps = {}) {
  const source = dependencies(deps);
  const { users, userIds, entries, aliases, songs, fingerprint } = await snapshot(source);
  const rowsById = new Map();
  const counts = new Array(entries.length);
  await source.pool(entries, 8, async ({ key, id }, index) => {
    const input = await readJson(source, key);
    const normalized = normalizeAliasInputs({
      histRows: input.value, restRows: [], aliases: aliases.value, songs: songs.value,
    }).histRows;
    counts[index] = { bytes: input.bytes, rows: input.value.length, normalized: normalized.length,
      empty: input.value.length === 0 };
    rowsById.set(id, normalized);
  });
  const histories = new Map();
  const usersWithoutHist = [];
  for (const id of [...userIds].sort(compare)) {
    if (!rowsById.has(id)) usersWithoutHist.push(id);
    histories.set(id, rowsById.get(id) ?? []);
  }
  const deletedIds = entries.filter(({ id }) => !userIds.has(id)).map(({ id }) => id);
  const histBytes = counts.reduce((n, item) => n + item.bytes, 0);
  const diagnostics = {
    hist_files: entries.length,
    files: entries.length + 2,
    hist_bytes: histBytes,
    source_bytes: histBytes + aliases.bytes + songs.bytes,
    rows: counts.reduce((n, item) => n + item.rows, 0),
    normalized_rows: counts.reduce((n, item) => n + item.normalized, 0),
    empty_hist: counts.filter((item) => item.empty).length,
    deleted_users_excluded: deletedIds.length,
    deleted_user_ids: deletedIds,
    users_without_hist: usersWithoutHist,
  };
  if (typeof source.log === 'function') source.log(diagnostics);
  else source.log?.info?.(diagnostics);
  return { users, histories, fingerprint, diagnostics };
}

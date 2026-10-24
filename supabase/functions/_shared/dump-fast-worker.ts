import { mergeEdgeUser } from '../../../.github/scripts/dump-fast-publish.mjs';
import { mergeFastPending } from '../../../.github/scripts/pending-marker.mjs';

const FAST_FIELDS = ['dp', 'sp', 'dpRecent', 'spRecent'] as const;
const R2_KEYS = (id: string) => [`pending/${id}.json`, `user/${id}.json`, `hist/${id}.json`, 'meta/song-aliases.json', 'songs.json'];

type Snapshot = { body: string; etag: string | null };
type BufferSnapshot<Row> = { rows: Row[]; fingerprint: string };
type WorkerDeps<Row> = {
  readBuffer: (id: string) => Promise<BufferSnapshot<Row>>;
  read: (key: string) => Promise<Snapshot>;
  put: (key: string, body: string, etag: string) => Promise<unknown>;
  prepareFastDump: (input: Record<string, unknown>) => Record<string, any>;
  now?: () => string;
  deadline?: number;
  nowMs?: () => number;
};

const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const parse = (snapshot: Snapshot | null | undefined) => {
  if (!snapshot || typeof snapshot.body !== 'string' || typeof snapshot.etag !== 'string'
    || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(snapshot.etag)) return null;
  try { const value = JSON.parse(snapshot.body); return object(value) ? value : null; } catch { return null; }
};
const digest = async (bytes: Uint8Array) => {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
};
const bytesEqual = (a: string, b: string) => a === b;

/** Run one bounded fast dump publication. No operation is retried. */
export async function runLightDump<Row>({ id, G, since, deps }: {
  id: string; G: string; since: string; deps: WorkerDeps<Row>;
}) {
  const generation = typeof G === 'string' && /^[1-9][0-9]*$/.test(G) ? BigInt(G) : null;
  if (!/^[A-Za-z0-9]+$/.test(id) || generation === null || typeof since !== 'string' || !Number.isFinite(Date.parse(since))) return { ok: false, reason: 'invalid-input' };
  const now = deps.now ?? (() => new Date().toISOString());
  const nowMs = deps.nowMs ?? (() => Date.now());
  const checkDeadline = () => {
    if (deps.deadline !== undefined && nowMs() >= deps.deadline) throw new Error('deadline');
  };
  const readAll = async () => Promise.all(R2_KEYS(id).map(key => deps.read(key)));
  try {
    checkDeadline();
    const first = await readAll();
    const [pendingSource, userSource, histSource, aliasesSource, songsSource] = first;
    const pending = parse(pendingSource), user = parse(userSource);
    if (!pending || pending.generation !== G || pending.since !== since) return { ok: false, reason: 'pending-changed' };
    if (!user || !histSource || !aliasesSource || !songsSource) return { ok: false, reason: 'invalid-reference' };
    const hist = JSON.parse(histSource.body), aliases = JSON.parse(aliasesSource.body), songs = JSON.parse(songsSource.body);
    const userTime = typeof user._v === 'string' ? Date.parse(user._v) : NaN;
    if (!Number.isFinite(userTime) || new Date(userTime).toISOString() !== user._v) return { ok: false, reason: 'invalid-user-time' };
    const generationNumber = Number(generation);
    if (!Number.isSafeInteger(generationNumber) || generationNumber < 1) return { ok: false, reason: 'generation-out-of-range' };
    checkDeadline();
    const firstBuffer = await deps.readBuffer(id);
    if (!firstBuffer || !Array.isArray(firstBuffer.rows) || typeof firstBuffer.fingerprint !== 'string') return { ok: false, reason: 'invalid-buffer' };
    const histHash = await digest(new TextEncoder().encode(histSource.body));
    const input = { iidxId: id, previousHistRows: hist, restRows: firstBuffer.rows, aliases, aliasesBytes: new TextEncoder().encode(aliasesSource.body), songs, previousUser: user, generation: generationNumber, nowMs: Date.parse(since) };
    const baseline = deps.prepareFastDump({ ...input, restRows: [] });
    if (await digest(baseline.histBytes) !== histHash) return { ok: false, reason: 'hist-not-stable' };
    const candidate = deps.prepareFastDump(input);
    const patch = Object.fromEntries(FAST_FIELDS.map(field => [field, candidate.fastPatch[field]]));
    patch.fastGeneration = G;
    const secondTask = async () => Promise.all([deps.readBuffer(id), readAll()]);
    checkDeadline();
    const [secondBuffer, second] = await secondTask();
    if (secondBuffer.fingerprint !== firstBuffer.fingerprint || second.some((snapshot, index) => !bytesEqual(snapshot.body, first[index].body))) return { ok: false, reason: 'inputs-changed' };
    const latestPending = parse(second[0]);
    if (!latestPending || latestPending.generation !== G || latestPending.since !== since) return { ok: false, reason: 'pending-changed' };
    checkDeadline();
    const merged = mergeEdgeUser(user, patch, G);
    if (!merged.ok) return merged;
    if (merged.changed) {
      try { await deps.put(`user/${id}.json`, JSON.stringify(merged.value), userSource.etag!); }
      catch { return { ok: false, reason: 'user-put-failed' }; }
    }
    checkDeadline();
    const pendingDoneSource = await deps.read(`pending/${id}.json`);
    const pendingDone = parse(pendingDoneSource);
    if (!pendingDone || pendingDone.generation !== G || pendingDone.since !== since) return { ok: true, changed: merged.changed, done: false, reason: 'pending-changed' };
    const done = new Date(Math.max(Date.parse(now()), Date.parse(since))).toISOString();
    const doneResult = mergeFastPending(pendingDone, { generation: G, since, done });
    if (!doneResult.ok || !pendingDoneSource.etag) return { ok: true, changed: merged.changed, done: false, reason: 'done-invalid' };
    checkDeadline();
    try { await deps.put(`pending/${id}.json`, JSON.stringify(doneResult.marker), pendingDoneSource.etag); }
    catch { return { ok: true, changed: merged.changed, done: false, reason: 'done-put-failed' }; }
    return { ok: true, changed: merged.changed, done: true, value: merged.value };
  } catch (error) {
    return { ok: false, reason: error instanceof Error && error.message === 'deadline' ? 'deadline' : 'read-or-calculation-failed' };
  }
}

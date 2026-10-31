import { publishHistWithLease, assertHistLease, releaseHistLease, mergeHistUser, mergeHistPending, mergeEdgeUser } from '../../../.github/scripts/dump-fast-publish.mjs';
import { mergeFastPending } from '../../../.github/scripts/pending-marker.mjs';

const FAST_FIELDS = ['dp', 'sp', 'dpRecent', 'spRecent'] as const;
const R2_KEYS = (id: string) => [`pending/${id}.json`, `user/${id}.json`, `hist/${id}.json`, 'meta/song-aliases.json', 'songs.json'];

type Snapshot = { body: string; etag: string | null };
type BufferSnapshot<Row> = { rows: Row[]; fingerprint: string };
type WorkerDeps<Row> = {
  readBuffer: (id: string) => Promise<BufferSnapshot<Row>>;
  read: (key: string) => Promise<Snapshot | null>;
  put: (key: string, body: string, etag: string | null) => Promise<unknown>;
  prepareFastDump: (input: Record<string, unknown>) => Record<string, any>;
  histPublish?: boolean;
  now?: () => string;
  deadline?: number;
  nowMs?: () => number;
  timing?: (step: string, elapsedMs: number) => void;
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

/** Run one bounded fast dump publication; only ON history CAS retries 412. */
export async function runLightDump<Row>({ id, G, since, deps }: {
  id: string; G: string; since: string; deps: WorkerDeps<Row>;
}) {
  if (deps.histPublish === true) return runHistDump({ id, G, since, deps });
  const generation = typeof G === 'string' && /^[1-9][0-9]*$/.test(G) ? BigInt(G) : null;
  if (!/^[A-Za-z0-9]+$/.test(id) || generation === null || typeof since !== 'string' || !Number.isFinite(Date.parse(since))) return { ok: false, reason: 'invalid-input' };
  const now = deps.now ?? (() => new Date().toISOString());
  const nowMs = deps.nowMs ?? (() => Date.now());
  const timing = deps.timing;
  const timedRead = (key: string, step: string) => {
    const started = timing ? performance.now() : 0;
    try { return deps.read(key).finally(() => { if (timing) timing(step, performance.now() - started); }); }
    catch (error) { if (timing) timing(step, performance.now() - started); throw error; }
  };
  const timedBuffer = () => {
    const started = timing ? performance.now() : 0;
    try { return deps.readBuffer(id).finally(() => { if (timing) timing('bufferRead', performance.now() - started); }); }
    catch (error) { if (timing) timing('bufferRead', performance.now() - started); throw error; }
  };
  const checkDeadline = () => {
    if (deps.deadline !== undefined && nowMs() >= deps.deadline) throw new Error('deadline');
  };
  const readAll = async () => Promise.all(R2_KEYS(id).map((key, index) => timedRead(key, ['pendingRead', 'userRead', 'histRead', 'referenceRead', 'referenceRead'][index])));
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
    const firstBuffer = await timedBuffer();
    if (!firstBuffer || !Array.isArray(firstBuffer.rows) || typeof firstBuffer.fingerprint !== 'string') return { ok: false, reason: 'invalid-buffer' };
    const histHash = await digest(new TextEncoder().encode(histSource.body));
    const input = { iidxId: id, previousHistRows: hist, restRows: firstBuffer.rows, aliases, aliasesBytes: new TextEncoder().encode(aliasesSource.body), songs, previousUser: user, generation: generationNumber, nowMs: Date.parse(since) };
    let started = timing ? performance.now() : 0;
    let baseline;
    try { baseline = deps.prepareFastDump({ ...input, restRows: [] }); }
    finally { if (timing) timing('compute', performance.now() - started); }
    if (await digest(baseline.histBytes) !== histHash) return { ok: false, reason: 'hist-not-stable' };
    started = timing ? performance.now() : 0;
    let candidate;
    try { candidate = deps.prepareFastDump(input); }
    finally { if (timing) timing('compute', performance.now() - started); }
    const patch = Object.fromEntries(FAST_FIELDS.map(field => [field, candidate.fastPatch[field]]));
    patch.fastGeneration = G;
    const secondTask = async () => Promise.all([timedBuffer(), Promise.all(R2_KEYS(id).map((key, index) => timedRead(key, ['pendingRead', 'userRead', 'histRead', 'referenceRead', 'referenceRead'][index])))]);
    checkDeadline();
    const [secondBuffer, second] = await secondTask();
    if (secondBuffer.fingerprint !== firstBuffer.fingerprint || second.some((snapshot, index) => !bytesEqual(snapshot?.body ?? '', first[index]?.body ?? ''))) return { ok: false, reason: 'inputs-changed' };
    const latestPending = parse(second[0]);
    if (!latestPending || latestPending.generation !== G || latestPending.since !== since) return { ok: false, reason: 'pending-changed' };
    checkDeadline();
    const merged = mergeEdgeUser(user, patch, G);
    if (!merged.ok) return merged;
    if (merged.changed) {
      started = timing ? performance.now() : 0;
      try { await deps.put(`user/${id}.json`, JSON.stringify(merged.value), userSource!.etag!); }
      catch { return { ok: false, reason: 'user-put-failed' }; }
      finally { if (timing) timing('userPut', performance.now() - started); }
    }
    checkDeadline();
    const pendingDoneSource = await timedRead(`pending/${id}.json`, 'pendingRead');
    const pendingDone = parse(pendingDoneSource);
    if (!pendingDone || pendingDone.generation !== G || pendingDone.since !== since) return { ok: true, changed: merged.changed, done: false, reason: 'pending-changed' };
    const done = new Date(Math.max(Date.parse(now()), Date.parse(since))).toISOString();
    const doneResult = mergeFastPending(pendingDone, { generation: G, since, done });
    if (!doneResult.ok || !pendingDoneSource?.etag) return { ok: true, changed: merged.changed, done: false, reason: 'done-invalid' };
    checkDeadline();
    started = timing ? performance.now() : 0;
    try { await deps.put(`pending/${id}.json`, JSON.stringify(doneResult.marker), pendingDoneSource.etag); }
    catch { return { ok: true, changed: merged.changed, done: false, reason: 'done-put-failed' }; }
    finally { if (timing) timing('pendingDone', performance.now() - started); }
    return { ok: true, changed: merged.changed, done: true, value: merged.value };
  } catch (error) {
    return { ok: false, reason: error instanceof Error && error.message === 'deadline' ? 'deadline' : 'read-or-calculation-failed' };
  }
}

/** Extended publication retains the shared lease through user and completion CAS. */
async function runHistDump<Row>({ id, G, since, deps }: {
  id: string; G: string; since: string; deps: WorkerDeps<Row>;
}) {
  const generation = Number(G);
  if (!/^[A-Za-z0-9]+$/.test(id) || !/^[1-9][0-9]*$/.test(G)
    || !Number.isSafeInteger(generation) || !Number.isFinite(Date.parse(since))
    || new Date(since).toISOString() !== since) return { ok: false, reason: 'invalid-input' };
  const nowMs = deps.nowMs ?? Date.now;
  const now = deps.now ?? (() => new Date().toISOString());
  const timing = deps.timing;
  let started = timing ? performance.now() : 0;
  const timedRead = (key: string, step: string) => {
    const started = timing ? performance.now() : 0;
    try { return r2.read(key).finally(() => { if (timing) timing(step, performance.now() - started); }); }
    catch (error) { if (timing) timing(step, performance.now() - started); throw error; }
  };
  const timedBuffer = () => {
    const started = timing ? performance.now() : 0;
    try { return deps.readBuffer(id).finally(() => { if (timing) timing('bufferRead', performance.now() - started); }); }
    catch (error) { if (timing) timing('bufferRead', performance.now() - started); throw error; }
  };
  let heldLease: { key: string; token: string; expiresAt: string } | undefined;
  const leaseKey = `meta/fast-hist-lease-${id}.json`;
  const check = () => {
    if (deps.deadline !== undefined && nowMs() >= deps.deadline) throw new Error('deadline');
    if (heldLease && nowMs() >= Date.parse(heldLease.expiresAt)) throw new Error('hist lease expired or lost');
  };
  const r2 = { read: async (key: string) => { check(); return await deps.read(key); },
    put: async (key: string, body: string, etag: string | null) => {
      check();
      const result = await deps.put(key, body, etag);
      if (key === leaseKey && !heldLease) heldLease = { key, ...JSON.parse(body) };
      return result;
    } };
  const userKey = `user/${id}.json`, pendingKey = `pending/${id}.json`;
  try {
    const observe = <T>(promise: Promise<T>) => promise.then(value => ({ value }), error => ({ error }));
    const initial = [observe(timedRead(pendingKey, 'pendingRead')), observe(timedRead(userKey, 'userRead')), observe(timedRead(`hist/${id}.json`, 'histRead'))] as const;
    const firstBuffer = observe(timedBuffer());
    const firstReferences = observe(Promise.all([timedRead('meta/song-aliases.json', 'referenceRead'), timedRead('songs.json', 'referenceRead')]));
    let firstPrepare = true;
    const [pendingResult, userResult, histResult] = await Promise.all(initial);
    if ('error' in pendingResult) throw pendingResult.error;
    if ('error' in userResult) throw userResult.error;
    if ('error' in histResult) throw histResult.error;
    const pendingSource = pendingResult.value, userSource = userResult.value, histSource = histResult.value;
    const pending = parse(pendingSource), initialUser = parse(userSource);
    if (!pending || pending.generation !== G || pending.since !== since) return { ok: false, reason: 'pending-changed' };
    const allowCreate = userSource === null && histSource === null;
    if ((!initialUser && !allowCreate) || (histSource === null && !allowCreate)) return { ok: false, reason: 'invalid-reference' };
    if (initialUser && (!Number.isFinite(Date.parse(initialUser._v)) || new Date(initialUser._v).toISOString() !== initialUser._v)) return { ok: false, reason: 'invalid-user-time' };
    if (initialUser?.fastGeneration && /^[1-9][0-9]*$/.test(initialUser.fastGeneration)
      && BigInt(initialUser.fastGeneration) > BigInt(G)) return { ok: false, reason: 'newer-generation' };
    check();
    const bufferResult = await firstBuffer;
    if ('error' in bufferResult) throw bufferResult.error;
    const buffer = bufferResult.value;
    if (!buffer || !Array.isArray(buffer.rows) || typeof buffer.fingerprint !== 'string'
      || (allowCreate && buffer.rows.length === 0)) return { ok: false, reason: 'invalid-buffer' };
    // References are reloaded for every 412 replay; the original buffer is retained.
    const published = await publishHistWithLease({ r2, id, restRows: buffer.rows, enabled: true, allowCreate, now: nowMs, timing,
      prepare: async ({ previousHistRows, restRows }: { previousHistRows: unknown[]; restRows: Row[] }) => {
        let referenceResult;
        if (firstPrepare) {
          firstPrepare = false;
          referenceResult = await firstReferences;
        } else {
          const [aliasesSource, songsSource] = await Promise.all([timedRead('meta/song-aliases.json', 'referenceRead'), timedRead('songs.json', 'referenceRead')]);
          referenceResult = { value: [aliasesSource, songsSource] };
        }
        if ('error' in referenceResult) throw referenceResult.error;
        const [aliasesSource, songsSource] = referenceResult.value;
        if (!aliasesSource || !songsSource) throw new Error('missing references');
        started = timing ? performance.now() : 0;
        try { await assertHistLease({ r2, id, lease: heldLease, now: nowMs }); }
        finally { if (timing) timing('leaseCheck', performance.now() - started); }
        const aliases = JSON.parse(aliasesSource.body), songs = JSON.parse(songsSource.body);
        const input = { iidxId: id, previousHistRows, restRows, aliases, aliasesBytes: new TextEncoder().encode(aliasesSource.body), songs,
          previousUser: initialUser ?? {}, generation, nowMs: Date.parse(since) };
        started = timing ? performance.now() : 0;
        let baseline;
        try { baseline = deps.prepareFastDump({ ...input, restRows: [] }); }
        finally { if (timing) timing('compute', performance.now() - started); }
        if (new TextDecoder().decode(baseline.histBytes) !== JSON.stringify(previousHistRows)) throw new Error('hist not stable');
        started = timing ? performance.now() : 0;
        let prepared;
        try { prepared = deps.prepareFastDump(input); }
        finally { if (timing) timing('compute', performance.now() - started); }
        started = timing ? performance.now() : 0;
        try { await assertHistLease({ r2, id, lease: heldLease, now: nowMs }); }
        finally { if (timing) timing('leaseCheck', performance.now() - started); }
        check();
        const [again, aliasesAfter, songsAfter, marker] = await Promise.all([timedBuffer(), timedRead('meta/song-aliases.json', 'referenceRead'), timedRead('songs.json', 'referenceRead'), timedRead(pendingKey, 'pendingRead')]);
        const latest = parse(marker);
        if (again.fingerprint !== buffer.fingerprint || aliasesAfter?.body !== aliasesSource.body || songsAfter?.body !== songsSource.body
          || !latest || latest.generation !== G || latest.since !== since) throw new Error('inputs changed');
        return prepared;
      } });
    if (!published?.ok) return published ?? { ok: false, reason: 'hist-validation-failed' };
    if (!('histBytes' in published)) return { ok: false, reason: 'hist-validation-failed' };
    const verify = async () => {
      started = timing ? performance.now() : 0;
      try { await assertHistLease({ r2, id, lease: published.lease, now: nowMs }); }
      finally { if (timing) timing('leaseCheck', performance.now() - started); }
      const hist = await timedRead(`hist/${id}.json`, 'histVerify');
      if (!hist || hist.body !== new TextDecoder().decode(published.histBytes)) throw new Error('hist changed');
      started = timing ? performance.now() : 0;
      try { await assertHistLease({ r2, id, lease: published.lease, now: nowMs }); }
      finally { if (timing) timing('leaseCheck', performance.now() - started); }
    };
    await verify();
    const currentSource = await timedRead(userKey, 'userRead'), current = parse(currentSource);
    if (!current && !(allowCreate && currentSource === null)) return { ok: false, reason: 'invalid-reference' };
    const patch = Object.fromEntries(FAST_FIELDS.map(field => [field, published.prepared.fastPatch[field]]));
    patch.fastGeneration = G; patch.histRevision = published.histRevision;
    // Slow fields have no computed value yet on a first upload; Actions supplies them.
    const merged = mergeHistUser(current ?? { _v: since, user: null, radars: null, osPattern: null, persona: null, spPersona: null, reachNps: null }, patch, G, published.histRevision);
    if (!merged.ok) return merged;
    await verify();
    if (merged.changed) {
      started = timing ? performance.now() : 0;
      try { await r2.put(userKey, JSON.stringify(merged.value), currentSource?.etag ?? null); }
      catch { return { ok: false, reason: 'user-put-failed' }; }
      finally { if (timing) timing('userPut', performance.now() - started); }
    }
    await verify();
    const markerSource = await timedRead(pendingKey, 'pendingRead'), marker = parse(markerSource);
    const completion = mergeHistPending(marker, { generation: G, since, histRevision: published.histRevision, done: now() });
    if (!completion.ok || !markerSource?.etag) return { ok: true, changed: merged.changed, done: false, reason: completion.reason ?? 'done-invalid' };
    await verify();
    started = timing ? performance.now() : 0;
    try { await r2.put(pendingKey, JSON.stringify(completion.value), markerSource.etag); }
    catch { return { ok: true, changed: merged.changed, done: false, reason: 'done-put-failed' }; }
    finally { if (timing) timing('pendingDone', performance.now() - started); }
    await releaseHistLease({ r2, id, lease: published.lease, now: nowMs, timing });
    return { ok: true, changed: merged.changed, done: true, value: merged.value };
  } catch (error) {
    return { ok: false, reason: error instanceof Error && error.message === 'deadline' ? 'deadline' : 'read-or-calculation-failed' };
  }
}

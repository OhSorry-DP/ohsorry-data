// Pure, opt-in gate for deleting exact score IDs after snapshot verification.
import { sha256Hex, validateCandidate } from './score-buffer.mjs';

const fail = (message) => { throw new TypeError(message); };
const result = (status, scoreIds, batches, deleted, reason = null) => ({ status, scoreIds, batches, deleted, reason });

function bytes(value, name) {
  if (!(value instanceof Uint8Array)) fail(`${name} must be bytes`);
}

function validateSnapshotKey(key) {
  if (typeof key !== 'string' || !/^snapshot\/(?:daily|monthly)\/\d{4}-\d{2}(?:-\d{2})?\.tar\.gz$/.test(key)) {
    fail('invalid snapshotKey');
  }
  const date = key.slice(key.lastIndexOf('/') + 1, -7);
  const valid = /^\d{4}-\d{2}$/.test(date)
    ? Number(date.slice(5)) >= 1 && Number(date.slice(5)) <= 12
    : Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
  if (!valid) fail('invalid snapshotKey date');
}

function snapshotIdentity(snapshotKey, tarSha256) {
  validateSnapshotKey(snapshotKey);
  if (typeof tarSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(tarSha256)) fail('invalid tarSha256');
}

export async function runScoreDeleteGate({
  iidxId, candidateBytes, histBytes, snapshotKey, tarSha256, serialization = null, execute = false, deleteScoreIds,
}) {
  if (typeof iidxId !== 'string' || !/^[A-Za-z0-9]+$/.test(iidxId)) fail('invalid iidxId');
  bytes(candidateBytes, 'candidateBytes');
  bytes(histBytes, 'histBytes');
  snapshotIdentity(snapshotKey, tarSha256);

  let candidate;
  try { candidate = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(candidateBytes)); }
  catch { fail('candidateBytes must contain valid UTF-8 JSON'); }
  validateCandidate(candidate, iidxId);
  if (sha256Hex(histBytes) !== candidate.hist.sha256) fail('hist sha256 mismatch');

  const scoreIds = [...candidate.score_ids];
  const batches = [];
  for (let i = 0; i < scoreIds.length; i += 200) batches.push(scoreIds.slice(i, i + 200));
  if (!execute) return result('prepared', scoreIds, batches, 0);

  const validSerialization = serialization && typeof serialization === 'object'
    && serialization.iidxId === iidxId && serialization.snapshotKey === snapshotKey
    && serialization.tarSha256 === tarSha256 && serialization.scope === 'all-hist-writers'
    && typeof serialization.assertHeld === 'function';
  if (!validSerialization) return result('blocked', scoreIds, batches, 0, 'matching all-hist-writers lock capability required');
  if (typeof deleteScoreIds !== 'function') return result('blocked', scoreIds, batches, 0, 'deleteScoreIds adapter required');

  const assertHeld = async () => {
    try { await serialization.assertHeld(); return null; }
    catch (error) { return `lock assertion failed: ${error && error.message ? error.message : String(error)}`; }
  };
  let reason = await assertHeld();
  if (reason) return result('blocked', scoreIds, batches, 0, reason);

  let deleted = 0;
  for (const batch of batches) {
    reason = await assertHeld();
    if (reason) return result(deleted ? 'partial' : 'blocked', scoreIds, batches, deleted, reason);
    try {
      const response = await deleteScoreIds(iidxId, [...batch]);
      if (response === null || typeof response !== 'object' || Array.isArray(response)
        || !Number.isSafeInteger(response.deleted) || response.deleted < 0 || response.deleted > batch.length) {
        throw new TypeError('invalid deleted count');
      }
      deleted += response.deleted;
    } catch (error) {
      reason = `delete batch failed: ${error && error.message ? error.message : String(error)}`;
      return result('partial', scoreIds, batches, deleted, reason);
    }
  }
  reason = await assertHeld();
  if (reason) return result(deleted ? 'partial' : 'blocked', scoreIds, batches, deleted, reason);
  return result('deleted', scoreIds, batches, deleted);
}

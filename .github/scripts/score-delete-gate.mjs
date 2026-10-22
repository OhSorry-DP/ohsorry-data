// Exact fingerprints from this process's verified tar only.
import { sha256Hex, validateCandidate } from './score-buffer.mjs';
import { isVerifiedDeleteSnapshot, isExecutableDeleteSnapshot, getVerifiedDeleteSnapshot } from './snapshot-r2.mjs';

const verified = new WeakSet();
const consumed = new WeakSet();
const fail = (message) => { throw new TypeError(message); };

export function validateDeleteResponse(response, rows) {
  const ids = rows.map((row) => row.score_id);
  if (!response || typeof response !== 'object' || Array.isArray(response) || response.requested !== ids.length
    || !Array.isArray(response.deleted_ids) || !Array.isArray(response.kept_ids)) fail('invalid delete response');
  const all = [...response.deleted_ids, ...response.kept_ids];
  if (all.length !== ids.length || new Set(all).size !== all.length
    || all.some((id) => !Number.isSafeInteger(id) || !ids.includes(id))) fail('invalid delete ID partition');
  for (const list of [response.deleted_ids, response.kept_ids]) {
    if (list.some((id, i) => i > 0 && id <= list[i - 1])) fail('delete IDs must be ascending');
  }
  return response;
}

export async function runScoreDeleteGate({ iidxId, verifiedSnapshot, candidateBytes, histBytes,
  snapshotKey, tarSha256, execute = false, deleteScoreRows }) {
  if (typeof execute !== 'boolean') fail('execute must be boolean');
  if (isVerifiedDeleteSnapshot(verifiedSnapshot)) verified.add(verifiedSnapshot);
  const trusted = verified.has(verifiedSnapshot);
  if (execute && (!trusted || !isExecutableDeleteSnapshot(verifiedSnapshot) || consumed.has(verifiedSnapshot))) fail('fresh verified snapshot required');
  if (trusted) {
    const snapshot = getVerifiedDeleteSnapshot(verifiedSnapshot);
    const entry = snapshot.candidates.find((item) => item.iidxId === iidxId);
    if (!entry) fail('candidate outside verified snapshot');
    ({ candidateBytes, histBytes } = entry);
    ({ snapshotKey, tarSha256 } = snapshot);
  }
  if (typeof snapshotKey !== 'string' || !/^snapshot\/(daily\/\d{4}-\d{2}-\d{2}|monthly\/\d{4}-\d{2})\.tar\.gz$/.test(snapshotKey)
    || !/^[a-f0-9]{64}$/.test(tarSha256)) fail('invalid snapshot identity');
  const date = snapshotKey.slice(snapshotKey.lastIndexOf('/') + 1, -7);
  const validDate = date.length === 7 ? Number(date.slice(5)) >= 1 && Number(date.slice(5)) <= 12
    : Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
  if (!validDate) fail('invalid snapshot date');
  if (!(candidateBytes instanceof Uint8Array) || !(histBytes instanceof Uint8Array)) fail('candidate and hist must be bytes');
  const candidate = validateCandidate(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(candidateBytes)), iidxId);
  if (sha256Hex(histBytes) !== candidate.hist.sha256) fail('hist sha256 mismatch');
  const scoreIds = [...candidate.score_ids];
  const batches = [];
  for (let i = 0; i < candidate.rows.length; i += 200) batches.push(candidate.rows.slice(i, i + 200));
  const out = { status: 'prepared', scoreIds, batches, requested: 0, deleted: 0,
    deleted_ids: [], kept_ids: [], unconfirmed_ids: [], unrequested_ids: [...scoreIds], snapshotKey, tarSha256, reason: null };
  if (!execute) return out;
  if (iidxId !== '89388691' || !snapshotKey.startsWith('snapshot/daily/')) fail('only daily 89388691 deletion is allowed');
  if (typeof deleteScoreRows !== 'function') fail('deleteScoreRows adapter required');
  consumed.add(verifiedSnapshot);
  for (const batch of batches) {
    out.requested += batch.length;
    out.unrequested_ids.splice(0, batch.length);
    try {
      const response = validateDeleteResponse(await deleteScoreRows(iidxId, structuredClone(batch)), batch);
      out.deleted_ids.push(...response.deleted_ids);
      out.kept_ids.push(...response.kept_ids);
      out.deleted = out.deleted_ids.length;
    } catch (error) {
      out.status = 'partial';
      out.unconfirmed_ids = batch.map((row) => row.score_id);
      out.reason = `delete batch failed: ${error instanceof Error ? error.message : String(error)}`;
      return out;
    }
  }
  out.status = 'deleted';
  return out;
}

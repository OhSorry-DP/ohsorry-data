const validTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const validGeneration = (value) => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);

export function mergeFastPending(marker, { generation, since, done } = {}) {
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
    return { ok: false, reason: 'corrupt' };
  }
  if (!validGeneration(generation)) return { ok: false, reason: 'invalid-generation' };
  const currentGeneration = marker.generation;
  if (currentGeneration !== undefined && !validGeneration(currentGeneration)) {
    return { ok: false, reason: 'invalid-generation' };
  }
  if (marker.since !== undefined && !validTime(marker.since)) {
    return { ok: false, reason: 'invalid-since' };
  }

  const comparison = currentGeneration === undefined
    ? 1
    : BigInt(generation) < BigInt(currentGeneration) ? -1
      : BigInt(generation) > BigInt(currentGeneration) ? 1 : 0;
  if (comparison < 0) return { ok: false, reason: 'stale-generation' };

  const serverNow = new Date().toISOString();
  if (done === undefined) {
    if (comparison === 0) return { ok: true, marker: { ...marker } };
    if (!validTime(since)) return { ok: false, reason: 'invalid-since' };
    const previousSince = marker.since === undefined ? null : marker.since;
    const nextSinceMs = Math.max(Date.parse(serverNow), previousSince === null ? -Infinity : Date.parse(previousSince) + 1);
    const next = { ...marker, generation, since: new Date(nextSinceMs).toISOString() };
    delete next.done;
    return { ok: true, marker: next };
  }

  if (comparison !== 0 || marker.since !== since || !validTime(done)) {
    return { ok: false, reason: 'stale-completion' };
  }
  const previousDone = validTime(marker.done) ? marker.done : null;
  const completedAt = new Date(Math.max(Date.parse(since), Date.parse(serverNow), previousDone === null ? -Infinity : Date.parse(previousDone))).toISOString();
  return { ok: true, marker: { ...marker, done: completedAt } };
}

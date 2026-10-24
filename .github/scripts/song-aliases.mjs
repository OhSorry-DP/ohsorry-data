import { mergeScoreHistory, replayScoreBuffer } from './score-history.mjs';

const fail = (message) => { throw new TypeError(message); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, label) => {
  if (!Number.isSafeInteger(value)) fail(`${label} must be a safe integer`);
};
function keys(value, expected, label) {
  if (!object(value) || Object.keys(value).length !== expected.length
    || expected.some((key) => !Object.hasOwn(value, key))) fail(`invalid ${label} schema`);
}

function rulesBySource(aliases) {
  keys(aliases, ['v', 'rules'], 'aliases');
  if (aliases.v !== 1 || !Array.isArray(aliases.rules)) fail('invalid aliases version or rules');
  const bySource = new Map();
  for (const rule of aliases.rules) {
    if (!object(rule) || !['song', 'chart-ac'].includes(rule.scope)) fail('invalid alias scope');
    keys(rule, rule.scope === 'song' ? ['from', 'to', 'scope'] : ['from', 'to', 'scope', 'diff'], 'rule');
    integer(rule.from, 'from');
    integer(rule.to, 'to');
    if (rule.scope === 'chart-ac') integer(rule.diff, 'diff');
    if (rule.from === rule.to) fail('self reference in aliases');
    const previous = bySource.get(rule.from) ?? [];
    if (previous.some((r) => r.scope === 'song' || rule.scope === 'song' || r.diff === rule.diff)) {
      fail('overlapping or branching alias rules');
    }
    previous.push(rule);
    bySource.set(rule.from, previous);
  }
  return bySource;
}

function resolve(songId, diff, playedVersion, bySource) {
  if (playedVersion === -10) return songId;
  const visited = new Set();
  let current = songId;
  while (true) {
    if (visited.has(current)) fail('cycle in aliases');
    visited.add(current);
    const rule = bySource.get(current)?.find((r) => r.scope === 'song'
      || (playedVersion > 0 && r.diff === diff));
    if (!rule) return current;
    current = rule.to;
  }
}

/** Validate terminal targets in every applicable input domain, including retired sources. */
export function validateAliases(aliases, songs) {
  const bySource = rulesBySource(aliases);
  if (!Array.isArray(songs)) fail('songs must be an array');
  const live = new Set();
  for (const song of songs) {
    if (!object(song)) fail('song must be an object');
    integer(song.song_id, 'song_id');
    if (live.has(song.song_id)) fail('duplicate song_id');
    live.add(song.song_id);
  }
  const diffs = [...new Set(aliases.rules.filter((r) => r.scope === 'chart-ac').map((r) => r.diff))];
  // null represents all other diffs: chart-ac rules cannot match it.
  for (const rule of aliases.rules) {
    const domains = rule.scope === 'song'
      ? [[null, 0], ...[null, ...diffs].map((diff) => [diff, 1])]
      : [[rule.diff, 1]];
    for (const [diff, version] of domains) {
      if (!live.has(resolve(rule.from, diff, version, bySource))) fail('alias terminal target does not exist in songs');
    }
  }
  return aliases;
}

export function resolveSongId(songId, diff, playedVersion, aliases) {
  integer(songId, 'songId');
  integer(diff, 'diff');
  integer(playedVersion, 'playedVersion');
  return resolve(songId, diff, playedVersion, rulesBySource(aliases));
}

const chartKey = (row) => JSON.stringify([row[0], row[1], row[4], row[7]]);
const naturalKey = (row) => JSON.stringify([row[0], row[1], row[4], row[7], row[6]]);

// Input dates have already been validated by mergeScoreHistory. Preserve their spelling.
function micros(value) {
  const m = value.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/);
  const zone = m[4] === 'Z' ? 'Z' : m[4].length === 3 ? `${m[4]}:00`
    : m[4].includes(':') ? m[4] : `${m[4].slice(0, 3)}:${m[4].slice(3)}`;
  return BigInt(Date.parse(`${m[1]}T${m[2]}${zone}`)) * 1000n + BigInt((m[3] ?? '').padEnd(6, '0'));
}

/** Normalize copies only; REST copies must never be used as deletion fingerprints. */
export function normalizeAliasInputs({ histRows, restRows, aliases, songs }) {
  validateAliases(aliases, songs);
  const bySource = rulesBySource(aliases);
  // Validate original natural keys first so aliases cannot conceal pre-existing duplicates.
  const original = mergeScoreHistory(histRows, []);
  const normalized = original.map((row) => {
    integer(row[0], 'song_id');
    const copy = [...row];
    copy[0] = resolve(row[0], row[1], row[4], bySource);
    return copy;
  });
  const seen = new Set();
  const collisions = new Set();
  for (const row of normalized) {
    if (row[4] === -10) continue;
    const key = naturalKey(row);
    if (seen.has(key)) collisions.add(chartKey(row));
    seen.add(key);
  }
  const groups = new Map([...collisions].map((key) => [key, []]));
  normalized.forEach((row, ordinal) => {
    groups.get(chartKey(row))?.push({ row, ordinal, time: micros(row[5]) });
  });
  const replayed = new Map();
  for (const [key, group] of groups) {
    group.sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : a.ordinal - b.ordinal);
    const syntheticRest = group.map(({ row }, score_id) => ({
      score_id,
      song_id: row[0], diff: row[1], lamp: row[2], ex_score: row[3],
      played_version: row[4], date: row[5], date_kst: row[6],
      play_style: row[7], bp: row[8], note_count: row[9],
    }));
    replayed.set(key, replayScoreBuffer([], syntheticRest));
  }
  const result = [];
  for (const row of normalized) {
    const key = chartKey(row);
    if (!collisions.has(key)) result.push(row);
    else if (replayed.has(key)) {
      result.push(...replayed.get(key));
      replayed.delete(key);
    }
  }
  if (!Array.isArray(restRows)) fail('restRows must be an array');
  const rest = restRows.map((row) => {
    if (!object(row)) fail('REST row must be an object');
    integer(row.song_id, 'song_id');
    integer(row.diff, 'diff');
    integer(row.played_version, 'played_version');
    return { ...row, song_id: resolve(row.song_id, row.diff, row.played_version, bySource) };
  });
  return { histRows: result, restRows: rest };
}

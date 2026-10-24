import { normalizeAliasInputs } from './song-aliases.mjs';
import { gridFromHistory, replayScoreBuffer } from './score-history.mjs';
import { buildCandidate, sha256Hex } from './score-buffer.mjs';

// Pure helpers shared by the local dumper and the fast dump path.
export const SCORE_KEEP = ['song_id', 'diff', 'lamp', 'ex_score', 'played_version', 'date', 'bp', 'note_count'];
export const HIST_COLS = ['song_id', 'diff', 'lamp', 'ex_score', 'played_version', 'date', 'date_kst', 'play_style', 'bp', 'note_count'];

export const slimRow = (row) => {
  const out = {};
  for (const key of SCORE_KEEP) if (row[key] !== undefined) out[key] = row[key];
  return out;
};

export function recentHistoryFromRows(rows, playStyle, nowMs = Date.now()) {
  const todayKst = new Date(nowMs + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const cutoff = new Date(`${todayKst}T00:00:00+09:00`);
  cutoff.setUTCDate(cutoff.getUTCDate() - 92);
  const cutoffKst = cutoff.toISOString().slice(0, 10);
  const distinct = new Map();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== HIST_COLS.length) continue;
    const [song_id, diff, , , played_version, , date_kst, style] = row;
    if (style !== playStyle || played_version === -10 || typeof date_kst !== 'string'
      || date_kst < cutoffKst || date_kst > todayKst) continue;
    const key = `${song_id}\u0000${diff}\u0000${date_kst}`;
    if (!distinct.has(key)) distinct.set(key, { song_id, diff, date_kst });
  }
  return [...distinct.values()].sort((a, b) => b.date_kst.localeCompare(a.date_kst)
    || a.song_id - b.song_id || a.diff - b.diff);
}

// Preserve the original object literal's property insertion order and JSON bytes.
export function assembleUserDump({ timestamp, userRows, radars, osPattern, persona, spPersona, reachNps, dpRows, sp, cumulative, dpRecent, spRecent }) {
  return {
    _v: timestamp, user: userRows[0] ? {
      ...userRows[0],
      sp_r_star: userRows[0].sp_r_star ?? null,
      sp_r_star_model_id: userRows[0].sp_r_star_model_id ?? null,
      sp_r_star_formula_version: userRows[0].sp_r_star_formula_version ?? null,
    } : null, radars, osPattern, persona, spPersona, reachNps,
    dp: dpRows.map(slimRow), sp,
    ...(cumulative ? { dpRecent: dpRecent ?? [], spRecent: spRecent ?? [] } : {}),
    ...(!cumulative && dpRecent ? { dpRecent } : {}),
    ...(!cumulative && spRecent ? { spRecent } : {}),
  };
}

/** Prepare deterministic history bytes and fast score fields from supplied snapshots. */
export function prepareFastDump({ iidxId, previousHistRows, restRows, aliases, aliasesBytes, songs,
  previousUser, generation, nowMs }) {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new TypeError('generation must be a safe integer >= 1');
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) throw new TypeError('nowMs must be a finite number');

  const normalized = normalizeAliasInputs({ histRows: previousHistRows, restRows, aliases, songs });
  const histRows = replayScoreBuffer(normalized.histRows, normalized.restRows);
  const histBytes = new TextEncoder().encode(JSON.stringify(histRows));
  // These bytes are the locally generated body supplied to both candidate validation
  // slots; this does not claim that publication or a subsequent download occurred.
  const candidate = buildCandidate({ iidxId, restRows, previousHistRows, aliases, aliasesBytes, songs,
    publishedHistBytes: histBytes, downloadedHistBytes: histBytes });
  const dp = gridFromHistory(iidxId, histRows, songs, 1).map(slimRow);
  const sp = gridFromHistory(iidxId, histRows, songs, 0).map(slimRow);
  const dpRecent = recentHistoryFromRows(histRows, 1, nowMs);
  const spRecent = recentHistoryFromRows(histRows, 0, nowMs);
  const histRevision = sha256Hex(histBytes);
  const fastPatch = { dp, sp, dpRecent, spRecent, fastGeneration: generation, histRevision };
  return { histRows, histBytes, candidate, fastPatch };
}

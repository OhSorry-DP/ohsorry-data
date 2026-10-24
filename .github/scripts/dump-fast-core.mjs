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

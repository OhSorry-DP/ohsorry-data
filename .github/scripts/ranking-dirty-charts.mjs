const keyOf = (row) => `${row.song_id}\u0000${row.diff}`;

function slimCharts(rows) {
  const out = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.played_version === -10 || row.song_id === undefined || row.diff === undefined) continue;
    out.set(keyOf(row), [row.song_id, row.diff, row.ex_score, row.played_version]);
  }
  return out;
}

function chartList(map) {
  return [...map.values()]
    .map(([songId, diff]) => [songId, diff])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])) || Number(a[1]) - Number(b[1]));
}

export function computeDirtyCharts({ prevOk, prev, user, dp }) {
  const current = slimCharts(dp);
  const previous = slimCharts(prev && prev.dp);
  const all = new Map([...previous, ...current]);
  if (!prevOk || (prev && prev.user && user && prev.user.dj_name !== user.dj_name)) return chartList(all);
  if (prev === null) return chartList(current);
  const dirty = new Map();
  for (const [key, row] of all) {
    const before = previous.get(key);
    if (!before || !current.has(key) || before[2] !== row[2] || before[3] !== row[3]) dirty.set(key, row);
  }
  return chartList(dirty);
}

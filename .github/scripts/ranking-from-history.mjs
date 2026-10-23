import { historyInstant } from './score-history.mjs';

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const compareEx = (a, b) => a === b ? 0 : a === null ? 1 : b === null ? -1 : compare(b, a);
const compareScoreDate = (a, b) => compareEx(a.row[3], b.row[3]) || compare(a.time, b.time);
const compareRanking = (a, b) => compareScoreDate(a, b) || compare(a.id, b.id);

/** Inputs are already normalized to ten columns by normalizeAliasInputs. */
export function representativeRowKey(row) {
  return JSON.stringify(row);
}

/** Build public rankings from normalized history without changing any input. */
export function buildHistoryRankings({ users, histories }) {
  if (!Array.isArray(users) || !(histories instanceof Map)) {
    throw new TypeError('users must be an array and histories must be a Map');
  }
  const names = new Map();
  for (const user of users) {
    if (user === null || typeof user !== 'object' || Array.isArray(user)
      || typeof user.iidx_id !== 'string' || !user.iidx_id
      || (user.dj_name !== null && typeof user.dj_name !== 'string')) {
      throw new TypeError('invalid users metadata: iidx_id must be a nonempty string and dj_name a string or null');
    }
    if (names.has(user.iidx_id)) throw new TypeError(`duplicate users ID: ${user.iidx_id}`);
    names.set(user.iidx_id, user.dj_name);
  }

  const groups = new Map();
  for (const [id, rows] of histories) {
    if (!names.has(id)) continue;
    for (const row of rows) {
      if (row[7] !== 1 || row[4] === -10) continue;
      const key = JSON.stringify([row[0], row[1]]);
      let group = groups.get(key);
      if (!group) {
        group = { song_id: row[0], diff: row[1], representatives: new Map(), winner: null };
        groups.set(key, group);
      }
      const candidate = { id, row, time: historyInstant(row[5]), key: representativeRowKey(row) };
      const previous = group.representatives.get(id);
      if (!previous || (compareScoreDate(candidate, previous) || compare(candidate.key, previous.key)) < 0) {
        group.representatives.set(id, candidate);
      }
      // Inspect every original candidate independently of representative selection.
      if (row[3] !== null && (!group.winner || compareRanking(candidate, group.winner) < 0)) {
        group.winner = candidate;
      }
    }
  }

  const charts = [];
  const winners = [];
  const ordered = [...groups.values()].sort((a, b) => a.song_id - b.song_id || a.diff - b.diff);
  for (const group of ordered) {
    const representatives = [...group.representatives.values()].sort(compareRanking);
    let rank = 0;
    const rows = representatives.slice(0, 100).map(({ id, row }, index) => {
      if (row[3] === null) throw new TypeError(`null ex_score in ranking: ${group.song_id}/${group.diff}/${id}`);
      if (index === 0 || row[3] !== representatives[index - 1].row[3]) rank = index + 1;
      return {
        rank, iidx_id: id, dj_name: names.get(id), ex_score: row[3], lamp: row[2],
        played_version: row[4], date: row[5], bp: row[8], note_count: row[9],
      };
    });
    charts.push({ song_id: group.song_id, diff: group.diff, rows });
    if (group.winner) winners.push({ song_id: group.song_id, diff: group.diff, iidx_id: group.winner.id });
  }
  return { charts, winners };
}

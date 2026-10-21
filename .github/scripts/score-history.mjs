// Pure score history merge helpers. Date parsing follows dbr-history.mjs day()/instant().

const COLS = 10;
const fail = (message) => { throw new TypeError(message); };

function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail('invalid date_kst');
  return value;
}

// PostgreSQL timestamptz 비교를 위해 원문 표기는 보존하고 마이크로초 BigInt로 변환한다.
function instant(value) {
  const m = typeof value === 'string' && value.match(
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/,
  );
  if (!m) fail('date requires a timestamp with timezone (up to 6 fractional digits)');
  day(m[1]);
  if (+m[2] > 23 || +m[3] > 59 || +m[4] > 59) fail('invalid timestamp time');
  const zone = m[6] === 'Z' ? 'Z' : m[6].length === 3 ? `${m[6]}:00`
    : m[6].includes(':') ? m[6] : `${m[6].slice(0, 3)}:${m[6].slice(3)}`;
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}${zone}`);
  if (!Number.isFinite(ms)) fail('invalid timestamp timezone');
  return BigInt(ms) * 1000n + BigInt((m[5] || '').padEnd(6, '0'));
}

function integer(value, label, nullable = false) {
  if (nullable && value === null) return;
  if (!Number.isFinite(value) || !Number.isInteger(value)) fail(`${label} must be a finite integer${nullable ? ' or null' : ''}`);
}

function normalize(row, kind, index) {
  if (!Array.isArray(row) || (row.length !== 8 && row.length !== COLS)) {
    fail(`${kind} row at index ${index} must have 8 or 10 columns`);
  }
  const r = row.length === 8 ? [...row, null, null] : [...row];
  for (const i of [0, 1, 4, 7]) integer(r[i], `column ${i}`);
  if (r[4] === -10 && kind === 'incoming') fail(`incoming row at index ${index} cannot be DBR (-10)`);
  if (r[7] !== 0 && r[7] !== 1) fail(`column 7 at ${kind} row ${index} must be 0 or 1`);
  for (const i of [2, 3, 8, 9]) integer(r[i], `column ${i}`, true);
  const time = instant(r[5]);
  day(r[6]);
  const kst = new Date(Number(time / 1000n) + 9 * 3600000).toISOString().slice(0, 10);
  if (kst !== r[6]) fail(`${kind} row at index ${index}: date_kst does not match date in KST`);
  return { row: r, time };
}

const chartKey = (r) => JSON.stringify([r[0], r[1], r[4], r[7]]);
const naturalKey = (r) => JSON.stringify([r[0], r[1], r[4], r[7], r[6]]);
const ex = (r) => r[3] ?? -1;
const lamp = (r) => r[2] ?? 0;

/** Merge one SQL-request batch into score history without mutating input arrays. */
export function mergeScoreHistory(histRows, incomingRows) {
  if (!Array.isArray(histRows) || !Array.isArray(incomingRows)) fail('histRows and incomingRows must be arrays');
  const hist = histRows.map((r, i) => normalize(r, 'hist', i));
  const incoming = incomingRows.map((r, i) => normalize(r, 'incoming', i));

  const keys = new Set();
  for (let i = 0; i < hist.length; i += 1) {
    const r = hist[i].row;
    if (r[4] === -10) continue;
    const key = naturalKey(r);
    if (keys.has(key)) fail(`duplicate natural key in hist at row ${i}: ${key}`);
    keys.add(key);
  }
  const incomingKeys = new Set();
  for (let i = 0; i < incoming.length; i += 1) {
    const key = chartKey(incoming[i].row);
    if (incomingKeys.has(key)) fail(`duplicate incoming chart key at row ${i}: ${key}`);
    incomingKeys.add(key);
  }

  const result = hist.map(({ row }) => [...row]);
  for (const item of incoming) {
    const row = item.row;
    if (row[4] === -10) continue;
    const ck = chartKey(row);
    const matches = result.map((r, i) => ({ r, i })).filter(({ r }) => r[4] !== -10 && chartKey(r) === ck);
    if (!matches.some(({ r }) => ex(r) > ex(row) || (ex(r) === ex(row) && lamp(r) >= lamp(row)))) {
      const nk = naturalKey(row);
      const slot = result.findIndex((r) => r[4] !== -10 && naturalKey(r) === nk);
      if (slot < 0) result.push([...row]);
      else {
        const old = result[slot];
        const replacement = [...row];
        replacement[8] = row[8] ?? (row[3] !== null && row[3] === old[3] ? old[8] : null);
        replacement[9] = row[9] ?? old[9];
        result[slot] = replacement;
      }
    }

    for (const old of result) {
      if (old[4] === -10 || chartKey(old) !== ck) continue;
      if (old[9] === null && row[9] !== null) old[9] = row[9];
      if (old[8] === null && row[8] !== null && row[3] !== null && old[3] === row[3]) old[8] = row[8];
    }
  }
  return result;
}

/** Build the SQL make_grid_data shape from history rows without mutating inputs. */
export function gridFromHistory(iidxId, histRows, songs, playStyle = 1) {
  if (!Array.isArray(histRows) || !Array.isArray(songs)) fail('histRows and songs must be arrays');
  integer(playStyle, 'playStyle');
  if (playStyle !== 0 && playStyle !== 1) fail('playStyle must be 0 or 1');

  const songById = new Map();
  for (let i = 0; i < songs.length; i += 1) {
    const song = songs[i];
    if (song === null || typeof song !== 'object' || Array.isArray(song)) fail(`song at index ${i} must be an object`);
    integer(song.song_id, `song at index ${i} song_id`);
    if (songById.has(song.song_id)) fail(`duplicate song_id at index ${i}: ${song.song_id}`);
    songById.set(song.song_id, song);
  }

  const groups = new Map();
  for (let i = 0; i < histRows.length; i += 1) {
    const { row, time } = normalize(histRows[i], 'hist', i);
    if (row[7] !== playStyle || row[4] === -10) continue;
    const song = songById.get(row[0]);
    if (song === undefined) continue;
    const key = JSON.stringify([row[0], row[1]]);
    const candidate = { row, time, ordinal: i, song };
    const group = groups.get(key) ?? { ex: null, lamp: null };
    if (group.ex === null || ex(row) > ex(group.ex.row)
      || (ex(row) === ex(group.ex.row) && (time < group.ex.time
        || (time === group.ex.time && i < group.ex.ordinal)))) group.ex = candidate;
    if (group.lamp === null || lamp(row) > lamp(group.lamp.row)
      || (lamp(row) === lamp(group.lamp.row) && (time < group.lamp.time
        || (time === group.lamp.time && i < group.lamp.ordinal)))) group.lamp = candidate;
    groups.set(key, group);
  }

  return [...groups.values()].map(({ ex: exBest, lamp: lampBest }) => {
    const e = exBest.row;
    const l = lampBest.row;
    const latest = exBest.time >= lampBest.time ? exBest : lampBest;
    const song = exBest.song;
    return {
      song_id: e[0], iidx_id: iidxId, diff: e[1], lamp: l[2], ex_score: e[3],
      played_version: latest.row[4], date: latest.row[5], date_kst: latest.row[6],
      textage_song_id: song.textage_song_id, title: song.title, series_no: song.series_no,
      ac: song.ac, legen: song.legen, bp: e[8], note_count: e[9],
    };
  }).sort((a, b) => a.song_id - b.song_id || a.diff - b.diff);
}

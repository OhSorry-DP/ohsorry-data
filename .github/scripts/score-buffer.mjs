// Pure helpers for validating a complete REST score dump against published history.
import { createHash } from 'node:crypto';

export const HIST_COLS = ['song_id', 'diff', 'lamp', 'ex_score', 'played_version', 'date', 'date_kst', 'play_style', 'bp', 'note_count'];
const fail = (message) => { throw new TypeError(message); };

function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail('invalid date_kst');
  return value;
}

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
  if (!Number.isSafeInteger(value)) fail(`${label} must be a safe integer${nullable ? ' or null' : ''}`);
}

function validateRow(row, kind, index) {
  if (!Array.isArray(row) || row.length !== 10) fail(`${kind} row at index ${index} must have 10 columns`);
  for (const i of [0, 1, 4, 7]) integer(row[i], `column ${i}`);
  if (row[4] === -10) fail(`${kind} row at index ${index} cannot be DBR (-10)`);
  if (row[7] !== 0 && row[7] !== 1) fail(`column 7 at ${kind} row ${index} must be 0 or 1`);
  for (const i of [2, 3, 8, 9]) integer(row[i], `column ${i}`, true);
  const time = instant(row[5]);
  day(row[6]);
  const kst = new Date(Number(time / 1000n) + 9 * 3600000).toISOString().slice(0, 10);
  if (kst !== row[6]) fail(`${kind} row at index ${index}: date_kst does not match date in KST`);
  return time;
}

const naturalKey = (row) => JSON.stringify([row[0], row[1], row[4], row[7], row[6]]);

export function rowsFromRest(restRows) {
  if (!Array.isArray(restRows)) fail('scores response must be an array');
  const ids = new Set();
  return restRows.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) fail(`scores row ${index} must be an object`);
    const scoreId = item.score_id;
    if (!Number.isSafeInteger(scoreId) || scoreId < 0) fail(`score_id at row ${index} must be a non-negative safe integer`);
    if (ids.has(scoreId)) fail(`duplicate score_id at row ${index}`);
    ids.add(scoreId);
    const row = HIST_COLS.map((key) => item[key] === undefined ? null : item[key]);
    validateRow(row, 'REST', index);
    return { scoreId, naturalKey: naturalKey(row), row };
  });
}

export function sha256Hex(bytes) {
  if (!(bytes instanceof Uint8Array)) fail('body must be bytes');
  return createHash('sha256').update(bytes).digest('hex');
}

function validateKey(key, iidxId) {
  if (typeof iidxId !== 'string' || !/^[A-Za-z0-9]+$/.test(iidxId)) fail('invalid iidxId');
  if (key !== `hist/${iidxId}.json`) fail('hist key must match iidxId');
}

export function validateCandidate(candidate, iidxId) {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)
    || Object.keys(candidate).sort().join(',') !== 'hist,score_ids') fail('invalid candidate shape');
  if (!Array.isArray(candidate.score_ids)) fail('score_ids must be an array');
  let last = -1;
  for (const id of candidate.score_ids) {
    if (!Number.isSafeInteger(id) || id < 0 || id <= last) fail('score_ids must be unique ascending non-negative safe integers');
    last = id;
  }
  const hist = candidate.hist;
  if (hist === null || typeof hist !== 'object' || Array.isArray(hist)
    || Object.keys(hist).sort().join(',') !== 'key,sha256') fail('invalid hist shape');
  validateKey(hist.key, iidxId);
  if (typeof hist.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(hist.sha256)) fail('invalid hist sha256');
  return candidate;
}

function parseHistBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) fail('hist body must be UTF-8 bytes');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail('hist body is not valid UTF-8'); }
  let rows;
  try { rows = JSON.parse(text); }
  catch { fail('hist body is not valid JSON'); }
  if (!Array.isArray(rows)) fail('hist must be an array');
  const keys = new Set();
  const times = [];
  rows.forEach((row, index) => {
    const time = validateRow(row, 'hist', index);
    const key = naturalKey(row);
    if (keys.has(key)) fail(`duplicate natural key in hist at row ${index}`);
    keys.add(key);
    times.push(time);
  });
  return { rows, keys, times };
}

export function buildCandidate({ iidxId, restRows, publishedHistBytes, downloadedHistBytes }) {
  validateKey(`hist/${iidxId}.json`, iidxId);
  if (!(publishedHistBytes instanceof Uint8Array) || !(downloadedHistBytes instanceof Uint8Array)) fail('hist bodies must be bytes');
  if (publishedHistBytes.length !== downloadedHistBytes.length
    || !Buffer.from(publishedHistBytes).equals(Buffer.from(downloadedHistBytes))) fail('published and downloaded hist bytes differ');
  const incoming = rowsFromRest(restRows);
  const hist = parseHistBytes(downloadedHistBytes);
  const histByKey = new Map(hist.rows.map((row, index) => [naturalKey(row), { row, time: hist.times[index] }]));
  for (const item of incoming) {
    const found = histByKey.get(item.naturalKey);
    if (!found) fail(`REST row missing from hist: ${item.naturalKey}`);
    const row = item.row;
    for (let column = 0; column < row.length; column += 1) {
      if (column === 5) {
        if (instant(row[column]) !== found.time) fail(`REST date differs from hist at natural key ${item.naturalKey}`);
      } else if (row[column] !== found.row[column]) {
        fail(`REST value differs from hist column ${column} at natural key ${item.naturalKey}`);
      }
    }
    histByKey.delete(item.naturalKey);
  }
  if (histByKey.size !== 0) fail('hist contains rows absent from REST');
  return validateCandidate({
    score_ids: incoming.map(({ scoreId }) => scoreId).sort((a, b) => a - b),
    hist: { key: `hist/${iidxId}.json`, sha256: sha256Hex(downloadedHistBytes) },
  }, iidxId);
}

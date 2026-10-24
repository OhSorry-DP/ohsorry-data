// Pure helpers for validating score buffer replay against cumulative published history.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { replayScoreBuffer } from './score-history.mjs';
import { normalizeAliasInputs, validateAliases } from './song-aliases.mjs';

export const HIST_COLS = ['song_id', 'diff', 'lamp', 'ex_score', 'played_version', 'date', 'date_kst', 'play_style', 'bp', 'note_count'];
const ROW_COLS = ['score_id', 'iidx_id', ...HIST_COLS];
const fail = (message) => { throw new TypeError(message); };
const DATE_PARSE_MEMO_LIMIT = 32768;
const dayMemo = new Map();
const instantMemo = new Map();

function day(value) {
  if (typeof value === 'string' && dayMemo.has(value)) return value;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail('invalid date_kst');
  if (dayMemo.size >= DATE_PARSE_MEMO_LIMIT) dayMemo.clear();
  dayMemo.set(value, value);
  return value;
}

function instant(value) {
  const cached = typeof value === 'string' ? instantMemo.get(value) : undefined;
  if (cached !== undefined) return cached;
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
  const result = BigInt(ms) * 1000n + BigInt((m[5] || '').padEnd(6, '0'));
  if (instantMemo.size >= DATE_PARSE_MEMO_LIMIT) instantMemo.clear();
  instantMemo.set(value, result);
  return result;
}

function integer(value, label, nullable = false) {
  if (nullable && value === null) return;
  if (!Number.isSafeInteger(value)) fail(`${label} must be a safe integer${nullable ? ' or null' : ''}`);
}

function validateRow(row, kind, index, allowDbr = false) {
  if (!Array.isArray(row) || row.length !== 10) fail(`${kind} row at index ${index} must have 10 columns`);
  for (const i of [0, 1, 4, 7]) integer(row[i], `column ${i}`);
  if (row[4] === -10 && !allowDbr) fail(`${kind} row at index ${index} cannot be DBR (-10)`);
  if (row[7] !== 0 && row[7] !== 1) fail(`column 7 at ${kind} row ${index} must be 0 or 1`);
  for (const i of [2, 3, 8, 9]) integer(row[i], `column ${i}`, true);
  const time = instant(row[5]);
  day(row[6]);
  const kst = new Date(Number(time / 1000n) + 9 * 3600000).toISOString().slice(0, 10);
  if (kst !== row[6]) fail(`${kind} row at index ${index}: date_kst does not match date in KST`);
  return time;
}

const naturalKey = (row) => JSON.stringify([row[0], row[1], row[4], row[7], row[6]]);

export function rowsFromRest(restRows, iidxId) {
  if (!Array.isArray(restRows)) fail('scores response must be an array');
  const ids = new Set();
  return restRows.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) fail(`scores row ${index} must be an object`);
    if (ROW_COLS.some((key) => !Object.hasOwn(item, key))) fail(`scores row ${index} missing required key`);
    if (typeof item.iidx_id !== 'string' || !/^[A-Za-z0-9]+$/.test(item.iidx_id)
      || (iidxId !== undefined && item.iidx_id !== iidxId)) fail(`scores row ${index} iidx_id differs from requested user`);
    const scoreId = item.score_id;
    if (!Number.isSafeInteger(scoreId) || scoreId < 0) fail(`score_id at row ${index} must be a non-negative safe integer`);
    if (ids.has(scoreId)) fail(`duplicate score_id at row ${index}`);
    ids.add(scoreId);
    const row = HIST_COLS.map((key) => item[key]);
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
    || Object.keys(candidate).sort().join(',') !== 'aliases_sha256,hist,rows,score_ids,v'
    || candidate.v !== 2) fail('invalid candidate v2 shape');
  if (!Array.isArray(candidate.score_ids)) fail('score_ids must be an array');
  let last = -1;
  for (const id of candidate.score_ids) {
    if (!Number.isSafeInteger(id) || id < 0 || id <= last) fail('score_ids must be unique ascending non-negative safe integers');
    last = id;
  }
  if (!Array.isArray(candidate.rows) || candidate.rows.length !== candidate.score_ids.length) fail('rows and score_ids must be the same ascending set');
  const checked = rowsFromRest(candidate.rows, iidxId);
  checked.forEach(({ scoreId }, index) => {
    if (Object.keys(candidate.rows[index]).length !== ROW_COLS.length) fail('invalid candidate row shape');
    if (scoreId !== candidate.score_ids[index]) fail('rows and score_ids must be the same ascending set');
  });
  if (typeof candidate.aliases_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.aliases_sha256)) fail('invalid aliases sha256');
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
    // Existing DBR rows survive replay but are never deletion fingerprints.
    const time = validateRow(row, 'hist', index, true);
    const key = naturalKey(row);
    if (row[4] !== -10) {
      if (keys.has(key)) fail(`duplicate natural key in hist at row ${index}`);
      keys.add(key);
    }
    times.push(time);
  });
  return { rows, keys, times };
}

export function buildCandidate({ iidxId, restRows, previousHistRows, aliases, aliasesBytes, songs, publishedHistBytes, downloadedHistBytes }) {
  validateKey(`hist/${iidxId}.json`, iidxId);
  if (!(publishedHistBytes instanceof Uint8Array) || !(downloadedHistBytes instanceof Uint8Array)) fail('hist bodies must be bytes');
  if (publishedHistBytes.length !== downloadedHistBytes.length
    || !Buffer.from(publishedHistBytes).equals(Buffer.from(downloadedHistBytes))) fail('published and downloaded hist bytes differ');
  const incoming = rowsFromRest(restRows, iidxId);
  if (!(aliasesBytes instanceof Uint8Array)) fail('aliases body must be UTF-8 bytes');
  let parsedAliases;
  try { parsedAliases = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(aliasesBytes)); }
  catch { fail('aliases body must be valid UTF-8 JSON'); }
  validateAliases(parsedAliases, songs);
  if (!isDeepStrictEqual(aliases, parsedAliases)) fail('aliases differ from aliases bytes');
  const normalized = normalizeAliasInputs({ histRows: previousHistRows, restRows, aliases: parsedAliases, songs });
  const expected = replayScoreBuffer(normalized.histRows, normalized.restRows);
  const hist = parseHistBytes(downloadedHistBytes);
  const equalHist = (left, right) => left.length === right.length && left.every((row, index) =>
    row.length === right[index].length && row.every((value, column) => column === 5
      ? instant(value) === instant(right[index][column]) : value === right[index][column]));
  if (!equalHist(expected, hist.rows)) fail('published hist differs from expected normalized replay');
  const again = normalizeAliasInputs({ histRows: expected, restRows, aliases: parsedAliases, songs });
  if (!isDeepStrictEqual(replayScoreBuffer(again.histRows, again.restRows), expected)) fail('normalized replay is not idempotent');
  const rows = restRows.map((item) => Object.fromEntries(ROW_COLS.map((key) => [key, item[key]])))
    .sort((a, b) => a.score_id - b.score_id);
  return validateCandidate({
    v: 2,
    score_ids: incoming.map(({ scoreId }) => scoreId).sort((a, b) => a - b),
    rows,
    hist: { key: `hist/${iidxId}.json`, sha256: sha256Hex(downloadedHistBytes) },
    aliases_sha256: sha256Hex(aliasesBytes),
  }, iidxId);
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { filterScoreHistoryRows, mergeScoreHistory } from '../score-history.mjs';

const canonicalPath = new URL('../score-history.mjs', import.meta.url);
const copies = [
  { name: 'ohSorry dbConn', url: new URL('../../../../ohSorry/modules/dbConn.js', import.meta.url), lang: 'js' },
  { name: 'ohSorryAdmin batch', url: new URL('../../../../ohSorryAdmin/scripts/batchAcUsers.js', import.meta.url), lang: 'js' },
  { name: 'INFOhSorry TypeScript', url: new URL('../../../../INFOhSorry/src/renderer/src/supabaseSync.ts', import.meta.url), lang: 'ts' },
];
const begin = '// BEGIN SCORE_HISTORY_UPLOAD_FILTER_SYNC';
const end = '// END SCORE_HISTORY_UPLOAD_FILTER_SYNC';
const canonicalComment = /\/\/ Canonical source: D:\/work\/oh[Ss]orry-data\/\.github\/scripts\/score-history\.mjs/;

function extractBlock(source, label) {
  const starts = [...source.matchAll(/\/\/ BEGIN SCORE_HISTORY_UPLOAD_FILTER_SYNC/g)];
  const ends = [...source.matchAll(/\/\/ END SCORE_HISTORY_UPLOAD_FILTER_SYNC/g)];
  assert.equal(starts.length, 1, `${label}: expected exactly one BEGIN boundary`);
  assert.equal(ends.length, 1, `${label}: expected exactly one END boundary`);
  assert.ok(starts[0].index < ends[0].index, `${label}: END must follow BEGIN`);
  const block = source.slice(starts[0].index, ends[0].index + end.length);
  assert.match(block, canonicalComment, `${label}: missing canonical source path comment`);
  return block.slice(begin.length, -end.length);
}

function executableBlock(block, lang, label) {
  let code = block.replace(/^\s*\/\/[^\r\n]*(?:\r?\n|$)/gm, '');
  code = code.replace(/\bexport\s+(?=(?:function|const)\b)/g, '');
  if (lang === 'ts') {
    const repoRequire = createRequire(new URL('../../../../INFOhSorry/package.json', import.meta.url));
    let ts;
    try { ts = repoRequire('typescript'); }
    catch (error) { throw new Error(`${label}: cannot resolve INFOhSorry TypeScript dependency`, { cause: error }); }
    code = ts.transpileModule(code, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      reportDiagnostics: true,
    }).outputText;
    code = code.replace(/Object\.defineProperty\(exports, "__esModule"[^;]*;?/g, '');
    code = code.replace(/exports\.(?:mergeScoreHistory|filterScoreHistoryRows)\s*=\s*[^;]+;?/g, '');
  }
  return code;
}

function recover(code, label) {
  const context = vm.createContext({});
  new vm.Script(`${code}\n;globalThis.__scoreFns = { mergeScoreHistory, filterScoreHistoryRows };`, { filename: label }).runInContext(context);
  return context.__scoreFns;
}

function tokens(source) {
  const normalized = source
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, '')
    // dbConn's equivalent filter omits an intermediate index-bearing map.
    .replace(/\.map\(\(\{\s*r\s*,\s*i\s*\}\)\s*=>\s*\(\{\s*r\s*,\s*i\s*\}\)\)\.filter\(\(\{\s*r\s*\}\)\s*=>/g, '.filter((r) =>')
    // TypeScript's explicit typeof guard is redundant with Number.isFinite.
    .replace(/typeof\s+value\s*!==\s*'number'\s*\|\|\s*/g, '');
  const equivalentMapFilter = normalized.replace('.map((r, i) => ({ r, i })).filter(({ r }) =>', '.filter((r) =>');
  return equivalentMapFilter
    .match(/[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|(?:===|!==|=>|\?\?|&&|\|\||<=|>=|\+\+|\+=|-=|\.\.\.)|[^\s]/g) ?? [];
}

function normalizeTokens(list) {
  const replacements = [
    [/^scoreHistoryFail$/, 'fail'], [/^scoreHistoryDay$/, 'day'], [/^scoreHistoryInstant$/, 'instant'],
    [/^scoreHistoryInteger$/, 'integer'], [/^normalizeScoreHistoryRow$/, 'normalize'],
    [/^scoreHistoryChartKey$/, 'chartKey'], [/^scoreHistoryNaturalKey$/, 'naturalKey'],
    [/^scoreHistoryEx$/, 'ex'], [/^scoreHistoryLamp$/, 'lamp'], [/^SCORE_HISTORY_COLS$/, 'COLS'],
  ];
  return list
    .filter((token) => !['{', '}', 'map', 'i', ',', 'const', 'void', 'normalizedRequest', 'merged'].includes(token))
    .map((token) => replacements.find(([re]) => re.test(token))?.[1] ?? token);
}

const sourceText = async (url, label) => {
  try { return await readFile(url, 'utf8'); }
  catch (error) { throw new Error(`${label}: required source is missing or unreadable: ${fileURLToPath(url)}`, { cause: error }); }
};

const canonicalSource = await sourceText(canonicalPath, 'canonical');
const canonicalBlock = extractBlock(canonicalSource, 'canonical');
const canonicalCode = executableBlock(canonicalBlock, 'js', 'canonical');
const canonicalFns = { mergeScoreHistory, filterScoreHistoryRows };
const implementations = [{ name: 'canonical', ...canonicalFns }];
for (const copy of copies) {
  const source = await sourceText(copy.url, copy.name);
  const block = extractBlock(source, copy.name);
  const code = executableBlock(block, copy.lang, copy.name);
  if (copy.lang === 'ts') {
    const canonicalNames = new Set(normalizeTokens(tokens(canonicalCode)).filter((token) => /^[A-Za-z_$][\w$]*$/.test(token)));
    const copyNames = new Set(normalizeTokens(tokens(code)).filter((token) => /^[A-Za-z_$][\w$]*$/.test(token)));
    assert.deepEqual(copyNames, canonicalNames, `${copy.name}: normalized pure-block token set differs`);
  } else {
    assert.deepEqual(normalizeTokens(tokens(code)), normalizeTokens(tokens(canonicalCode)), `${copy.name}: pure block differs from canonical tokens`);
  }
  implementations.push({ name: copy.name, ...recover(code, copy.name) });
}

const date = '2026-10-22T01:02:03.123456+00:00';
const date2 = '2026-10-22T01:02:03.123457+00:00';
const row = (song, diff = 3, lamp = 5, ex = 2000, version = 33, at = date,
  kst = '2026-10-22', style = 1, bp = null, notes = 1500) =>
  [song, diff, lamp, ex, version, at, kst, style, bp, notes];
const payload = { song_id: 100, iidx_id: '89388691', diff: 3, lamp: 5, ex_score: 2100,
  played_version: 33, play_style: 1, date: date2, bp: 0, note_count: 1500 };
const user = { _v: '2026-10-23T02:00:00Z', user: { iidx_id: '89388691' }, dp: [], sp: [] };
const dbr = { scores: [], history: [], updatedAt: '2026-10-23T02:00:00Z', v: 1 };

function observe(impl, method, args) {
  const before = structuredClone(args);
  try {
    const value = impl[method](...args);
    return { result: value, error: null, before, after: structuredClone(args) };
  } catch (error) {
    return { result: undefined, error: { name: error?.name, message: error?.message }, before, after: structuredClone(args) };
  }
}

function parityCases(cases) {
  for (const [method, args] of cases) {
    const expected = observe(implementations[0], method, args);
    for (const impl of implementations.slice(1)) {
      const actual = observe(impl, method, args);
      assert.deepEqual(actual.error, expected.error, `${impl.name} ${method} error parity`);
      assert.equal(JSON.stringify(actual.result), JSON.stringify(expected.result), `${impl.name} ${method} result parity`);
      assert.deepEqual(actual.after, actual.before, `${impl.name} ${method} input mutation`);
      assert.deepEqual(actual.after, expected.after, `${impl.name} ${method} input parity`);
    }
    assert.deepEqual(expected.after, expected.before, `canonical ${method} input mutation`);
  }
}

test('EX precedence, lamp ties, date-only no-op, and new chart keys', () => {
  const hist = [row(1), row(2), row(3), row(4)];
  const incoming = [row(1, 3, 7, 1999), row(2, 3, 5, 2000, 33, date2),
    row(3, 3, 6, 2001, 33, date2), row(4, 3, 1, 1900, 34), row(5, 3, 1, 100)];
  parityCases([['filterScoreHistoryRows', [hist, incoming]]]);
  assert.deepEqual(filterScoreHistoryRows(hist, incoming), [incoming[2], incoming[3], incoming[4]]);
});

test('NULL metadata fills, zero BP is meaningful, lower BP alone is ignored', () => {
  const hist = [row(10, 3, 5, 2000, 33, date, '2026-10-22', 1, null, null),
    row(11, 3, 5, 2000, 33, date, '2026-10-22', 1, null, 1500),
    row(12, 3, 5, 2000, 33, date, '2026-10-22', 1, 2, 1500)];
  const incoming = [row(10, 3, 5, 2000, 33, date2, '2026-10-22', 1, 0, 1500),
    row(11, 3, 5, 2000, 33, date2, '2026-10-22', 1, 0, 1500),
    row(12, 3, 5, 2000, 33, date2, '2026-10-22', 1, 1, 1500)];
  parityCases([['filterScoreHistoryRows', [hist, incoming]], ['mergeScoreHistory', [hist, incoming.slice(0, 2)]]]);
  assert.deepEqual(filterScoreHistoryRows(hist, incoming), [incoming[0], incoming[1]]);
});

test('same-day slot replacement and eight-column extension alone do not upload', () => {
  const legacy = row(20, 3, 4, 1000).slice(0, 8);
  const hist = [legacy, row(21, 3, 4, 1000)];
  const incoming = [row(20, 3, 5, 1001, 33, date2), row(21, 3, 4, 1000, 33, date2)];
  parityCases([['filterScoreHistoryRows', [hist, incoming]]]);
  assert.deepEqual(filterScoreHistoryRows(hist, incoming), [incoming[0]]);
  assert.deepEqual(mergeScoreHistory(hist, [] )[0], [...legacy, null, null]);
});

test('late version 33, SP/DP, INF0 and DBR shape behavior', () => {
  const hist = [row(100, 3, 7, 2200, 34), row(100, 3, 4, 1800, 33),
    row(100, 3, 3, 1600, 33, date, '2026-10-22', 0), row(100, 3, 2, 1500, 0), row(200, 3, 6, 1000, -10)];
  const incoming = [row(100, 3, 5, 1900, 33, date2), row(100, 3, 5, 1700, 33, date2, '2026-10-22', 0),
    row(100, 3, 3, 1550, 0, date2)];
  parityCases([['filterScoreHistoryRows', [hist, incoming]], ['filterScoreHistoryRows', [dbr, incoming]],
    ['filterScoreHistoryRows', [user, incoming]]]);
  assert.deepEqual(filterScoreHistoryRows(hist, incoming), incoming);
  assert.throws(() => filterScoreHistoryRows(dbr, incoming), /arrays/);
  assert.equal(payload.song_id, 100);
});

test('microseconds, original timestamp spelling, date and duplicate errors match', () => {
  const hist = [row(100, 3, 5, 2000, 33, '2026-10-22T10:02:03.123456+09:00')];
  const incoming = [row(100, 3, 6, 2001, 33, '2026-10-22T01:02:03.123457+00:00')];
  const cases = [['filterScoreHistoryRows', [hist, incoming]],
    ['filterScoreHistoryRows', [[], [row(1, 3, 5, 1, 33, 'bad-date')]]],
    ['filterScoreHistoryRows', [[], [row(2), row(2)]]],
    ['filterScoreHistoryRows', [[row(3, 3, 4, 10, 33, date, '2026-10-22'), row(3, 3, 4, 10, 33, date2, '2026-10-22')], []]]];
  parityCases(cases);
  assert.deepEqual(mergeScoreHistory(hist, incoming)[0][5], incoming[0][5]);
});

test('merge conservation, order, reference identity, immutability and missing dependencies', () => {
  const hist = [row(100, 3, 4, 1800), row(101, 2, 3, 900)];
  const a = row(100, 3, 5, 1900, 33, date2);
  const b = row(102, 2, 4, 900, 33, date2);
  const incoming = [a, b];
  const histBefore = structuredClone(hist);
  const inputBefore = structuredClone(incoming);
  const selected = filterScoreHistoryRows(hist, incoming);
  assert.deepEqual(mergeScoreHistory(hist, selected), mergeScoreHistory(hist, incoming));
  assert.deepEqual(selected, [a, b]);
  assert.equal(selected[0], a);
  assert.equal(selected[1], b);
  assert.deepEqual(hist, histBefore);
  assert.deepEqual(incoming, inputBefore);
  assert.deepEqual(payload, { song_id: 100, iidx_id: '89388691', diff: 3, lamp: 5, ex_score: 2100,
    played_version: 33, play_style: 1, date: date2, bp: 0, note_count: 1500 });
  assert.throws(() => createRequire(new URL('../../../../INFOhSorry/package.json', import.meta.url))('typescript/missing-score-filter-test'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { applyTable, balanceLine, buildTables, collectObservations, loadInputs, loadNorm, loadVariants, tableOf, validateTables, compareTables, decideGuard, run, recover } from './dump-sp-clear-map.mjs';

const norm = (value) => value;
const variants = {
  resolveChartId: (row, _songs, _norm, context) => row.textage_song_id || (row.played_version === 0 || context?.source === 'INF' ? 'inf' : 'ac'),
  variantChartKey: (title, diff, id) => id ? `${title}|${diff}${id === 'inf' ? '|@inf' : ''}` : null,
  ratingKeyOf: (row) => row.title && row.diff ? `${row.title}|${row.diff}${(row.__textageSongId ?? row.textage_song_id) === 'inf' ? '|@inf' : ''}` : null,
};
const songs = [{ song_id: 1, title: 'A', textage_song_id: 'ac' }];
const starRows = [{ title: 'A', diff: 'ANOTHER', gameLevel: 11, estEc: 2, estHc: 3, estExh: 4, estFc: 5 }];
const cpiRows = [{ title: 'A', diff: 'ANOTHER', gameLevel: 12, estEc: 3, estExh: 4, estFc: 5 }];
const dump = (id, spStar, lamp = 5, rows) => ({ user: { iidx_id: id, sp_star: spStar }, sp: rows ?? [{ song_id: 1, diff: 3, lamp }] });
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => body });
const fakeFetch = (overrides = {}) => async (url) => response(overrides[url] ?? ({
  'https://data.iidx.in/songs.json': JSON.stringify(songs),
  'https://data.iidx.in/data/textage-meta.json': JSON.stringify({ songs: {} }),
  'https://data.iidx.in/data/cpi.json': JSON.stringify(cpiRows),
  'https://data.iidx.in/data/sp-clear-star.json': JSON.stringify({ rows: starRows }),
  'https://iidx.in/legacy/shared/variants.js': 'export function resolveChartId(){}; export function ratingKeyOf(){}; export function variantChartKey(){}',
  'https://data.iidx.in/lib/normTitle.js': 'module.exports={norm: value => value};',
})[url]);

test('user null 덤프는 제외하고 user 누락은 장애', () => {
  const base = { songs, textage: { songs: {} }, cpiRows, starRows, norm, variants };
  const counts = collectObservations({ ...base, dumps: [{ user: null, sp: [] }, dump('A1', 3)] }).counts;
  assert.equal(counts.usersRead, 2);
  assert.equal(counts.usersWithoutStar, 1);
  assert.throws(() => collectObservations({ ...base, dumps: [{ sp: [] }] }));
});

test('유저 덤프를 각각 한 번 읽고 저장 sp_star를 보존하며 null은 제외', async () => {
  const reads = [];
  const loaded = await loadInputs({ list: async () => ['user/A1.json', 'user/B2.json', 'user/C3.json'],
    getText: async (key) => { reads.push(key); return JSON.stringify(key.includes('A1') ? dump('A1', 3) : key.includes('B2') ? dump('B2', 4) : dump('C3', null)); },
    fetchImpl: fakeFetch(), importModule: async () => variants });
  assert.deepEqual(reads.sort(), ['user/A1.json', 'user/B2.json', 'user/C3.json']);
  const result = collectObservations({ ...loaded, norm, variants });
  assert.deepEqual(result.plays.get('A|ANOTHER'), [['A1', 3, 5], ['B2', 4, 5]]);
  assert.deepEqual(result.counts, { usersRead: 3, usersWithStar: 2, usersWithoutStar: 1, observations: 2, unresolved: 0, outOfScope: 0 });
  assert.deepEqual(Object.keys(loaded.hashes).sort(), ['cpi', 'normTitle', 'songs', 'sp-clear-star', 'textage', 'variants']);
});

test('목록 뒤 404, 500, JSON 파손과 공개 URL 오류 및 형식 오류를 reject', async () => {
  for (const raw of [null, Object.assign(new Error('HTTP 500'), { status: 500 }), '{']) {
    await assert.rejects(loadInputs({ list: async () => ['user/A1.json'], getText: async () => raw, fetchImpl: fakeFetch(), importModule: async () => variants }));
  }
  for (const [url, body, status] of [
    ['https://data.iidx.in/songs.json', '{}', 200],
    ['https://data.iidx.in/data/cpi.json', '{"ratings":[]}', 200],
    ['https://data.iidx.in/data/sp-clear-star.json', '[]', 200],
    ['https://data.iidx.in/data/cpi.json', '{}', 500],
  ]) {
    await assert.rejects(loadInputs({ list: async () => ['user/A1.json'], getText: async () => JSON.stringify(dump('A1', 3)),
      fetchImpl: async (requested) => requested === url ? response(body, status) : fakeFetch()(requested), importModule: async () => variants }));
  }
});

test('norm UMD와 세 함수 ESM을 쓰고 HTML 또는 함수 누락을 reject', async () => {
  assert.equal(loadNorm('module.exports={norm: value => value};')('X'), 'X');
  const source = 'export function resolveChartId(){}; export function ratingKeyOf(){}; export function variantChartKey(){}';
  assert.deepEqual(await loadVariants(source, async () => variants), variants);
  assert.throws(() => loadNorm('<html>'), /SyntaxError|norm/);
  await assert.rejects(loadVariants(source, async () => ({ resolveChartId() {}, ratingKeyOf() {} })), /variantChartKey/);
  await assert.rejects(loadInputs({ list: async () => ['user/A1.json'], getText: async () => JSON.stringify(dump('A1', 3)),
    fetchImpl: async (url) => response(url === 'https://iidx.in/legacy/shared/variants.js' ? '<html>' : await fakeFetch()(url).text()), importModule: async () => variants }));
});

test('AC와 INF 식별을 분리하고 DBR을 제외하며 미지 song_id는 unresolved로 센다', () => {
  const rows = [
    { song_id: 1, diff: 3, lamp: 5 },
    { song_id: 1, diff: 3, lamp: 5, played_version: 0, textage_song_id: 'inf' },
    { song_id: 1, diff: 3, lamp: 5, played_version: -10 },
    { song_id: 404, diff: 3, lamp: 5 },
    { song_id: 1, diff: 3, lamp: 5, title: 'Unrated' },
  ];
  const result = collectObservations({ dumps: [dump('U1', 3, 5, rows)], songs, cpiRows: [], starRows, norm, variants });
  assert.deepEqual(result.plays.get('A|ANOTHER'), [['U1', 3, 5]]);
  assert.equal(result.counts.unresolved, 1);
  assert.equal(result.counts.outOfScope, 2);
  const dbrOnly = collectObservations({ dumps: [dump('DBR', 3, 5, [{ song_id: 1, diff: 3, lamp: 5, played_version: -10 }])], songs, cpiRows: [], starRows, norm, variants });
  assert.equal(dbrOnly.plays.has('A|ANOTHER'), false);
  assert.equal(dbrOnly.counts.unresolved, 0);
  const normal = collectObservations({ dumps: [dump('SP', 3, 5, [{ song_id: 1, diff: 3, lamp: 5 }])], songs, cpiRows: [], starRows, norm, variants });
  assert.deepEqual(normal.plays.get('A|ANOTHER'), [['SP', 3, 5]]);
});

test('유저와 채보마다 최고 램프 하나만 관측하고 잘못된 램프는 장애', () => {
  const result = collectObservations({ dumps: [dump('A1', 3, 5, [{ song_id: 1, diff: 3, lamp: 1 }, { song_id: 1, diff: 3, lamp: 5 }]),
    dump('B2', 4, 0), dump('C3', 5, null), dump('D4', 6, 5, [{ song_id: 1, diff: 3, lamp: undefined }])], songs, cpiRows: [], starRows, norm, variants });
  assert.deepEqual(result.plays.get('A|ANOTHER'), [['A1', 3, 5]]);
  const reversed = collectObservations({ dumps: [dump('A1', 3, 5, [{ song_id: 1, diff: 3, lamp: 5 }, { song_id: 1, diff: 3, lamp: 1 }])], songs, cpiRows: [], starRows, norm, variants });
  assert.deepEqual(reversed.plays.get('A|ANOTHER'), [['A1', 3, 5]]);
  for (const lamp of ['5', NaN, 1.5, -1, 8]) assert.throws(() => collectObservations({ dumps: [dump('E5', 7, lamp)], songs, cpiRows: [], starRows, norm, variants }), /lamp 값 오류/);
  for (let lamp = 1; lamp <= 7; lamp++) assert.doesNotThrow(() => collectObservations({ dumps: [dump('E5', 7, lamp)], songs, cpiRows: [], starRows, norm, variants }));
});

test('SP11은 CPI를 받지 않고 SP12는 유한 CPI 값을 우선하며 CPI 전용 곡은 12레벨로 포함', () => {
  const merged = collectObservations({ dumps: [], songs, cpiRows, starRows, norm, variants });
  assert.equal(merged.stars.get('A|ANOTHER').gameLevel, 11);
  assert.equal(merged.stars.get('A|ANOTHER').estEc, 2);
  const sp12 = collectObservations({ dumps: [], songs, cpiRows, starRows: [{ ...starRows[0], gameLevel: 12, estEc: 2 }], norm, variants });
  assert.equal(sp12.stars.get('A|ANOTHER').estEc, 3);
  const nullCpi = collectObservations({ dumps: [], songs, cpiRows: [{ ...cpiRows[0], estEc: null }], starRows: [{ ...starRows[0], gameLevel: 12, estEc: 2 }], norm, variants });
  assert.equal(nullCpi.stars.get('A|ANOTHER').estEc, 2);
  const cpiOnly = collectObservations({ dumps: [], songs, cpiRows: [{ ...cpiRows[0], title: 'B' }], starRows: [], norm, variants });
  assert.equal(cpiOnly.stars.get('B|ANOTHER').gameLevel, 12);
});

test('확정 산식과 보정표 및 필수 표 계약을 검증한다', () => {
  const makePlays = (stars, lamps) => stars.map((star, index) => [`U${index}`, star, lamps[index]]);
  assert.equal(balanceLine(makePlays(Array(7).fill(1), Array(7).fill(1)), 'ec'), null);
  assert.deepEqual(balanceLine(makePlays([1, 1, 1, 1, 2, 2, 2, 2], [1, 1, 1, 1, 3, 3, 3, 3]), 'ec'), { c: 2, st: 'hard' });
  assert.deepEqual(balanceLine(makePlays([1, 2, 1, 2, 1, 2, 1, 2], Array(8).fill(3)), 'ec'), { c: 1, st: 'easy' });
  assert.deepEqual(balanceLine(makePlays([1, 2, 1, 2, 1, 2, 1, 2], Array(8).fill(1)), 'ec'), { c: 2, st: 'hard' });
  assert.deepEqual(balanceLine(makePlays([1.01, 1.01, 1.01, 1.01, 1.29, 1.29, 1.29, 1.29], [1, 1, 1, 1, 3, 3, 3, 3]), 'ec'), { c: 1.15, st: 'ok' });
  const table = tableOf([[1, 4], [1, 3], [1, 2], [1, 1], [1, 5], [1, 6], [2, 1], [2, 1], [2, 1], [2, 1], [2, 1]]);
  assert.deepEqual(table, [[1.5, 4], [2.5, 4]]);
  assert.deepEqual([applyTable(2, table), applyTable(1, table), applyTable(3, table)], [4, 3.5, 4.5]);
  const stars = new Map(); const observations = new Map();
  for (let i = 0; i < 6; i++) {
    const key = `chart${i}`;
    stars.set(key, { gameLevel: i < 4 ? 11 : 12, estEc: 1.1, estHc: 1.1, estExh: 1.1, estFc: 1.1 });
    observations.set(key, Array.from({ length: 8 }, (_, n) => [`u${n}`, 1, 1]));
  }
  const built = buildTables({ stars, plays: observations, measure: () => ({ c: 1, st: 'hard' }) });
  assert.deepEqual(built.tables['11'].ec, []);
  assert.equal(built.tables['12'].hc, null);
  for (const lamp of ['ec', 'hc', 'ex', 'fc']) assert.ok(Array.isArray(built.tables['11'][lamp]));
  for (const lamp of ['ec', 'ex', 'fc']) assert.ok(Array.isArray(built.tables['12'][lamp]));
  const sixStars = new Map(Array.from({ length: 6 }, (_, i) => [`k${i}`, { gameLevel: 11, estEc: 2.1 }]));
  const sixPlays = new Map([...sixStars.keys()].map((key, i) => [key, [[`u${i}`, 1, 1]]]));
  const kept = buildTables({ stars: sixStars, plays: sixPlays, measure: (plays) => ({ c: 2, st: Number(plays[0][0].slice(1)) < 3 ? 'hard' : 'ok' }) });
  assert.deepEqual(kept.tables['11'].ec, [[2.5, 2]]);
  const fourHard = buildTables({ stars: sixStars, plays: sixPlays, measure: (plays) => ({ c: 2, st: Number(plays[0][0].slice(1)) < 4 ? 'hard' : 'ok' }) });
  assert.deepEqual(fourHard.tables['11'].ec, []);
});

test('램프 임계와 표 경계', () => {
  const p = (lamp) => [1.01,1.01,1.01,1.01,1.29,1.29,1.29,1.29].map((s, i) => ['u' + i, s, i < 4 ? 1 : lamp]);
  assert.equal(balanceLine(p(3), 'ec').st, 'ok');
  assert.equal(balanceLine(p(2), 'ec').st, 'hard');
  assert.equal(balanceLine(p(5), 'hc').st, 'ok');
  assert.equal(balanceLine(p(4), 'hc').st, 'hard');
  assert.equal(balanceLine(p(6), 'ex').st, 'ok');
  assert.equal(balanceLine(p(5), 'ex').st, 'hard');
  assert.equal(balanceLine(p(7), 'fc').st, 'ok');
  assert.equal(balanceLine(p(6), 'fc').st, 'hard');
  assert.deepEqual(tableOf([[1,1],[1,2],[1,3],[1,4]]), []);
  assert.deepEqual(tableOf([[1,1],[1,2],[1,3],[1,4],[1,5]]), [[1.5,3]]);
});

const guardTables = (y) => ({ '11': { ec: [[0.5, y], [1.5, y + 1]], hc: [[0.5, y], [1.5, y + 1]], ex: [[0.5, y], [1.5, y + 1]], fc: [[0.5, y], [1.5, y + 1]] }, '12': { ec: [[0.5, y], [1.5, y + 1]], ex: [[0.5, y], [1.5, y + 1]], fc: [[0.5, y], [1.5, y + 1]] } });
const generation = (tables) => ({ generation: 'g', generatedAt: '2026-11-07T00:00:00Z', tables });
const guardPolicy = { maxChange: 0.1, similarityDistance: 0.05, directionTolerance: 0.01, consecutiveRounds: 3, version: 'test', starPositions: [0.5, 1.5] };

test('guard 표 검증 및 비교와 연속 확인 계약', () => {
  const a = guardTables(1), b = guardTables(1.2);
  assert.deepEqual(validateTables(a), { valid: true });
  for (const mutate of [t => { t['11'].ec = []; }, t => { t['11'].ec[0][1] = Infinity; }, t => { t['11'].ec[1][0] = 0.5; }, t => { t['11'].ec[1][1] = 0; }]) {
    const bad = guardTables(1); mutate(bad); assert.throws(() => validateTables(bad));
  }
  b['11'].ec.pop();
  const comparison = compareTables(a, b, [0.5, 1.5]);
  assert.ok(Math.abs(comparison.worst - 0.2) < 1e-12);
  assert.deepEqual(comparison.tables['11.ec'].lostNodes, [1.5]);
  assert.equal(comparison.tables['11.ec'].currentNodeCount, 2);
  const current = generation(a), candidate = generation(guardTables(1.2));
  let pending = null;
  for (const round of ['2026-11-07', '2026-11-08']) {
    const result = decideGuard({ current, candidate, pending, policy: guardPolicy, round, positions: { '11': { ec: [0.5, 1.5] } } });
    assert.equal(result.action, 'hold'); pending = result.pending;
  }
  assert.equal(decideGuard({ current, candidate, pending, policy: guardPolicy, round: '2026-11-09', positions: { '11': { ec: [0.5, 1.5] } } }).action, 'publish');
});

test('guard는 역방향·유사도 이탈·회차 단절을 초기화하고 재시도·해시 변경을 보존한다', () => {
  const current = generation(guardTables(1)), a = generation(guardTables(1.2)), b = generation(guardTables(1.4));
  const first = decideGuard({ current, candidate: a, pending: null, policy: guardPolicy, round: '2026-11-07' }).pending;
  assert.equal(decideGuard({ current, candidate: a, pending: first, policy: guardPolicy, round: '2026-11-07' }).pending.count, 1);
  assert.equal(decideGuard({ current, candidate: b, pending: first, policy: guardPolicy, round: '2026-11-08' }).pending.count, 1);
  assert.equal(decideGuard({ current, candidate: generation(guardTables(0.8)), pending: first, policy: guardPolicy, round: '2026-11-08' }).pending.count, 1);
  const changed = { ...a, inputHashes: { value: 'changed' } };
  assert.equal(decideGuard({ current, candidate: changed, pending: first, policy: guardPolicy, round: '2026-11-08' }).pending.count, 2);
  assert.equal(decideGuard({ current, candidate: a, pending: first, policy: guardPolicy, round: '2026-11-10' }).pending.count, 1);
  assert.equal(decideGuard({ current, candidate: generation(guardTables(1.05)), pending: null, policy: guardPolicy, round: '2026-11-07' }).action, 'publish');
});

const A = [[0.5, 1], [1.5, 2]];
const B = [[0.5, 1.2], [1.5, 2.2]];
const all = (t) => ({ '11': { ec: t, hc: t, ex: t, fc: t }, '12': { ec: t, ex: t, fc: t } });
const only = (level, lamp, t) => { const x = all(A); x[level] = { ...x[level], [lamp]: t }; return x; };
const pos = { '11': { ec: [1], hc: [1], ex: [1], fc: [1] }, '12': { ec: [1], ex: [1], fc: [1] } };
const policy = { version: 't', maxChange: 0.1, similarityDistance: 0.05, directionTolerance: 0.01, consecutiveRounds: 3 };
const cand = (t) => ({ tables: t });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} is not close to ${b}`);

test('표 7개를 표마다 비교한다', () => {
  const comparison = compareTables(all(A), only('12', 'fc', B), pos);
  near(comparison.worst, 0.2);
  assert.equal(Object.keys(comparison.tables).length, 7);
  assert.equal(comparison.tables['12.fc'].actual.direction, 1);
  near(comparison.tables['12.fc'].actual.maxAbs, 0.2);
  assert.equal(comparison.tables['11.ec'].actual.maxAbs, 0);
  near(compareTables(all(A), only('11', 'hc', B), pos).worst, 0.2);
  const lost = compareTables(all(A), only('12', 'ex', [[0.5, 1]]), pos);
  assert.deepEqual(lost.tables['12.ex'].lostNodes, [1.5]);
  assert.deepEqual(lost.tables['11.ec'].lostNodes, []);
});

test('정책이 없거나 깨지면 던진다', () => {
  const args = { current: cand(all(A)), candidate: cand(all(B)), pending: null, round: '2026-11-01', positions: pos };
  assert.throws(() => decideGuard({ ...args, policy: null }));
  for (const key of ['maxChange', 'similarityDistance', 'directionTolerance']) {
    const broken = { ...policy }; delete broken[key];
    assert.throws(() => decideGuard({ ...args, policy: broken }));
  }
  assert.throws(() => decideGuard({ ...args, policy: { ...policy, consecutiveRounds: 0 } }));
  assert.throws(() => decideGuard({ ...args, policy: { ...policy, version: '' } }));
});

test('연속 N회면 게시', () => {
  const args = { current: cand(all(A)), candidate: cand(all(B)), policy, positions: pos };
  const first = decideGuard({ ...args, pending: null, round: '2026-11-01' });
  assert.equal(first.action, 'hold'); assert.equal(first.pending.count, 1);
  const second = decideGuard({ ...args, pending: first.pending, round: '2026-11-02' });
  assert.equal(second.action, 'hold'); assert.equal(second.pending.count, 2);
  const third = decideGuard({ ...args, pending: second.pending, round: '2026-11-03' });
  assert.equal(third.action, 'publish'); assert.equal(third.pending, null);
  const retried = decideGuard({ ...args, pending: first.pending, round: '2026-11-01' });
  const retryAgain = decideGuard({ ...args, pending: retried.pending, round: '2026-11-01' });
  assert.equal(retryAgain.action, 'hold'); assert.equal(retryAgain.pending.count, 1);
  const small = cand(all([[0.5, 1.05], [1.5, 2.05]]));
  const smallResult = decideGuard({ ...args, candidate: small, pending: null, round: '2026-11-01' });
  assert.equal(smallResult.action, 'publish'); assert.equal(smallResult.pending, null);
});

test('끊기면 1로 돌아간다', () => {
  const current = cand(all(A));
  const first = cand(all(B));
  const pending = { first, last: first, count: 2, policyVersion: 't', lastRound: '2026-11-02' };
  const check = (candidate, round = '2026-11-03', suppliedPending = pending) => {
    const result = decideGuard({ current, candidate, pending: suppliedPending, policy, round, positions: pos });
    assert.equal(result.action, 'hold'); assert.equal(result.pending.count, 1);
  };
  check(first, '2026-11-04');
  check(cand(all([[0.5, 0.8], [1.5, 1.8]])));
  check(cand(all([[0.5, 1.3], [1.5, 2.3]])));
  const previous = cand(all([[0.5, 1.24], [1.5, 2.24]]));
  const candidate = cand(all([[0.5, 1.28], [1.5, 2.28]]));
  check(candidate, '2026-11-03', { first, last: previous, count: 2, policyVersion: 't', lastRound: '2026-11-02' });
  const previousOnlyMismatch = cand(all([[0.5, 1.3], [1.5, 2.3]]));
  const candidateNearFirst = cand(all([[0.5, 1.24], [1.5, 2.24]]));
  check(candidateNearFirst, '2026-11-03', { first, last: previousOnlyMismatch, count: 2, policyVersion: 't', lastRound: '2026-11-02' });
});

const workflowInputs = () => {
  const songs = [], starRows = [], dumps = [];
  for (const [level, baseId] of [[11, 1], [12, 101]]) for (let i = 0; i < 5; i++) {
    const song_id = baseId + i, title = `W${level}-${i}`;
    songs.push({ song_id, title, textage_song_id: 'ac' });
    starRows.push({ title, diff: 'ANOTHER', gameLevel: level, estEc: 2.1, estHc: 2.1, estExh: 2.1, estFc: 2.1 });
  }
  for (let user = 0; user < 8; user++) dumps.push({ user: { iidx_id: `U${user}`, sp_star: user + 1 },
    sp: songs.map((song) => ({ song_id: song.song_id, diff: 3, lamp: user < 4 ? 7 : 1 })) });
  return { dumps, songs, textage: { songs: {} }, cpiRows: [], starRows, norm, variants, hashes: { songs: 'hash' } };
};
const workflowBaseTables = () => ({ '11': { ec: [[2.5, 1]], hc: [[2.5, 1]], ex: [[2.5, 1]], fc: [[2.5, 1]] }, '12': { ec: [[2.5, 1]], ex: [[2.5, 1]], fc: [[2.5, 1]] } });
const storedGeneration = (tables = workflowBaseTables()) => ({ generation: createHash('sha256').update(JSON.stringify(tables)).digest('hex'),
  generatedAt: '2026-11-01T00:00:00.000Z', tables,
  meta: { formulaVersion: 'sp-clear-map-v1', inputHashes: {}, counts: {}, bins: {}, guard: null } });
function fakeStore(initial = null, options = {}) {
  let value = initial, etag = '"one"'; const writes = [];
  return { writes, async read() { return value === null ? null : { body: value, etag }; }, async put(_key, body, condition) {
    writes.push({ body, condition });
    if (options.failPut) throw new Error('PUT failed');
    if (options.conflict) throw new Error('R2 PUT HTTP 412');
    value = options.mismatch ? '{}' : body; etag = '"two"';
    if (options.afterPut) throw new Error('network response lost');
  } };
}
const logger = () => { const lines = []; return { lines, log(line) { lines.push(line); }, error() {} }; };
const assertCandidateLine = (logs, candidate) => {
  const lines = logs.lines.filter((line) => line.startsWith('SP_CLEAR_MAP_CANDIDATE_JSON '));
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0].slice('SP_CLEAR_MAP_CANDIDATE_JSON '.length)), candidate);
};

test('최초 게시 404 조건부 생성과 기존 정본 거부', async () => {
  const store = fakeStore();
  const inputs = workflowInputs();
  const first = await run({ mode: 'initial', env: {}, client: store, loadInputsImpl: async () => inputs,
    log: logger(), now: () => new Date('2026-11-07T12:00:00Z'), policy: null });
  assert.equal(first.action, 'publish'); assert.equal(store.writes.length, 1);
  const existing = fakeStore(JSON.stringify({ version: 1, current: storedGeneration(), previous: null, pending: null }));
  await assert.rejects(run({ mode: 'initial', env: {}, client: existing, loadInputsImpl: async () => { throw new Error('should not load'); }, log: logger() }), /이미 존재함/);
  assert.equal(existing.writes.length, 0);
});

test('관찰 404와 dry-run은 무쓰기이며 자동 404는 실패', async () => {
  const store = fakeStore();
  const observeLogs = logger();
  const observe = await run({ mode: 'auto', env: {}, client: store, loadInputsImpl: async () => workflowInputs(), log: observeLogs, now: () => new Date('2026-11-07T12:00:00Z') });
  assert.equal(observe.action, 'observe');
  assertCandidateLine(observeLogs, observe.candidate);
  assert.equal(store.writes.length, 0);
  const dryStore = fakeStore();
  const dry = await run({ mode: 'dry-run', env: { SP_CLEAR_MAP_AUTO_PUBLISH: 'true' }, client: dryStore, loadInputsImpl: async () => workflowInputs(), log: logger(), now: () => new Date('2026-11-07T12:00:00Z'), policy: null });
  assert.equal(dry.action, 'dry-run'); assert.equal(dryStore.writes.length, 0);
  await assert.rejects(run({ mode: 'auto', env: { SP_CLEAR_MAP_AUTO_PUBLISH: 'true' }, client: fakeStore(), loadInputsImpl: async () => { throw new Error('must not load'); }, log: logger() }), /정본 자산 404/);
  const old = storedGeneration();
  await assert.rejects(run({ mode: 'auto', env: { SP_CLEAR_MAP_AUTO_PUBLISH: 'true' },
    client: fakeStore(JSON.stringify({ version: 1, current: old, previous: null, pending: null })),
    loadInputsImpl: async () => workflowInputs(), log: logger(), now: () => new Date('2026-11-07T12:00:00Z'), policy: null }), /GUARD_POLICY/);
});

test('후보 로그는 접두 한 줄이며 전체 세대 JSON이다', async () => {
  const logs = logger();
  const result = await run({ mode: 'dry-run', env: {}, client: fakeStore(), loadInputsImpl: async () => workflowInputs(), log: logs, now: () => new Date('2026-11-07T12:00:00Z') });
  const candidates = logs.lines.filter((line) => line.startsWith('SP_CLEAR_MAP_CANDIDATE_JSON '));
  assert.equal(candidates.length, 1);
  const parsed = JSON.parse(candidates[0].slice('SP_CLEAR_MAP_CANDIDATE_JSON '.length));
  assert.deepEqual(parsed, result.candidate); assert.equal(Object.keys(parsed.tables['11']).length + Object.keys(parsed.tables['12']).length, 7);
  assert.equal(Object.hasOwn(parsed.tables['12'], 'hc'), false);
  assert.ok(parsed.generation && parsed.meta.inputHashes && parsed.meta.counts && parsed.meta.bins);
});

test('조건부 저장 실패와 사후 본문 불일치는 추가 쓰기 없이 실패', async () => {
  const input = workflowInputs();
  for (const options of [{ failPut: true }, { mismatch: true }, { conflict: true }]) {
    const store = fakeStore(null, options);
    await assert.rejects(run({ mode: 'initial', env: {}, client: store, loadInputsImpl: async () => input, log: logger(), now: () => new Date('2026-11-07T12:00:00Z') }));
    assert.equal(store.writes.length, 1);
  }
  const lost = fakeStore(null, { afterPut: true });
  const result = await run({ mode: 'initial', env: {}, client: lost, loadInputsImpl: async () => input, log: logger(), now: () => new Date('2026-11-07T12:00:00Z') });
  assert.equal(result.action, 'publish'); assert.equal(lost.writes.length, 1);
});

test('가드는 보류 때 표·시각을 보존하고 게시 때 이전 세대를 한 개 보관한다', async () => {
  const oldTables = workflowBaseTables();
  for (const lamps of Object.values(oldTables)) for (const key of Object.keys(lamps)) lamps[key] = [[2.5, 0]];
  const old = storedGeneration(oldTables);
  const previous = storedGeneration(workflowBaseTables());
  const asset = JSON.stringify({ version: 1, current: old, previous, pending: null });
  const policy = { version: 'test', maxChange: 0, similarityDistance: 0.05, directionTolerance: 0.01, consecutiveRounds: 3 };
  const holdStore = fakeStore(asset);
  const holdLogs = logger();
  const held = await run({ mode: 'auto', env: { SP_CLEAR_MAP_AUTO_PUBLISH: 'true' }, client: holdStore,
    loadInputsImpl: async () => workflowInputs(), log: holdLogs, now: () => new Date('2026-11-07T12:00:00Z'), policy });
  assert.equal(held.action, 'hold');
  assertCandidateLine(holdLogs, held.candidate);
  const heldAsset = JSON.parse((await holdStore.read('')).body);
  assert.deepEqual(heldAsset.current, old); assert.deepEqual(heldAsset.previous, previous); assert.equal(heldAsset.pending.count, 1);
  const publishStore = fakeStore(asset);
  const publishLogs = logger();
  const published = await run({ mode: 'auto', env: { SP_CLEAR_MAP_AUTO_PUBLISH: 'true' }, client: publishStore,
    loadInputsImpl: async () => workflowInputs(), log: publishLogs, now: () => new Date('2026-11-07T12:00:00Z'),
    policy: { ...policy, maxChange: 10 } });
  assert.equal(published.action, 'publish');
  assertCandidateLine(publishLogs, published.candidate);
  const finalAsset = JSON.parse((await publishStore.read('')).body);
  assert.equal(finalAsset.previous.generation, old.generation); assert.equal(finalAsset.pending, null);
});

test('같은 세대 게시 결정은 previous를 보존하고 pending만 정리한다', async () => {
  const inputs = workflowInputs();
  const preview = await run({ mode: 'dry-run', env: {}, client: fakeStore(), loadInputsImpl: async () => inputs,
    log: logger(), now: () => new Date('2026-11-07T12:00:00Z') });
  const current = storedGeneration(preview.candidate.tables);
  const pending = { first: current, last: current, count: 1, policyVersion: 'test', lastRound: '2026-11-06' };
  const policy = { ...guardPolicy, maxChange: 10 };
  const emptyStore = fakeStore(JSON.stringify({ version: 1, current, previous: null, pending: null }));
  const unchanged = await run({ mode: 'auto', env: { SP_CLEAR_MAP_AUTO_PUBLISH: 'true' }, client: emptyStore,
    loadInputsImpl: async () => inputs, log: logger(), now: () => new Date('2026-11-07T12:00:00Z'), policy });
  assert.equal(unchanged.action, 'unchanged');
  assert.equal(emptyStore.writes.length, 0);

  const previous = storedGeneration(workflowBaseTables());
  const original = { version: 1, current, previous, pending };
  const pendingStore = fakeStore(JSON.stringify(original));
  const cleared = await run({ mode: 'auto', env: { SP_CLEAR_MAP_AUTO_PUBLISH: 'true' }, client: pendingStore,
    loadInputsImpl: async () => inputs, log: logger(), now: () => new Date('2026-11-07T12:00:00Z'), policy });
  assert.equal(cleared.action, 'unchanged');
  assert.equal(pendingStore.writes.length, 1);
  const written = JSON.parse(pendingStore.writes[0].body);
  assert.deepEqual(written.current, original.current);
  assert.deepEqual(written.previous, original.previous);
  assert.equal(written.pending, null);
});

test('복구는 조건부 승격하며 충돌 시 실패한다', async () => {
  const current = storedGeneration();
  const previousTables = workflowBaseTables();
  for (const lamps of Object.values(previousTables)) for (const key of Object.keys(lamps)) lamps[key] = [[2.5, 0]];
  const previous = storedGeneration(previousTables);
  const asset = JSON.stringify({ version: 1, current, previous, pending: { first: current, last: current, count: 1, policyVersion: 'p', lastRound: '2026-11-07' } });
  const store = fakeStore(asset);
  const result = await recover({ client: store, generation: 'previous', log: logger() });
  assert.equal(result.current.generation, previous.generation); assert.equal(result.previous.generation, current.generation); assert.equal(result.pending, null);
  const conflict = fakeStore(asset, { conflict: true });
  await assert.rejects(recover({ client: conflict, generation: 'current', log: logger() }), /412/);
});

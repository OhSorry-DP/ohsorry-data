import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTable, balanceLine, buildTables, collectObservations, loadInputs, loadNorm, loadVariants, tableOf } from './dump-sp-clear-map.mjs';

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
});

test('유저와 채보마다 최고 램프 하나만 관측하고 잘못된 램프는 장애', () => {
  const result = collectObservations({ dumps: [dump('A1', 3, 5, [{ song_id: 1, diff: 3, lamp: 1 }, { song_id: 1, diff: 3, lamp: 5 }]),
    dump('B2', 4, 0), dump('C3', 5, null), dump('D4', 6, 5, [{ song_id: 1, diff: 3, lamp: undefined }])], songs, cpiRows: [], starRows, norm, variants });
  assert.deepEqual(result.plays.get('A|ANOTHER'), [['A1', 3, 5]]);
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

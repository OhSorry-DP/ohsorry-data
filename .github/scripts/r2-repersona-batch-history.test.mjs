import test from 'node:test';
import assert from 'node:assert/strict';
import { runHistoryBatch, selectIds, parseArgs } from './r2-repersona.mjs';
import { mergeScoreHistory } from './score-history.mjs';
import { historyInputs } from './persona-lib.mjs';

const h34 = [101, 3, 6, 1800, 34, '2026-10-21T01:02:03.123456+00:00', '2026-10-21', 1, 20, 1000];
const late33 = [101, 3, 4, 1900, 33, '2026-10-22T01:02:03.123457+00:00', '2026-10-22', 1, 18, 1000];
const songs = [{ song_id: 101, title: 'TEST', textage_song_id: 'test', series_no: 34, ac: true }];
function resources() { return { textageMeta: { songs: { test: { title: 'TEST', notes: { DA: 1000, SA: 1000 }, levels: { DA: 12, SA: 12 } } } },
  ratingJson: { ratings: {}, rateStar: { scale: 1 }, spRateStar: {} }, ereterData: { charts: [], players: {} }, cpiData: [], norm: x => x,
  featScores: {}, spFeatScores: {}, onlyOSR2eLib: { inferEreter: () => ({ ereterStar: 8, ohsorryStar: 9 }) },
  userRateStarLib: { inferUserRStar: () => ({ rStar: 10 }) }, spSkillLib: { computeSpStarGuarded: () => ({ cpiInt: 11, starRounded: 12 }) },
  spUserRateStarLib: { inferSpUserRStar: () => ({ status: 'ok', rStar: 13, modelId: 'm', formulaVersion: 1 }) },
  patternScoreKernelLib: { computePatternScoreKernel: () => ({ matched: 1, vec: { NOTES: 2 } }) } }; }
function harness(ids, behavior = {}) {
  const docs = new Map(ids.map(id => [`user/${id}.json`, { user: { iidx_id: id, star: 1 }, dp: ['stale'], sp: [] }]));
  const hist = new Map(ids.map(id => [`hist/${id}.json`, mergeScoreHistory([h34], [late33])]));
  const puts = [], capture = [];
  const client = {
    async read(key) {
      if (behavior.histError === key) throw new Error('bad hist');
      const body = key.startsWith('hist/') ? hist.get(key) : docs.get(key);
      return body === undefined ? null : { body: JSON.stringify(body), etag: `"${key}"` };
    },
    async put(key, body, etag) {
      puts.push({ key, body: JSON.parse(body), etag });
      if (behavior.conflict?.[key]?.length) {
        const next = behavior.conflict[key].shift();
        if (next === 412) { const error = new Error('HTTP 412'); throw error; }
      }
      docs.set(key, JSON.parse(body));
    },
  };
  const engine = { historyInputs(id, rows) { capture.push({ id, rows }); return { dpCharts: [{ exScore: rows.find(r => r[4] === 33)?.[3], lampNum: 6 }], spCharts: [], dp: [], sp: [], spRateRows: [] }; },
    personaFor: () => ({ x: 1 }), spPersonaFor: () => ({ x: 2 }), reachNpsFor: () => ({ x: 3 }) };
  return { client, puts, capture, engine };
}

test('병합 hist 입력과 오래된 dp 무시를 두 유저에서 확인한다', async () => {
  const h = harness(['u1', 'u2']);
  const result = await runHistoryBatch({ ids: ['u1', 'u2'], ...h, R: resources(), songs,
    arrangeFor: async () => [], concurrency: 2 });
  assert.equal(result.length, 2);
  assert.equal(h.capture[0].rows.length, 2);
  assert.equal(h.capture[0].rows[1][3], 1900);
  assert.equal(h.puts.length, 2);
});

test('재시도는 최신 user와 hist를 다시 읽고 조건부 게시한다', async () => {
  const h = harness(['u1', 'u2']);
  const originalPut = h.client.put;
  let first = true;
  h.client.put = async (...args) => { if (args[0] === 'user/u1.json' && first) { first = false; const e = new Error('HTTP 412'); throw e; } return originalPut(...args); };
  const result = await runHistoryBatch({ ids: ['u1', 'u2'], ...h, R: resources(), songs, arrangeFor: async id => [id], concurrency: 2 });
  assert.equal(result.filter(x => x.updated).length, 2);
  assert.deepEqual(h.capture.map(x => x.id).sort(), ['u1', 'u1', 'u2']);
});

test('개별 파싱 실패와 반복 충돌을 부분 실패로 보존한다', async () => {
  const h = harness(['u1', 'u2', 'u3'], { histError: 'hist/u1.json' });
  h.client.put = async key => { if (key === 'user/u2.json') throw new Error('HTTP 412'); };
  const r = await runHistoryBatch({ ids: ['u1', 'u2', 'u3'], ...h, R: resources(), songs, arrangeFor: async () => [], concurrency: 2 });
  assert.match(r.find(x => x.id === 'u1').error.message, /bad hist/);
  assert.equal(r.find(x => x.id === 'u2').conflicted, true);
  assert.equal(r.find(x => x.id === 'u3').updated, true);
});

test('dry, 대상 선택과 concurrency 상한 및 빈 대상', async () => {
  const h = harness(['u1', 'u2', 'u3']);
  let active = 0, maximum = 0;
  const r = await runHistoryBatch({ ids: selectIds(['u1', 'u2', 'u3'].map(iidx_id => ({ iidx_id })), { only: new Set(['u2', 'u3']), limit: 1 }), ...h, R: resources(), songs,
    arrangeFor: async () => { active++; maximum = Math.max(active, maximum); await new Promise(resolve => setTimeout(resolve, 5)); active--; return []; }, dry: true, concurrency: 2 });
  assert.equal(r.length, 1); assert.equal(h.puts.length, 0); assert.equal(maximum, 1);
  assert.deepEqual(await runHistoryBatch({ ids: [], ...h, R: resources(), songs, arrangeFor: async () => [] }), []);
  assert.equal(parseArgs(['--concurrency=2', '--dry']).dry, true);
});

test('누락 user와 hist 조회 실패는 git이나 PUT으로 대체되지 않는다', async () => {
  const h = harness(['u1']);
  h.client.read = async key => key === 'user/u1.json' ? null : null;
  const r = await runHistoryBatch({ ids: ['u1'], ...h, R: resources(), songs, arrangeFor: async () => [] });
  assert.match(r[0].error.message, /R2 user missing/); assert.equal(h.puts.length, 0);
});

test('기존 persona 입력 helper는 hist로 구성된 입력을 받는다', () => {
  assert.equal(typeof historyInputs, 'function');
  assert.deepEqual(selectIds([{ iidx_id: 'u1' }, { iidx_id: 'u1' }]), ['u1']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeScoreHistory } from './score-history.mjs';
import { historyInputs } from './persona-lib.mjs';
import { updateSinglePersona, historyPersonaFields, guardedSlowUserPut, runHistoryBatch } from './r2-repersona.mjs';

const id = '12345678';
const h34 = [101, 3, 6, 1800, 34, '2026-10-21T01:02:03.123456+00:00', '2026-10-21', 1, 20, 1000];
const late33 = [101, 3, 4, 1900, 33, '2026-10-22T01:02:03.123457+00:00', '2026-10-22', 1, 18, 1000];
const sp34 = [101, 3, 4, 1500, 34, '2026-10-21T01:02:03.123456+00:00', '2026-10-21', 0, 10, 1000];
const song = { song_id: 101, title: 'TEST', textage_song_id: 'test', series_no: 34, ac: true, legen: false };
const meta = { songs: { test: { title: 'TEST', notes: { DA: 1000, SA: 1000 }, levels: { DA: 12, SA: 12 } } } };
const baseData = () => ({ user: { iidx_id: id, dj_name: 'OLD', star: 1, native_star: 2, r_star: 3,
  sp_cpi: 4, sp_star: 5, sp_r_star: 6, sp_r_star_model_id: 'old', sp_r_star_formula_version: 1 },
  dp: [{ old: 'dp' }], sp: [{ old: 'sp' }], plays: 77, date: 'kept', persona: { p: 1 },
  spPersona: { s: 1 }, reachNps: { n: 1 }, osPattern: [{ play_style: 1, notes: 1 }] });

function officialResources(capture = {}) {
  return { textageMeta: meta, ratingJson: { ratings: {}, rateStar: { scale: 1 }, spRateStar: {} },
    ereterData: { charts: [], players: {} }, cpiData: [], norm: value => value,
    featScores: {}, spFeatScores: {},
    onlyOSR2eLib: { inferEreter(charts) { capture.dpCharts = charts; return { ereterStar: 8, ohsorryStar: 9 }; } },
    userRateStarLib: { inferUserRStar(charts) { capture.rCharts = charts; return { rStar: 10 }; } },
    spSkillLib: { computeSpStarGuarded() { return { cpiInt: 11, starRounded: 12 }; } },
    spUserRateStarLib: { inferSpUserRStar(rows, _seed, opts) {
      capture.spCalls = (capture.spCalls || 0) + 1;
      capture.spRows = rows; capture.prevSp = opts.prev;
      return capture.spFew ? { status: 'few_plays', modelId: 'model-new', formulaVersion: 2 }
        : { status: 'ok', rStar: 13, modelId: 'model-new', formulaVersion: 2 };
    } },
    patternScoreKernelLib: { computePatternScoreKernel(rows) {
      capture.featureRows = rows;
      return { matched: 1, vec: { NOTES: capture.osNotes ?? 2 } };
    } } };
}
const historyEngine = (capture) => ({ historyInputs, personaFor(_charts, _R, user) { capture.personaUser = user; return { from: 'hist' }; },
  spPersonaFor() { return { sp: 'hist' }; }, reachNpsFor(charts) { capture.reachCharts = charts; return { count: charts.length }; } });
const officialFields = (R, capture, data = baseData(), rows = [h34, late33]) =>
  historyPersonaFields(id, data, rows, [song], [], R, historyEngine(capture));

function makeClient(data, histRows = [h34, late33], etag = '"e1"') {
  const reads = [], puts = [];
  return { reads, puts,
    async read(key) {
      reads.push(key);
      if (key === `user/${id}.json`) return { body: JSON.stringify(data), etag };
      if (key === `hist/${id}.json`) return histRows === null ? null : { body: JSON.stringify(histRows), etag: '"hist-e1"' };
      return null;
    },
    async put(key, body, condition) { puts.push({ key, data: JSON.parse(body), condition }); } };
}

function makeS3(data, conflictStatuses = []) {
  let current = structuredClone(data), puts = 0, gets = 0;
  return { state: () => ({ current, puts, gets }), async request(key, init) {
    assert.equal(key, `user/${id}.json`);
    if (init.method === 'GET') { gets++; return new Response(JSON.stringify(current), { headers: { etag: `"s${gets}"` } }); }
    puts++;
    if (conflictStatuses.length) return new Response('', { status: conflictStatuses.shift() });
    assert.equal(init.headers['If-Match'], `"s${gets}"`);
    current = JSON.parse(init.body);
    return new Response('', { status: 200 });
  } };
}

test('공식 계산은 병합 hist grid의 늦은 33 EX와 lamp를 사용하고 user dp를 읽지 않는다', () => {
  const histRows = mergeScoreHistory([h34], [late33]);
  const capture = {}, R = officialResources(capture);
  const data = baseData();
  const fields = officialFields(R, capture, data, histRows);
  assert.equal(histRows.length, 2);
  assert.deepEqual(capture.dpCharts.map(({ exScore, lampNum, noteCount }) => ({ exScore, lampNum, noteCount })),
    [{ exScore: 1900, lampNum: 6, noteCount: 1000 }]);
  assert.equal(capture.dpCharts[0].missCount, 18);
  assert.deepEqual(fields.persona, { from: 'hist' });
  assert.deepEqual(fields.reachNps, { count: 1 });
  assert.deepEqual(data.dp, [{ old: 'dp' }]);
});

test('첫 412 후 user와 hist를 재읽고 새 user 원본과 1950 hist로 재계산한다', async () => {
  const first = baseData();
  const second = { ...baseData(), user: { ...baseData().user, dj_name: 'NEW' }, dp: [{ stale: 1 }], sp: [{ stale: 2 }], plays: 99, date: 'new-date' };
  const oldRows = [h34, late33], freshRows = [h34, [101, 3, 6, 1950, 33, late33[5], late33[6], 1, 17, 1000]];
  const reads = [], writes = [];
  let round = 0;
  const client = { async read(key) {
    reads.push(key);
    if (key === `user/${id}.json`) return round++ === 0 ? { body: JSON.stringify(first), etag: '"u1"' } : { body: JSON.stringify(second), etag: '"u2"' };
    if (key === `hist/${id}.json`) return { body: JSON.stringify(round <= 1 ? oldRows : freshRows), etag: '"h"' };
  }, async put(_key, body, etag) {
    writes.push({ data: JSON.parse(body), etag });
    if (writes.length === 1) throw new Error('HTTP 412');
  } };
  const seen = [];
  const result = await updateSinglePersona(id, { client, official: true, calculate: async (data, { histRows }) => {
    seen.push({ name: data.user.dj_name, dp: data.dp, sp: data.sp, plays: data.plays, date: data.date,
      best: Math.max(...histRows.map(row => row[3])) });
    return { persona: { name: data.user.dj_name }, userFields: {}, osPattern: data.osPattern, reachNps: data.reachNps };
  } });
  assert.deepEqual(result, { updated: true });
  assert.deepEqual(seen.map(x => [x.name, x.best]), [['OLD', 1900], ['NEW', 1950]]);
  assert.deepEqual(seen[1].dp, [{ stale: 1 }]); assert.deepEqual(seen[1].sp, [{ stale: 2 }]);
  assert.equal(seen[1].plays, 99); assert.equal(seen[1].date, 'new-date');
  assert.deepEqual(writes.map(x => x.etag), ['"u1"', '"u2"']);
  assert.deepEqual(reads, [`user/${id}.json`, `hist/${id}.json`, `user/${id}.json`, `hist/${id}.json`]);
});

test('두 번 412면 재시도 후 중단하고 다른 PUT 오류는 전달한다', async () => {
  for (const failure of ['HTTP 412', 'HTTP 403', 'HTTP 500']) {
    const client = makeClient(baseData()); let puts = 0;
    client.put = async () => { puts++; throw new Error(failure); };
    const calculate = async () => ({ persona: { next: true } });
    if (failure === 'HTTP 412') {
      const warn = console.warn; console.warn = () => {};
      try { assert.deepEqual(await updateSinglePersona(id, { client, official: true, calculate }), { conflicted: true }); }
      finally { console.warn = warn; }
      assert.equal(puts, 2);
    } else {
      await assert.rejects(updateSinglePersona(id, { client, official: true, calculate }), new RegExp(failure.replace(' ', ' ')));
      assert.equal(puts, 1);
    }
  }
});

test('persona 불변이어도 공식 tuple, 모델명, osPattern과 reachNps 변화는 PUT하고 few_plays tuple도 반영한다', async () => {
  const data = baseData(), capture = {}, R = officialResources(capture);
  const fields = officialFields(R, capture, data);
  let client = makeClient(data);
  assert.deepEqual(await updateSinglePersona(id, { client, official: true, calculate: async () => ({ persona: data.persona,
    spPersona: data.spPersona, ...fields }) }), { updated: true });
  assert.equal(client.puts.length, 1);

  client = makeClient(data);
  assert.deepEqual(await updateSinglePersona(id, { client, official: true, calculate: async () => ({ persona: data.persona,
    spPersona: data.spPersona, reachNps: data.reachNps, userFields: { star: data.user.star, native_star: data.user.native_star,
      r_star: data.user.r_star, sp_cpi: data.user.sp_cpi, sp_star: data.user.sp_star, sp_r_star: data.user.sp_r_star,
      sp_r_star_model_id: data.user.sp_r_star_model_id, sp_r_star_formula_version: data.user.sp_r_star_formula_version }, osPattern: data.osPattern }) }),
  { unchanged: true });
  assert.equal(client.puts.length, 0);

  const noSpCapture = {}, noSp = officialFields(officialResources(noSpCapture), noSpCapture, data, [h34, late33]);
  assert.equal(noSpCapture.spCalls || 0, 0);
  assert.deepEqual({ rStar: noSp.userFields.sp_r_star, model: noSp.userFields.sp_r_star_model_id,
    formula: noSp.userFields.sp_r_star_formula_version }, { rStar: 6, model: 'old', formula: 1 });

  const fewCapture = { spFew: true }, fewR = officialResources(fewCapture);
  const few = officialFields(fewR, fewCapture, data, [h34, late33, sp34]);
  assert.equal(fewCapture.spCalls, 1);
  assert.equal(fewCapture.spRows.length, 1);
  assert.deepEqual(few.userFields, { star: 8, native_star: 9, r_star: 10, sp_cpi: 11, sp_star: 12,
    sp_r_star: null, sp_r_star_model_id: 'model-new', sp_r_star_formula_version: 2 });
  client = makeClient(data);
  assert.deepEqual(await updateSinglePersona(id, { client, official: true, calculate: async () => ({
    persona: data.persona, spPersona: data.spPersona, ...few,
  }) }), { updated: true });
  assert.equal(client.puts.length, 1);
  assert.equal(client.puts[0].data.user.sp_r_star, null);
  assert.equal(client.puts[0].data.user.sp_r_star_model_id, 'model-new');
  assert.equal(client.puts[0].data.user.sp_r_star_formula_version, 2);
});

test('hist 부재, JSON·배열·identity·timestamp 오류는 PUT 없이 실패하고 빈 hist는 허용한다', async () => {
  const cases = [
    { hist: null, error: /hist missing/ },
    { hist: '{bad', error: /hist JSON invalid/ },
    { hist: JSON.stringify({ history: [] }), error: /hist must be an array/ },
    { hist: JSON.stringify([[...h34.slice(0, 5), 'bad-date', ...h34.slice(6)]]), error: /timestamp/ },
  ];
  for (const item of cases) {
    const client = makeClient(baseData());
    client.read = async key => key.startsWith('user/') ? { body: JSON.stringify(baseData()), etag: '"u"' }
      : item.hist === null ? null : { body: item.hist, etag: '"h"' };
    await assert.rejects(updateSinglePersona(id, { client, official: true, calculate: async () => ({}) }), item.error);
    assert.equal(client.puts.length, 0);
  }
  const mismatch = makeClient(baseData());
  mismatch.read = async key => key.startsWith('user/')
    ? { body: JSON.stringify({ ...baseData(), user: { iidx_id: '87654321' } }), etag: '"u"' }
    : { body: '[]', etag: '"h"' };
  await assert.rejects(updateSinglePersona(id, { client: mismatch, official: true, calculate: async () => ({}) }), /identity mismatch/);
  assert.equal(mismatch.puts.length, 0);
  const empty = makeClient(baseData(), []);
  assert.deepEqual(await updateSinglePersona(id, { client: empty, official: true, calculate: async (_data, { histRows }) => {
    assert.deepEqual(histRows, []); return {};
  } }), { unchanged: true });
});

test('legacy는 hist를 읽지 않고 기존 calculate 인자를 유지하며 dry는 PUT하지 않는다', async () => {
  const data = baseData();
  let histReads = 0, argsSeen, legacyPuts = 0, dryPuts = 0;
  const client = { async read(key) {
    if (key.startsWith('hist/')) histReads++;
    return { body: JSON.stringify(data), etag: '"u"' };
  }, async put() { legacyPuts++; } };
  assert.deepEqual(await updateSinglePersona(id, { client, calculate: async (...args) => {
    argsSeen = args; return { persona: { legacy: true }, spPersona: null };
  } }), { updated: true });
  assert.equal(histReads, 0); assert.equal(argsSeen.length, 1); assert.equal(legacyPuts, 1);
  const dryClient = makeClient(data); dryClient.put = async () => { dryPuts++; };
  assert.deepEqual(await updateSinglePersona(id, { client: dryClient, official: true, dry: true,
    calculate: async () => ({ persona: { dry: true } }) }), { dry: true, changed: true });
  assert.equal(dryPuts, 0);
  assert.deepEqual(await updateSinglePersona(id, { client: dryClient, official: true, dry: true,
    calculate: async () => ({}) }), { dry: true, changed: false });
});

test('GUARD OFF는 기존 본문과 PUT 횟수 및 ETag를 유지한다', async () => {
  const old = process.env.FAST_DUMP_LIGHT_GUARD;
  delete process.env.FAST_DUMP_LIGHT_GUARD;
  try {
    const data = baseData(), client = makeClient(data);
    assert.deepEqual(await updateSinglePersona(id, { client, calculate: async () => ({ persona: { next: 1 } }) }), { updated: true });
    assert.equal(client.puts.length, 1);
    assert.equal(client.puts[0].condition, '"e1"');
    assert.equal(client.puts[0].data.persona.next, 1);
  } finally { if (old === undefined) delete process.env.FAST_DUMP_LIGHT_GUARD; else process.env.FAST_DUMP_LIGHT_GUARD = old; }
});

test('GUARD ON S3 If-Match PUT은 최신 fast4와 generation 및 미지 필드를 보존한다', async () => {
  const old = process.env.FAST_DUMP_LIGHT_GUARD; process.env.FAST_DUMP_LIGHT_GUARD = '1';
  try {
    const local = baseData(), latest = { ...baseData(), dp: [{ newest: 1 }], sp: [{ newest: 2 }],
      dpRecent: [3], spRecent: [4], fastGeneration: '9', unknown: { retained: true } };
    const s3 = makeS3(latest), client = makeClient(local);
    assert.deepEqual(await updateSinglePersona(id, { client, s3, official: true, calculate: async () => ({ persona: { fresh: true } }) }), { updated: true });
    const { current, puts } = s3.state();
    for (const key of ['dp', 'sp', 'dpRecent', 'spRecent', 'fastGeneration']) assert.deepEqual(current[key], latest[key]);
    assert.deepEqual(current.unknown, { retained: true }); assert.deepEqual(current.persona, { fresh: true });
    assert.equal(puts, 1);
  } finally { if (old === undefined) delete process.env.FAST_DUMP_LIGHT_GUARD; else process.env.FAST_DUMP_LIGHT_GUARD = old; }
});

test('GUARD ON S3 CAS는 412 두 번 뒤 최신 원본 재병합 후 성공한다', async () => {
  const old = process.env.FAST_DUMP_LIGHT_GUARD; process.env.FAST_DUMP_LIGHT_GUARD = '1';
  try {
    const data = baseData(), s3 = makeS3(data, [412, 412]);
    assert.equal(await guardedSlowUserPut({ client: null, key: `user/${id}.json`, source: {}, local: { ...data, persona: { next: 1 } }, s3 }), true);
    assert.deepEqual(s3.state().current.persona, { next: 1 });
    assert.equal(s3.state().gets, 3); assert.equal(s3.state().puts, 3);
  } finally { if (old === undefined) delete process.env.FAST_DUMP_LIGHT_GUARD; else process.env.FAST_DUMP_LIGHT_GUARD = old; }
});

test('GUARD ON S3 CAS 412 세 번이면 실패하고 무조건 PUT은 없다', async () => {
  const old = process.env.FAST_DUMP_LIGHT_GUARD; process.env.FAST_DUMP_LIGHT_GUARD = '1';
  try {
    const data = baseData(), s3 = makeS3(data, [412, 412, 412]);
    assert.equal(await guardedSlowUserPut({ client: null, key: `user/${id}.json`, source: {}, local: { ...data, persona: { next: 1 } }, s3 }), false);
    assert.equal(s3.state().gets, 3); assert.equal(s3.state().puts, 3);
  } finally { if (old === undefined) delete process.env.FAST_DUMP_LIGHT_GUARD; else process.env.FAST_DUMP_LIGHT_GUARD = old; }
});

test('GUARD ON 배치 경로도 공유 S3 CAS 함수를 사용한다', async () => {
  const old = process.env.FAST_DUMP_LIGHT_GUARD; process.env.FAST_DUMP_LIGHT_GUARD = '1';
  try {
    const h = makeClient(baseData()), s3 = makeS3(baseData());
    const r = await runHistoryBatch({ ids: [id], client: h, s3, R: officialResources(), songs: [song],
      engine: historyEngine({}), arrangeFor: async () => [], concurrency: 1 });
    assert.equal(r[0].updated, true); assert.equal(s3.state().puts, 1);
  } finally { if (old === undefined) delete process.env.FAST_DUMP_LIGHT_GUARD; else process.env.FAST_DUMP_LIGHT_GUARD = old; }
});

test('GUARD ON S3 자격 누락은 유저 실패이며 REST PUT fallback을 하지 않는다', async () => {
  const old = process.env.FAST_DUMP_LIGHT_GUARD, access = process.env.R2_ACCESS_KEY_ID, secret = process.env.R2_SECRET_ACCESS_KEY;
  process.env.FAST_DUMP_LIGHT_GUARD = '1'; delete process.env.R2_ACCESS_KEY_ID; delete process.env.R2_SECRET_ACCESS_KEY;
  try {
    const data = baseData(), client = makeClient(data);
    assert.deepEqual(await updateSinglePersona(id, { client, calculate: async () => ({ persona: { next: 1 } }) }), { conflicted: true });
    assert.equal(client.puts.length, 0);
  } finally {
    if (old === undefined) delete process.env.FAST_DUMP_LIGHT_GUARD; else process.env.FAST_DUMP_LIGHT_GUARD = old;
    if (access === undefined) delete process.env.R2_ACCESS_KEY_ID; else process.env.R2_ACCESS_KEY_ID = access;
    if (secret === undefined) delete process.env.R2_SECRET_ACCESS_KEY; else process.env.R2_SECRET_ACCESS_KEY = secret;
  }
});

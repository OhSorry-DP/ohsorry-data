import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCandidate, rowsFromRest, sha256Hex, validateCandidate } from './score-buffer.mjs';

const iidxId = '89388691';
const fixtureDate = '2026-10-22T01:02:03.123456+00:00';
const fixtureRow = [100, 3, 5, 2000, 33, fixtureDate, '2026-10-22', 1, null, 1500];
const fixtureRest = [{ score_id: 12345, iidx_id: iidxId, song_id: 100, diff: 3, played_version: 33,
  play_style: 1, ex_score: 2000, lamp: 5, bp: null, note_count: 1500, date: fixtureDate, date_kst: '2026-10-22' }];
const songs = [100, 200, 300, 400].map((song_id) => ({ song_id }));
const noAliases = { v: 1, rules: [] };
const aliasesBytes = (aliases = noAliases) => Buffer.from(JSON.stringify(aliases), 'utf8');
const rowBytes = (rows) => Buffer.from(JSON.stringify(rows), 'utf8');
const restObject = (scoreId, overrides = {}) => ({ ...fixtureRest[0], score_id: scoreId, ...overrides });
const candidateFor = ({ iidx = iidxId, rest = fixtureRest, previous = [], aliases = noAliases,
  histRows, published = rowBytes(histRows ?? [...previous, ...rest.map((r) => [r.song_id, r.diff, r.lamp,
    r.ex_score, r.played_version, r.date, r.date_kst, r.play_style, r.bp, r.note_count])]),
  downloaded = published } = {}) => buildCandidate({ iidxId: iidx, restRows: rest, previousHistRows: previous,
  aliases, aliasesBytes: aliasesBytes(aliases), songs, publishedHistBytes: published, downloadedHistBytes: downloaded });

test('1. nullable 키 누락은 거부하고 명시 null은 허용한다', () => {
  const missing = { ...fixtureRest[0] };
  delete missing.bp;
  assert.throws(() => rowsFromRest([missing], iidxId), /missing required key/);
  assert.deepEqual(candidateFor().rows[0].bp, null);
  assert.equal(candidateFor().rows[0].note_count, 1500);
});

test('score buffer date memo: 성공값 재사용, 실패 비저장, 각 캐시 상한 퇴출', async () => {
  const { historyInstant } = await import('./score-history.mjs');
  const validDay = '2026-10-23';
  const validInstant = `${validDay}T03:12:45.123456+00:00`;
  const expected = historyInstant(validInstant);
  assert.equal(historyInstant(validInstant), expected);
  for (const value of ['invalid-date', '2026-10-24T25:00:00Z']) {
    const capture = () => {
      try { rowsFromRest([restObject(1, { date: value })], iidxId); }
      catch (error) { return error; }
      assert.fail('expected invalid date input to throw');
    };
    const first = capture();
    const second = capture();
    assert.equal(second.constructor, first.constructor);
    assert.equal(second.message, first.message);
  }
  const invalidDayCapture = () => {
    try { rowsFromRest([restObject(1, { date_kst: '2026-02-30' })], iidxId); }
    catch (error) { return error; }
    assert.fail('expected invalid date_kst to throw');
  };
  const firstInvalidDay = invalidDayCapture();
  const secondInvalidDay = invalidDayCapture();
  assert.equal(firstInvalidDay.constructor, secondInvalidDay.constructor);
  assert.equal(firstInvalidDay.message, 'invalid date_kst');
  assert.equal(secondInvalidDay.message, 'invalid date_kst');
  const validDays = Array.from({ length: 32769 }, (_, index) =>
    new Date(Date.UTC(2000, 0, 1 + index)).toISOString().slice(0, 10));
  for (const value of validDays) {
    const date = `${value}T00:00:00Z`;
    assert.equal(rowsFromRest([restObject(1, { date, date_kst: value })], iidxId)[0].row[5], date);
  }
  assert.equal(historyInstant(validInstant), expected);
  assert.equal(rowsFromRest([restObject(1, { date: validInstant, date_kst: validDay })], iidxId)[0].row[5], validInstant);
});

test('2. date 마이크로초 원문, 사용자 일치, DBR 보존과 안전 정수를 검사한다', () => {
  assert.equal(candidateFor().rows[0].date, fixtureDate);
  assert.throws(() => candidateFor({ rest: [restObject(12345, { iidx_id: 'other' })] }), /iidx_id differs/);
  assert.throws(() => rowsFromRest([restObject(Number.MAX_SAFE_INTEGER + 1)], iidxId), /safe integer/);
  const dbr = [-10, 3, 5, 2000, -10, fixtureDate, '2026-10-22', 1, null, 1500];
  const dbrHist = [dbr, fixtureRow];
  const got = candidateFor({ previous: [dbr], histRows: dbrHist });
  assert.equal(got.hist.sha256, sha256Hex(rowBytes(dbrHist)));
  assert.equal(got.rows[0].song_id, 100);
  assert.throws(() => candidateFor({ rest: [restObject(12345, { song_id: Number.MAX_SAFE_INTEGER + 1 })] }), /safe integer/);
});

test('3. 중복 ID, 순서 불일치, ID 목록 불일치와 v1 후보를 거부한다', () => {
  assert.throws(() => rowsFromRest([fixtureRest[0], fixtureRest[0]], iidxId), /duplicate score_id/);
  const valid = candidateFor();
  assert.throws(() => validateCandidate({ ...valid, score_ids: [12346, 12345] }, iidxId), /ascending/);
  assert.throws(() => validateCandidate({ ...valid, score_ids: [12346] }, iidxId), /same ascending set/);
  assert.throws(() => validateCandidate({ ...valid, v: 1 }, iidxId), /v2/);
});

test('4. 무향상 ID도 수록하고 NULL 보충 및 200행 초과 과거 hist를 허용한다', () => {
  const prior = [...fixtureRow]; prior[8] = null;
  const rest = [restObject(12345, { bp: 12 })];
  const completed = [...fixtureRow]; completed[8] = 12;
  const out = candidateFor({ rest, previous: [prior], histRows: [completed] });
  assert.deepEqual(out.score_ids, [12345]);
  assert.equal(out.rows[0].bp, 12);

  const oldRows = Array.from({ length: 205 }, (_, index) => [10000 + index, 3, 1, 100, 32,
    fixtureDate, '2026-10-22', 1, null, 1500]);
  const many = candidateFor({ rest: [], previous: oldRows, histRows: oldRows });
  assert.deepEqual(many.score_ids, []);
  assert.equal(many.hist.sha256, sha256Hex(rowBytes(oldRows)));
});

test('5. 지문은 별칭 전 원본 song_id, 별칭 바이트 해시와 기대 병합을 검증한다', () => {
  const aliases = { v: 1, rules: [{ from: 100, to: 200, scope: 'song' }] };
  const expectedHist = [[200, 3, 5, 2000, 33, fixtureDate, '2026-10-22', 1, null, 1500]];
  const out = candidateFor({ aliases, histRows: expectedHist });
  assert.equal(out.rows[0].song_id, 100);
  assert.equal(out.aliases_sha256, sha256Hex(aliasesBytes(aliases)));
  assert.throws(() => candidateFor({ aliases, histRows: [fixtureRow] }), /expected normalized replay/);
});

test('6. 원본 byte 불일치를 거부하고 재전송은 멱등이며 played_version 33을 받는다', () => {
  const exact = rowBytes([fixtureRow]);
  const pretty = Buffer.from(JSON.stringify([fixtureRow], null, 2), 'utf8');
  assert.throws(() => candidateFor({ published: exact, downloaded: pretty }), /bytes differ/);
  const first = candidateFor({ rest: [restObject(12345, { played_version: 33 })] });
  const retry = candidateFor({ rest: [restObject(12345, { played_version: 33 })] });
  assert.deepEqual(retry, first);
  assert.equal(first.rows[0].played_version, 33);
});

// The Actions adapter tests use real conditional object versions, including 412.
async function guardedModule() {
  process.env.SUPABASE_URL ||= 'https://example.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test';
  return import('./dump-user.mjs');
}
function histStore() {
  const objects = new Map([
    [`hist/${iidxId}.json`, '[]'], ['songs.json', JSON.stringify(songs)],
    ['meta/song-aliases.json', JSON.stringify(noAliases)],
  ]);
  const calls = [], versions = new Map();
  return { objects, calls, beforePut: null, afterRead: null,
    async read(key) {
      calls.push(['read', key]);
      const body = objects.get(key);
      const result = body === undefined ? null : { body, bytes: Buffer.from(body), etag: `"${versions.get(key) || 0}"` };
      this.afterRead?.(key, result);
      return result;
    },
    async put(key, body, etag) {
      calls.push(['put', key, String(body), etag]);
      await this.beforePut?.(key, body, etag);
      const expected = objects.has(key) ? `"${versions.get(key) || 0}"` : null;
      if (etag !== expected) throw new Error('HTTP 412');
      objects.set(key, String(body)); versions.set(key, (versions.get(key) || 0) + 1);
    },
  };
}
const guardEnv = { FAST_DUMP_HIST_GUARD: '1', FAST_DUMP_GENERATION: '7', FAST_DUMP_SINCE: '2026-10-22T00:00:00.000Z' };
const actionsLocal = (revision) => ({ _v: '2026-10-22T02:00:00.000Z', user: { star: 3 },
  dp: [], sp: [], dpRecent: [], spRecent: [], histRevision: revision });
function readyActions(store) {
  const revision = sha256Hex(Buffer.from('[]'));
  store.objects.set(`user/${iidxId}.json`, JSON.stringify({ user: { star: 1, unknown: true }, unknown: 42,
    fastGeneration: '7', histRevision: 'a'.repeat(64), dp: ['old'] }));
  store.objects.set(`pending/${iidxId}.json`, JSON.stringify({ generation: '7', since: guardEnv.FAST_DUMP_SINCE, unknown: 99 }));
  return actionsLocal(revision);
}

test('hist guard S3 adapter: identity GET, conditional PUT, 404 only missing, no transmission retry', async () => {
  const { guardedHistoryClient } = await guardedModule();
  const calls = [];
  const client = guardedHistoryClient({ accessKeyId: 'test', secretAccessKey: 'test',
    fetchImpl: async (url, init) => { calls.push(init); return new Response(init.method === 'GET' ? '[]' : '',
      { status: init.method === 'GET' ? 200 : 412, headers: { etag: '"v1"' } }); } });
  assert.equal((await client.read('hist/1.json')).body, '[]');
  assert.equal(calls[0].headers.get('accept-encoding'), 'identity');
  await assert.rejects(client.put('hist/1.json', '[]', null), /412/);
  await assert.rejects(client.put('hist/1.json', '[]', '"v1"'), /412/);
  assert.equal(calls[1].headers.get('if-none-match'), '*');
  assert.equal(calls[2].headers.get('if-match'), '"v1"');
  assert.equal(calls.length, 3);
  for (const status of [404, 500]) {
    let count = 0;
    const failing = guardedHistoryClient({ accessKeyId: 'test', secretAccessKey: 'test',
      fetchImpl: async () => { count++; return new Response('', { status }); } });
    if (status === 404) assert.equal(await failing.read('x'), null);
    else await assert.rejects(failing.read('x'), /500/);
    assert.equal(count, 1);
  }
});

test('hist guard 412 replays latest history into local file, returned calculation input, and verified candidate', async () => {
  const { prepareOfficialHistory } = await guardedModule();
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-guard-'));
  const file = path.join(dir, 'hist.json');
  const oldEnv = process.env.FAST_DUMP_HIST_GUARD, oldPrepare = process.env.SCORE_BUFFER_PREPARE, oldFetch = globalThis.fetch;
  process.env.FAST_DUMP_HIST_GUARD = '1';
  process.env.SCORE_BUFFER_PREPARE = '1';
  globalThis.fetch = async () => new Response(JSON.stringify(fixtureRest));
  const store = histStore(); let conflict = true;
  const concurrent = [...fixtureRow]; concurrent[0] = 200;
  store.beforePut = (key) => {
    if (key === `hist/${iidxId}.json` && conflict) {
      conflict = false; store.objects.set(key, JSON.stringify([concurrent])); throw new Error('HTTP 412');
    }
  };
  try {
    const result = await prepareOfficialHistory(iidxId, undefined, { r2: store, histFile: file });
    assert.equal(result.histRows.length, 2);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)), result.histRows);
    assert.equal(store.objects.get(`hist/${iidxId}.json`), result.histBytes.toString());
    const candidate = JSON.parse(store.objects.get(`meta/scores-delete-${iidxId}.json`));
    assert.equal(candidate.hist.sha256, sha256Hex(result.histBytes));
    assert.deepEqual(candidate.score_ids, [12345]);
    assert.equal(store.calls.filter(([op, key]) => op === 'put' && key.startsWith('hist/')).length, 2);
    assert.ok(store.calls.filter(([op, key]) => op === 'read' && key === 'songs.json').length >= 3);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldEnv === undefined) delete process.env.FAST_DUMP_HIST_GUARD; else process.env.FAST_DUMP_HIST_GUARD = oldEnv;
    if (oldPrepare === undefined) delete process.env.SCORE_BUFFER_PREPARE; else process.env.SCORE_BUFFER_PREPARE = oldPrepare;
    fs.rmSync(dir, { recursive: true });
  }
});

test('hist guard busy lease, exhausted 412, uncertain PUT and readback mismatch never publish candidate or completion', async () => {
  const { publishGuardedHistory } = await guardedModule();
  const noCandidate = histStore();
  await publishGuardedHistory(iidxId, { r2: noCandidate, restRows: fixtureRest });
  assert.equal(noCandidate.calls.some(([op, key]) => op === 'put' && key.includes('scores-delete')), false);
  for (const failure of ['busy', '412', 'uncertain', 'readback']) {
    const store = histStore(); let histWritten = false;
    if (failure === 'busy') store.objects.set(`meta/fast-hist-lease-${iidxId}.json`, JSON.stringify({ token: 'other', expiresAt: new Date(Date.now() + 15000).toISOString() }));
    store.beforePut = (key) => {
      if (!key.startsWith('hist/')) return;
      histWritten = true;
      if (failure === '412') throw new Error('HTTP 412');
      if (failure === 'uncertain') throw new Error('response lost');
    };
    store.afterRead = (key, result) => { if (failure === 'readback' && histWritten && key.startsWith('hist/')) result.body = '[]'; };
    await assert.rejects(publishGuardedHistory(iidxId, { r2: store, restRows: fixtureRest }));
    const puts = store.calls.filter(([op]) => op === 'put');
    assert.equal(puts.filter(([, key]) => key.includes('scores-delete') || key.startsWith('user/') || key.startsWith('pending/')).length, 0);
    assert.equal(puts.filter(([, key]) => key.startsWith('hist/')).length, failure === 'busy' ? 0 : failure === '412' ? 3 : 1);
    assert.equal(puts.filter(([, key]) => key.includes('lease')).length, failure === 'busy' ? 0 : 1);
  }
});

test('hist guard same-generation recovery merges slow fields and unknowns, user then pending then own lease release', async () => {
  const { publishGuardedActions } = await guardedModule();
  const store = histStore(), local = readyActions(store);
  const value = await publishGuardedActions(iidxId, local, { r2: store, env: guardEnv });
  assert.equal(value.unknown, 42); assert.equal(value.user.unknown, true); assert.equal(value.user.star, 3);
  assert.equal(value.histRevision, local.histRevision); assert.deepEqual(value.dp, []);
  const pending = JSON.parse(store.objects.get(`pending/${iidxId}.json`));
  assert.equal(pending.unknown, 99); assert.equal(pending.viewGeneration, '7'); assert.equal(pending.histRevision, local.histRevision);
  assert.deepEqual(store.calls.filter(([op]) => op === 'put').map(([, key]) => key),
    [`meta/fast-hist-lease-${iidxId}.json`, `user/${iidxId}.json`, `pending/${iidxId}.json`, `meta/fast-hist-lease-${iidxId}.json`]);
});

test('hist guard user uncertainty, newer generation, changed hist/pending and lease loss fail closed without completion/release', async () => {
  const { publishGuardedActions } = await guardedModule();
  for (const failure of ['user', 'newer', 'hist', 'pending', 'lease', 'user412']) {
    const store = histStore(), local = readyActions(store);
    if (failure === 'newer') store.objects.set(`user/${iidxId}.json`, '{"fastGeneration":"8"}');
    if (failure === 'hist') local.histRevision = 'b'.repeat(64);
    if (failure === 'pending') store.objects.set(`pending/${iidxId}.json`, '{"generation":"8"}');
    store.beforePut = (key) => {
      if (key.startsWith('user/') && failure === 'user') throw new Error('response lost');
      if (key.startsWith('user/') && failure === 'user412') throw new Error('HTTP 412');
    };
    let leaseReads = 0;
    store.afterRead = (key, result) => {
      if (failure === 'lease' && key.includes('lease') && ++leaseReads > 1 && result) result.body = '{"token":"other"}';
    };
    await assert.rejects(publishGuardedActions(iidxId, local, { r2: store, env: guardEnv }));
    assert.equal(store.calls.filter(([op, key]) => op === 'put' && key.startsWith('pending/')).length, 0);
    assert.equal(store.calls.filter(([op, key]) => op === 'put' && key.includes('lease')).length, 1);
  }
});

test('hist guard OFF keeps prepare bytes, candidate and exact IO unchanged and refuses new Actions entry without IO', async () => {
  const { prepareOfficialHistory, publishGuardedActions } = await guardedModule();
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-off-'));
  const previous = process.env.FAST_DUMP_HIST_GUARD, oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(fixtureRest));
  const results = [];
  try {
    for (const flag of [undefined, '0']) {
      if (flag === undefined) delete process.env.FAST_DUMP_HIST_GUARD; else process.env.FAST_DUMP_HIST_GUARD = flag;
      const store = histStore(), file = path.join(dir, `${flag}.json`);
      const result = await prepareOfficialHistory(iidxId, undefined, { r2: store, histFile: file });
      results.push({ bytes: result.histBytes, file: fs.readFileSync(file), calls: store.calls });
      assert.equal(store.calls.some(([, key]) => key.includes('lease')), false);
    }
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(results[0].bytes, rowBytes([fixtureRow]));
    const store = histStore();
    await assert.rejects(publishGuardedActions(iidxId, {}, { r2: store, env: {} }), /disabled/);
    assert.deepEqual(store.calls, []);
  } finally {
    globalThis.fetch = oldFetch;
    if (previous === undefined) delete process.env.FAST_DUMP_HIST_GUARD; else process.env.FAST_DUMP_HIST_GUARD = previous;
    fs.rmSync(dir, { recursive: true });
  }
});


test('Edge same G/revision keeps all fast fields while Actions publishes slow fields once and completes pending', async () => {
  const { publishGuardedActions } = await guardedModule();
  const store = histStore(), local = readyActions(store);
  const edge = { dp: ['edge-dp'], sp: ['edge-sp'], dpRecent: ['edge-window'], spRecent: ['edge-sp-window'] };
  const current = JSON.parse(store.objects.get(`user/${iidxId}.json`));
  store.objects.set(`user/${iidxId}.json`, JSON.stringify({ ...current, ...edge, histRevision: local.histRevision }));
  Object.assign(local, { persona: 'actions-persona', radars: ['actions-radars'] });
  const value = await publishGuardedActions(iidxId, local, { r2: store, env: guardEnv });
  for (const key of Object.keys(edge)) assert.deepEqual(value[key], edge[key], key);
  assert.equal(value.user.star, 3); assert.equal(value.persona, local.persona); assert.deepEqual(value.radars, local.radars);
  assert.equal(value.unknown, 42);
  assert.equal(store.calls.filter(([op, key]) => op === 'put' && key.startsWith('user/')).length, 1);
  const marker = JSON.parse(store.objects.get(`pending/${iidxId}.json`));
  assert.equal(marker.viewGeneration, '7'); assert.equal(marker.histRevision, local.histRevision); assert.ok(marker.done);
});

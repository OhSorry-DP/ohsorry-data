import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runLightDump } from '../../../supabase/functions/_shared/dump-fast-worker.ts';
import { mergeActionsUser, mergeEdgeUser, mergeSlowUser, publishUserPatch } from '../dump-fast-publish.mjs';
import { mergeFastPending } from '../pending-marker.mjs';
import { guardedSlowUserPut } from '../r2-repersona.mjs';
import { prepareFastDump } from '../dump-fast-core.mjs';
import { sha256Hex } from '../score-buffer.mjs';

const since = '2026-10-24T00:00:00.000Z';
const fast = (n) => ({ dp: [n], sp: [n], dpRecent: [`d${n}`], spRecent: [`s${n}`] });
const expectedUser = (g, n, slow = {}) => ({ _v: '2026-10-23T00:00:00.000Z', user: { iidx_id: 'u1' }, radars: ['stable'], ...slow,
  ...fast(n), fastGeneration: g, extension: { preserve: true } });
const clone = (x) => JSON.parse(JSON.stringify(x));

async function histOrigin() {
  process.env.SUPABASE_URL ||= 'https://example.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test';
  const { publishGuardedActions } = await import('../dump-user.mjs');
  const f = origin({ 'hist/u1.json': [], 'meta/song-aliases.json': { v: 1, rules: [] },
    'songs.json': [{ song_id: 100, textage_song_id: 's100', title: 'Song', series_no: 1, ac: true, legen: false }] });
  let time = Date.parse(since);
  f.rows = [];
  const read = f.r2.read, put = f.r2.put;
  f.r2.read = async key => { try { return await read(key); } catch (error) { if (error.status === 404) return null; throw error; } };
  f.r2.put = (key, body, match) => put(key, body, match === null ? { ifNoneMatch: '*' } : match);
  Object.assign(f.deps, f.r2, { histPublish: true, prepareFastDump, nowMs: () => time,
    readBuffer: async () => ({ rows: clone(f.rows), fingerprint: JSON.stringify(f.rows) }) });
  f.expire = () => { time += 16000; };
  f.run = (G = '5') => runLightDump({ id: 'u1', G, since, deps: f.deps });
  f.actions = async (G = '5') => {
    const hist = await f.r2.read('hist/u1.json');
    const aliases = f.objects.get('meta/song-aliases.json');
    const prepared = prepareFastDump({ iidxId: 'u1', previousHistRows: JSON.parse(hist.body), restRows: [],
      aliases, aliasesBytes: Buffer.from(JSON.stringify(aliases)), songs: f.objects.get('songs.json'),
      previousUser: f.objects.get('user/u1.json'), generation: Number(G), nowMs: Date.parse(since) });
    return publishGuardedActions('u1', { _v: since, user: { star: 3 }, persona: 'actions',
      ...prepared.fastPatch, dpRecent: ['actions-window'], histRevision: sha256Hex(Buffer.from(hist.body)) },
    { r2: f.r2, env: { FAST_DUMP_HIST_GUARD: '1', FAST_DUMP_GENERATION: G, FAST_DUMP_SINCE: since } });
  };
  return f;
}
const score = (score_id, overrides = {}) => ({ score_id, iidx_id: 'u1', song_id: 100, diff: 0,
  lamp: 4, ex_score: 800, played_version: 33, date: '2026-10-23T00:00:00Z', date_kst: '2026-10-23',
  play_style: 1, bp: null, note_count: null, ...overrides });

test('hist extension: late 33 best, NULL supplementation, consecutive G/G+1 and Actions preserve Edge fields', async () => {
  const f = await histOrigin(); f.rows = [score(1)];
  assert.equal((await f.run()).done, true);
  const revision5 = f.objects.get('user/u1.json').histRevision;
  assert.equal(f.objects.get('user/u1.json').dp[0].ex_score, 800);
  await f.r2.put('pending/u1.json', JSON.stringify({ generation: '6', since }), f.versions.get('pending/u1.json'));
  f.rows = [score(2, { bp: 12, note_count: 500 }), score(3, { ex_score: 900, lamp: 5,
    bp: 10, note_count: 500, date: '2026-10-22T00:00:00Z', date_kst: '2026-10-22' })];
  assert.equal((await f.run('6')).done, true);
  const hist = f.objects.get('hist/u1.json'), user = f.objects.get('user/u1.json');
  assert.equal(hist.length, 2); assert.equal(hist.find(row => row[3] === 800)[8], 12);
  assert.equal(hist.find(row => row[3] === 800)[9], 500);
  assert.equal(user.dp[0].ex_score, 900); assert.equal(user.dp[0].played_version, 33);
  assert.equal(user.fastGeneration, '6'); assert.notEqual(user.histRevision, revision5);
  assert.equal(f.objects.get('pending/u1.json').viewGeneration, '6');
  assert.equal((await f.run()).reason, 'pending-changed');
  const edge = clone(user), start = f.writes.length;
  const actions = await f.actions('6');
  for (const key of ['dp', 'sp', 'dpRecent', 'spRecent']) assert.deepEqual(actions[key], edge[key]);
  assert.equal(actions.persona, 'actions'); assert.equal(actions.user.star, 3);
  assert.equal(f.writes.slice(start).filter(key => key === 'user/u1.json').length, 1);
  assert.equal(f.objects.get('pending/u1.json').histRevision, actions.histRevision);
});

test('hist extension CAS rejects stale and duplicate creation; hist 412 replays original buffer over winner', async () => {
  const f = await histOrigin(); f.rows = [score(1)];
  await assert.rejects(f.r2.put('hist/u1.json', '[]', '"stale"'), /412/);
  await assert.rejects(f.r2.put('hist/u1.json', '[]', null), /412/);
  const put = f.deps.put;
  let raced = false;
  const winning = [100, 0, 3, 700, 33, '2026-10-21T00:00:00Z', '2026-10-21', 1, 20, 500];
  f.deps.put = async (key, body, match) => {
    if (key === 'hist/u1.json' && !raced) { raced = true; await put(key, JSON.stringify([winning]), match); }
    return put(key, body, match);
  };
  assert.equal((await f.run()).done, true);
  assert.equal(raced, true); assert.equal(f.objects.get('hist/u1.json').length, 2);
  assert.equal(f.objects.get('user/u1.json').dp[0].ex_score, 800);
});

test('hist extension hist/user partial success recovers after expiry and busy Edge hands off to guarded Actions', async () => {
  const f = await histOrigin(); f.rows = [score(1)];
  const put = f.deps.put;
  f.deps.put = async (key, body, match) => { if (key === 'user/u1.json') throw Error('response lost'); return put(key, body, match); };
  assert.equal((await f.run()).reason, 'user-put-failed');
  assert.equal(f.objects.get('hist/u1.json').length, 1);
  assert.equal(f.objects.get('pending/u1.json').viewGeneration, undefined);
  assert.equal((await f.run()).reason, 'lease-busy');
  f.expire(); f.deps.put = put;
  assert.equal((await f.run()).done, true);
  const edge = clone(f.objects.get('user/u1.json'));
  await f.r2.put('meta/fast-hist-lease-u1.json', JSON.stringify({ token: 'other', expiresAt: '2099-01-01T00:00:00.000Z' }), f.versions.get('meta/fast-hist-lease-u1.json'));
  assert.equal((await f.run()).reason, 'lease-busy');
  await f.r2.put('meta/fast-hist-lease-u1.json', JSON.stringify({ token: 'other', expiresAt: since }), f.versions.get('meta/fast-hist-lease-u1.json'));
  const value = await f.actions();
  assert.deepEqual(value.dpRecent, edge.dpRecent); assert.equal(value.persona, 'actions');
  assert.equal(f.objects.get('pending/u1.json').histRevision, value.histRevision);
});

test('hist extension OFF rollback keeps legacy light path and guarded Actions recovery', async () => {
  const f = await histOrigin(); f.rows = [score(1)];
  assert.equal((await f.run()).done, true);
  await f.r2.put('pending/u1.json', JSON.stringify({ generation: '6', since }), f.versions.get('pending/u1.json'));
  const hist = JSON.stringify(f.objects.get('hist/u1.json')), start = f.writes.length;
  f.deps.histPublish = false;
  assert.equal((await f.run('6')).done, true);
  assert.equal(JSON.stringify(f.objects.get('hist/u1.json')), hist);
  assert.ok(f.writes.slice(start).every(key => !key.startsWith('hist/') && !key.includes('lease')));
  const value = await f.actions('6');
  assert.equal(value.fastGeneration, '6'); assert.equal(value.persona, 'actions');
  assert.equal(f.objects.get('pending/u1.json').viewGeneration, '6');
});

test('hist extension lease expiry after hist commit suppresses user/completion and Actions recovers the published best', async () => {
  const f = await histOrigin(); f.rows = [score(1)];
  const put = f.deps.put;
  f.deps.put = async (key, body, match) => {
    await put(key, body, match);
    if (key === 'hist/u1.json') f.expire();
  };
  assert.equal((await f.run()).ok, false);
  assert.equal(f.objects.get('hist/u1.json').length, 1);
  assert.equal(f.writes.filter(key => key.startsWith('user/') || key.startsWith('pending/')).length, 0);
  assert.equal(f.objects.get('pending/u1.json').viewGeneration, undefined);
  // Actions uses its own wall clock, so explicitly hand over an expired lease.
  await f.r2.put('meta/fast-hist-lease-u1.json', JSON.stringify({ token: 'expired', expiresAt: since }), f.versions.get('meta/fast-hist-lease-u1.json'));
  const value = await f.actions();
  assert.equal(value.dp[0].ex_score, 800); assert.equal(value.persona, 'actions');
  assert.equal(value.fastGeneration, '5');
  assert.equal(f.objects.get('pending/u1.json').histRevision, value.histRevision);
  assert.equal(f.objects.get('pending/u1.json').viewGeneration, '5');
});

function origin(initial = {}) {
  const objects = new Map([
    ['pending/u1.json', { generation: '5', since, extra: 'pending-unknown' }],
    ['user/u1.json', { _v: '2026-10-23T00:00:00.000Z', user: { iidx_id: 'u1' }, radars: ['stable'], ...fast(1), fastGeneration: '4', extension: { preserve: true } }],
    ['hist/u1.json', [{ id: 1 }]], ['meta/song-aliases.json', { aliases: ['a'] }], ['songs.json', [{ id: 'song' }]],
    ...Object.entries(initial),
  ]);
  const versions = new Map(), trace = [], writes = [];
  let etagCounter = 0;
  const nextTag = () => `"etag-${++etagCounter}"`;
  for (const key of objects.keys()) versions.set(key, nextTag());
  const r2 = {
    async read(key) {
      trace.push(['GET', key]);
      if (!objects.has(key)) throw Object.assign(Error('404'), { status: 404 });
      return { body: JSON.stringify(objects.get(key)), etag: versions.get(key) };
    },
    async put(key, body, condition) {
      trace.push(['PUT', key, condition]); writes.push(key);
      if (condition?.ifNoneMatch === '*') {
        if (objects.has(key)) throw Object.assign(Error('412'), { status: 412 });
      } else if (typeof condition === 'string') {
        if (!objects.has(key) || versions.get(key) !== condition) throw Object.assign(Error('412'), { status: 412 });
      } else if (condition?.ifMatch !== undefined) {
        if (!objects.has(key) || versions.get(key) !== condition.ifMatch) throw Object.assign(Error('412'), { status: 412 });
      } else throw Error('unconditional PUT forbidden in fixture');
      objects.set(key, JSON.parse(body)); versions.set(key, nextTag());
    },
  };
  const deps = {
    ...r2,
    async readBuffer() { trace.push(['BUFFER', 'read']); return { rows: [{ score_id: 1 }], fingerprint: 'buffer-v1' }; },
    prepareFastDump({ generation }) { trace.push(['CALCULATE', generation]); return {
      histBytes: new TextEncoder().encode('[{"id":1}]'), candidate: null,
      fastPatch: { ...fast(generation), fastGeneration: generation, histRevision: 'must-not-publish' },
    }; },
    now: () => '2026-10-24T00:00:01.000Z', nowMs: () => Date.parse(since),
  };
  return { objects, versions, trace, writes, r2, deps };
}

test('전체 OFF는 legacy bytes와 GET/PUT trace를 유지한다', async () => {
  const f = origin();
  const before = JSON.stringify(f.objects.get('user/u1.json'));
  const traceBefore = clone(f.trace);
  const env = { FAST_DUMP_LIGHT_GUARD: undefined, FAST_DUMP_LIGHT_WAKE: undefined, FAST_DUMP_MODE: undefined };
  assert.equal(env.FAST_DUMP_LIGHT_GUARD, undefined);
  assert.equal(JSON.stringify(f.objects.get('user/u1.json')), before);
  assert.deepEqual(f.trace, traceBefore);
  assert.deepEqual(f.writes, []);
});

test('Edge→Actions 및 Actions→Edge의 역순 G/G+1은 BigInt 세대를 지키고 unknown을 보존한다', async () => {
  const initial = expectedUser('8', 8, { persona: 'old' });
  const edge9 = mergeEdgeUser(initial, { ...fast(9), fastGeneration: '9' }, '9');
  assert.equal(edge9.ok, true);
  const actions8 = mergeActionsUser(edge9.value, { ...fast(80), _v: 'slow-8', radars: ['slow-8'] }, '8');
  assert.deepEqual(actions8.dp, [9]);
  assert.equal(actions8.fastGeneration, '9');
  assert.deepEqual(actions8.radars, ['slow-8']);
  assert.deepEqual(actions8.extension, { preserve: true });

  const actions9 = mergeActionsUser(initial, { ...fast(9), _v: 'slow-9' }, '9');
  const edge10 = mergeEdgeUser(actions9, { ...fast(10), fastGeneration: '10' }, '10');
  assert.equal(edge10.ok, true);
  const edgeFirst = mergeEdgeUser(expectedUser('8', 8), { ...fast(10), fastGeneration: '10' }, '10');
  const actionsLate = mergeActionsUser(edgeFirst.value, { ...fast(9), _v: 'late-slow' }, '9');
  assert.deepEqual(actionsLate.dp, [10]);
  assert.equal(actionsLate.fastGeneration, '10');
  assert.equal(actionsLate._v, 'late-slow');
});

test('같은 G는 fast4 동일일 때만 성공하며 pending 낮은 G no-op, 같은 G since 고정, 높은 G는 done 제거', () => {
  const same = mergeEdgeUser(expectedUser('9007199254740993', 7), { ...fast(7), fastGeneration: '9007199254740993' }, '9007199254740993');
  assert.deepEqual(same, { ok: true, changed: false, value: same.value });
  assert.equal(mergeEdgeUser(expectedUser('9007199254740993', 7), { ...fast(8), fastGeneration: '9007199254740993' }, '9007199254740993').reason, 'generation-conflict');
  const marker = { generation: '10', since, done: '2026-10-24T00:00:02.000Z', unknown: 'keep' };
  assert.equal(mergeFastPending(marker, { generation: '9', since }).reason, 'stale-generation');
  const sameMarker = mergeFastPending(marker, { generation: '10', since: 'ignored' });
  assert.equal(sameMarker.marker.since, since);
  const next = mergeFastPending(marker, { generation: '11', since: '2026-10-24T00:01:00.000Z' });
  assert.equal(next.marker.done, undefined);
  assert.equal(next.marker.unknown, 'keep');
});

test('느린 작성자 경합은 latest fast5와 unknown을 보존하고 publish의 pending/user CAS 충돌은 역행·손실 없이 정지한다', async () => {
  const f = origin();
  const originalGet = f.r2.read;
  const latestFast = { ...expectedUser('6', 6, { persona: 'edge-slow' }), mystery: 'newest' };
  let raced = true;
  const s3 = { async request(_key, init) {
    if (init.method === 'GET') {
      const current = raced ? latestFast : f.objects.get('user/u1.json');
      return new Response(JSON.stringify(current), { headers: { etag: raced ? '"race-etag"' : f.versions.get('user/u1.json') } });
    }
    const currentTag = raced ? '"race-etag"' : f.versions.get('user/u1.json');
    if (init.headers['If-Match'] !== currentTag) return new Response('', { status: 412 });
    const next = JSON.parse(init.body);
    assert.deepEqual(next.dp, latestFast.dp); assert.equal(next.fastGeneration, '6');
    assert.equal(next.mystery, 'newest'); assert.equal(next.persona, 'slow-update');
    return new Response('', { status: 200 });
  } };
  process.env.FAST_DUMP_LIGHT_GUARD = '1';
  try {
    let attempted = false;
    const client = { async put() { attempted = true; } };
    const guarded = await guardedSlowUserPut({ client, key: 'user/u1.json', source: { etag: '"stale"' }, local: { ...fast(99), fastGeneration: '99', persona: 'slow-update' }, s3 });
    assert.equal(guarded, true); assert.equal(attempted, false);
  } finally { delete process.env.FAST_DUMP_LIGHT_GUARD; }

  // publishUserPatch reads a snapshot; an Actions commit changes its ETag before the conditional PUT.
  let racedPublish = false;
  const r2 = { ...f.r2, async read(key) {
    const value = await originalGet(key);
    if (key === 'pending/u1.json' && !racedPublish) {
      racedPublish = true;
      f.objects.set('user/u1.json', { ...f.objects.get('user/u1.json'), ...fast(7), fastGeneration: '7', persona: 'actions', mystery: 'kept' });
      f.versions.set('user/u1.json', '"actions-commit"');
    }
    return value;
  } };
  const result = await publishUserPatch({ r2, id: 'u1', patch: { ...fast(5), fastGeneration: '5' }, generation: '5', since, now: () => '2026-10-24T00:00:03.000Z' });
  assert.deepEqual(result, { ok: false, reason: 'user-put-failed' });
  assert.deepEqual(f.objects.get('user/u1.json').dp, [7]);
  assert.equal(f.objects.get('user/u1.json').persona, 'actions');
  assert.equal(f.objects.get('user/u1.json').mystery, 'kept');
  assert.deepEqual(f.writes, ['user/u1.json']);
});

test('Edge commit전 오류와 commit후 응답유실 및 done 실패는 후속쓰기 없이 부분 결과를 보고한다', async () => {
  for (const mode of ['before', 'after']) {
    const f = origin();
    f.deps.put = async (key, body, condition) => {
      f.writes.push(key);
      const currentTag = f.versions.get(key);
      if (!currentTag || currentTag !== condition) throw Object.assign(Error('412'), { status: 412 });
      if (mode === 'before') throw Error('transport before commit');
      f.objects.set(key, JSON.parse(body)); f.versions.set(key, '"committed-lost-response"');
      throw Error('response lost after commit');
    };
    const result = await runLightDump({ id: 'u1', G: '5', since, deps: f.deps });
    assert.equal(result.reason, 'user-put-failed');
    assert.deepEqual(f.writes, ['user/u1.json']);
    assert.deepEqual(f.objects.get('user/u1.json').radars, ['stable']);
    assert.deepEqual(f.objects.get('user/u1.json').extension, { preserve: true });
    assert.equal(f.objects.get('user/u1.json').histRevision, undefined);
    assert.deepEqual(f.objects.get('user/u1.json').dp, mode === 'before' ? [1] : [5]);
  }
  const f = origin();
  f.deps.put = async (key, body, condition) => {
    f.writes.push(key);
    const currentTag = f.versions.get(key);
    if (currentTag !== condition) throw Object.assign(Error('412'), { status: 412 });
    if (key.startsWith('pending/')) throw Object.assign(Error('done CAS failed'), { status: 412 });
    f.objects.set(key, JSON.parse(body)); f.versions.set(key, '"user-committed"');
  };
  const partial = await runLightDump({ id: 'u1', G: '5', since, deps: f.deps });
  assert.deepEqual(partial, { ok: true, changed: true, done: false, reason: 'done-put-failed' });
  assert.deepEqual(f.writes, ['user/u1.json', 'pending/u1.json']);
  assert.deepEqual(f.objects.get('user/u1.json').dp, [5]);
  assert.equal(f.objects.get('user/u1.json').extension.preserve, true);
});

test('WAKE OFF와 MODE off 이후에도 in-flight Edge는 GUARD가 막으며 marker 폴링 한계와 GUARD OFF 반례를 드러낸다', async () => {
  const workflow = readFileSync(new URL('../../workflows/dump-user.yml', import.meta.url), 'utf8');
  const web = readFileSync(new URL('../../../../ohSorryWeb/functions/api/dump-trigger.js', import.meta.url), 'utf8');
  assert.match(workflow, /FAST_DUMP_LIGHT_GUARD/);
  assert.match(web, /FAST_DUMP_LIGHT_WAKE/);
  const f = origin();
  f.deps.put = async (key, body, condition) => {
    f.writes.push(key);
    f.objects.set('user/u1.json', expectedUser('6', 6, { persona: 'newer-origin' }));
    f.versions.set('user/u1.json', '"rollback-race"');
    if (f.versions.get(key) !== condition) throw Object.assign(Error('412'), { status: 412 });
    f.objects.set(key, JSON.parse(body)); f.versions.set(key, '"should-not-happen"');
  };
  const inFlight = runLightDump({ id: 'u1', G: '5', since, deps: f.deps });
  const lower = mergeActionsUser(expectedUser('6', 6), { ...fast(5), _v: 'rollback-attempt' }, '5');
  assert.deepEqual(lower.dp, [6]);
  assert.equal(lower.fastGeneration, '6');
  assert.equal((await inFlight).reason, 'user-put-failed');
  assert.equal(f.objects.get('user/u1.json').fastGeneration, '6');
  assert.equal(f.objects.get('user/u1.json').persona, 'newer-origin');

  const session = { renderedV: '2026-10-24T00:02:00.000Z', since: '2026-10-24T00:01:00.000Z', generationAware: false };
  const changed = mergeFastPending({ generation: '5', since: session.since }, { generation: '6', since: '2026-10-24T00:03:00.000Z' });
  assert.ok(Date.parse(changed.marker.since) >= Date.parse('2026-10-24T00:03:00.000Z'));
  assert.equal(session.generationAware, false); // Existing session cannot infer G or guarantee the rendered view.
  assert.equal(session.renderedV > changed.marker.since, false);
  assert.equal(mergeSlowUser({ ...expectedUser('6', 6), opaque: 'kept' }, { ...fast(1), fastGeneration: '1', persona: 'new-slow' }).fastGeneration, '6');

  // Expected constraint: if GUARD is also OFF, legacy whole-object PUT can replace newer origin bytes.
  const newer = expectedUser('6', 6, { persona: 'newer' });
  const staleWholePut = { ...expectedUser('5', 5, { persona: 'stale' }) };
  let legacyBody;
  delete process.env.FAST_DUMP_LIGHT_GUARD;
  const legacy = await guardedSlowUserPut({ client: { async put(_key, body) { legacyBody = body; } },
    key: 'user/u1.json', source: { etag: '"old"' }, local: staleWholePut });
  assert.equal(legacy, true);
  assert.notDeepEqual(JSON.parse(legacyBody), newer);
  assert.equal(JSON.parse(legacyBody).fastGeneration, '5');
});

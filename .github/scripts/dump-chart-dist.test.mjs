import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDist, distKey, noteCountFor, run, runUserRecovery, serializeDist } from './dump-chart-dist.mjs';
import { md5 } from './r2-client.mjs';
import { readFileSync } from 'node:fs';

function 기초자료() {
  const songsById = new Map([[10, { textage_song_id: 'tx' }]]);
  const textageMeta = { songs: { tx: { notes: { DH: 100, SH: 80 } } } };
  return { songsById, textageMeta };
}

function 의존성(변경 = {}) {
  const 호출 = { put: [], del: [], get: [], list: [] };
  const 원천 = {
    'users-list-slim.json': JSON.stringify([{ iidx_id: 'A1', r_star: 12.345 }]),
    'songs.json': JSON.stringify([{ song_id: 10, textage_song_id: 'tx' }]),
    'data/textage-meta.json': JSON.stringify({ songs: { tx: { notes: { DH: 100, SH: 80 } } } }),
  };
  return { 호출, ...{
    getText: async (key) => { 호출.get.push(key); return 원천[key] ?? (key.startsWith('user/') ? JSON.stringify({ user: { iidx_id: 'A1' }, dp: [], sp: [] }) : null); },
    list: async () => ['user/A1.json'],
    listEntries: async () => [],
    putText: async (...args) => { 호출.put.push(args); return { ok: true }; },
    del: async (key) => { 호출.del.push(key); return true; },
    log: { log() {}, error() {} },
  }, ...변경 };
}

test('분포 키 모양', () => assert.equal(distKey('dp', 10, 2), 'dist/dp/10-2.json'));
test('노트 수는 textage 메타를 사용', () => { const d = 기초자료(); assert.equal(noteCountFor({ song_id: 10, diff: 2 }, 'dp', d.songsById, d.textageMeta), 100); });
test('INF 기록은 note_count를 우선', () => { const d = 기초자료(); assert.equal(noteCountFor({ song_id: 10, diff: 2, played_version: 0, note_count: 55 }, 'dp', d.songsById, d.textageMeta), 55); });
test('노트 수 원천이 없으면 null', () => { const d = 기초자료(); assert.equal(noteCountFor({ song_id: 99, diff: 2 }, 'dp', d.songsById, d.textageMeta), null); });
test('SP 노트 키는 S 계열', () => { const d = 기초자료(); assert.equal(noteCountFor({ song_id: 10, diff: 2 }, 'sp', d.songsById, d.textageMeta), 80); });
test('분포 집계의 제외와 중복 및 반올림 규칙', () => {
  const d = 기초자료();
  const users = [{ user: { iidx_id: 'A1' }, dp: [
    { song_id: 10, diff: 2, ex_score: 0 }, { song_id: 10, diff: 2, ex_score: -1 },
    { song_id: 10, diff: 2, ex_score: 205 }, { song_id: 10, diff: 2, ex_score: 101 },
    { song_id: 10, diff: 2, ex_score: 103 },
  ], sp: [{ song_id: 10, diff: 2, ex_score: 80 }] },
  { user: { iidx_id: 'B2' }, dp: [{ song_id: 10, diff: 2, ex_score: 100 }] },
  { dp: [{ song_id: 10, diff: 2, ex_score: 100 }] }];
  const out = buildDist({ users, rStarById: new Map([['A1', 4.567]]), ...d });
  assert.deepEqual(out.get('dist/dp/10-2.json'), [[4.57, 0.515], [null, 0.5]]);
  assert.deepEqual(out.get('dist/sp/10-2.json'), [[null, 0.5]]);
});

test('scheduled recovery job is independent and uses required permissions and environment', () => {
  const workflow = readFileSync(new URL('../workflows/dump-chart-dist.yml', import.meta.url), 'utf8');
  const recovery = workflow.split('  check_user_recovery:\n')[1];
  assert.ok(recovery);
  assert.match(recovery, /^    needs: \[dump\]\n    if: \$\{\{ !cancelled\(\) && github\.event_name == 'schedule' \}\}\n/m);
  assert.match(recovery, /    permissions:\n      contents: write\n      actions: read\n/);
  assert.match(recovery, /    timeout-minutes: 75\n/);
  assert.match(recovery, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.match(recovery, /CLOUDFLARE_ACCOUNT_ID: 607eea1b073bea6747e6e9b76f2d7b41/);
  assert.match(recovery, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(recovery, /node \.github\/scripts\/dump-chart-dist\.mjs --check-user-recovery/);
});

test('recovery condition admits failed predecessors and schedule reruns only', () => {
  const applies = ({ cancelled, eventName }) => !cancelled && eventName === 'schedule';
  assert.equal(applies({ cancelled: false, eventName: 'schedule' }), true);
  assert.equal(applies({ cancelled: true, eventName: 'schedule' }), false);
  assert.equal(applies({ cancelled: false, eventName: 'workflow_dispatch' }), false);
});

test('existing distribution configuration and step order are preserved', () => {
  const workflow = readFileSync(new URL('../workflows/dump-chart-dist.yml', import.meta.url), 'utf8');
  assert.match(workflow, /  schedule:\n    - cron: '35 18 \* \* \*'/);
  assert.match(workflow, /  workflow_dispatch:\n    inputs:/);
  assert.match(workflow, /concurrency: \{ group: dump-chart-dist, cancel-in-progress: false \}/);
  assert.match(workflow, /permissions: \{ contents: read \}/);
  const dump = workflow.split('  dump:\n')[1].split('  check_user_recovery:\n')[0];
  assert.doesNotMatch(dump, /--check-user-recovery/);
  assert.ok(dump.indexOf('id: distribution') < dump.indexOf('id: sp_clear_map'));
  assert.ok(dump.indexOf('id: sp_clear_map') < dump.indexOf('name: Summarize chart distribution and SP clear map'));
  assert.match(dump, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.match(dump, /CLOUDFLARE_ACCOUNT_ID: 607eea1b073bea6747e6e9b76f2d7b41/);
});
test('표본 입력 순서가 달라도 같은 JSON', () => {
  const a = [[2, 0.7], [1, 0.7], [null, 0.8]];
  assert.equal(serializeDist(a), serializeDist([...a].reverse()));
});
test('null r 표본은 숫자 r 뒤에 정렬', () => {
  assert.deepEqual(JSON.parse(serializeDist([[null, 0.5], [3, 0.5], [1, 0.5]])).samples, [[1, 0.5], [3, 0.5], [null, 0.5]]);
});
test('원천 파일 누락이면 PUT 없이 중단', async () => {
  const d = 의존성({ getText: async () => null });
  await assert.rejects(run(d));
  assert.equal(d.호출.put.length, 0);
});
test('유저 덤프 하나라도 실패하면 변경 전에 중단', async () => {
  const d = 의존성({ list: async () => ['user/A1.json', 'user/B2.json'], getText: async (key) => key === 'user/B2.json' ? '{' : 의존성().getText(key), listEntries: async () => [{ key: 'dist/dp/1-0.json', etag: 'x' }] });
  await assert.rejects(run(d));
  assert.equal(d.호출.put.length, 0);
  assert.equal(d.호출.del.length, 0);
});
test('404 유저는 건너뜀', async () => {
  const d = 의존성({ list: async () => ['user/A1.json', 'user/B2.json'], getText: async (key) => key === 'user/B2.json' ? null : 의존성().getText(key) });
  const result = await run(d);
  assert.equal(result.charts, 0);
});
test('읽은 유저가 0명이면 삭제 없이 중단', async () => {
  const d = 의존성({ getText: async (key) => key === 'user/A1.json' ? null : 의존성().getText(key), listEntries: async () => [{ key: 'dist/dp/1-0.json', etag: 'x' }] });
  await assert.rejects(run(d));
  assert.equal(d.호출.del.length, 0);
});
test('md5가 같으면 skip', async () => {
  const 본문 = serializeDist([[null, 0.5]]);
  const d = 의존성({ list: async () => ['user/A1.json'], getText: async (key) => key === 'user/A1.json' ? JSON.stringify({ user: { iidx_id: 'A1' }, dp: [], sp: [{ song_id: 10, diff: 2, ex_score: 80 }] }) : 의존성().getText(key), listEntries: async () => [{ key: 'dist/sp/10-2.json', etag: md5(본문) }] });
  const result = await run(d);
  assert.equal(result.skips, 1);
  assert.equal(d.호출.put.length, 0);
  assert.equal(d.호출.del.length, 0);
});
test('원격에만 있는 차트를 삭제', async () => {
  const d = 의존성({ listEntries: async () => [{ key: 'dist/dp/99-0.json', etag: 'x' }] });
  const result = await run(d);
  assert.equal(result.deletes, 1);
  assert.deepEqual(d.호출.del, ['dist/dp/99-0.json']);
});
test('드라이런은 PUT과 삭제 호출을 하지 않음', async () => {
  const d = 의존성({ dryRun: true, getText: async (key) => key === 'user/A1.json' ? JSON.stringify({ user: { iidx_id: 'A1' }, dp: [], sp: [{ song_id: 10, diff: 2, ex_score: 80 }] }) : 의존성().getText(key), listEntries: async () => [{ key: 'dist/dp/99-0.json', etag: 'x' }] });
  const result = await run(d);
  assert.equal(result.puts, 1);
  assert.equal(result.deletes, 1);
  assert.equal(d.호출.put.length, 0);
  assert.equal(d.호출.del.length, 0);
});
test('PUT 실패 응답을 실패 수에 포함', async () => {
  const d = 의존성({ getText: async (key) => key === 'user/A1.json' ? JSON.stringify({ user: { iidx_id: 'A1' }, dp: [], sp: [{ song_id: 10, diff: 2, ex_score: 80 }] }) : 의존성().getText(key), putText: async () => ({ ok: false }) });
  const result = await run(d);
  assert.equal(result.failures, 1);
});

function recoveryDeps({ values = { 'user/A1.json': '{"user":null}' }, listError, readError, fetch: fetchFn, clock = { value: Date.parse('2026-01-01T00:00:00.789Z') } } = {}) {
  const calls = [];
  return {
    calls, values, clock,
    list: async (prefix) => { calls.push(['list', prefix]); if (listError) throw listError; return Object.keys(values); },
    getText: async (key) => { calls.push(['get', key]); if (readError) throw readError; return values[key] ?? null; },
    now: () => clock.value,
    pool: async (items, n, fn) => { calls.push(['pool', n, items.length]); for (const [i, item] of items.entries()) await fn(item, i); },
    sleep: async (ms) => { calls.push(['sleep', ms]); clock.value += ms; },
    fetch: fetchFn ?? (async (...args) => { calls.push(['fetch', ...args]); return { status: 204, ok: true }; }),
    env: { GITHUB_REPOSITORY: 'owner/repo', GITHUB_TOKEN: 'token' },
    log: { log() {}, error() {} },
  };
}

test('recovery checks final remaining users and rechecks before dispatch', async () => {
  const remaining = recoveryDeps();
  remaining.getText = async () => remaining.calls.filter(([kind]) => kind === 'list').length === 1
    ? '{"user":{"iidx_id":"A1"}}' : '{"user":null}';
  const remainingOut = await runUserRecovery(remaining);
  assert.equal(remainingOut.failures.length, 0);
  assert.equal(remainingOut.remaining, 1);
  assert.equal(remainingOut.failed, true);
  assert.equal(remaining.calls.filter(([kind, , init]) => kind === 'fetch' && init?.method === 'POST').length, 0);

  const rechecked = recoveryDeps();
  let reads = 0;
  rechecked.getText = async () => ++reads === 1 ? '{"user":null}' : '{"user":{"iidx_id":"A1"}}';
  const recheckedOut = await runUserRecovery(rechecked);
  assert.equal(rechecked.calls.filter(([kind, , init]) => kind === 'fetch' && init?.method === 'POST').length, 0);
  assert.equal(recheckedOut.failed, false);
});

test('복구 점검은 정상 user를 후보에서 제외한다', async () => {
  const d = recoveryDeps({ values: { 'user/A1.json': '{"user":{}}', 'user/B2.json': '{"user":null}' } });
  let fetches = 0;
  d.fetch = async () => { fetches++; return { status: 204, ok: true }; };
  const out = await runUserRecovery(d);
  assert.equal(out.anomalies, 1);
  assert.equal(fetches, 2); // POST plus new-run polling; the healthy user was not dispatched.
  assert.equal(d.calls.filter(([kind]) => kind === 'list').length, 2);
  assert.deepEqual(d.calls.filter(([kind]) => kind === 'pool').map(([, n]) => n), [8, 8]);
});

test('최초 점검의 JSON, R2 읽기 및 목록 오류는 POST를 막는다', async () => {
  for (const opts of [{ values: { 'user/A1.json': '{' } }, { readError: new Error('read') }, { listError: new Error('list') }]) {
    const d = recoveryDeps(opts);
    const out = await runUserRecovery(d);
    assert.equal(out.failed, true);
    assert.equal(d.calls.filter(([kind]) => kind === 'fetch').length, 0);
  }
});

test('204 dispatch 뒤 신규 run과 두 정숙 조회 후 R2 상태로 복구 판정', async () => {
  const values = { 'user/A1.json': '{"user":null}' };
  const calls = [];
  let clock = Date.parse('2026-01-01T00:00:00.789Z');
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    if (init.method === 'POST') { values['user/A1.json'] = '{"user":{"iidx_id":"A1"}}'; return { status: 204, ok: true }; }
    const search = new URL(url).searchParams;
    if (search.has('created')) return { status: 200, ok: true, json: async () => ({ workflow_runs: [{ conclusion: 'failure' }] }) };
    return { status: 200, ok: true, json: async () => ({ workflow_runs: [] }) };
  };
  const d = recoveryDeps({ values, fetch: fetchFn, clock: { get value() { return clock; }, set value(v) { clock = v; } } });
  const out = await runUserRecovery(d);
  assert.equal(out.recovered, 1);
  assert.equal(out.failed, false);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { event_type: 'dump-user', client_payload: { iidx_id: 'A1' } });
  assert.equal(calls[0].init.headers.Authorization, 'Bearer token');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[1].url, 'https://api.github.com/repos/owner/repo/actions/workflows/dump-user.yml/runs?event=repository_dispatch&created=%3E%3D2026-01-01T00%3A00%3A00.000Z&per_page=100&page=1');
  assert.match(calls[2].url, /status=queued/);
  assert.match(calls[3].url, /status=in_progress/);
  assert.equal(calls.length, 4);
  assert.equal(calls[1].init?.headers?.['Content-Type'], undefined);
});

test('복구 경계와 정렬, quiet 대기, 페이지 넘김 및 20분 제한', async () => {
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  const skeleton = (v) => JSON.stringify({ _v: v, user: null, radars: null, osPattern: null, persona: null, spPersona: null, reachNps: null, fastGeneration: '1' });
  const runSingle = async (raw) => {
    const d = recoveryDeps({ values: { 'user/A1.json': raw }, clock: { value: base } });
    const out = await runUserRecovery(d);
    return { out, posts: d.calls.filter(([kind]) => kind === 'fetch').filter(([, , init]) => init.method === 'POST').length };
  };
  assert.equal((await runSingle(skeleton(new Date(base - 2 * 60 * 60 * 1000).toISOString()))).posts, 1);
  assert.equal((await runSingle(skeleton(new Date(base - 2 * 60 * 60 * 1000 + 1).toISOString()))).posts, 0);
  assert.equal((await runSingle(skeleton(new Date(base + 1000).toISOString()))).posts, 1);
  assert.equal((await runSingle(skeleton('bad'))).posts, 1);
  assert.equal((await runSingle(JSON.stringify({ _v: new Date(base).toISOString(), user: null }))).posts, 1);

  const values = {
    'user/A1.json': '{"user":null}', 'user/B2.json': skeleton('2025-12-30T00:00:00.000Z'),
    'user/C3.json': skeleton('2025-12-31T00:00:00.000Z'), 'user/D4.json': skeleton('2025-12-31T00:00:00.000Z'),
  };
  const posted = [];
  const d = recoveryDeps({ values, clock: { value: base + 3 * 60 * 60 * 1000 }, pool: async (items, n, fn) => { for (const [i, item] of items.entries()) await fn(item, i); }, fetch: async (url, init) => { if (init.method === 'POST') { posted.push(JSON.parse(init.body).client_payload.iidx_id); return { status: 204, ok: true }; } return { status: 200, ok: true, json: async () => ({ workflow_runs: new URL(url).searchParams.has('created') ? [{}] : [] }) }; } });
  const limited = await runUserRecovery(d);
  assert.deepEqual(posted, ['A1', 'B2', 'C3']);
  assert.equal(limited.unprocessed, 1);
  assert.equal(limited.failed, true);

  for (const status of ['queued', 'in_progress']) {
    let clock = base;
    const waits = [];
    let createdChecks = 0;
    const quiet = recoveryDeps({ values: { 'user/A1.json': '{"user":null}' }, clock: { get value() { return clock; }, set value(v) { clock = v; } }, fetch: async (url, init) => {
      if (init.method === 'POST') return { status: 204, ok: true };
      const q = new URL(url).searchParams;
      if (q.has('created')) { createdChecks++; return { status: 200, ok: true, json: async () => ({ workflow_runs: [{}] }) }; }
      return { status: 200, ok: true, json: async () => ({ workflow_runs: q.get('status') === status && createdChecks === 1 ? [{}] : [] }) };
    } });
    quiet.sleep = async (ms) => { waits.push(ms); clock += ms; };
    await runUserRecovery(quiet);
    assert.deepEqual(waits, [15000]);
  }

  let pageCalls = [];
  const pageD = recoveryDeps({ values: { 'user/A1.json': '{"user":null}' }, fetch: async (url, init) => {
    if (init.method === 'POST') return { status: 204, ok: true };
    const q = new URL(url).searchParams;
    if (q.has('created')) { pageCalls.push(q.get('page')); return { status: 200, ok: true, json: async () => ({ workflow_runs: q.get('page') === '1' ? Array(100).fill({}) : [] }) }; }
    return { status: 200, ok: true, json: async () => ({ workflow_runs: [] }) };
  } });
  await runUserRecovery(pageD);
  assert.deepEqual(pageCalls, ['1', '2']);

  let clock = base, posts = 0, listsAtEnd = 0;
  const timeoutD = recoveryDeps({ values: { 'user/A1.json': '{"user":null}' }, clock: { get value() { return clock; }, set value(v) { clock = v; } }, fetch: async (url, init) => {
    if (init.method === 'POST') { posts++; return { status: 204, ok: true }; }
    return { status: 200, ok: true, json: async () => ({ workflow_runs: [] }) };
  } });
  const originalList = timeoutD.list;
  timeoutD.list = async (...args) => { listsAtEnd++; return originalList(...args); };
  const timeout = await runUserRecovery(timeoutD);
  assert.equal(clock, base + 20 * 60 * 1000);
  assert.equal(timeout.failures.some((f) => f.stage === 'workflow-wait'), true);
  assert.equal(posts, 1);
  assert.equal(listsAtEnd, 2);
});

test('dispatch 오류는 재시도하지 않고 중단 후 전수 재점검한다', async () => {
  let attempts = 0;
  const d = recoveryDeps({ fetch: async () => { attempts++; return { status: 500, ok: false }; } });
  const out = await runUserRecovery(d);
  assert.equal(attempts, 1);
  assert.equal(out.failures[0].stage, 'dispatch');
  assert.equal(d.calls.filter(([kind]) => kind === 'list').length, 2);
});

test('기존 분포 run의 목록 404 스킵은 그대로 보존', async () => {
  const d = 의존성({ list: async () => ['user/A1.json', 'user/B2.json'], getText: async (key) => key === 'user/A1.json' ? null : key === 'user/B2.json' ? JSON.stringify({ user: { iidx_id: 'B2' }, dp: [], sp: [] }) : 의존성().getText(key) });
  const out = await run(d);
  assert.equal(out.charts, 0);
});

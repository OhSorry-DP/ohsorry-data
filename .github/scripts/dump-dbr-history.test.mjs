import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { run, readDbrRows, parseArgs } from './dump-dbr-history.mjs';
import { conditionalR2Client } from './r2-client.mjs';
import { normalizeDbrHistory, DBR_HISTORY_COLS } from './dbr-history.mjs';

const sb = 'https://supabase.invalid';
const base = 'https://api.cloudflare.com/client/v4/accounts/fake-account/r2/buckets/ohsorry-data/objects';
const row = (extra = {}) => ({ iidx_id: 'A', song_id: 1, diff: 3, lamp: 4, ex_score: 100,
  played_version: -10, date: '2026-09-01T10:00:00Z', date_kst: '2026-09-01',
  play_style: 1, bp: 30, note_count: 500, score_id: 1, ...extra });
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const hash = (body) => createHash('sha256').update(body).digest('hex');

function fixture({ pages = [[]], existing = {}, listed, putStatus = 200, onGet } = {}) {
  const requests = [], puts = [], logs = [];
  let pageIndex = 0;
  const entries = listed ?? Object.keys(existing);
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), ...init });
    const u = new URL(url);
    if (u.origin === sb) {
      assert.equal(init.method, 'GET');
      assert.equal(init.headers.apikey, 'fake-sb');
      assert.equal(init.headers.Authorization, 'Bearer fake-sb');
      assert.ok(pageIndex < pages.length, '예상보다 많은 Supabase 요청');
      const page = pages[pageIndex++];
      return page instanceof Response ? page : json(page);
    }
    assert.equal(init.headers.Authorization, 'Bearer fake-r2');
    if (String(url).startsWith(base + '?')) {
      const second = u.searchParams.has('cursor');
      return json({ result: (second ? entries.slice(1) : entries.slice(0, 1)).map((key) => ({ key, etag: 'list-etag' })),
        ...(second || entries.length < 2 ? {} : { result_info: { cursor: 'NEXT' } }) });
    }
    const key = decodeURIComponent(u.pathname.split('/objects/')[1]);
    assert.ok(key, '예상하지 못한 URL');
    if (init.method === 'GET') {
      assert.equal(init.headers['Accept-Encoding'], 'identity');
      if (onGet) { const response = onGet(key); if (response) return response; }
      return existing[key] ? json(existing[key], 200, { etag: '"get-etag"' }) : new Response('', { status: 404 });
    }
    assert.equal(init.method, 'PUT');
    puts.push({ key, ...init });
    return new Response('', { status: putStatus });
  };
  const r2 = conditionalR2Client({ account: 'fake-account', token: 'fake-r2', fetchImpl });
  return { requests, puts, logs, options: { supabaseUrl: sb, token: 'fake-sb', fetchImpl, r2,
    log: { log: (text) => logs.push({ text, puts: puts.length }) } } };
}

test('키셋 페이지 경계: 짧은 페이지도 계속 읽고 실제 필터·정렬·선택·커서를 단정한다', async () => {
  const f = fixture({ pages: [[row(), row({ song_id: 2, score_id: 2 })],
    [row({ song_id: 3, score_id: '9007199254740993' })], []] });
  const result = await run({ ...f.options, pageSize: 2 });
  assert.equal(result.rows, 3);
  const requests = f.requests.filter((r) => r.url.startsWith(sb));
  assert.equal(requests.length, 3);
  const cursors = ['gt.0', 'gt.2', 'gt.9007199254740993'];
  for (const [index, request] of requests.entries()) {
    const url = new URL(request.url);
    assert.equal(url.pathname, '/rest/v1/scores');
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      select: ['iidx_id', ...DBR_HISTORY_COLS].join(','), played_version: 'eq.-10',
      play_style: 'eq.1', order: 'score_id.asc', limit: '2', score_id: cursors[index],
    });
    assert.equal(url.searchParams.has('offset'), false);
  }
  assert.equal(f.puts.length, 0);
});

test('DB에 행 없는 기존 보유자도 포함하고 기본 dry-run의 PUT은 0이다', async () => {
  const f = fixture({ existing: {
    'dbr/B.json': { scores: { old: 1 } }, 'dbr/C.json': { scores: {} },
  }, pages: [[row()], []] });
  const result = await run(f.options);
  assert.equal(result.dryRun, true);
  assert.equal(result.users, 3);
  assert.equal(result.rows, 1);
  assert.deepEqual(result.objects.map((x) => x.key), ['dbr/A.json', 'dbr/B.json', 'dbr/C.json']);
  assert.equal(result.puts, 0);
  assert.equal(f.puts.length, 0);
  const listUrls = f.requests.filter((r) => r.url.startsWith(base + '?')).map((r) => r.url);
  assert.deepEqual(listUrls, [`${base}?prefix=dbr%2F&per_page=1000`, `${base}?prefix=dbr%2F&per_page=1000&cursor=NEXT`]);
  assert.deepEqual(f.requests.filter((r) => r.url.startsWith(base + '/') && r.method === 'GET').map((r) => r.url),
    ['A', 'B', 'C'].map((id) => `${base}/dbr/${id}.json`));
});

test('apply: scores·부가 필드·기존 history 보존, revision 증가와 빈 보유자 완료', async () => {
  const original = { scores: { '1_3': { lamp: 7, ex_score: 900 } }, _v: 'keep',
    history: normalizeDbrHistory([row({ song_id: 8, score_id: 8 })], { revision: 12 }) };
  const f = fixture({ pages: [[row(), row({ score_id: 2, ex_score: 20 })], []], existing: {
    'dbr/A.json': original, 'dbr/B.json': { scores: { legacy: true } },
  } });
  const result = await run({ ...f.options, apply: true });
  assert.equal(result.puts, 2);
  const a = JSON.parse(f.puts[0].body), b = JSON.parse(f.puts[1].body);
  assert.deepEqual(a.scores, original.scores);
  assert.equal(a._v, 'keep');
  assert.equal(a.history.revision, 13);
  assert.equal(a.history.complete, true);
  assert.equal(a.history.rows.length, 2);
  assert.deepEqual(a.history.rows[0], original.history.rows[0]);
  assert.equal(a.history.rows[1][3], 20);
  assert.equal(b.history.complete, true);
  assert.deepEqual(b.history.rows, []);
  assert.deepEqual(b.scores, { legacy: true });
  assert.equal(result.duplicateKeys, 1);
  for (const put of f.puts) {
    assert.equal(put.headers['If-Match'], '"get-etag"');
    assert.equal(put.headers['If-None-Match'], undefined);
    assert.equal(put.headers['Content-Type'], 'application/json; charset=utf-8');
    assert.equal(f.requests.find((r) => r.body === put.body).url, `${base}/${put.key}`);
  }
  assert.equal(f.logs[0].puts, 0);
  const sizes = f.puts.map((p) => Buffer.byteLength(p.body));
  assert.deepEqual(result.bytes, { total: sizes[0] + sizes[1], max: Math.max(...sizes), median: (sizes[0] + sizes[1]) / 2 });
  assert.deepEqual(result.objects.map((o) => o.sha256), f.puts.map((p) => hash(p.body)));
  assert.equal(result.sha256, hash(JSON.stringify(result.objects)));
  assert.equal(original.history.revision, 12);
});

test('신규 객체 생성은 If-None-Match: * 조건으로만 PUT한다', async () => {
  const f = fixture({ pages: [[row()], []] });
  await run({ ...f.options, apply: true });
  assert.equal(f.puts.length, 1);
  assert.equal(f.puts[0].headers['If-None-Match'], '*');
  assert.equal(f.puts[0].headers['If-Match'], undefined);
  assert.deepEqual(JSON.parse(f.puts[0].body).scores, {});
});

test('결함 주입: ETag 경쟁 412는 중단하고 무조건 PUT·재시도하지 않는다', async () => {
  const f = fixture({ existing: { 'dbr/A.json': { scores: {} }, 'dbr/B.json': { scores: {} } }, putStatus: 412 });
  await assert.rejects(run({ ...f.options, apply: true }), /R2 PUT dbr\/A.json HTTP 412/);
  assert.equal(f.puts.length, 1);
  assert.equal(f.puts[0].headers['If-Match'], '"get-etag"');
});

test('결함 주입: 페이지 경계 중복 ID·역순·필터 누출·비배열·조회 실패는 PUT 전에 차단한다', async () => {
  for (const pages of [ [[row()], [row()], []], [[row({ score_id: 2 }), row()], []],
    [[row({ played_version: 0 })], []], [[row({ play_style: 0 })], []],
    [json({ unexpected: true })], [json({}, 403)], [[row({ score_id: 9007199254740992 })], []] ]) {
    const f = fixture({ pages });
    await assert.rejects(run({ ...f.options, apply: true }));
    assert.equal(f.puts.length, 0);
  }
});

test('결함 주입: 나중 객체의 잘못된 JSON·scores·history·소실도 전체 사전 검증으로 PUT 0', async () => {
  for (const bad of [new Response('{', { headers: { etag: '"x"' } }),
    json({ scores: [] }, 200, { etag: '"x"' }),
    json({ scores: {}, history: { schemaVersion: 99 } }, 200, { etag: '"x"' }),
    new Response('', { status: 404 }), new Response('', { status: 403 }),
    json({ scores: {} }), json({ scores: {} }, 200, { etag: 'W/"x"' })]) {
    const f = fixture({ existing: { 'dbr/A.json': { scores: {} } }, listed: ['dbr/A.json', 'dbr/B.json'],
      onGet: (key) => key === 'dbr/B.json' ? bad : null });
    await assert.rejects(run({ ...f.options, apply: true }));
    assert.equal(f.puts.length, 0);
  }
});

test('빈 덤프 통계·해시는 결정적이며 CLI는 기본 dry-run과 명시적 apply만 허용한다', async () => {
  const f = fixture();
  const result = await run(f.options);
  assert.deepEqual(result.bytes, { total: 0, max: 0, median: 0 });
  assert.equal(result.users, 0);
  assert.equal(result.sha256, hash('[]'));
  assert.deepEqual(parseArgs([]), { apply: false });
  assert.deepEqual(parseArgs(['--dry-run']), { apply: false });
  assert.deepEqual(parseArgs(['--apply']), { apply: true });
  assert.throws(() => parseArgs(['--apply', '--dry-run']));
  assert.throws(() => parseArgs(['--aply']));
  await assert.rejects(readDbrRows({ ...f.options, pageSize: 0 }));
});

test('workflow는 수동 전용이며 dry_run 기본 true 및 apply 분기가 명시되어 있다', () => {
  const source = readFileSync(new URL('../workflows/dump-dbr-history.yml', import.meta.url), 'utf8');
  assert.match(source, /workflow_dispatch:/);
  assert.doesNotMatch(source, /schedule:|repository_dispatch:|\n  push:|pull_request:/);
  assert.match(source, /dry_run:[\s\S]*?type: boolean\s+default: true/);
  assert.match(source, /node --test \.github\/scripts\/\*\.test\.mjs/);
  assert.match(source, /if \[ "\$DRY_RUN" = "true" \]; then\s+node .* --dry-run\s+elif \[ "\$DRY_RUN" = "false" \]; then\s+node .* --apply/);
  assert.match(source, /else[\s\S]*exit 1/);
});

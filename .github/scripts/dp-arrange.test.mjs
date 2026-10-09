import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fetchDpArrange, fetchDpArrangeByUser } from './dp-arrange.mjs';
import { attachArrange } from './persona-lib.mjs';

const options = { supabaseUrl: 'https://example.test', serviceRoleKey: 'test-key' };
const row = (song_id, iidx_id = 'a') => ({ iidx_id, song_id, diff: 3, play_style: 1, arrange: 5 });
function pages(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), init });
    assert.ok(responses.length, '예상 밖 추가 조회');
    const { rows, range, status = 200 } = responses.shift();
    return { ok: status >= 200 && status < 300, status,
      headers: new Headers(range == null ? {} : { 'Content-Range': range }), json: async () => rows };
  };
  return { calls, opts: { ...options, fetchImpl } };
}

test('단일 유저 여러 페이지를 실제 수신 행수만큼 이어서 수집한다', async () => {
  const expected = Array.from({ length: 1003 }, (_, i) => row(i + 1));
  const { calls, opts } = pages([
    { rows: expected.slice(0, 1000), range: '0-999/1003' },
    { rows: expected.slice(1000), range: '1000-1002/1003' },
  ]);
  assert.deepEqual(await fetchDpArrange('a &b', opts), expected);
  assert.deepEqual(calls.map((c) => c.url.searchParams.get('offset')), ['0', '1000']);
  for (const { url, init } of calls) {
    assert.equal(url.pathname, '/rest/v1/chart_arrange');
    assert.equal(url.searchParams.get('iidx_id'), 'eq.a &b');
    assert.equal(url.searchParams.get('play_style'), 'eq.1');
    assert.equal(url.searchParams.get('select'), 'song_id,diff,play_style,arrange');
    assert.equal(url.searchParams.get('order'), 'song_id.asc,diff.asc');
    assert.equal(url.searchParams.get('limit'), '1000');
    assert.equal(init.headers.Prefer, 'count=exact');
    assert.equal(init.headers.apikey, options.serviceRoleKey);
    assert.equal(init.headers.Authorization, 'Bearer test-key');
  }
});

test('서버가 요청 limit보다 작게 잘라도 전체 행수까지 계속 조회한다', async () => {
  const { calls, opts } = pages([
    { rows: [row(1)], range: '0-0/3' },
    { rows: [row(2)], range: '1-1/3' },
    { rows: [row(3)], range: '2-2/3' },
  ]);
  assert.deepEqual(await fetchDpArrange('a', opts), [row(1), row(2), row(3)]);
  assert.deepEqual(calls.map((c) => c.url.searchParams.get('offset')), ['0', '1', '2']);
});

test('0행은 */0 응답에서만 허용한다', async () => {
  const { calls, opts } = pages([{ rows: [], range: '*/0' }]);
  assert.deepEqual(await fetchDpArrange('a', opts), []);
  assert.equal(calls.length, 1);
});

test('페이지 사이 전체 행수 변경을 거부한다', async () => {
  const { opts } = pages([
    { rows: [row(1)], range: '0-0/2' },
    { rows: [row(2)], range: '1-1/3' },
  ]);
  await assert.rejects(fetchDpArrange('a', opts), /전체 행수 변경/);
});

for (const [label, rows, range] of [
  ['시작 범위', [row(1)], '1-1/2'],
  ['끝 범위와 행수', [row(1)], '0-1/2'],
  ['전체 행수 초과', [row(1), row(2)], '0-1/1'],
  ['양수 전체 행수의 빈 페이지', [], '*/2'],
  ['0행의 숫자 범위', [], '0-0/0'],
  ['0행의 비어 있지 않은 응답', [row(1)], '*/0'],
  ['행이 있는데 범위 없음', [row(1)], '*/1'],
  ['요청 limit 초과', Array.from({ length: 1001 }, (_, i) => row(i)), '0-1000/1001'],
]) {
  test(`${label} 불일치를 거부한다`, async () => {
    const { opts } = pages([{ rows, range }]);
    await assert.rejects(fetchDpArrange('a', opts), /페이지 범위\/행수 불일치/);
  });
}

test('후속 페이지의 범위 겹침을 거부한다', async () => {
  const { opts } = pages([
    { rows: [row(1)], range: '0-0/2' },
    { rows: [row(2)], range: '0-0/2' },
  ]);
  await assert.rejects(fetchDpArrange('a', opts), /페이지 범위\/행수 불일치/);
});

for (const [label, rows, range] of [
  ['전체 행수 헤더 누락', [row(1)], null],
  ['정확한 전체 행수 없음', [row(1)], '0-0/*'],
  ['전체 행수의 안전한 정수 범위 초과', [row(1)], '0-0/9007199254740992'],
  ['응답이 배열 아님', {}, '0-0/1'],
]) {
  test(`${label}을 거부한다`, async () => {
    const { opts } = pages([{ rows, range }]);
    await assert.rejects(fetchDpArrange('a', opts), /응답 배열\/정확한 전체 행수 없음/);
  });
}

test('HTTP 실패는 수집한 페이지를 반환하지 않고 throw한다', async () => {
  const { opts } = pages([
    { rows: [row(1)], range: '0-0/2' },
    { status: 503 },
  ]);
  await assert.rejects(fetchDpArrange('a', opts), /HTTP 503/);
  const first = pages([{ status: 401 }]);
  await assert.rejects(fetchDpArrange('a', first.opts), /HTTP 401/);
});

test('전량 조회는 유저별 조회 없이 페이지를 수집하고 유저를 격리해 결합한다', async () => {
  const a = row(1, 'a'), b = { ...row(1, 'b'), arrange: 2 };
  const { calls, opts } = pages([
    { rows: [a], range: '0-0/2' },
    { rows: [b], range: '1-1/2' },
  ]);
  const byUser = await fetchDpArrangeByUser(opts);
  assert.deepEqual([...byUser], [['a', [a]], ['b', [b]]]);
  for (const { url } of calls) {
    assert.equal(url.searchParams.has('iidx_id'), false);
    assert.equal(url.searchParams.get('play_style'), 'eq.1');
    assert.equal(url.searchParams.get('select'), 'iidx_id,song_id,diff,play_style,arrange');
    assert.equal(url.searchParams.get('order'), 'iidx_id.asc,song_id.asc,diff.asc');
  }
  const rows = [{ song_id: 1, diff: 3, ex_score: 100 }];
  assert.equal(attachArrange(rows, byUser.get('a'))[0].arrange, 5);
  assert.equal(attachArrange(rows, byUser.get('b'))[0].arrange, 2);
  assert.equal(attachArrange(rows, byUser.get('absent') || []), rows);
  assert.ok(!Object.hasOwn(rows[0], 'arrange'));
});

test('전량 0행은 빈 Map이고 조회 실패는 빈 Map으로 대체하지 않는다', async () => {
  const empty = pages([{ rows: [], range: '*/0' }]);
  assert.deepEqual(await fetchDpArrangeByUser(empty.opts), new Map());
  const failed = pages([{ status: 403 }]);
  await assert.rejects(fetchDpArrangeByUser(failed.opts), /HTTP 403/);
});

test('전량 조회에 유저 키가 없거나 SP 행이면 거부한다', async () => {
  for (const invalid of [{ ...row(1), iidx_id: undefined }, { ...row(1), play_style: 0 }]) {
    const { opts } = pages([{ rows: [invalid], range: '0-0/1' }]);
    await assert.rejects(fetchDpArrangeByUser(opts), /iidx_id\/play_style 불일치/);
  }
});

test('자격 누락은 fetch 호출 전에 거부한다', async () => {
  for (const missing of [{ supabaseUrl: '' }, { serviceRoleKey: '' }]) {
    await assert.rejects(fetchDpArrange('a', { ...options, ...missing,
      fetchImpl: () => assert.fail('자격 누락 시 fetch 금지') }), /SUPABASE_URL/);
  }
});

test('R2 재계산 진입점도 자격 누락 시 외부 접근 전에 중단한다', () => {
  const entry = new URL('./r2-repersona.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
     globalThis.fetch = () => { throw new Error('외부 접근 시도'); };
     // 진입점은 직접 실행일 때만 main() 을 돈다 — 같은 경로를 main([]) 로 태운다.
     const m = await import(${JSON.stringify(entry)});
     await m.main([]).catch((e) => { console.error(e.message); process.exit(1); });`], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /SUPABASE_URL \/ SUPABASE_SERVICE_ROLE_KEY 없음/);
  assert.doesNotMatch(result.stderr, /외부 접근 시도/);
});

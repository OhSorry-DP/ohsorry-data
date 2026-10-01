import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { refreshMissingSongs } from './refresh-missing-songs.mjs';
import { fetchAllSongs, serializeSongs } from './songs-lib.mjs';

const song = (id) => ({ song_id: id, title: '곡 ' + id, ac: true, legen: false, textage_song_id: 'a', series_no: 34 });
function fixture(overrides = {}) {
  const calls = { get: 0, rebuild: 0, puts: [], warnings: [] };
  const deps = {
    readFile: async (file) => JSON.stringify(file.startsWith('user/') ? { dp: [{ song_id: 1 }], sp: [{ song_id: 2 }] } : [[3, 4]]),
    get: async (key) => { calls.get++; assert.equal(key, 'songs.json'); return JSON.stringify([song(1)]); },
    rebuild: async () => { calls.rebuild++; return [song(1), song(2), song(3)]; },
    put: async (...args) => { calls.puts.push(args); return { ok: true }; },
    log: () => {},
    warn: (message) => calls.warnings.push(message),
    ...overrides,
  };
  return { calls, run: () => refreshMissingSongs('12345678', deps) };
}

test('누락 곡이면 한 번 재생성하고 기존 바이트 형식으로 업로드한다', async () => {
  const f = fixture();
  assert.equal((await f.run()).status, 'updated');
  assert.equal(f.calls.rebuild, 1);
  assert.deepEqual(f.calls.puts, [['songs.json', JSON.stringify([song(1), song(2), song(3)])]]);
});

test('모두 있으면 R2 비교만 하고 재생성·업로드하지 않는다', async () => {
  const f = fixture({ get: async () => JSON.stringify([song(1), song(2), song(3)]) });
  assert.equal((await f.run()).status, 'unchanged');
  assert.equal(f.calls.rebuild, 0);
  assert.equal(f.calls.puts.length, 0);
});

for (const [name, overrides] of [
  ['R2 조회 예외', { get: async () => { throw new Error('HTTP 503'); } }],
  ['R2 객체 없음', { get: async () => null }],
  ['R2 JSON 오류', { get: async () => '{' }],
  ['R2 목록 형식 오류', { get: async () => '{}' }],
  ['Supabase 예외', { rebuild: async () => { throw new Error('HTTP 503'); } }],
  ['재생성 빈 결과', { rebuild: async () => [] }],
  ['재생성 형식 오류', { rebuild: async () => ({}) }],
  ['곡 수 감소', { get: async () => JSON.stringify([song(1), song(4), song(5)]), rebuild: async () => [song(1), song(2)] }],
  ['로컬 덤프 읽기 예외', { readFile: async () => { throw new Error('ENOENT'); } }],
]) {
  test(name + '면 업로드 0이고 후속 본 작업을 계속한다', async () => {
    const f = fixture(overrides);
    const order = [];
    assert.equal((await f.run()).status, 'failed');
    // 실제 workflow의 후속 단계는 아래 별도 테스트에서 실패 격리를 확인한다.
    order.push('users-list 병합', 'user 업로드', 'hist 업로드');
    assert.equal(f.calls.puts.length, 0);
    assert.equal(f.calls.warnings.length, 1);
    assert.equal(order.length, 3);
    if (name.startsWith('R2') || name.startsWith('로컬')) assert.equal(f.calls.rebuild, 0);
  });
}

test('재생성 후에도 없는 곡은 경고만 남기고 재시도하지 않는다 — 새로 찾은 곡이 하나도 없으면 업로드 생략', async () => {
  const f = fixture({ rebuild: async () => [song(1)] });
  const result = await f.run();
  assert.deepEqual(result, { status: 'unchanged', remaining: ['2', '3'] });
  assert.equal(f.calls.puts.length, 0);
  assert.match(f.calls.warnings[0], /2, 3/);
});

test('일부만 새로 찾으면 업로드하고 남은 곡은 경고한다', async () => {
  const f = fixture({ rebuild: async () => [song(1), song(2)] });
  const result = await f.run();
  assert.deepEqual(result, { status: 'updated', remaining: ['3'] });
  assert.deepEqual(f.calls.puts, [['songs.json', JSON.stringify([song(1), song(2)])]]);
  assert.match(f.calls.warnings[0], /3/);
});

test('PUT 실패도 경고만 반환한다', async () => {
  for (const put of [async () => ({ ok: false, msg: 'HTTP 500' }), async () => { throw new Error('network'); }]) {
    const f = fixture({ put });
    assert.equal((await f.run()).status, 'failed');
    assert.match(f.calls.warnings[0], /PUT 실패|network/);
  }
});

test('문자열과 숫자 ID를 동일하게 비교한다', async () => {
  const f = fixture({ get: async () => JSON.stringify([song('1'), song('2'), song('3')]) });
  assert.equal((await f.run()).status, 'unchanged');
  assert.equal(f.calls.rebuild, 0);
});

test('hist에만 있는 과거·DBR 곡도 감지한다', async () => {
  const f = fixture({ get: async () => JSON.stringify([song(1), song(2)]) });
  assert.equal((await f.run()).status, 'updated');
  assert.equal(f.calls.rebuild, 1);
});

test('빈 점수 덤프는 재생성하지 않는다', async () => {
  const f = fixture({ readFile: async (file) => JSON.stringify(file.startsWith('user/') ? { dp: [], sp: [] } : []) });
  assert.equal((await f.run()).status, 'unchanged');
  assert.equal(f.calls.get, 1);
  assert.equal(f.calls.rebuild, 0);
});

test('CLI 파일 오류는 네트워크 접근 없이 경고와 종료 코드 0으로 끝난다', () => {
  const child = spawnSync(process.execPath, ['.github/scripts/refresh-missing-songs.mjs', '../invalid'], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stderr, /::warning::/);
});

test('workflow는 갱신 실패를 격리하고 병합·업로드 단계를 유지한다', async () => {
  const workflow = await fs.readFile(new URL('../workflows/dump-user.yml', import.meta.url), 'utf8');
  const start = workflow.indexOf('      - name: 누락 신곡');
  const end = workflow.indexOf('\n      - name:', start + 1);
  const step = workflow.slice(start, end);
  assert.match(step, /continue-on-error: true/);
  assert.match(step, /!cancelled\(\) && steps.dump.outcome == 'success'/);
  assert.match(step, /SUPABASE_SERVICE_ROLE_KEY:/);
  assert.match(step, /CLOUDFLARE_API_TOKEN:/);
  assert.match(workflow.slice(end), /node .github\/scripts\/merge-user-into-list.mjs/);
  assert.match(workflow.slice(end), /put "user\/\$IIDX_ID.json"/);
  assert.match(workflow.slice(end), /put "hist\/\$IIDX_ID.json"/);
});

test('공통 생성기는 기존 select·정렬·페이지·바이트 형식을 유지한다', async () => {
  const first = Array.from({ length: 1000 }, (_, i) => song(i));
  const urls = [];
  const result = await fetchAllSongs({ supabaseUrl: 'https://test', serviceRoleKey: 'test', fetchImpl: async (url, init) => {
    urls.push(url);
    assert.deepEqual(init.headers, { apikey: 'test', Authorization: 'Bearer test' });
    return new Response(JSON.stringify(urls.length === 1 ? first : [song(1000)]));
  } });
  assert.deepEqual(urls, [0, 1000].map((offset) => 'https://test/rest/v1/songs?select=song_id,title,ac,legen,textage_song_id,series_no&order=song_id.asc&limit=1000&offset=' + offset));
  assert.equal(serializeSongs(result), JSON.stringify([...first, song(1000)]));
  const script = await fs.readFile(new URL('./dump-users-list.mjs', import.meta.url), 'utf8');
  assert.match(script, /const songs = await fetchAllSongs\(\)/);
  assert.match(script, /writeFileSync\('songs.json', serializeSongs\(songs\)\)/);
});

test('공통 생성기는 후속 페이지 HTTP·형식 오류를 부분 결과로 반환하지 않는다', async () => {
  for (const response of [new Response('{}'), new Response('', { status: 503 })]) {
    let calls = 0;
    await assert.rejects(fetchAllSongs({ supabaseUrl: 'https://test', serviceRoleKey: 'test', fetchImpl: async () => {
      calls++;
      return calls === 1 ? new Response(JSON.stringify(Array.from({ length: 1000 }, (_, i) => song(i)))) : response;
    } }), /배열|HTTP 503/);
    assert.equal(calls, 2);
  }
});

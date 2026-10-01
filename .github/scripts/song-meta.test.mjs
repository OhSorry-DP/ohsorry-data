import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSongMeta, publishSongMeta, SOURCE_KEYS, pacedFetch } from './song-meta.mjs';
import { md5, listEntries } from './r2-client.mjs';

const sources = [[{ song_id: 1, title: 'Target', ac: 1, series_no: 33, textage_song_id: 'tx' },
  { song_id: 2, title: 'Target', ac: 2, series_no: 98, textage_song_id: 'txinf' }],
{ songs: { tx: { title: 'Target', levels: { DA: 12 }, notes: { DA: 1000 }, bpm: '180' },
  txinf: { title: 'Target', levels: { DA: 11 }, notes: { DA: 900 } } } },
{ ratings: [{ title: 'Target', diff: 'ANOTHER', estEc: 12, unused: '빼야 함' }] },
{ 33: 'Sparkle', 98: 'INF', 1: '불필요' }, { charts: [{ title: 'Target', diff: 'ANOTHER', level: 12 }] }];
// 테스트용 norm — 운영은 R2 lib/normTitle.js(마스터 게시본)를 받는다. 게시본 로드 경로도 이 UMD 문자열로 같이 검사한다.
const norm = (title) => String(title).trim().toLowerCase();
const NORM_UMD = 'module.exports = { norm: (t) => String(t).trim().toLowerCase() };';
function mock(entries = []) {
  const writes = []; const reads = []; const waits = [];
  const client = { md5, getText: async key => { reads.push(key); return key === 'lib/normTitle.js' ? NORM_UMD : JSON.stringify(sources[SOURCE_KEYS.indexOf(key)]); },
    listEntries: async prefix => { reads.push(prefix); return entries; },
    putText: async (key, body) => { writes.push(['put', key, body]); return { ok: true }; },
    del: async key => { writes.push(['delete', key]); return true; } };
  return { client, writes, reads, waits, sleep: async ms => waits.push(ms) };
}
test('변종 양방향 진입은 요청 id 외 같은 계약·원본 순서이며 미소비 필드는 제외', () => {
  const bundles = [...buildSongMeta(sources, { norm }).values()].map(JSON.parse);
  assert.equal(bundles.length, 2);
  const [{ songId: a, ...one }, { songId: b, ...two }] = bundles;
  assert.deepEqual(one, two); assert.deepEqual(one.songs.map(song => song.song_id), [1, 2]);
  assert.equal(one.ratingData.ratings[0].unused, undefined); assert.equal(one.seriesNames[1], undefined);
});
test('md5 동일 목록은 PUT 0', async () => {
  const entries = [...buildSongMeta(sources, { norm })].map(([key, body]) => ({ key, etag: `W/"${md5(body)}"` }));
  const m = mock(entries); const result = await publishSongMeta({ ...m, apply: true });
  assert.equal(result.puts, 0); assert.deepEqual(m.writes, []);
});
test('사라진 곡 DELETE, 타 prefix·비계약 키 보존', async () => {
  const m = mock([{ key: 'data/song-meta-9.json' }, { key: 'data/song-meta-not-ours.json' }]);
  const result = await publishSongMeta({ ...m, apply: true });
  assert.equal(result.deletes, 1); assert.deepEqual(m.writes[0], ['delete', 'data/song-meta-9.json']);
});
test('회당 상한은 PUT+DELETE 합계이며 다음 회차 나머지를 계속 게시', async () => {
  const m = mock(); const first = await publishSongMeta({ ...m, apply: true, maxWrites: 1 });
  assert.equal(m.writes.length, 1); assert.equal(first.remaining, 1);
  const [, key, body] = m.writes[0]; const next = mock([{ key, etag: md5(body) }]);
  const second = await publishSongMeta({ ...next, apply: true, maxWrites: 1 });
  assert.equal(second.written, 1); assert.equal(second.remaining, 0);
  assert.notEqual(next.writes[0][1], key);
});
test('기본 dry-run 쓰기 0, 모든 요청 사이 최소 250ms', async () => {
  const m = mock(); const result = await publishSongMeta(m);
  assert.equal(result.written, 0); assert.deepEqual(m.writes, []);
  assert.equal(m.waits.length, m.reads.length - 1); assert.ok(m.waits.every(ms => ms >= 250));
});
test('원본 조회·파싱·스키마·목록 실패는 apply에서도 쓰기 0', async () => {
  for (const key of SOURCE_KEYS) for (const failure of ['request', 'missing', 'parse', 'schema']) {
    const m = mock(); const original = m.client.getText;
    m.client.getText = async input => input !== key ? original(input) : failure === 'request' ? Promise.reject(new Error('원본 실패'))
      : failure === 'missing' ? null : failure === 'parse' ? '{' : '[]';
    await assert.rejects(publishSongMeta({ ...m, apply: true })); assert.deepEqual(m.writes, []);
  }
  const m = mock(); m.client.listEntries = async () => { throw new Error('목록 실패'); };
  await assert.rejects(publishSongMeta({ ...m, apply: true })); assert.deepEqual(m.writes, []);
});
test('쓰기 실패는 중단·실패로 보고하며 간격/상한 무효 입력도 거절', async () => {
  const m = mock(); m.client.putText = async () => ({ ok: false });
  await assert.rejects(publishSongMeta({ ...m, apply: true }), /PUT|put/);
  await assert.rejects(publishSongMeta({ ...mock(), intervalMs: 249 }));
  await assert.rejects(publishSongMeta({ ...mock(), maxWrites: 0 }));
});
test('실제 LIST의 페이지·429 재시도도 250ms 이상 감속한다', async () => {
  let clock = 0; const starts = []; const sleep = async ms => { clock += ms; };
  const fetchImpl = pacedFetch(async () => {
    starts.push(clock);
    if (starts.length === 1) return new Response('', { status: 429 });
    return new Response(JSON.stringify({ result: [], ...(starts.length === 2 ? { result_info: { cursor: 'next' } } : {}) }));
  }, { now: () => clock, sleep });
  await listEntries('data/song-meta-', { token: 'test', fetchImpl, sleep });
  assert.equal(starts.length, 3);
  assert.ok(starts.slice(1).every((time, i) => time - starts[i] >= 250));
});
test('워크플로는 30분 cron·dispatch·겹침 방지·쓰기 상한과 기본 수동 dry-run', () => {
  const workflow = readFileSync(new URL('../workflows/dump-song-meta.yml', import.meta.url), 'utf8');
  assert.match(workflow, /cron: '\*\/30 \* \* \* \*'/);
  assert.match(workflow, /workflow_dispatch:/); assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /default: false/); assert.match(workflow, /--max-writes=500/);
  assert.match(workflow, /github.event_name == 'schedule' \|\| inputs.apply/);
});

test('norm 없이 생성하면 던진다 — 손사본 폴백 금지', () => {
  assert.throws(() => buildSongMeta(sources), /norm 함수 필요/);
});
test('R2 lib/normTitle.js 를 받아 쓴다', async () => {
  const m = mock(); await publishSongMeta({ ...m });
  assert.ok(m.reads.includes('lib/normTitle.js'));
});
test('기존 묶음 대비 5% 초과 삭제는 쓰기 없이 중단', async () => {
  const stale = Array.from({ length: 40 }, (_, i) => ({ key: `data/song-meta-${1000 + i}.json`, etag: 'x' }));
  const m = mock(stale);
  await assert.rejects(publishSongMeta({ ...m, apply: true }), /초과/);
  assert.equal(m.writes.length, 0);
});

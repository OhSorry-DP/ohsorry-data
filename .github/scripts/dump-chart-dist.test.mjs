import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDist, distKey, noteCountFor, run, serializeDist } from './dump-chart-dist.mjs';
import { md5 } from './r2-client.mjs';

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

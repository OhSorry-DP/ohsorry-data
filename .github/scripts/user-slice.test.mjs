import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildUserSlice, publishUserSlice, writeUserSliceFile, USLICE_SHARDS } from './user-slice.mjs';
import { md5 } from './r2-client.mjs';

const data = () => ({ user: { iidx_id: 'A1', dj_name: 'DJ', date: '2026-10-02', r_star: 1.5, star: 2.25, sp_star: null, secret: '제외' },
  dp: [{ song_id: 1, played_version: 30, diff: 2 }, { song_id: 17, played_version: 33, diff: 3 }, { song_id: 16, played_version: -10 }],
  sp: [{ song_id: 1, played_version: 99 }] });
function fixture(overrides = {}) {
  const calls = [];
  return { calls, listEntries: async (prefix) => { calls.push(['list', prefix]); return []; },
    getText: async (key) => { calls.push(['get', key]); return null; },
    putText: async (key, body) => { calls.push(['put', key, body]); return { ok: true }; },
    del: async (key) => { calls.push(['del', key]); return true; }, log: { warn() {} }, ...overrides };
}
test('16 shard 분배·원본 행 보존·전체 DP 최대 버전', () => {
  const source = data(), before = JSON.stringify(source);
  const bundle = buildUserSlice('A1', source);
  assert.equal(USLICE_SHARDS, 16);
  assert.deepEqual(bundle.summary, { v: 1, id: 'A1', date: source.user.date, u: { dj_name: 'DJ', star: 2.25, r_star: 1.5, sp_star: null }, dpSeriesMax: 33,
    shards: { r: { dp: [0, 1], sp: [1] }, h: { dp: [], sp: [] } } });
  assert.deepEqual(JSON.parse(bundle.objects['uslice/A1-r-dp-01.json']).songs, { 1: [source.dp[0]], 17: [source.dp[1]] });
  assert.equal(JSON.stringify(source), before);
});
test('빈 shard 미생성·DP 0행은 최대 버전 null', () => {
  const b = buildUserSlice('A1', { ...data(), dp: [], sp: [] });
  assert.deepEqual(b.objects, {});
  assert.equal(b.summary.dpSeriesMax, null);
});
test('음수·소수·문자열 song_id는 쓰기 전에 거부', () => {
  for (const song_id of [-1, 1.1, '1', null]) assert.throws(() => buildUserSlice('A1', { ...data(), dp: [{ song_id }] }));
});
test('목록 1회·요약 마지막 PUT', async () => {
  const d = fixture(), b = { ok: true, ...buildUserSlice('A1', data()) };
  const r = await publishUserSlice('A1', b, d);
  assert.equal(r.rc, 0);
  assert.equal(r.puts, 4);
  assert.deepEqual(d.calls.filter(([op]) => op === 'list'), [['list', 'uslice/A1-']]);
  assert.equal(d.calls.at(-1)[1], 'uslice/A1.json');
});
test('md5 동일이면 shard·요약 PUT 0', async () => {
  const b = { ok: true, ...buildUserSlice('A1', data()) };
  const d = fixture({ listEntries: async () => Object.entries(b.objects).map(([key, body]) => ({ key, etag: `W/"${md5(body)}"` })),
    getText: async () => JSON.stringify(b.summary) });
  const r = await publishUserSlice('A1', b, d);
  assert.equal(r.puts, 0);
  assert.equal(r.skips, 4);
  assert.equal(r.rc, 0);
  assert.deepEqual(d.calls, []);
});
test('비게 된 shard DELETE·다른 키는 보존·요약은 마지막', async () => {
  const b = { ok: true, ...buildUserSlice('A1', { ...data(), dp: [], sp: [] }) };
  const d = fixture({ listEntries: async () => ['uslice/A1-r-dp-01.json', 'uslice/A1-h-sp-02.json', 'uslice/A12-r-dp-01.json', 'uslice/A1-other.json'].map((key) => ({ key })) });
  const r = await publishUserSlice('A1', b, d);
  assert.equal(r.deletes, 2);
  assert.deepEqual(d.calls.filter(([op]) => op === 'del').map(([, key]) => key), ['uslice/A1-r-dp-01.json', 'uslice/A1-h-sp-02.json']);
  // 요약 PUT 이 빈 shard 삭제보다 먼저다 — 옛 요약이 지워진 shard 를 가리키는 창을 없앤다.
  const order = d.calls.map(([op, key]) => op + ':' + key);
  assert.ok(order.indexOf('put:uslice/A1.json') < order.indexOf('del:uslice/A1-r-dp-01.json'));
});
test('DELETE 실패는 rc=1 (요약은 이미 새 매니페스트 — 남은 shard 는 매니페스트 밖이라 소비처가 읽지 않는다)', async () => {
  const d = fixture({ listEntries: async () => [{ key: 'uslice/A1-r-dp-02.json' }], del: async () => false });
  const r = await publishUserSlice('A1', { ok: true, ...buildUserSlice('A1', data()) }, d);
  assert.equal(r.ok, false);
  assert.equal(r.rc, 1);
});
test('PUT·목록·요약조회 실패는 rc=1·요약 PUT 금지', async () => {
  for (const overrides of [
    { putText: async () => ({ ok: false }) },
    { listEntries: async () => { throw new Error('목록 실패'); } },
    { getText: async () => { throw new Error('조회 실패'); } },
  ]) {
    const d = fixture(overrides);
    const r = await publishUserSlice('A1', { ok: true, ...buildUserSlice('A1', data()) }, d);
    assert.equal(r.ok, false);
    assert.equal(r.rc, 1);
    assert.equal(d.calls.some(([op, key]) => op === 'put' && key === 'uslice/A1.json'), false);
  }
});
test('계산 실패는 원본 바이트 유지·실패 기록·업로드 rc=1', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uslice-test-'));
  try {
    const userFile = path.join(dir, 'user.json'), histFile = path.join(dir, 'hist.json'), sliceFile = path.join(dir, 'slice.json');
    const userBytes = JSON.stringify(data()), histBytes = '[[1,2,3]]';
    fs.writeFileSync(userFile, userBytes); fs.writeFileSync(histFile, histBytes);
    const r = writeUserSliceFile('A1', data(), sliceFile, { build() { throw new Error('계산 실패'); }, log: { warn() {} } });
    assert.equal(r.rc, 1);
    assert.equal(fs.readFileSync(userFile, 'utf8'), userBytes);
    assert.equal(fs.readFileSync(histFile, 'utf8'), histBytes);
    const d = fixture();
    assert.equal((await publishUserSlice('A1', JSON.parse(fs.readFileSync(sliceFile, 'utf8')), d)).rc, 1);
    assert.deepEqual(d.calls, []);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test('워크플로는 slice 실패와 무관하게 user/hist PUT을 먼저 수행', () => {
  const workflow = fs.readFileSync(new URL('../workflows/dump-user.yml', import.meta.url), 'utf8');
  const sliceAt = workflow.indexOf('- name: uslice 증분');
  assert.ok(workflow.indexOf('put "user/$IIDX_ID.json"') < sliceAt);
  assert.ok(workflow.indexOf('put "hist/$IIDX_ID.json"') < sliceAt);
  const step = workflow.slice(sliceAt);
  assert.match(step, /continue-on-error: true/);
  assert.match(step, /!cancelled\(\) && steps.dump.outcome == 'success'/);
});

test('hist 모드·곡·shard 분리와 원본 열·순서·DBR 보존', () => {
  const hist = [[1, 3, 5, 100, 33, '날짜', 'KST', 0, null, 50],
    [1, 3, 5, 200, 33, '날짜', 'KST', 1], [17, 3, 5, 300, -10, '날짜', 'KST', 1],
    [1, 3, 5, 201, 33, '날짜2', 'KST2', 1]];
  const before = JSON.stringify(hist);
  const b = buildUserSlice('A1', data(), hist);
  assert.deepEqual(b.summary.shards.h, { dp: [1], sp: [1] });
  assert.deepEqual(JSON.parse(b.objects['uslice/A1-h-sp-01.json']).songs, { 1: [hist[0]] });
  assert.deepEqual(JSON.parse(b.objects['uslice/A1-h-dp-01.json']).songs, { 1: [hist[1], hist[3]], 17: [hist[2]] });
  assert.equal(before, JSON.stringify(hist));
});
test('hist 모드 전부 없으면 경고·DP만, 일부 없거나 잘못된 모드면 실패', () => {
  const b = buildUserSlice('A1', data(), [[1, 3, 5, 200, 33, '날짜', 'KST']]);
  assert.deepEqual(b.summary.shards.h, { dp: [1], sp: [] });
  assert.equal(b.warnings.length, 1);
  assert.throws(() => buildUserSlice('A1', data(), [[1], [1, 3, 5, 200, 33, '날짜', 'KST', 0]]));
  assert.throws(() => buildUserSlice('A1', data(), [[1, 3, 5, 200, 33, '날짜', 'KST', 2]]));
});
test('hist 필드 위치는 dump-user 정본과 일치한다', () => {
  const source = fs.readFileSync(new URL('./dump-user.mjs', import.meta.url), 'utf8');
  const cols = JSON.parse(source.match(/export const HIST_COLS = (\[[^;]+\]);/)[1].replace(/'/g, '"'));
  assert.equal(cols[0], 'song_id'); assert.equal(cols[7], 'play_style');
});
test('첫 생성 최대 64 shard PUT·요약 1 PUT', async () => {
  const source = data();
  source.dp = source.sp = Array.from({ length: 16 }, (_, song_id) => ({ song_id, played_version: 33 }));
  const hist = source.dp.flatMap(({ song_id }) => [0, 1].map((style) => [song_id, 3, 5, 200, 33, '날짜', 'KST', style]));
  const b = { ok: true, ...buildUserSlice('A1', source, hist) }, d = fixture();
  assert.equal(Object.keys(b.objects).length, 64);
  const r = await publishUserSlice('A1', b, d);
  assert.equal(r.puts, 65); assert.equal(r.rc, 0);
  assert.equal(d.calls.at(-1)[1], 'uslice/A1.json');
});

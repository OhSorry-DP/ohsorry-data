import assert from 'node:assert/strict';
import test from 'node:test';
import { producePhysUser, sha256 } from '../phys-lib.mjs';

const versions = { model_version: 'm1', q_version: 'q1', time_axis_version: 't1' };
const chart = (songId, diff, extra = {}) => ({ chartKey: `${songId}|${diff}`, songId, diff, notes: 100, duration: 10,
  features: { STAIR_UP: { maxQ: 2 }, CN: { maxQ: 0 } }, arrange_assumed: 'unknown', content_hash: sha256({ songId, diff }), ...extra });
const baseDump = () => ({ dp: [
  { song_id: 11, diff: 3, lamp: 5 }, { song_id: 12, diff: 3, lamp: '6' },
  { song_id: 13, diff: 3, lamp: 4 }, { song_id: 11, diff: 3, lamp: 6 },
  { song_id: 14, diff: 3, lamp: 7 }, { song_id: 11, diff: 3, lamp: 3 },
], sp: [{ song_id: 11, diff: 3, lamp: 7 }], songMap: { 11: 'tx-a', 12: 'tx-b', 13: 'tx-c', 14: 'tx-d' },
chart_arrange: [{ song_id: 11, diff: 3, play_style: 1, arrange: 'MIRROR' },
  { song_id: 11, diff: 3, play_style: 0, arrange: 'RANDOM' }] });
const manifest = { publishable: true };
const assetLoader = async () => ({ status: 'ready', model: { content_hash: 'a'.repeat(64) },
  charts: new Map([chart('tx-a', 'ANOTHER'), chart('tx-b', 'ANOTHER'), chart('tx-c', 'ANOTHER'), chart('tx-d', 'ANOTHER')].map((c) => [c.chartKey, c])) });
const ioOf = (initial = null) => {
  const state = { value: initial, reads: 0, writes: [], failRead: false, failPut: null };
  return { state,
    async read() { state.reads++; if (state.failRead) throw new Error('read fail'); return state.value; },
    async put(key, body, etag) {
      state.writes.push({ key, body, etag });
      if (state.failPut) throw state.failPut;
      state.value = { body, etag: 'etag-next' };
    } };
};

test('정확한 곡 매핑·diff·DP만 join하고 숫자 lamp와 배치 provenance를 적용', async () => {
  const io = ioOf(), fitted = [];
  const result = await producePhysUser({ id: 'USER', dump: baseDump(), versions, manifest, io, loadAssets: assetLoader,
    fitUser: async (input, options) => { fitted.push({ input, options }); return { status: 'ready', purpose: 'clear' }; } });
  assert.equal(result.status, 'ready');
  assert.equal(fitted.length, 1);
  const rows = fitted[0].input.rows;
  assert.deepEqual(rows.map((r) => r.chartKey), ['tx-a|ANOTHER', 'tx-c|ANOTHER', 'tx-d|ANOTHER']);
  assert.equal(rows[0].lampNum, 6);
  assert.equal(rows[0].arrange, 'MIRROR');
  assert.equal(rows[1].arrange_assumed, 'unknown');
  assert.equal(result.counts.song_mapping_missing, 0);
  assert.equal(result.counts.invalid_lamp, 1);
  assert.equal(fitted[0].options.concurrency, 1);
});

test('버전 미지정 또는 자산 비게시 상태는 I/O·fit 없이 skip', async () => {
  const io = ioOf(); let calls = 0;
  for (const args of [
    { versions: { ...versions, q_version: null }, manifest },
    { versions, manifest: { publishable: false } },
  ]) {
    const result = await producePhysUser({ id: 'USER', dump: baseDump(), io, fitUser: async () => { calls++; }, ...args });
    assert.equal(result.status, 'skipped');
  }
  assert.equal(io.state.reads, 0);
  assert.equal(io.state.writes.length, 0);
  assert.equal(calls, 0);
});

test('Textage ID가 다른 정규화 곡명 자산을 명시적 별칭으로 조인하고 모호한 별칭은 제외한다', async () => {
  const assets = await assetLoader();
  const renamed = chart('normalized-title', 'ANOTHER', { textage_song_id: 'tx-a' });
  assets.charts.delete('tx-a|ANOTHER'); assets.charts.set(renamed.chartKey, renamed);
  let rows;
  const run = () => producePhysUser({ id:'USER', dump:baseDump(), versions, manifest, assets, io:ioOf(),
    fitUser:async input => { rows=input.rows; return {status:'ready'}; } });
  await run();
  assert.equal(rows.find(r=>r.songId==='normalized-title').lampNum, 6);
  assert.equal(rows.find(r=>r.songId==='normalized-title').features.STAIR_UP.maxQ, 2);
  const collision = chart('other-title', 'ANOTHER', { textage_song_id:'tx-a' });
  assets.charts.set(collision.chartKey,collision);
  await run();
  assert.equal(rows.some(r=>['normalized-title','other-title'].includes(r.songId)),false);
});

test('주입한 검증 자산으로 생산할 때 로더를 다시 호출하지 않는다', async () => {
  const assets = await assetLoader(), io = ioOf(); let fits = 0;
  const result = await producePhysUser({ id: 'USER', dump: baseDump(), versions, manifest, io, assets,
    loadAssets: async () => { throw new Error('unexpected asset load'); },
    fitUser: async input => { fits++; assert.equal(input.model, assets.model); return { status: 'ready' }; },
  });
  assert.equal(result.status, 'ready'); assert.equal(fits, 1);
  assert.equal(io.state.reads, 1); assert.equal(io.state.writes.length, 1);
});

test('동일 revision은 no-op, 배치 변경은 revision을 바꿔 한 번 fit한다', async () => {
  const io = ioOf(), fitted = [];
  const fitUser = async (input) => { fitted.push(input); return { status: 'ready' }; };
  const first = await producePhysUser({ id: 'USER', dump: baseDump(), versions, manifest, io, loadAssets: assetLoader, fitUser });
  const saved = JSON.parse(io.state.value.body);
  saved.absolute.source_revision = first.source_revision;
  Object.assign(saved.absolute, versions);
  io.state.value = { body: JSON.stringify(saved), etag: 'etag-next' };
  const same = await producePhysUser({ id: 'USER', dump: baseDump(), versions, manifest, io, loadAssets: assetLoader, fitUser });
  assert.equal(same.changed, false);
  assert.equal(fitted.length, 1);
  const changed = baseDump();
  changed.chart_arrange[0].arrange = 'RANDOM';
  await producePhysUser({ id: 'USER', dump: changed, versions, manifest, io, loadAssets: assetLoader, fitUser });
  assert.equal(fitted.length, 2);
  assert.notEqual(fitted[0].source_revision, fitted[1].source_revision);
});

test('fit 1회 결과는 clear-only 공통 envelope로 조건부 저장', async () => {
  const io = ioOf(); let calls = 0;
  const result = await producePhysUser({ id: 'USER', dump: baseDump(), versions, manifest, io, loadAssets: assetLoader,
    fitUser: async (input) => { calls++; assert.equal(input.rows.every((r) => !Object.hasOwn(r, 'scoreRate')), true);
      return { status: 'ready', purpose: 'clear', source_revision: input.source_revision, generated_at: input.generated_at, axes: {} }; } });
  assert.equal(calls, 1);
  assert.equal(result.status, 'ready');
  assert.equal(io.state.writes[0].etag, null);
  const saved = JSON.parse(io.state.writes[0].body);
  assert.deepEqual(Object.keys(saved), ['schema_version', 'iidx_id', 'play_style', 'absolute']);
  assert.equal(saved.schema_version, 'coach-skill-evidence/1');
  assert.equal(saved.absolute.purpose, 'clear');
});

test('생성 실패는 이전 ready를 stale로 보존하고 최초 실패는 missing 반환', async () => {
  const previous = { schema_version: 'coach-skill-evidence/1', iidx_id: 'USER', play_style: 'DP',
    absolute: { status: 'ready', purpose: 'clear', ...versions, source_revision: 'old', generated_at: '2026-01-01T00:00:00Z', stale: false, axes: { CN: { lower: 3 } } } };
  const io = ioOf({ body: JSON.stringify(previous), etag: 'etag-old' });
  const old = JSON.parse(JSON.stringify(previous));
  const stale = await producePhysUser({ id: 'USER', dump: baseDump(), versions, manifest, io, loadAssets: async () => { throw new Error('fixture fail'); } });
  const written = JSON.parse(io.state.writes[0].body);
  assert.equal(stale.status, 'stale');
  assert.deepEqual(written.absolute.axes, old.absolute.axes);
  assert.equal(written.absolute.generated_at, old.absolute.generated_at);
  assert.equal(written.absolute.model_version, old.absolute.model_version);
  assert.equal(written.absolute.reason, 'generation_failed');
  const freshIo = ioOf();
  const missing = await producePhysUser({ id: 'USER', dump: baseDump(), versions, manifest, io: freshIo, loadAssets: async () => { throw new Error('fixture fail'); } });
  assert.equal(missing.status, 'missing');
  assert.equal(JSON.parse(freshIo.state.value.body).absolute.reason, 'not_generated');
});

test('412 conflict 및 이전 GET 실패는 기록을 덮지 않음', async () => {
  const conflictIo = ioOf(); conflictIo.state.failPut = Object.assign(new Error('HTTP 412'), { status: 412 });
  const conflict = await producePhysUser({ id: 'USER', dump: baseDump(), versions, manifest, io: conflictIo,
    loadAssets: async () => { throw new Error('force stale'); } });
  assert.equal(conflict.status, 'conflict');
  const failedIo = ioOf(); failedIo.state.failRead = true;
  const failed = await producePhysUser({ id: 'USER', dump: baseDump(), versions, manifest, io: failedIo,
    loadAssets: assetLoader, fitUser: async () => ({}) });
  assert.equal(failed.reason, 'previous_read_failed');
  assert.equal(failedIo.state.writes.length, 0);
});

test('생성 원 예외는 dry-run과 최초 missing 및 stale 경로에서 200자로 보존한다', async () => {
  const message = 'model: ' + 'x'.repeat(250);
  for (const dryRun of [true, false]) {
    const io = ioOf();
    const result = await producePhysUser({ id: 'USER', dump: baseDump(), versions, manifest, io, dryRun,
      loadAssets: async () => { throw new Error(message); } });
    assert.equal(result.error_message, message.slice(0, 200));
    assert.equal(io.state.writes.length, dryRun ? 0 : 1);
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { producePhysUser, sha256 } from '../phys-lib.mjs';

const vendor = (await import('../vendor/physLine.js')).default;
const versions = vendor.CONFIG_SP;
const axes = vendor.AXES_SP;
const featureSet = (meanNps = 2) => Object.fromEntries(axes.map(axis => [axis, { meanNps, duration: 5, notes: 10 }]));
const chart = (songId, extra = {}) => ({ chartKey: `${songId}|ANOTHER`, songId, diff: 'ANOTHER', textage_song_id: songId,
  arrange: 'OFF', notes: 20, duration: 10, features: featureSet(), content_hash: sha256(songId), ...extra });
const manifest = { publishable: true };
const fixtureAssets = () => ({ status: 'ready', model: { content_hash: 'a'.repeat(64), line_config: { ...versions, content_hash: 'b'.repeat(64) } },
  charts: new Map([chart('tx-a'), chart('tx-b')].map(row => [row.chartKey, row])) });
const dump = () => ({ sp: [{ song_id: 11, diff: 3, lamp: 7 }, { song_id: 12, diff: 3, lamp: 5 }],
  dp: [{ song_id: 11, diff: 3, lamp: 7 }], songMap: { 11: 'tx-a', 12: 'tx-b' },
  chart_arrange: [{ song_id: 11, diff: 3, play_style: 1, arrange: 'RANDOM' }] });
const ioOf = initial => { const state = { value: initial ?? null, reads: [], writes: [], failPut: null };
  return { state, async read(key) { state.reads.push(key); return state.value?.[key] ?? null; }, async put(key, body, etag) {
    state.writes.push({ key, body, etag }); if (state.failPut) throw state.failPut;
    state.value ||= {}; state.value[key] = { body, etag: 'next' };
  } };
};
const run = (io, extra = {}) => producePhysUser({ id: 'U 1', dump: dump(), versions, manifest, io, assets: fixtureAssets(), playStyle: 'SP', ...extra });

test('sp-phys-producer/1 — sp-join=정확identity', async () => {
  const io = ioOf(); let seen;
  const result = await run(io, { computePhysLine: input => { seen = input; return vendor.computePhysLine(input); } });
  assert.equal(result.status, 'ready');
  assert.deepEqual(seen.rows.map(row => row.chartKey), ['tx-a|ANOTHER', 'tx-b|ANOTHER']);
  assert.ok(seen.rows.every(row => row.arrange === 'OFF' && row.arrange_assumed === 'OFF' && row.arrangeAssumed === true));
  assert.equal(io.state.writes[0].key, 'phys/user-sp/U%201.json');
});

test('sp-phys-producer/2 — maxima=직접계산과동일', async () => {
  const io = ioOf(); let inputRows;
  await run(io, { computePhysLine: input => { inputRows = input.rows; return vendor.computePhysLine(input); } });
  const direct = vendor.computePhysLine({ rows: inputRows, config: vendor.CONFIG_SP });
  const saved = JSON.parse(io.state.writes[0].body).absolute;
  for (const axis of axes) {
    assert.equal(saved.axes[axis].line, direct.axes[axis].line);
    assert.deepEqual(saved.axes[axis].max_by_lamp, direct.axes[axis].max_by_lamp);
    assert.equal(saved.axes[axis].unit, 'notes/s/side');
  }
  assert.equal(saved.axes.NOTES.max_by_lamp.fc.chartKey, 'tx-a|ANOTHER');
  assert.equal(saved.unit, 'notes/s/side');
});

test('sp-phys-producer/3 — isolation=DP유저GET/PUT0', async () => {
  const io = ioOf(); await run(io);
  assert.deepEqual(io.state.reads, ['phys/user-sp/U%201.json']);
  assert.ok(io.state.writes.every(write => write.key.startsWith('phys/user-sp/')));
});

test('sp-phys-producer/4 — idempotent=PUT0', async () => {
  const io = ioOf(); const first = await run(io);
  const stored = io.state.value['phys/user-sp/U%201.json'];
  const record = JSON.parse(stored.body); record.absolute.source_revision = first.source_revision;
  io.state.value['phys/user-sp/U%201.json'] = { body: JSON.stringify(record), etag: 'saved' };
  const second = await run(io);
  assert.equal(second.changed, false); assert.equal(io.state.writes.length, 1);
});

test('sp-phys-producer/5 — failure-cas=stale/412', async () => {
  const io = ioOf(); const ready = await run(io); const key = 'phys/user-sp/U%201.json';
  const saved = io.state.value[key]; const record = JSON.parse(saved.body); record.absolute.source_revision = ready.source_revision;
  io.state.value[key] = { body: JSON.stringify(record), etag: 'old' };
  const failed = await producePhysUser({ id: 'U 1', dump: dump(), versions, manifest, io, playStyle: 'SP', assets: async () => { throw Error('fixture'); } });
  assert.equal(failed.status, 'stale'); assert.equal(JSON.parse(io.state.writes.at(-1).body).absolute.status, 'stale');
  const conflict = ioOf(); conflict.state.failPut = Object.assign(Error('HTTP 412'), { status: 412 });
  const result = await producePhysUser({ id: 'U 1', dump: dump(), versions, manifest, io: conflict, playStyle: 'SP', assets: async () => { throw Error('fixture'); } });
  assert.equal(result.status, 'conflict');
});

test('sp-phys-producer/6 — dp-envelope=JSON/hash동일', async () => {
  const io = ioOf(); await producePhysUser({ id: 'U 1', dump: dump(), versions: { ...versions, model_version: 'phys-line-v2' }, manifest, io, playStyle: 'SP' });
  assert.equal(io.state.reads.length, 0); assert.equal(io.state.writes.length, 0);
  const dpIo = ioOf();
  const dpVersions = { model_version: 'phys-line-v1', line_version: 'phys-line-v1', mean_version: 'mean-feature-span-v1', q_version: 'q-samehand-2s-v1', time_axis_version: 'ta-20261004' };
  const dpChart = { chartKey: 'tx-a|ANOTHER', songId: 'tx-a', diff: 'ANOTHER', notes: 20, duration: 10,
    features: { STAIR_UP: { maxQ: 2 } }, content_hash: 'tx-a' };
  const dpAssets = { status: 'ready', model: { content_hash: 'c'.repeat(64), line_config: { model_version: 'phys-line-v1', line_version: 'phys-line-v1', mean_version: 'mean-feature-span-v1', content_hash: 'd'.repeat(64) } },
    charts: new Map([['tx-a|ANOTHER', dpChart]]) };
  await producePhysUser({ id: 'U 1', dump: dump(), versions: dpVersions, manifest, io: dpIo, assets: dpAssets, computePhysLine: () => ({ model_version: 'phys-line-v1', line_version: 'phys-line-v1', mean_version: 'mean-feature-span-v1', axes: {} }) });
  const written = JSON.parse(dpIo.state.writes[0].body);
  assert.equal(written.play_style, 'DP'); assert.deepEqual(Object.keys(written), ['schema_version', 'iidx_id', 'play_style', 'absolute']);
  assert.match(written.absolute.source_revision, /^[a-f0-9]{64}$/);
});

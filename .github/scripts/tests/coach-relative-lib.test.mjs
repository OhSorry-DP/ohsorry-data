import assert from 'node:assert/strict';
import test from 'node:test';
import { produceRelativeUser } from '../coach-relative-lib.mjs';
import { stableJson, sha256 } from '../dump-coach-relative.mjs';
import { buildPopulation } from '../coach-relative.mjs';

const registry = [{ key: 'osPattern:TEST', valueUnit: 'feature_score', higherIsBetter: true }];
const featureVersion = 'feature-1';
const makeUser = (iidxId, value) => ({ iidxId, featureVersion, sourceRevision: `source-${iidxId}`,
  star: 12, features: { 'osPattern:TEST': { value, recordCount: 40 } } });
const users = Array.from({ length: 30 }, (_, i) => makeUser(`U${String(i).padStart(2, '0')}`, i));
const population = buildPopulation({ users, registry, featureVersion,
  populationVersion: 'pop-1', generatedAt: '2026-10-05T00:00:00Z' });
const populationRecord = { schema_version: 'coach-relative-population/1', rank_version: 'coach-relative/1',
  feature_version: featureVersion, population_version: 'pop-1', registry: registry.map(item => ({ ...item, key: `dp/${item.key}` })),
  membership_hash: sha256(users.map(u => u.iidxId)),
  source_hash: sha256({ membership: users.map(u => u.iidxId), source_revisions: users.map(u => [u.iidxId, u.sourceRevision]),
    feature_version: featureVersion, registry: registry.map(item => ({ ...item, key: `dp/${item.key}` })) }), membership: users.map(u => u.iidxId),
  source_revisions: users.map(u => [u.iidxId, u.sourceRevision]), calculation: population };
const manifestFor = (version = 'pop-1', feature = featureVersion) => ({ schema_version: 'coach-relative-manifest/1',
  rank_version: 'coach-relative/1', feature_version: feature, population_version: version,
  population_key: `coach/relative/population/${version}.json` });
const dumpFor = id => ({ user: { iidx_id: id, star: 12 }, dp: [], osPattern: [{ play_style: 1, TEST: 30 }] });
const assets = { featureVersion, hashes: {}, codeHashes: {}, kernel: { countPatternScoreRecords: () => ({}) },
  featureFile: { scores: {} }, metaFile: { songs: {} } };
test('슬림 덤프의 곡 매핑 조회 실패는 이전 결과를 보존하고 쓰지 않는다', async () => {
  const { io, state } = fixture();
  const dump = { ...dumpFor('TARGET'), dp: [{ song_id: 1, diff: 3, ex_score: 100 }] };
  const output = await produceRelativeUser({ id: 'TARGET', dump, io, assets, generatedAt: 't', dryRun: true });
  assert.equal(output.reason, 'songs_read_failed');
  assert.ok(state.reads.includes('songs.json'));
  assert.deepEqual(state.puts, []);
});
function fixture({ manifest = manifestFor(), old = null, race = null } = {}) {
  const objects = new Map([
    ['coach/relative/current.json', { body: JSON.stringify(manifest), etag: 'manifest-etag' }],
    ['coach/relative/population/pop-1.json', { body: JSON.stringify(populationRecord), etag: 'population-etag' }],
  ]);
  if (old) objects.set('coach/relative/user/TARGET.json', { body: JSON.stringify(old), etag: 'old-etag' });
  const state = { objects, puts: [], reads: [], race, raceReads: 0, failRead: null, failPut: null };
  const io = {
    async read(key) {
      state.reads.push(key);
      if (state.failRead === key) throw new Error('fixture GET error');
      if (key === 'coach/relative/current.json' && state.race && ++state.raceReads === state.race.at) {
        state.objects.set(key, { body: JSON.stringify(state.race.manifest), etag: `manifest-${state.raceReads}` });
      }
      return state.objects.get(key) || null;
    },
    async put(key, body, etag) {
      state.puts.push({ key, body, etag });
      if (state.failPut) throw state.failPut;
      const current = state.objects.get(key);
      if ((current?.etag ?? null) !== etag) throw Object.assign(new Error('HTTP 412'), { status: 412 });
      state.objects.set(key, { body, etag: `etag-${state.puts.length}` });
    },
  };
  return { io, state };
}
const produce = (io, id = 'TARGET', extra = {}) => produceRelativeUser({ id, dump: dumpFor(id), io, assets,
  generatedAt: '2026-10-05T01:00:00Z', ...extra });

test('신규 대상 ID는 frozen 모집단 분모 30에 추가되지 않음', async () => {
  const { io, state } = fixture();
  const result = await produce(io);
  assert.equal(result.value.relative.features['osPattern:TEST'].overall.n, 30);
  assert.equal(result.value.relative.features['osPattern:TEST'].overall.reason, 'unknown_record_count');
  assert.equal(state.puts.length, 1);
});

test('동일 source tuple은 no-op이고 population 변경은 재투영', async () => {
  const first = fixture();
  const initial = await produce(first.io);
  first.state.objects.set('coach/relative/user/TARGET.json', { body: JSON.stringify(initial.value), etag: 'saved' });
  const same = await produce(first.io);
  assert.equal(same.changed, false);
  assert.equal(first.state.puts.length, 1);
  const changedManifest = manifestFor('pop-2');
  const population2 = { ...populationRecord, population_version: 'pop-2', calculation: { ...population, population_version: 'pop-2' } };
  first.state.objects.set('coach/relative/current.json', { body: JSON.stringify(changedManifest), etag: 'manifest-2' });
  first.state.objects.set('coach/relative/population/pop-2.json', { body: JSON.stringify(population2), etag: 'population-2' });
  const changed = await produce(first.io);
  assert.equal(changed.changed, true);
  assert.equal(changed.value.relative.population_version, 'pop-2');
  assert.equal(first.state.puts.length, 2);
});

test('manifest 1회 경합은 새 모집단으로 재시도하고 총 3회 경합은 소진', async () => {
  const once = fixture({ race: { at: 2, manifest: { ...manifestFor(), generated_at: 'raced' } } });
  const retried = await produce(once.io);
  assert.equal(retried.status, 'ready');
  assert.equal(retried.attempts, 2);
  const always = fixture({ race: { at: 2, manifest: { ...manifestFor(), generated_at: 'raced' } } });
  const realRead = always.io.read;
  always.io.read = async key => {
    const value = await realRead(key);
    if (key === 'coach/relative/current.json' && always.state.raceReads >= 2) {
      const current = always.state.objects.get(key);
      const next = { ...JSON.parse(current.body), generated_at: `race-${always.state.raceReads}` };
      always.state.objects.set(key, { ...current, body: JSON.stringify(next) });
    }
    return value;
  };
  const exhausted = await produce(always.io);
  assert.equal(exhausted.reason, 'manifest_race_exhausted');
  assert.equal(exhausted.attempts, 3);
  assert.equal(always.state.puts.length, 0);
});

test('feature mismatch는 상대 결과를 쓰지 않음', async () => {
  const { io, state } = fixture({ manifest: manifestFor('pop-1', 'other-feature') });
  const result = await produce(io);
  assert.equal(result.reason, 'feature_mismatch');
  assert.equal(state.puts.length, 0);
});

test('생성 실패는 이전 ready를 stale로 보존하고 최초 유저는 missing', async () => {
  const { io, state } = fixture();
  const old = { schema_version: 'coach-skill-evidence/1', iidx_id: 'TARGET', play_style: 'DP',
    relative: { status: 'ready', generated_at: 'old-time', population_version: 'old-pop', features: { keep: true } } };
  state.objects.set('coach/relative/population/pop-1.json', { body: '{broken', etag: 'bad' });
  state.objects.set('coach/relative/user/TARGET.json', { body: JSON.stringify(old), etag: 'old' });
  const stale = await produce(io);
  assert.equal(stale.status, 'stale');
  assert.equal(stale.value.relative.generated_at, 'old-time');
  assert.equal(stale.value.relative.population_version, 'old-pop');
  assert.equal(stale.value.relative.stale, true);
  assert.equal(state.puts.length, 0);
  state.objects.delete('coach/relative/user/TARGET.json');
  const missing = await produce(io);
  assert.equal(missing.status, 'missing');
});

test('상대PUT 412와 GET 오류는 쓰기 금지', async () => {
  const conflict = fixture();
  conflict.state.failPut = Object.assign(new Error('HTTP 412'), { status: 412 });
  const conflicted = await produce(conflict.io);
  assert.equal(conflicted.status, 'conflict');
  const failed = fixture();
  failed.state.failRead = 'coach/relative/current.json';
  const error = await produce(failed.io);
  assert.equal(error.reason, 'previous_read_failed');
  assert.equal(failed.state.puts.length, 0);
});

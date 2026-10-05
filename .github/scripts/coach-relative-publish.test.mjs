import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateUser, publishSnapshot, selectDpRegistry, stripDpPrefix } from './dump-coach-relative.mjs';
import { buildRelativeRegistry } from './coach-relative-input.mjs';

for (const legacy of [false, true]) {
  test(`실제 덤프 행 모양을 입력부터 게시까지 보존한다 (${legacy ? '이전 접두 체크포인트' : '정규화 입력'})`, async () => {
    const assets = { featureFile: { scores: { song: { DP_NOR: { NOTES: 100 } } } },
      metaFile: { songs: { song: { notes: { DN: 100 } } } } };
    const sourceRegistry = selectDpRegistry(buildRelativeRegistry());
    // 실제 덤프의 방식별 집계 행·null 축·유효 DP 성적 구조를 축소해 고정한다.
    const dump = { user: { iidx_id: 'C200074777849', star: 5.78 },
      osPattern: [{ play_style: 0, notes: 712.51 }, { play_style: 1, notes: 879.396, chord: null }],
      radars: [{ play_style: 0, notes: 99 }, { play_style: 1, notes: 120, soft: 0 }],
      dp: Array.from({ length: 30 }, (_, song_id) => ({ song_id, diff: 1, ex_score: 100, textage_song_id: 'song' })) };
    const user = calculateUser(dump, sourceRegistry, { featureVersion: 'v', sourceRevision: 's' }, assets,
      { countPatternScoreRecords: entries => ({ NOTES: entries.length }) });
    const users = Array.from({ length: 30 }, (_, i) => ({ ...user, iidxId: String(i).padStart(8, '0') }));
    const registry = legacy ? sourceRegistry : stripDpPrefix({ registry: sourceRegistry }).registry;
    const objects = new Map();
    // 외부 저장소 없이 조건부 게시 계약과 최종 본문을 확인한다.
    const r2 = { async read(key) { return objects.get(key) || null; },
      async put(key, body, etag) {
        assert.equal(etag, objects.get(key)?.etag ?? null);
        objects.set(key, { body, etag: String(objects.size) });
      } };
    await publishSnapshot({ users, registry, featureVersion: 'v', generatedAt: '2026-10-05T00:00:00Z',
      completePopulation: true, totalMembers: users.length }, { r2, logger: { log() {} } });
    const relative = JSON.parse(objects.get('coach/relative/user/00000000.json').body).relative;
    const feature = relative.features['osPattern:NOTES'];
    assert.equal(feature.value, 879.396);
    assert.equal(feature.record_count, 30);
    assert.equal(feature.overall.percentile, 50);
    assert.equal(feature.same_star.percentile, 50);
    assert.equal(relative.features['radar:soflan'].value, 0);
    assert.equal(relative.features['radar:soflan'].overall.percentile, 50);
    assert.equal(relative.features['osPattern:CHORD'].overall.reason, 'missing_value');
    assert.ok(Object.keys(relative.features).every(key => !key.startsWith('dp/')));
    const manifest = JSON.parse(objects.get('coach/relative/current.json').body);
    const population = JSON.parse(objects.get(manifest.population_key).body);
    assert.deepEqual(population.registry, stripDpPrefix({ registry: sourceRegistry }).registry.sort((a, b) => a.key.localeCompare(b.key)));
    assert.equal(population.calculation.features['osPattern:NOTES'].values.length, 30);
  });
}

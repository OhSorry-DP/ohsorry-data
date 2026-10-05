import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRelativeRegistry, adaptRelativeInput, patternRecordSources, radarRecordSources } from './coach-relative-input.mjs';
import { buildPopulation, projectRelative } from './coach-relative.mjs';

const registry = buildRelativeRegistry({ featureMeta: { feats: [{ name: 'NOTES', nzCount: 1000 }, { name: 'KEIMA_L' }], maxScoreByFeat: { HSTAIR_SYM: 100 } } });
const input = (dump, options = {}) => adaptRelativeInput({ dump, registry, featureVersion: 'fixture/1', sourceRevision: 'revision/1', ...options });
const dump = () => ({ user: { iidx_id: '00000001', star: 6.4, r_star: 20, native_star: 30 },
  osPattern: [{ play_style: 0, notes: 99 }, { play_style: 1, notes: 12.5, soflan: 0, keima_l: 42 }],
  radars: [{ play_style: 0, notes: 88 }, { play_style: 1, notes: 31, soft: 27 }],
  persona: { report: 'NOTES 약함 -2.4σ', nCharts: 400, feats: { NOTES: -5 } },
  dp: Array.from({ length: 40 }, () => ({ song_id: 1, diff: 3 })) });

test('기본·canonical 축, 단위·방향 및 DP/SP 원천 값을 보존한다', () => {
  const user = input(dump());
  assert.equal(registry.length, 86);
  assert.equal(registry.some(item => item.key.includes('/weakness:')), false);
  assert.equal(registry.find(item => item.key === 'dp/osPattern:HSTAIR_SYM'), undefined);
  assert.ok(registry.some(item => item.key === 'dp/osPattern:HANDS'));
  assert.equal(user.star, 6.4);
  for (const [key, value] of Object.entries({ 'dp/osPattern:NOTES': 12.5, 'sp/osPattern:NOTES': 99,
    'dp/osPattern:SOF-LAN': 0, 'dp/osPattern:KEIMA_L': 42, 'dp/radar:soflan': 27, 'sp/radar:notes': 88 })) {
    assert.deepEqual(user.features[key], { value, recordCount: null });
  }
});

test('원천 결손·비유한 값·문자열·보고문을 null로 보존하고 입력을 바꾸지 않는다', () => {
  const source = dump(); source.osPattern[1].peak = Infinity; source.osPattern[1].charge = '45';
  const before = structuredClone(source);
  const user = input(source);
  for (const key of ['dp/osPattern:PEAK', 'dp/osPattern:CHARGE']) {
    assert.deepEqual(user.features[key], { value: null, recordCount: null });
  }
  assert.deepEqual(source, before);
});

test('축별 유효 채보 목록만 세고 동일 채보의 버전·날짜 중복을 제거한다', () => {
  const key = 'dp/osPattern:NOTES';
  const user = input(dump(), { axisSources: { [key]: { recordCount: 300, records: [
    { song_id: 1, diff: 3, played_version: 0 }, { song_id: '1', diff: 3, played_version: 33 },
    { song_id: 1, diff: 2 }, { song_id: 2, diff: 3 },
  ] }, 'sp/osPattern:NOTES': { records: [] } } });
  assert.equal(user.features[key].recordCount, 3);
  assert.equal(user.features['sp/osPattern:NOTES'].recordCount, 0);
  assert.equal(user.features['dp/radar:notes'].recordCount, null);
  assert.equal(input(dump(), { axisSources: { [key]: { records: [{}] } } }).features[key].recordCount, null);
});

test('명시된 생산자 σ와 약점 방향만 사용하며 재계산하지 않는다', () => {
  const weakRegistry = buildRelativeRegistry({ weaknessAxes: [{ key: 'NOTES', higherIsBetter: false }] });
  const user = input(dump(), { registry: weakRegistry,
    axisSources: { 'dp/weakness:NOTES': { sigma: -1.75, recordCount: 31 } } });
  assert.deepEqual(user.features['dp/weakness:NOTES'], { value: -1.75, recordCount: 31 });
  assert.equal(weakRegistry.find(item => item.key === 'dp/weakness:NOTES').higherIsBetter, false);
});

test('구형 DP만 있는 행을 SP에 섞지 않고 충돌·잘못된 메타를 거부한다', () => {
  const source = dump(); source.osPattern = [{ notes: 10 }]; source.user.star = NaN;
  const user = input(source);
  assert.equal(user.features['dp/osPattern:NOTES'].value, 10);
  assert.equal(user.features['sp/osPattern:NOTES'].value, null);
  assert.equal(user.star, null);
  source.osPattern = [{ play_style: 1, notes: 1 }, { play_style: 1, notes: 2 }];
  assert.throws(() => input(source), /충돌/);
  assert.throws(() => input(dump(), { sourceRevision: '' }), /버전/);
});

test('R01 모집단·투영과 연결해 중복 제거 하한 및 결손 사유를 확인한다', () => {
  const records = Array.from({ length: 30 }, (_, song_id) => ({ song_id, diff: 3 }));
  const users = Array.from({ length: 30 }, (_, i) => {
    const source = dump(); source.user.iidx_id = String(i); source.osPattern[1].notes = i;
    return input(source, { axisSources: { 'dp/osPattern:NOTES': { records: [...records, ...records] } } });
  });
  const population = buildPopulation({ users, registry, featureVersion: 'fixture/1', populationVersion: 'pop/1', generatedAt: '2026-10-05T00:00:00Z' });
  const projected = projectRelative({ user: users[15], registry, population, sourceRevision: 'revision/1', generatedAt: population.generated_at });
  assert.equal(projected.features['dp/osPattern:NOTES'].same_star.percentile, 51.67);
  assert.equal(projected.features['dp/osPattern:NOTES'].overall.n, 30);
  assert.equal(projected.features['dp/radar:notes'].overall.reason, 'unknown_record_count');
  assert.equal(projected.features['dp/weakness:NOTES'], undefined);
});

test('커널 카운트를 축별 계약으로 연결하고 EX 양수 채보만 방식별로 중복 제거한다', () => {
  // 커널의 카운트 결과 계약만 주입하므로 데이터 저장소 테스트는 형제 저장소에 의존하지 않는다.
  const counts = { NOTES: 1, CHORD: 2, PEAK: 0 };
  const source = dump();
  source.dp = [
    { song_id: 1, diff: 3, ex_score: 10, played_version: 0 },
    { song_id: '1', diff: 3, ex_score: 20, played_version: 33 },
    { song_id: 1, diff: 2, ex_score: 30 },
    { song_id: 2, diff: 3, ex_score: 0 },
    { song_id: 3, diff: 3, ex_score: '100' },
    { song_id: 4, diff: 3, ex_score: NaN },
    { song_id: 5, diff: 3, ex_score: -1 },
  ];
  source.sp = [{ song_id: 2, diff: 3, ex_score: 100 }];
  const before = structuredClone({ source, counts });
  const axisSources = { ...patternRecordSources({ style: 'dp', counts }),
    ...radarRecordSources({ dump: source }) };
  const user = input(source, { axisSources });
  assert.equal(user.features['dp/osPattern:NOTES'].recordCount, 1);
  assert.equal(user.features['dp/osPattern:CHORD'].recordCount, 2);
  assert.equal(user.features['dp/osPattern:PEAK'].recordCount, 0);
  assert.equal(user.features['sp/osPattern:NOTES'].recordCount, null);
  for (const axis of ['notes', 'peak', 'charge', 'chord', 'scratch', 'soflan']) {
    assert.equal(user.features[`dp/radar:${axis}`].recordCount, 2);
    assert.equal(user.features[`sp/radar:${axis}`].recordCount, 1);
  }
  assert.deepEqual({ source, counts }, before);
  assert.deepEqual(radarRecordSources({ dump: {} }), {});
  assert.equal(radarRecordSources({ dump: { dp: [] } })['dp/radar:notes'].recordCount, 0);
  assert.throws(() => patternRecordSources({ style: 'dp', counts: { NOTES: -1 } }), /유효/);
  assert.throws(() => radarRecordSources({ dump: { dp: [{ ex_score: 1 }] } }), /유효/);
});

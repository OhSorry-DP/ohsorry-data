import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPopulation, projectRelative } from './coach-relative.mjs';

const registry = [{ key: 'dp/score', valueUnit: 'score', higherIsBetter: true },
  { key: 'dp/weakness', valueUnit: 'score', higherIsBetter: false }];
const makeUsers = (count, fn = i => i) => Array.from({ length: count }, (_, i) => ({ iidxId: `id-${i}`, star: 5,
  featureVersion: 'features/1', sourceRevision: `sha-${i}`, features: { 'dp/score': { value: fn(i), recordCount: 30 } } }));
const population = users => buildPopulation({ users, registry, featureVersion: 'features/1', populationVersion: 'pool/1', generatedAt: '2026-10-05T00:00:00Z' });
const project = (user, pop) => projectRelative({ user, registry, population: pop, sourceRevision: 'target-sha', generatedAt: '2026-10-05T01:00:00Z' });

test('30 values retain zero, rank a new value against the fixed snapshot, and leave it unchanged', () => {
  const pop = population(makeUsers(30)); const before = JSON.stringify(pop);
  const user = { iidxId: 'new', star: 5, featureVersion: 'features/1', features: { 'dp/score': { value: 14.5, recordCount: 30 } } };
  const result = project(user, pop);
  assert.equal(pop.features['dp/score'].values.length, 30); assert.equal(pop.features['dp/score'].values[0], 0);
  assert.equal(result.features['dp/score'].overall.percentile, 50); assert.equal(result.features['dp/score'].overall.n, 30);
  assert.equal(JSON.stringify(pop), before);
});

test('ties center at 50 and direction reverses the percentile with half-tie treatment', () => {
  const ties = population(makeUsers(30, () => 7));
  assert.equal(project({ featureVersion: 'features/1', features: { 'dp/score': { value: 7, recordCount: 30 } } }, ties).features['dp/score'].overall.percentile, 50);
  const values = Array.from({ length: 30 }, (_, i) => i);
  const low = { rank_version: 'coach-relative/1', feature_version: 'features/1', population_version: 'pool/1', generated_at: 't', features: { 'dp/score': { higher_is_better: true, values, bands: { '5': values } }, 'dp/weakness': { higher_is_better: false, values, bands: { '5': values } } } };
  const result = project({ featureVersion: 'features/1', star: 5, features: { 'dp/score': { value: 0, recordCount: 30 }, 'dp/weakness': { value: 0, recordCount: 30 } } }, low);
  assert.equal(result.features['dp/weakness'].overall.percentile, 98.33); assert.equal(result.features['dp/score'].overall.percentile, 1.67);
});

test('floor star bands separate 4.999 from 5.0 and null star has no same-star sample', () => {
  const users = [...makeUsers(30, () => 10).map(u => ({ ...u, star: 4.999 })), ...makeUsers(30, () => 20).map((u, i) => ({ ...u, iidxId: `b-${i}`, star: 5 }))];
  const pop = population(users);
  assert.equal(pop.features['dp/score'].bands['4'].length, 30); assert.equal(pop.features['dp/score'].bands['5'].length, 30);
  const unknownStar = project({ featureVersion: 'features/1', features: { 'dp/score': { value: 10, recordCount: 30 } } }, pop).features['dp/score'];
  assert.equal(unknownStar.overall.percentile, 25); assert.equal(unknownStar.same_star.reason, 'missing_star'); assert.equal(unknownStar.same_star.n, 0);
  // 계약 §7: 항목에 단위·방향, 최상위에 star·star_band. ★ 없음은 값 결손보다 뒤 순위.
  assert.equal(unknownStar.value_unit, 'score'); assert.equal(unknownStar.higher_is_better, true);
  const banded = project({ featureVersion: 'features/1', star: 4.999, features: { 'dp/score': { value: 10, recordCount: 30 } } }, pop);
  assert.deepEqual([banded.star, banded.star_band], [4.999, { lower: 4, upper: 5, width: 1 }]);
  const noStarNoValue = project({ featureVersion: 'features/1', features: { 'dp/score': { value: null, recordCount: 30 } } }, pop);
  assert.equal(noStarNoValue.star_band, null); assert.equal(noStarNoValue.features['dp/score'].same_star.reason, 'missing_value');
});

test('population, record-count, and value eligibility report their reasons in precedence order', () => {
  const pop29 = population(makeUsers(29)); const pop30 = population(makeUsers(30));
  const cases = [
    [{ value: 0, recordCount: 29 }, 'insufficient_records'],
    [{ value: 0, recordCount: null }, 'unknown_record_count'],
    [{ value: 0, recordCount: 30 }, null],
    [{ value: 0, recordCount: 30 }, 'insufficient_population', pop29],
    [{ value: null, recordCount: 30 }, 'missing_value'],
    [{ value: NaN, recordCount: 30 }, 'missing_value'],
  ];
  for (const [feature, reason, chosen = pop30] of cases) {
    const item = project({ featureVersion: 'features/1', features: { 'dp/score': feature } }, chosen).features['dp/score'].overall;
    if (reason === null) { assert.equal(item.percentile, 1.67); assert.equal(item.reason, null); }
    else { assert.equal(item.percentile, null); assert.equal(item.reason, reason); }
  }
  assert.equal(pop30.features['dp/score'].values[0], 0);
  assert.throws(() => population(makeUsers(1).map(u => ({ ...u, features: { 'dp/score': { value: 1, recordCount: -1 } } }))));
  assert.throws(() => population(makeUsers(1).map(u => ({ ...u, features: { 'dp/score': { value: 1, recordCount: 1.5 } } }))));
});

test('missing registry axes persist; mismatch nulls percentiles; duplicate IDs and mixed versions throw', () => {
  const pop = population(makeUsers(30));
  const result = project({ featureVersion: 'features/other', features: {} }, pop);
  assert.ok(Object.hasOwn(result.features, 'dp/weakness')); assert.equal(result.features['dp/weakness'].value, null);
  assert.equal(result.status, 'version_mismatch'); assert.equal(result.reason, 'version_mismatch');
  assert.equal(result.features['dp/score'].overall.percentile, null); assert.equal(result.features['dp/score'].value, null);
  assert.throws(() => population([makeUsers(1)[0], makeUsers(1)[0]]), /duplicate/);
  assert.throws(() => population([{ ...makeUsers(1)[0], featureVersion: 'other' }]), /version/);
  assert.throws(() => buildPopulation({ users: [], registry: [...registry, registry[0]], featureVersion: 'features/1', populationVersion: 'p', generatedAt: 't' }), /registry/);
});

test('outside endpoints, independent denominators, and repeated projection are deterministic', () => {
  const users = makeUsers(30, i => i); for (let i = 0; i < 30; i++) { users[i].star = i < 15 ? 4 : 5; users[i].features['dp/weakness'] = { value: i, recordCount: 30 }; }
  const pop = population(users);
  const target = { featureVersion: 'features/1', star: 4, features: { 'dp/score': { value: -10, recordCount: 30 }, 'dp/weakness': { value: -10, recordCount: 30 } } };
  const a = project(target, pop); const b = project(target, pop);
  assert.equal(a.features['dp/score'].overall.percentile, 0); assert.equal(a.features['dp/weakness'].overall.percentile, 100);
  assert.equal(a.features['dp/score'].overall.n, 30); assert.equal(a.features['dp/score'].same_star.n, 15);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

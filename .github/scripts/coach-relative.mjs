const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);

function validateRegistry(registry) {
  if (!Array.isArray(registry)) throw new Error('registry must be an array');
  const seen = new Set();
  for (const item of registry) {
    if (!isObject(item) || typeof item.key !== 'string' || !item.key || seen.has(item.key)) {
      throw new Error('invalid or duplicate registry key');
    }
    if (typeof item.valueUnit !== 'string' || !item.valueUnit || typeof item.higherIsBetter !== 'boolean') {
      throw new Error(`invalid registry unit or direction: ${item.key}`);
    }
    seen.add(item.key);
  }
}

function lowerBound(values, target) {
  let lo = 0; let hi = values.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (values[mid] < target) lo = mid + 1; else hi = mid; }
  return lo;
}
function upperBound(values, target) {
  let lo = 0; let hi = values.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (values[mid] <= target) lo = mid + 1; else hi = mid; }
  return lo;
}
const rounded = value => Math.round(value * 100) / 100;

export function buildPopulation({ users, registry, featureVersion, populationVersion, generatedAt }) {
  validateRegistry(registry);
  if (!Array.isArray(users)) throw new Error('users must be an array');
  if (typeof featureVersion !== 'string' || !featureVersion || typeof populationVersion !== 'string' || !populationVersion || typeof generatedAt !== 'string' || !generatedAt) throw new Error('invalid population metadata');
  const ids = new Set();
  for (const user of users) {
    if (!isObject(user) || typeof user.iidxId !== 'string' || !user.iidxId || ids.has(user.iidxId)) throw new Error('invalid or duplicate user ID');
    ids.add(user.iidxId);
    if (user.featureVersion !== featureVersion) throw new Error('feature version mismatch');
    if (typeof user.sourceRevision !== 'string' || !user.sourceRevision) throw new Error('invalid source revision');
    if (!isObject(user.features)) throw new Error('invalid user features');
  }
  const features = Object.create(null);
  for (const { key, higherIsBetter } of registry) {
    const values = []; const bands = Object.create(null);
    for (const user of users) {
      const feature = user.features[key];
      if (feature === undefined || feature === null) continue;
      if (!isObject(feature)) throw new Error(`invalid feature: ${key}`);
      const count = feature.recordCount;
      if (count !== null && count !== undefined && (!Number.isInteger(count) || count < 0)) throw new Error(`invalid recordCount: ${key}`);
      if (!finite(feature.value) || count === null || count === undefined || count < 30) continue;
      values.push(feature.value);
      if (finite(user.star)) {
        const band = String(Math.floor(user.star));
        (bands[band] ||= []).push(feature.value);
      }
    }
    values.sort((a, b) => a - b);
    for (const band of Object.keys(bands)) bands[band].sort((a, b) => a - b);
    features[key] = { higher_is_better: higherIsBetter, values, bands };
  }
  return { rank_version: 'coach-relative/1', feature_version: featureVersion, population_version: populationVersion,
    generated_at: generatedAt, features };
}

export function projectRelative({ user, registry, population, sourceRevision, generatedAt }) {
  validateRegistry(registry);
  if (!isObject(user) || !isObject(user.features) || !isObject(population)) throw new Error('invalid projection input');
  const mismatch = user.featureVersion !== population.feature_version;
  const relativeFeatures = Object.create(null);
  for (const { key, valueUnit, higherIsBetter } of registry) {
    const source = user.features[key];
    const value = isObject(source) && finite(source.value) ? source.value : null;
    const recordCount = isObject(source) && Number.isInteger(source.recordCount) ? source.recordCount : null;
    const snapshot = population.features?.[key];
    const project = values => {
      const n = Array.isArray(values) ? values.length : 0;
      if (mismatch) return { percentile: null, n, reason: 'version_mismatch' };
      if (value === null) return { percentile: null, n, reason: 'missing_value' };
      if (recordCount === null) return { percentile: null, n, reason: 'unknown_record_count' };
      if (recordCount < 30) return { percentile: null, n, reason: 'insufficient_records' };
      if (n < 30) return { percentile: null, n, reason: 'insufficient_population' };
      const less = lowerBound(values, value); const upper = upperBound(values, value); const equal = upper - less;
      const pct = higherIsBetter ? 100 * (less + 0.5 * equal) / n : 100 * ((n - upper) + 0.5 * equal) / n;
      return { percentile: rounded(pct), n, reason: null };
    };
    const allValues = Array.isArray(snapshot?.values) ? snapshot.values : [];
    const star = finite(user.star) ? Math.floor(user.star) : null;
    const sameValues = star === null ? [] : (Array.isArray(snapshot?.bands?.[String(star)]) ? snapshot.bands[String(star)] : []);
    // ★ 없음은 다른 결손 사유보다 뒤 순위다(계약 §7 열거 순서, version_mismatch 최우선).
    const noStar = () => { const r = project([]); return r.reason === 'insufficient_population' ? { percentile: null, n: 0, reason: 'missing_star' } : r; };
    relativeFeatures[key] = { value, value_unit: valueUnit, higher_is_better: higherIsBetter, record_count: recordCount,
      overall: project(allValues), same_star: star === null ? noStar() : project(sameValues) };
  }
  const mismatchReason = mismatch ? 'version_mismatch' : null;
  return { rank_version: population.rank_version, feature_version: population.feature_version,
    population_version: population.population_version, population_generated_at: population.generated_at,
    source_revision: sourceRevision, generated_at: generatedAt, stale: false,
    star: finite(user.star) ? user.star : null,
    star_band: finite(user.star) ? { lower: Math.floor(user.star), upper: Math.floor(user.star) + 1, width: 1 } : null,
    status: mismatch ? 'version_mismatch' : 'ready', reason: mismatchReason, features: relativeFeatures };
}

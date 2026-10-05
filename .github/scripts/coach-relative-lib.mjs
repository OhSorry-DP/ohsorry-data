import { calculateUser, stableJson, sha256, stripDpPrefix } from './dump-coach-relative.mjs';
import { projectRelative } from './coach-relative.mjs';

const manifestKey = 'coach/relative/current.json';
const objectKey = id => `coach/relative/user/${id}.json`;
const jsonBody = value => JSON.stringify(value);
const parse = item => item ? JSON.parse(item.body) : null;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const is412 = error => error?.status === 412 || /HTTP 412/.test(String(error?.message || ''));

function validManifest(manifest) {
  return isObject(manifest) && manifest.schema_version === 'coach-relative-manifest/1'
    && manifest.rank_version === 'coach-relative/1' && typeof manifest.feature_version === 'string'
    && typeof manifest.population_version === 'string' && typeof manifest.population_key === 'string';
}

function validatePopulation(record, manifest) {
  if (!isObject(record) || record.schema_version !== 'coach-relative-population/1'
    || record.rank_version !== 'coach-relative/1' || record.feature_version !== manifest.feature_version
    || record.population_version !== manifest.population_version || !Array.isArray(record.registry)
    || !Array.isArray(record.membership) || !Array.isArray(record.source_revisions)
    || !isObject(record.calculation) || record.calculation.feature_version !== record.feature_version
    || record.calculation.population_version !== record.population_version
    || record.calculation.rank_version !== record.rank_version
    || record.membership_hash !== sha256(record.membership)
    || record.source_hash !== sha256({ membership: record.membership, source_revisions: record.source_revisions,
      feature_version: record.feature_version, registry: record.registry })) throw new Error('invalid_population_snapshot');
  const ids = [...record.membership];
  if (ids.some(id => typeof id !== 'string' || !id) || stableJson(ids) !== stableJson([...ids].sort())
    || new Set(ids).size !== ids.length) throw new Error('invalid_population_membership');
  const registry = record.registry;
  return { registry, calculation: record.calculation };
}

function result(status, reason, changed, attempts, populationVersion, extra = {}) {
  return { status, reason, changed, attempts, population_version: populationVersion ?? null, ...extra };
}

async function readRemote(io, key) {
  const item = await io.read(key);
  return { item, value: parse(item) };
}

export async function produceRelativeUser({ id, dump, io, assets, generatedAt, dryRun = false, maxManifestRetries = 2 }) {
  const userId = String(id);
  const key = objectKey(userId);
  let previous, initialManifest;
  try {
    const [old, current] = await Promise.all([readRemote(io, key), readRemote(io, manifestKey)]);
    previous = old;
    initialManifest = current;
  } catch {
    // Manifest 부재는 이후 정상 조회에서 null로 표현된다. GET 오류는 덮어쓰기 없이 실패 처리한다.
    return result('failed', 'previous_read_failed', false, 0, null);
  }
  const oldEnvelope = previous.value;
  const oldRelative = oldEnvelope?.relative;
  const staleOrMissing = (reason, attempts, populationVersion = null) => {
    if (!oldRelative || oldRelative.status !== 'ready') return result('missing', reason, false, attempts, populationVersion);
    const envelope = { ...oldEnvelope, relative: { ...oldRelative, stale: true } };
    return result('stale', reason, false, attempts, populationVersion, { value: envelope });
  };
  let manifest = initialManifest.value;
  if (!manifest) return staleOrMissing('manifest_missing', 0);
  if (!validManifest(manifest)) return staleOrMissing('invalid_manifest', 0, manifest?.population_version);
  if (assets?.featureVersion !== manifest.feature_version) return staleOrMissing('feature_mismatch', 0, manifest.population_version);

  const calculate = () => {
    const snapshotKey = `coach/relative/population/${manifest.population_version}.json`;
    if (manifest.population_key !== snapshotKey) throw new Error('population_key_mismatch');
    return io.read(snapshotKey).then(item => {
      if (!item) throw new Error('population_missing');
      const { registry, calculation } = validatePopulation(parse(item), manifest);
      const versions = assets.versions || { featureVersion: manifest.feature_version };
      const sourceRegistry = assets.sourceRegistry || registry.filter(item => item.key.startsWith('dp/'));
      const sourceRevision = sha256({ dump: sha256(dump), assets: assets.hashes, registry: sourceRegistry,
        codeHashes: assets.codeHashes });
      const fullRegistry = registry.map(item => item.key.startsWith('dp/') ? item : ({ ...item, key: `dp/${item.key}` }));
      const user = calculateUser(dump, fullRegistry, { featureVersion: manifest.feature_version, sourceRevision }, assets, assets.kernel);
      const relative = projectRelative({ user, registry: fullRegistry.map(item => ({ ...item, key: item.key.slice(3) })),
        population: calculation, sourceRevision, generatedAt });
      return { registry, sourceRevision, relative, envelope: { schema_version: 'coach-skill-evidence/1',
        iidx_id: userId, play_style: 'DP', relative } };
    });
  };

  for (let attempt = 1; attempt <= maxManifestRetries + 1; attempt++) {
    let projected;
    try { projected = await calculate(); }
    catch { return staleOrMissing('generation_failed', attempt, manifest.population_version); }
    const { relative, envelope, sourceRevision } = projected;
    if (oldEnvelope?.iidx_id === userId && oldRelative?.status === 'ready'
      && oldRelative.source_revision === sourceRevision && oldRelative.feature_version === manifest.feature_version
      && oldRelative.population_version === manifest.population_version && oldRelative.rank_version === manifest.rank_version) {
      return result('ready', null, false, attempt, manifest.population_version, { value: oldEnvelope });
    }
    if (dryRun) return result('planned', null, true, attempt, manifest.population_version, { value: envelope });

    let latest;
    try { latest = await readRemote(io, manifestKey); }
    catch { return staleOrMissing('manifest_read_failed', attempt, manifest.population_version); }
    if (stableJson(latest.value) !== stableJson(manifest)) {
      if (attempt > maxManifestRetries) return staleOrMissing('manifest_race_exhausted', attempt, manifest.population_version);
      if (!validManifest(latest.value)) return staleOrMissing('invalid_manifest', attempt, latest.value?.population_version);
      manifest = latest.value;
      if (assets.featureVersion !== manifest.feature_version) return staleOrMissing('feature_mismatch', attempt, manifest.population_version);
      continue;
    }
    try {
      await io.put(key, jsonBody(envelope), previous.item?.etag ?? null);
      return result('ready', null, true, attempt, manifest.population_version, { value: envelope });
    } catch (error) {
      if (is412(error)) return result('conflict', 'precondition_failed', false, attempt, manifest.population_version);
      return staleOrMissing('put_failed', attempt, manifest.population_version);
    }
  }
  return staleOrMissing('manifest_race_exhausted', maxManifestRetries + 1, manifest.population_version);
}

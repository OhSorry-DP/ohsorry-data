// 상대 순위 입력 전용 순수 어댑터. 버전·해시는 생산자가 계산해서 주입한다.
// 현행 덤프에는 축별 기록 수와 수치 σ가 없으므로 전체 dp/sp 길이로 대체하지 않는다.
const DEFAULT_AXES = ['NOTES', 'CHORD', 'PEAK', 'CHARGE', 'SCRATCH', 'SOF-LAN', 'PHRASE', 'JACK', 'TRILL', 'RAND'];
const RADAR_AXES = ['notes', 'peak', 'charge', 'chord', 'scratch', 'soflan'];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const token = key => key.toUpperCase().replace(/[^A-Z0-9]/g, '');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// 메타는 feature-scores의 _meta 객체다. 약점 추가 축은 현행 보고에 쓰이는 축만 생산자가 지정한다.
export function buildRelativeRegistry({ featureMeta = {}, weaknessAxes = DEFAULT_AXES } = {}) {
  const names = (featureMeta.feats || []).map(item => typeof item === 'string' ? item : item?.name);
  const canonical = [...new Set([...DEFAULT_AXES, ...names,
    ...Object.keys(featureMeta.maxScoreByFeat || {})])];
  if (canonical.some(key => typeof key !== 'string' || !key)) throw new Error('canonical 피처 이름이 유효하지 않습니다');
  const registry = [];
  for (const style of ['dp', 'sp']) {
    for (const axis of canonical) registry.push({ key: `${style}/osPattern:${axis}`, valueUnit: 'feature_score', higherIsBetter: true });
    for (const axis of RADAR_AXES) registry.push({ key: `${style}/radar:${axis}`, valueUnit: 'radar_value', higherIsBetter: true });
    for (const definition of weaknessAxes) {
      const axis = typeof definition === 'string' ? definition : definition.key;
      const higherIsBetter = typeof definition === 'string' ? true : definition.higherIsBetter;
      if (typeof axis !== 'string' || !axis || typeof higherIsBetter !== 'boolean') throw new Error('약점 축 정의가 유효하지 않습니다');
      registry.push({ key: `${style}/weakness:${axis}`, valueUnit: 'residual_sigma', higherIsBetter });
    }
  }
  if (new Set(registry.map(item => item.key)).size !== registry.length) throw new Error('레지스트리 축이 중복됩니다');
  return registry;
}

function rowFor(rows, style, legacyDp = false) {
  if (!Array.isArray(rows)) return null;
  const matches = rows.filter(row => row?.play_style === (style === 'dp' ? 1 : 0));
  if (!matches.length && legacyDp && style === 'dp' && rows.every(row => object(row) && row.play_style == null)) matches.push(...rows);
  // 여러 집계 행 중 최신을 판단할 근거가 없으면 임의로 하나를 고르지 않는다.
  if (matches.length > 1 && matches.some(row => JSON.stringify(row) !== JSON.stringify(matches[0]))) throw new Error('동일 플레이 방식의 집계 행이 충돌합니다');
  return matches[0] || null;
}

function recordCount(source) {
  if (!object(source)) return null;
  // records는 생산자가 해당 축의 유효 표본으로 선별한 {song_id,diff} 목록이다.
  // 원시 덤프의 모든 성적을 여기 넣으면 안 된다. played_version·날짜 차이는 같은 채보다.
  if (Array.isArray(source.records)) {
    const keys = new Set();
    for (const row of source.records) {
      if (!object(row) || !((typeof row.song_id === 'string' && row.song_id) || Number.isInteger(row.song_id))
        || !Number.isInteger(row.diff) || row.diff < 0 || row.diff > 4) return null;
      keys.add(JSON.stringify([String(row.song_id), row.diff]));
    }
    return keys.size;
  }
  // recordCount는 생산자가 이미 중복을 제거한 해당 축의 유효 채보 수다. nCharts/nzCount는 이 계약이 아니다.
  return Number.isInteger(source.recordCount) && source.recordCount >= 0 ? source.recordCount : null;
}

// axisSources는 선택적 생산자 수치 계약: 레지스트리 키 → {sigma?, recordCount? 또는 records?}.
// sigma는 이미 산출된 명시적 수치만 허용한다. persona.report/feats/raw residual은 읽지 않는다.
// osPattern/radar 값은 덤프가 정본이며 axisSources로 덮어쓰지 않는다.
export function adaptRelativeInput({ dump, registry, featureVersion, sourceRevision, axisSources = {} }) {
  if (!object(dump) || typeof dump.user?.iidx_id !== 'string' || !dump.user.iidx_id
    || typeof featureVersion !== 'string' || !featureVersion || typeof sourceRevision !== 'string' || !sourceRevision) {
    throw new Error('유저 또는 입력 버전이 유효하지 않습니다');
  }
  if (!Array.isArray(registry)) throw new Error('레지스트리가 필요합니다');
  const features = {};
  for (const { key } of registry) {
    const match = /^(dp|sp)\/(osPattern|radar|weakness):(.+)$/.exec(key);
    if (!match || Object.hasOwn(features, key)) throw new Error('레지스트리 키가 유효하지 않거나 중복됩니다');
    const [, style, kind, axis] = match;
    const source = axisSources[key];
    let value = null;
    if (kind === 'weakness') value = source?.sigma;
    else {
      const row = rowFor(kind === 'osPattern' ? dump.osPattern : dump.radars, style, kind === 'osPattern');
      // fullUserFeatures와 같은 canonical 토큰 대응. SOF-LAN↔soflan, KEIMA_L↔keima_l.
      const field = kind === 'radar' && axis === 'soflan' ? 'soft' : axis;
      const entries = Object.entries(row || {}).filter(([name]) => token(name) === token(field));
      if (entries.length > 1 && entries.some(([, v]) => v !== entries[0][1])) throw new Error('canonical 원천 필드가 충돌합니다');
      value = entries[0]?.[1];
    }
    features[key] = { value: finite(value) ? value : null, recordCount: recordCount(source) };
  }
  return { iidxId: dump.user.iidx_id, star: finite(dump.user.star) ? dump.user.star : null,
    featureVersion, sourceRevision, features };
}

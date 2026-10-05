// 상대 순위 입력 전용 순수 어댑터. 버전·해시는 생산자가 계산해서 주입한다.
// 축별 기록 수는 생산자 helper로 공급하며 수치 σ는 명시적 원천만 사용한다.
const DEFAULT_AXES = ['NOTES', 'CHORD', 'PEAK', 'CHARGE', 'SCRATCH', 'SOF-LAN', 'PHRASE', 'JACK', 'TRILL', 'RAND'];
// 덤프의 user_ohsorry_radars 저장 축만 사용한다. 차트 전용 메타 축은 포함하지 않는다.
const PATTERN_AXES = [...DEFAULT_AXES, 'STAIR_UP_L', 'STAIR_UP_R', 'STAIR_DN_L', 'STAIR_DN_R',
  ...Array.from({ length: 7 }, (_, index) => [`K${index + 1}_L`, `K${index + 1}_R`]).flat(),
  'DOUBLE_STAIR_L', 'DOUBLE_STAIR_R', 'KEIMA_L', 'KEIMA_R',
  'HSTAIR_ONEHAND', 'HSTAIR_SYNC', 'HSTAIR_SAMESHAPE', 'HSTAIR_DIFFSHAPE', 'HANDS'];
const RADAR_AXES = ['notes', 'peak', 'charge', 'chord', 'scratch', 'soflan'];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const token = key => key.toUpperCase().replace(/[^A-Z0-9]/g, '');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// 메타 확장은 저장 축을 늘리지 않는다. 약점 추가 축은 현행 보고에 쓰이는 축만 생산자가 지정한다.
export function buildRelativeRegistry({ featureMeta = {}, weaknessAxes = [] } = {}) {
  const canonical = PATTERN_AXES;
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

// 커널 countPatternScoreRecords 결과를 R03/R04의 axisSources 계약으로 연결한다.
// entries의 매칭·skip과 커널 호출은 생산자가 수행하며 여기서는 점수를 재계산하지 않는다.
export function patternRecordSources({ style, counts }) {
  if (!['dp', 'sp'].includes(style) || !object(counts)) throw new Error('패턴 기록 수 입력이 유효하지 않습니다');
  const sources = {};
  for (const [axis, count] of Object.entries(counts)) {
    if (!axis || !Number.isInteger(count) || count < 0) throw new Error('패턴 기록 수가 유효하지 않습니다');
    sources[`${style}/osPattern:${axis}`] = { recordCount: count };
  }
  return sources;
}

// 게임 radar는 방식별 전체 플레이 집합에서 산출되므로 EX>0인 서로 다른 채보 수를 공유한다.
// grid 결손은 빈 플레이 집합으로 간주하지 않고 해당 방식의 공급을 생략한다.
export function radarRecordSources({ dump }) {
  if (!object(dump)) throw new Error('레이더 기록 수 입력이 유효하지 않습니다');
  const sources = {};
  for (const style of ['dp', 'sp']) {
    if (!Array.isArray(dump[style])) continue;
    const records = dump[style].filter(row => finite(row?.ex_score) && row.ex_score > 0);
    const count = recordCount({ records });
    if (count === null) throw new Error('레이더 채보의 song_id·diff가 유효하지 않습니다');
    for (const axis of RADAR_AXES) sources[`${style}/radar:${axis}`] = { recordCount: count };
  }
  return sources;
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

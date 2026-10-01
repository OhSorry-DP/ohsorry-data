// R-5a: DBR 파일의 scores 맵을 보존하는 history 계약과 입출력 없는 계산기.
// dump-user.mjs는 import 시 환경변수를 검사하므로 HIST_COLS를 직접 import하지 않는다.
export const DBR_HISTORY_COLS = Object.freeze([
  'song_id', 'diff', 'lamp', 'ex_score', 'played_version', 'date',
  'date_kst', 'play_style', 'bp', 'note_count', 'score_id',
]);

function fail(message) { throw new TypeError(`DBR history: ${message}`); }
function integer(value, name) {
  if (!Number.isSafeInteger(value)) fail(`${name} must be a safe integer`);
  return value;
}
function scoreId(value) {
  if (typeof value === 'number') integer(value, 'score_id');
  else if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) fail('invalid score_id');
  const id = BigInt(value);
  if (id <= 0n || id > 9223372036854775807n) fail('score_id outside positive SQL bigint');
  return id;
}
function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail('invalid date_kst');
  return value;
}
// PostgreSQL timestamptz처럼 실제 시각을 비교하고 마이크로초를 보존한다.
function instant(value) {
  const m = typeof value === 'string' && value.match(
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/,
  );
  if (!m) fail('date requires a timestamp with timezone (up to 6 fractional digits)');
  day(m[1]);
  if (+m[2] > 23 || +m[3] > 59 || +m[4] > 59) fail('invalid timestamp time');
  const zone = m[6] === 'Z' ? 'Z' : m[6].length === 3 ? `${m[6]}:00`
    : m[6].includes(':') ? m[6] : `${m[6].slice(0, 3)}:${m[6].slice(3)}`;
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}${zone}`);
  if (!Number.isFinite(ms)) fail('invalid timestamp timezone');
  return BigInt(ms) * 1000n + BigInt((m[5] || '').padEnd(6, '0'));
}
function naturalKey(r) { return JSON.stringify([r[0], r[1], r[4], r[7], r[6]]); }
function chartKey(r) { return JSON.stringify([r[0], r[1], r[4], r[7]]); }
function checkRow(r) {
  if (!Array.isArray(r) || r.length !== DBR_HISTORY_COLS.length) fail('row must have exactly 11 columns');
  for (const i of [0, 1, 4, 7]) integer(r[i], DBR_HISTORY_COLS[i]);
  if (r[4] !== -10 || r[7] !== 1) fail('row must be DBR (-10, style 1)');
  for (const i of [2, 3, 8, 9]) if (r[i] !== null) integer(r[i], DBR_HISTORY_COLS[i]);
  const time = instant(r[5]);
  day(r[6]);
  const kst = new Date(Number(time / 1000n) + 9 * 3600000).toISOString().slice(0, 10);
  if (kst !== r[6]) fail('date_kst does not match date in KST');
  scoreId(r[10]);
}
function metadata(complete, revision) {
  if (typeof complete !== 'boolean') fail('complete must be boolean');
  integer(revision, 'revision');
  if (revision < 0) fail('revision must be nonnegative');
}
function pack(rows, complete, revision) {
  metadata(complete, revision);
  const result = { schemaVersion: 1, complete, revision, cols: [...DBR_HISTORY_COLS], rows };
  validateDbrHistory(result);
  return result;
}

/** 저장 계약을 검사한다. 유효하면 true, 잘못된 계약이면 TypeError. 누락은 조회 함수에서 처리한다. */
export function validateDbrHistory(history) {
  if (!history || history.schemaVersion !== 1) fail('unsupported schemaVersion');
  metadata(history.complete, history.revision);
  if (!Array.isArray(history.cols) || history.cols.length !== DBR_HISTORY_COLS.length
    || history.cols.some((col, i) => col !== DBR_HISTORY_COLS[i])) fail('cols order mismatch');
  if (!Array.isArray(history.rows)) fail('rows must be an array');
  const keys = new Set(), ids = new Set();
  for (const r of history.rows) {
    checkRow(r);
    const key = naturalKey(r), id = scoreId(r[10]).toString();
    if (keys.has(key)) fail('duplicate natural key');
    if (ids.has(id)) fail('duplicate score_id');
    keys.add(key); ids.add(id);
  }
  return true;
}

/** 원천 객체 또는 11열 행 배열을 DBR 전용 계약으로 변환. 중복 자연키는 입력의 마지막 행으로 교체. */
export function normalizeDbrHistory(sourceRows, { complete = false, revision = 0 } = {}) {
  if (!Array.isArray(sourceRows)) fail('sourceRows must be an array');
  const byKey = new Map();
  for (const source of sourceRows) {
    if (!source || typeof source !== 'object') fail('invalid source row');
    const version = Array.isArray(source) ? source[4] : source.played_version;
    const style = Array.isArray(source) ? source[7] : source.play_style;
    integer(version, 'played_version'); integer(style, 'play_style');
    if (version !== -10 || style !== 1) continue;
    const r = Array.isArray(source) ? [...source] : DBR_HISTORY_COLS.map((col) => source[col] ?? null);
    checkRow(r);
    byKey.set(naturalKey(r), r);
  }
  return pack([...byKey.values()], complete, revision);
}

/** 차분은 도착순으로 적용. complete 승격은 호출자가 명시한 전체 이력 확인에 한한다. */
export function mergeDbrHistory(previous, sourceRows, options = {}) {
  if (previous != null) validateDbrHistory(previous);
  const complete = options.complete ?? previous?.complete ?? false;
  const revision = options.revision ?? (previous?.revision ?? 0) + 1;
  if (previous && revision <= previous.revision) fail('merge revision must increase');
  const incoming = normalizeDbrHistory(sourceRows);
  const byKey = new Map((previous?.rows ?? []).map((r) => [naturalKey(r), [...r]]));
  for (const r of incoming.rows) byKey.set(naturalKey(r), r);
  return pack([...byKey.values()], complete, revision);
}

/** 기존 scores와 다른 최상위 필드를 보존하면서 history만 추가 또는 갱신한다. */
export function extendDbrPayload(payload, sourceRows, options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || !payload.scores || typeof payload.scores !== 'object' || Array.isArray(payload.scores)) fail('payload requires scores map');
  return { ...payload, history: mergeDbrHistory(payload.history, sourceRows, options) };
}

function visible(history) {
  if (history == null) return [];
  validateDbrHistory(history);
  return history.rows.filter((r) => r[3] > 0);
}
function result(history, values, field) {
  const complete = history?.complete === true;
  return { status: !complete ? 'incomplete' : values.length ? 'ready' : 'empty', complete, [field]: values };
}

/** make_recent_dates(p_dbr=true, p_play_style=1) 대응. 미완료 부분 결과는 incomplete로 표시한다. */
export function getDbrRecentDates(history) {
  const counts = new Map();
  for (const r of visible(history)) counts.set(r[6], (counts.get(r[6]) ?? 0) + 1);
  const dates = [...counts].sort(([a], [b]) => b.localeCompare(a))
    .map(([date_kst, row_count]) => ({ date_kst, row_count }));
  return result(history, dates, 'dates');
}

/** make_recent_data의 DBR 부분. 곡 메타데이터 JOIN은 별도 계층에서 수행. 직전값 없으면 SQL처럼 null. */
export function getDbrRecentData(history, dateKst) {
  day(dateKst);
  const rows = visible(history);
  const groups = new Map();
  for (const r of rows) {
    const key = chartKey(r);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ row: r, time: instant(r[5]) });
  }
  for (const group of groups.values()) group.sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : 0);
  const output = rows.filter((r) => r[6] === dateKst).sort((a, b) => scoreId(a[10]) < scoreId(b[10]) ? -1 : 1).map((r) => {
    const time = instant(r[5]), group = groups.get(chartKey(r));
    // 엄격한 하한을 이진 탐색하여 현재 행 자신이나 같은 시각의 행을 직전값으로 쓰지 않는다.
    let low = 0, high = group.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (group[mid].time < time) low = mid + 1;
      else high = mid;
    }
    const prev = group[low - 1]?.row;
    return {
      ...Object.fromEntries(DBR_HISTORY_COLS.map((col, i) => [col, r[i]])),
      prev_lamp: prev?.[2] ?? null, prev_ex_score: prev?.[3] ?? null,
      prev_played_version: prev?.[4] ?? null, prev_bp: prev?.[8] ?? null,
    };
  });
  return result(history, output, 'rows');
}

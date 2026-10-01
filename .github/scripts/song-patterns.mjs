// 곡 패턴 계약 v1: 원본 곡 키를 그대로 id로 쓰고 3밴드의 채보 행을 합친다.
export const SOURCE_KEYS = ['data/patterns-dp-1112.json', 'data/patterns-dp-0810.json', 'data/patterns-dp-rest.json'];
export const PREFIX = 'data/song-patterns-dp-';
export const MAX_DELETE_RATIO = 0.05;
export const MAX_DELETE_FLOOR = 20;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ownedKey = key => /^data\/song-patterns-dp-(?:[0-9a-f]{2})+\.json$/.test(key);

export function songPatternsKey(id) {
  if (typeof id !== 'string' || !id) throw new Error('곡 id 오류');
  const hex = Array.from(new TextEncoder().encode(id), byte => byte.toString(16).padStart(2, '0')).join('');
  return `${PREFIX}${hex}.json`;
}

export function buildSongPatterns(sources) {
  if (!Array.isArray(sources) || sources.length !== SOURCE_KEYS.length) throw new Error('패턴 3밴드 필요');
  const songs = new Map();
  for (const [index, band] of sources.entries()) {
    if (!object(band) || !Object.keys(band).length) throw new Error(`패턴 원본 스키마 오류: ${SOURCE_KEYS[index]}`);
    for (const [id, song] of Object.entries(band)) {
      songPatternsKey(id);
      if (!object(song?.c)) throw new Error(`패턴 곡 스키마 오류: ${id}`);
      if (!songs.has(id)) songs.set(id, Object.create(null));
      const charts = songs.get(id);
      for (const [chartKey, row] of Object.entries(song.c)) {
        if (Object.hasOwn(charts, chartKey)) throw new Error(`밴드 간 충돌: ${id}/${chartKey} (${SOURCE_KEYS[index]})`);
        if (!chartKey || !object(row)) throw new Error(`패턴 행 스키마 오류: ${id}/${chartKey}`);
        charts[chartKey] = row;
      }
    }
  }
  return new Map([...songs].map(([id, c]) => [songPatternsKey(id), JSON.stringify({ v: 1, id, c })]));
}

// 원본과 목록 검증을 마친 계획만 실행기로 넘긴다. md5는 공용 R2 클라이언트가 제공한다.
export function planSongPatterns(bundles, entries, { md5, maxWrites = 500 } = {}) {
  if (!Number.isSafeInteger(maxWrites) || maxWrites < 1) throw new Error('쓰기 상한 오류');
  const remote = new Map(entries.map(entry => [entry.key, String(entry.etag || '').replace(/^W\//i, '').replace(/"/g, '').toLowerCase()]));
  const existing = entries.filter(entry => ownedKey(entry.key));
  const deletes = existing.filter(entry => !bundles.has(entry.key)).map(entry => ({ type: 'delete', key: entry.key }));
  if (deletes.length > Math.max(MAX_DELETE_FLOOR, existing.length * MAX_DELETE_RATIO)) {
    throw new Error(`삭제 ${deletes.length}건이 기존 ${existing.length}건의 5% (최소 20건) 초과 — 원본 이상 의심, 중단`);
  }
  const puts = [...bundles].filter(([key, body]) => remote.get(key) !== md5(body)).map(([key, body]) => ({ type: 'put', key, body }));
  const pending = [...deletes, ...puts];
  const sizes = [...bundles.values()].map(body => Buffer.byteLength(body, 'utf8')).sort((a, b) => a - b);
  const middle = Math.floor(sizes.length / 2);
  return { puts: puts.length, deletes: deletes.length, pending: pending.length, selected: pending.slice(0, maxWrites),
    medianBytes: sizes.length ? (sizes.length % 2 ? sizes[middle] : (sizes[middle - 1] + sizes[middle]) / 2) : 0,
    maxBytes: sizes.at(-1) || 0 };
}

import { pathToFileURL } from 'node:url';

export function validateRows(rows) {
  if (!Array.isArray(rows)) throw new Error('first-place 응답이 배열이 아님');
  if (rows.length === 0) throw new Error('first-place 응답이 비어 있음');
  const seen = new Set();
  for (const row of rows) {
    if (!row || !Number.isInteger(row.song_id) || !Number.isInteger(row.diff)
      || typeof row.iidx_id !== 'string' || row.iidx_id.trim() === '') {
      throw new Error('first-place 행 필드 타입 불량');
    }
    const pair = `${row.song_id},${row.diff}`;
    if (seen.has(pair)) throw new Error(`first-place 중복: ${pair}`);
    seen.add(pair);
  }
  return rows;
}

export function toOutput(rows, createdAt = new Date().toISOString()) {
  validateRows(rows);
  const grouped = new Map();
  for (const { song_id, diff, iidx_id } of rows) {
    if (!grouped.has(iidx_id)) grouped.set(iidx_id, []);
    grouped.get(iidx_id).push([song_id, diff]);
  }
  const w = {};
  for (const iidxId of [...grouped.keys()].sort()) {
    w[iidxId] = grouped.get(iidxId).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }
  return { _v: createdAt, n: rows.length, w };
}

export function parseContentRangeTotal(contentRange) {
  const match = /^\d+-\d+\/(\d+|\*)$/.exec(contentRange ?? '');
  return match && match[1] !== '*' ? Number(match[1]) : null;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  console.error('직접 실행할 수 없습니다. dump-chart-rankings.mjs를 사용하세요.');
  process.exit(1);
}

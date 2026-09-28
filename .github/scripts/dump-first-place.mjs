import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const PAGE_SIZE = 1000;

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

export async function fetchAllFirstPlace(fetchImpl = fetch) {
  const sb = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sb || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 없음');
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'count=exact' };
  const all = [];
  let total;
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url = `${sb}/rest/v1/rpc/get_first_place_winners?limit=${PAGE_SIZE}&offset=${offset}&order=song_id.asc,diff.asc`;
    const res = await fetchImpl(url, { method: 'POST', headers, body: '{}' });
    if (!res.ok) throw new Error(`first-place HTTP ${res.status}`);
    if (offset === 0) total = parseContentRangeTotal(res.headers.get('Content-Range'));
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error('first-place 응답이 배열이 아님');
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  if (total === null) console.warn('first-place Content-Range 총수를 확인할 수 없음');
  else if (total !== all.length) throw new Error(`first-place 행 수 불일치: ${all.length}/${total}`);
  return validateRows(all);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const rows = await fetchAllFirstPlace();
    fs.writeFileSync('first-place-winners.json', JSON.stringify(toOutput(rows)));
    console.log('first-place-winners.json 갱신:', rows.length, '행');
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

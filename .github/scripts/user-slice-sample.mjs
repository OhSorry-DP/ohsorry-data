// 로컬 샘플 전용: 네트워크·파일 쓰기 없이 Git의 user 원본과 hist 폴더를 계산한다.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { buildUserSlice } from './user-slice.mjs';

const revision = process.argv[2];
if (!revision) throw new Error('user 샘플이 있는 Git revision 인자가 필요하다');
const files = fs.readdirSync('hist').filter((name) => /^[A-Za-z0-9]+\.json$/.test(name));
const paths = new Set(execFileSync('git', ['ls-tree', '-r', '--name-only', revision, '--', 'user'], { encoding: 'utf8' }).trim().split(/\r?\n/));
const sizes = { r: [], h: [], summary: [] }, modes = {}, lengths = {};
let users = 0, histRows = 0, missingUsers = 0, recordRows = 0, warnings = 0;
for (const file of files) {
  const hist = JSON.parse(fs.readFileSync('hist/' + file, 'utf8'));
  for (const row of hist) {
    histRows++;
    const mode = String(row[7]); modes[mode] = (modes[mode] || 0) + 1;
    lengths[row.length] = (lengths[row.length] || 0) + 1;
  }
  if (!paths.has('user/' + file)) { missingUsers++; continue; }
  const data = JSON.parse(execFileSync('git', ['show', revision + ':user/' + file], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }));
  const id = file.slice(0, -5), bundle = buildUserSlice(id, data, hist);
  users++; recordRows += data.dp.length + data.sp.length; warnings += bundle.warnings.length;
  sizes.summary.push(Buffer.byteLength(JSON.stringify(bundle.summary)));
  for (const [key, body] of Object.entries(bundle.objects)) sizes[key.includes('-r-') ? 'r' : 'h'].push(Buffer.byteLength(body));
}
const distribution = (values) => {
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  return { count: values.length, maxBytes: values.at(-1) ?? null,
    medianBytes: values.length ? (values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2) : null };
};
console.log(JSON.stringify({ revision, histFiles: files.length, users, missingUsers, histRows, recordRows, modes, lengths, warnings,
  distributions: { r: distribution(sizes.r), h: distribution(sizes.h), allShards: distribution([...sizes.r, ...sizes.h]), summary: distribution(sizes.summary) } }, null, 2));

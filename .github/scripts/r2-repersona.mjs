// r2-repersona.mjs — R2 서빙본의 persona/spPersona 만 제자리 재생성 (supabase 재조회 0).
//
// 왜 git → R2 단순 PUT 이면 안 되는가:
//   dump-user 는 **R2 는 매 덤프마다 PUT / git 은 유저당 1일 1커밋** 이다(dump-user.yml 주석).
//   즉 R2 가 git 보다 최신일 수 있고, git 본을 그대로 올리면 그 유저의 점수가
//   "마지막으로 커밋된 스냅샷" 으로 **롤백**된다. 그래서 read-modify-write 로만 건드린다.
//     ① R2 GET → ② 그 안의 dp/sp rows 로 persona 재생성 → ③ persona/spPersona 만 갈아끼워 PUT.
//   점수·램프 등 나머지 필드는 R2 원본 그대로다.
//
// 사용: node .github/scripts/r2-repersona.mjs [--limit=N] [--only=id,id] [--dry]
//   (repo 루트에서. wrangler r2 write 권한이 있는 환경 = GitHub Actions 전용.)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadPersonaResources, chartsFromGridRows, personaFor, spChartsFromGridRows, spPersonaFor } from './persona-lib.mjs';

const BUCKET = 'ohsorry-data';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'r2repersona-'));
const DRY = process.argv.includes('--dry');
const limArg = process.argv.find((a) => a.startsWith('--limit='));
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const LIMIT = limArg ? Number(limArg.slice(8)) : Infinity;
const ONLY = onlyArg ? new Set(onlyArg.slice(7).split(',')) : null;

function wrangler(args) {
  return execFileSync('npx', ['--yes', 'wrangler@4', ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
}
function r2Get(key, file) {
  try { wrangler(['r2', 'object', 'get', `${BUCKET}/${key}`, `--file=${file}`, '--remote']); return true; }
  catch { return false; }
}
function r2Put(key, file) {
  wrangler(['r2', 'object', 'put', `${BUCKET}/${key}`, `--file=${file}`,
    '--content-type=application/json; charset=utf-8', '--remote']);
}

const songs = JSON.parse(fs.readFileSync('songs.json', 'utf8'));
const songById = new Map(songs.map((s) => [s.song_id, s]));
// 슬림 row → grid row 복원 (backfill-personas.mjs 와 동일)
const rowsOf = (slim) => (slim || []).map((r) => {
  const s = songById.get(r.song_id);
  return s ? { title: s.title, textage_song_id: s.textage_song_id, diff: r.diff, ex_score: r.ex_score, lamp: r.lamp } : null;
}).filter(Boolean);

const R = await loadPersonaResources();
if (!R.popmean) console.warn('::warning::persona-popmean.json 미로드 — DP 가 raw 경로로 생성된다');
if (!R.popmeanSp) console.warn('::warning::persona-popmean-sp.json 미로드 — SP 가 raw 경로로 생성된다');

let ids = fs.readdirSync('user').filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
if (ONLY) ids = ids.filter((i) => ONLY.has(i));
ids = ids.slice(0, LIMIT);
console.log(`대상 ${ids.length}명 (R2 read-modify-write${DRY ? ', DRY RUN' : ''})`);

let put = 0, miss = 0, same = 0, fail = 0, dpOk = 0, spOk = 0;
for (const id of ids) {
  const f = path.join(TMP, `${id}.json`);
  if (!r2Get(`user/${id}.json`, f)) {
    // R2 에 없는 유저 — git 본을 그대로 올린다(신규/누락 보정). 롤백 위험 없음(R2 가 비어 있으므로).
    const gp = path.join('user', `${id}.json`);
    if (!fs.existsSync(gp)) { miss++; continue; }
    if (!DRY) { try { r2Put(`user/${id}.json`, gp); put++; } catch (e) { fail++; console.error('PUT 실패(신규)', id, e.message); } }
    else put++;
    continue;
  }
  let data;
  try { data = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { fail++; console.error('파싱 실패', id, e.message); continue; }
  const before = JSON.stringify([data.persona, data.spPersona]);
  try {
    data.persona = personaFor(chartsFromGridRows(rowsOf(data.dp), R.textageMeta), R);
    if (data.persona) dpOk++;
    data.spPersona = spPersonaFor(spChartsFromGridRows(rowsOf(data.sp), R.textageMeta), R);
    if (data.spPersona) spOk++;
  } catch (e) { fail++; console.error('persona 실패', id, e.message); continue; }
  if (JSON.stringify([data.persona, data.spPersona]) === before) { same++; continue; }   // 변화 없으면 PUT 생략
  if (DRY) { put++; continue; }
  fs.writeFileSync(f, JSON.stringify(data));
  try { r2Put(`user/${id}.json`, f); put++; } catch (e) { fail++; console.error('PUT 실패', id, e.message); }
  if (put % 25 === 0) console.log(`  ${put} PUT / ${same} 무변화 / ${fail} 실패`);
}
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`완료: PUT ${put} / 무변화 ${same} / R2·git 모두없음 ${miss} / 실패 ${fail} (DP ${dpOk} · SP ${spOk} 생성)`);
if (fail) process.exit(1);

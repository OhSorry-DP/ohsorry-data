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

// ── R2 접근 — REST 우선, 실패 시 wrangler 폴백 ────────────────────────────────
//   ⚠️ 종전엔 유저당 `npx --yes wrangler@4` 를 2번(GET/PUT) 불렀다. npx 가 호출마다 패키지를
//      재해석해 **호출당 2~4초** 가 붙어 369명에 30분이 걸렸다(736회 스폰이 지배적).
//      REST 는 프로세스 스폰이 없고 동시 실행도 되므로 수 분대로 떨어진다.
//   폴백을 남기는 이유 — 토큰 스코프에 따라 REST object API 가 막힐 수 있다. 시작 시 1회 probe 해
//   안 되면 통째로 wrangler 경로로 내려간다(종전 동작과 동일, 느릴 뿐 결과는 같다).
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const REST_BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets/${BUCKET}/objects/`;
let useRest = !!(ACCOUNT && TOKEN);

function wrangler(args) {
  return execFileSync('npx', ['--yes', 'wrangler@4', ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
}
// 429/5xx 는 잠깐 쉬고 재시도 — Cloudflare API 는 계정 단위 rate limit 이 있다.
async function restFetch(key, init, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(REST_BASE + key, {
      ...init,
      headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) },
    });
    if (r.status === 429 || r.status >= 500) {
      if (i === tries - 1) return r;
      await new Promise((s) => setTimeout(s, 500 * (i + 1) * (i + 1)));
      continue;
    }
    return r;
  }
}
async function r2GetText(key) {
  if (useRest) {
    const r = await restFetch(key, { method: 'GET' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`R2 GET ${key} — HTTP ${r.status}`);
    return await r.text();
  }
  const f = path.join(TMP, key.replace(/[/\\]/g, '_'));
  try { wrangler(['r2', 'object', 'get', `${BUCKET}/${key}`, `--file=${f}`, '--remote']); }
  catch { return null; }
  return fs.readFileSync(f, 'utf8');
}
async function r2PutText(key, text) {
  if (useRest) {
    const r = await restFetch(key, {
      method: 'PUT', body: text,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
    if (!r.ok) throw new Error(`R2 PUT ${key} — HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    return;
  }
  const f = path.join(TMP, key.replace(/[/\\]/g, '_'));
  fs.writeFileSync(f, text);
  wrangler(['r2', 'object', 'put', `${BUCKET}/${key}`, `--file=${f}`,
    '--content-type=application/json; charset=utf-8', '--remote']);
}
// 동시 실행 풀 — 순서 무관(유저별 독립)이라 단순 워커 N개로 충분.
async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  });
  await Promise.all(workers);
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

// REST probe — 고정 키(users-list.json)를 1회 GET 해 본다. 401/403 이면 토큰이 object API 를
//   못 쓰는 것 → wrangler 폴백. **유저 목록보다 먼저** 해야 한다(아래 목록 취득도 이 경로를 탄다).
if (useRest) {
  try {
    const r = await restFetch('users-list.json', { method: 'GET' });
    if (r.status === 401 || r.status === 403) {
      console.warn(`::warning::R2 REST ${r.status} — wrangler 폴백(느림). 토큰에 R2 오브젝트 권한을 주면 빨라진다`);
      useRest = false;
    }
  } catch (e) { console.warn('::warning::R2 REST probe 실패 — wrangler 폴백:', e.message); useRest = false; }
}

// 대상 유저 목록은 **R2 의 users-list.json** 에서 받는다.
//   ⚠️ 종전엔 git 의 `user/` 폴더를 readdir 했는데, §4(2026-08-09)로 데이터 커밋을 중단해
//   그 폴더가 그 시점에서 굳었다. 그대로 두면 이후 가입한 유저가 영영 대상에서 빠진다.
//   R2 취득에 실패하면 굳은 git 폴더로 폴백한다(없는 것보다는 낫다 — 경고를 남긴다).
let ids = [];
try {
  const listText = await r2GetText('users-list.json');
  const list = listText ? JSON.parse(listText) : null;
  if (!Array.isArray(list) || !list.length) throw new Error('users-list 비었음');
  ids = list.map((u) => u.iidx_id).filter((x) => /^[A-Za-z0-9]+$/.test(String(x || '')));
  console.log(`대상 목록 = R2 users-list.json (${ids.length}명)`);
} catch (e) {
  console.warn(`::warning::R2 users-list 취득 실패(${e.message}) — git user/ 폴더로 폴백(§4 이후 굳은 목록이라 신규 유저가 빠질 수 있다)`);
  try { ids = fs.readdirSync('user').filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); }
  catch { ids = []; }
}
if (!ids.length) { console.error('::error::대상 유저 목록이 비었다 — 중단'); process.exit(1); }
if (ONLY) ids = ids.filter((i) => ONLY.has(i));
ids = ids.slice(0, LIMIT);
// wrangler 폴백은 프로세스 스폰이라 동시 실행 이득이 없다(오히려 메모리만 먹는다) → 1.
const conArg = process.argv.find((a) => a.startsWith('--concurrency='));
const CONC = conArg ? Number(conArg.slice(14)) : (useRest ? 4 : 1);
console.log(`대상 ${ids.length}명 (R2 read-modify-write / ${useRest ? 'REST' : 'wrangler'} / 동시 ${CONC}${DRY ? ' / DRY RUN' : ''})`);

let put = 0, miss = 0, same = 0, fail = 0, dpOk = 0, spOk = 0, done = 0;
await pool(ids, CONC, async (id) => {
  const key = `user/${id}.json`;
  let text;
  try { text = await r2GetText(key); }
  catch (e) { fail++; console.error('GET 실패', id, e.message); return; }
  if (text == null) {
    // R2 에 없는 유저 — git 본을 그대로 올린다(신규/누락 보정). 롤백 위험 없음(R2 가 비어 있으므로).
    const gp = path.join('user', `${id}.json`);
    if (!fs.existsSync(gp)) { miss++; return; }
    if (DRY) { put++; return; }
    try { await r2PutText(key, fs.readFileSync(gp, 'utf8')); put++; }
    catch (e) { fail++; console.error('PUT 실패(신규)', id, e.message); }
    return;
  }
  let data;
  try { data = JSON.parse(text); } catch (e) { fail++; console.error('파싱 실패', id, e.message); return; }
  const before = JSON.stringify([data.persona, data.spPersona]);
  try {
    data.persona = personaFor(chartsFromGridRows(rowsOf(data.dp), R.textageMeta), R);
    if (data.persona) dpOk++;
    data.spPersona = spPersonaFor(spChartsFromGridRows(rowsOf(data.sp), R.textageMeta), R);
    if (data.spPersona) spOk++;
  } catch (e) { fail++; console.error('persona 실패', id, e.message); return; }
  if (JSON.stringify([data.persona, data.spPersona]) === before) { same++; return; }   // 변화 없으면 PUT 생략
  if (DRY) { put++; return; }
  try { await r2PutText(key, JSON.stringify(data)); put++; }
  catch (e) { fail++; console.error('PUT 실패', id, e.message); }
  if (++done % 50 === 0) console.log(`  ${done}/${ids.length} 처리 (PUT ${put} / 무변화 ${same} / 실패 ${fail})`);
});
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`완료: PUT ${put} / 무변화 ${same} / R2·git 모두없음 ${miss} / 실패 ${fail} (DP ${dpOk} · SP ${spOk} 생성)`);
if (fail) process.exit(1);

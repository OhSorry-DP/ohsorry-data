// R2 사용자 덤프 전원의 r_star를 계산한다. 기본 DRY RUN, --apply에서만 R2를 갱신한다.
// --db-only: R2는 건드리지 않고 Supabase users.r_star만 백필한다.
// --rebase: prevRStar 래칫을 끄고 새 곡별 r★ 모델로 전체 재기준화.
import { loadPersonaResources, DIFF_INT_TO_STR } from './persona-lib.mjs';
import { getText, putIfChanged, pool } from './r2-client.mjs';

const APPLY = process.argv.includes('--apply');
const DB_ONLY = process.argv.includes('--db-only');
const REBASE = process.argv.includes('--rebase');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.slice(8)) : Infinity;
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? new Set(onlyArg.slice(7).split(',').map((v) => v.trim()).filter(Boolean)) : null;
const delayArg = process.argv.find((a) => a.startsWith('--db-delay='));
const DB_DELAY = delayArg ? Number(delayArg.slice(11)) : 1000;
const CONCURRENCY = DB_ONLY ? 1 : 4;

if (APPLY && DB_ONLY) throw new Error('--apply와 --db-only는 동시에 사용할 수 없음');
if ((!Number.isFinite(LIMIT) && LIMIT !== Infinity) || LIMIT < 0) throw new Error('--limit은 0 이상의 숫자여야 함');
if (!Number.isFinite(DB_DELAY) || DB_DELAY < 0) throw new Error('--db-delay는 0 이상의 숫자여야 함');

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseHeaders = DB_ONLY ? {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
} : null;
if (DB_ONLY && (!SUPABASE_URL || !SUPABASE_KEY)) {
  throw new Error('--db-only에는 SUPABASE_URL과 SUPABASE_SERVICE_ROLE_KEY가 필요함');
}

async function supabaseFetch(path, init = {}, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...init,
      headers: { ...supabaseHeaders, ...(init.headers || {}) },
    });
    if (response.status !== 429 && response.status < 500 || i === tries - 1) return response;
    await new Promise((resolve) => setTimeout(resolve, 500 * (i + 1) * (i + 1)));
  }
}

async function fetchDbRStars() {
  const response = await supabaseFetch('users?select=iidx_id,r_star');
  if (!response.ok) throw new Error(`users r_star 조회 실패: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
  const rows = await response.json();
  return new Map(rows.map((row) => [String(row.iidx_id), typeof row.r_star === 'number' ? row.r_star : null]));
}

async function updateDbRStar(id, rStar) {
  const response = await supabaseFetch(`users?iidx_id=eq.${encodeURIComponent(id)}&select=iidx_id,r_star`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ r_star: rStar }),
  });
  if (!response.ok) throw new Error(`users.r_star 갱신 실패: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
  const rows = await response.json();
  if (rows.length !== 1 || String(rows[0].iidx_id) !== id || Number(rows[0].r_star) !== rStar) {
    throw new Error('users.r_star 갱신 결과 검증 실패');
  }
}

const [listRaw, songsRaw, R] = await Promise.all([getText('users-list.json'), getText('songs.json'), loadPersonaResources()]);
if (!listRaw || !songsRaw) throw new Error('R2 users-list.json 또는 songs.json 없음');
if (!R.userRateStarLib) throw new Error('userRateStar.js 미배포 — 먼저 모듈과 ohSorryRating.json을 배포할 것');
const list = JSON.parse(listRaw), songs = JSON.parse(songsRaw);
if (!Array.isArray(list) || !Array.isArray(songs)) throw new Error('R2 목록 형식 오류');
const songById = new Map(songs.map((s) => [Number(s.song_id), s]));
const diffToTextage = { NORMAL: 'DN', HYPER: 'DH', ANOTHER: 'DA', LEGGENDARIA: 'DX', BEGINNER: 'DB' };

function chartsOf(rows) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const song = songById.get(Number(row.song_id)), diff = DIFF_INT_TO_STR[row.diff];
    if (!song || !diff || !(row.ex_score > 0)) continue;
    let noteCount = typeof row.note_count === 'number' && row.note_count > 0 ? row.note_count : null;
    const meta = song.textage_song_id && R.textageMeta.songs[song.textage_song_id];
    if (!noteCount && meta && meta.notes) noteCount = meta.notes[diffToTextage[diff]] || null;
    if (!noteCount) continue;
    out.push({ title: song.title, diff, exScore: row.ex_score, noteCount });
  }
  return out;
}

const dbRStars = DB_ONLY ? await fetchDbRStars() : null;
let changed = 0, unavailable = 0, failed = 0, ratcheted = 0, dbChanged = 0, dbSkipped = 0;
const filtered = ONLY ? list.filter((entry) => ONLY.has(String(entry.iidx_id || ''))) : list;
const targets = filtered.slice(0, LIMIT);
await pool(targets, CONCURRENCY, async (entry, index) => {
  const id = String(entry.iidx_id || '');
  try {
    const raw = await getText(`user/${id}.json`); if (!raw) { unavailable++; return; }
    const dump = JSON.parse(raw);
    if (!dump.user) { unavailable++; return; }
    const prev = !REBASE && typeof dump.user.r_star === 'number' ? dump.user.r_star : null;
    const calc = R.userRateStarLib.inferUserRStar(chartsOf(dump.dp), R.ratingData, { normFn: R.norm, scale: R.rateStarScale, prevRStar: prev });
    if (calc.rStar == null) { unavailable++; return; }
    if (calc.ratcheted) ratcheted++;
    dump.user = { ...dump.user, r_star: calc.rStar }; dump.rStarCalc = calc; entry.r_star = calc.rStar;
    const body = JSON.stringify(dump);
    const isChanged = body !== raw;
    if (isChanged) { changed++; if (APPLY) { const p = await putIfChanged(`user/${id}.json`, body); if (!p.ok) throw new Error(p.msg); } }
    if (DB_ONLY) {
      if (!dbRStars.has(id)) throw new Error('Supabase users 행 없음');
      if (dbRStars.get(id) === calc.rStar) dbSkipped++;
      else {
        await updateDbRStar(id, calc.rStar);
        dbRStars.set(id, calc.rStar);
        dbChanged++;
        if (DB_DELAY > 0) await new Promise((resolve) => setTimeout(resolve, DB_DELAY));
      }
    }
    if ((index + 1) % 25 === 0) console.log(`${index + 1}/${targets.length} 처리`);
  } catch (e) { failed++; console.error(`FAIL ${id}:`, e.message); }
});
if (APPLY && failed === 0) {
  const p = await putIfChanged('users-list.json', JSON.stringify(list));
  if (!p.ok) throw new Error(`users-list PUT 실패: ${p.msg}`);
}
const result = { mode: APPLY ? 'APPLY' : 'DRY RUN', rebase: REBASE, users: targets.length, changed, unavailable, ratcheted, failed };
if (DB_ONLY) Object.assign(result, { mode: 'DB ONLY', dbChanged, dbSkipped });
console.log(result);
if (failed) process.exitCode = 1;

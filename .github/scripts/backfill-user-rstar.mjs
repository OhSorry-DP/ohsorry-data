// R2 사용자 덤프 전원의 r_star를 계산해 점검한다. 이 스크립트는 절대 저장하지 않는다.
// 유저 r_star 저장은 개별 유저 크롤링/갱신 경로만 담당한다.
// --rebase: prevRStar 래칫을 끄고 새 곡별 r★ 모델로 전체 재기준화.
import { loadPersonaResources, DIFF_INT_TO_STR } from './persona-lib.mjs';
import { getText, pool } from './r2-client.mjs';

const REBASE = process.argv.includes('--rebase');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.slice(8)) : Infinity;
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? new Set(onlyArg.slice(7).split(',').map((v) => v.trim()).filter(Boolean)) : null;
const CONCURRENCY = 4;

if (process.argv.includes('--apply') || process.argv.includes('--db-only')) {
  throw new Error('유저 r★ 일괄 저장은 폐지되었습니다. 개별 유저 크롤링/갱신 경로를 사용하세요.');
}
if ((!Number.isFinite(LIMIT) && LIMIT !== Infinity) || LIMIT < 0) throw new Error('--limit은 0 이상의 숫자여야 함');

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

let wouldChange = 0, unavailable = 0, failed = 0, ratcheted = 0;
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
    if (calc.rStar !== dump.user.r_star) wouldChange++;
    if ((index + 1) % 25 === 0) console.log(`${index + 1}/${targets.length} 처리`);
  } catch (e) { failed++; console.error(`FAIL ${id}:`, e.message); }
});
const result = { mode: 'AUDIT ONLY', rebase: REBASE, users: targets.length, wouldChange, unavailable, ratcheted, failed };
console.log(result);
if (failed) process.exitCode = 1;

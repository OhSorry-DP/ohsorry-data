// R2 사용자 덤프 전원의 r_star를 계산한다. 기본 DRY RUN, --apply에서만 R2를 갱신한다.
// --rebase: prevRStar 래칫을 끄고 새 곡별 r★ 모델로 전체 재기준화.
import { loadPersonaResources, DIFF_INT_TO_STR } from './persona-lib.mjs';
import { getText, putIfChanged, pool } from './r2-client.mjs';

const APPLY = process.argv.includes('--apply');
const REBASE = process.argv.includes('--rebase');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.slice(8)) : Infinity;
const CONCURRENCY = 4;

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

let changed = 0, unavailable = 0, failed = 0, ratcheted = 0;
const targets = list.slice(0, LIMIT);
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
    if ((index + 1) % 25 === 0) console.log(`${index + 1}/${targets.length} 처리`);
  } catch (e) { failed++; console.error(`FAIL ${id}:`, e.message); }
});
if (APPLY && failed === 0) {
  const p = await putIfChanged('users-list.json', JSON.stringify(list));
  if (!p.ok) throw new Error(`users-list PUT 실패: ${p.msg}`);
}
console.log({ mode: APPLY ? 'APPLY' : 'DRY RUN', rebase: REBASE, users: targets.length, changed, unavailable, ratcheted, failed });
if (failed) process.exitCode = 1;

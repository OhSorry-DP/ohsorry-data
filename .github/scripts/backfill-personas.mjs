// backfill-personas.mjs — 기존 user/*.json 에 persona 필드 백필 (로컬 1회성).
//   supabase 재fetch 없이 덤프의 슬림 dp rows + songs.json(song_id 조인)으로 차트 복원 → persona-lib 재사용.
//   사용: node .github/scripts/backfill-personas.mjs   (repo 루트에서)
//
// ⚠️⚠️ **이 스크립트의 결과를 R2 에 올리지 말 것.** (CF 통합 §7 검토 2026-08-09)
//   여기서 읽고 쓰는 것은 **git 작업본**인데, dump-user 는 R2 를 매 덤프마다 / git 을 유저당 1일 1회
//   갱신하므로 **R2 가 git 보다 최신일 수 있다.** git 본을 R2 에 PUT 하면 그 유저 점수가 롤백된다.
//   → R2 서빙본의 persona 를 고치려면 반드시 **`r2-repersona.mjs`** 를 쓸 것. 그쪽은 R2 를 읽어
//     persona/spPersona 필드만 갈아끼우고 되쓴다(read-modify-write)라 점수를 건드리지 않는다.
//   이 파일은 git 작업본 정리·과거 이력 보정 용도로만 남는다.
import fs from 'node:fs';
import path from 'node:path';
import { loadPersonaResources, chartsFromGridRows, personaFor, spChartsFromGridRows, spPersonaFor } from './persona-lib.mjs';

const songs = JSON.parse(fs.readFileSync('songs.json', 'utf8'));
const songById = new Map(songs.map((s) => [s.song_id, s]));

// 슬림 row → grid row 형태 복원 (title/textage_song_id 는 songs.json 조인)
const rowsOf = (slim) => (slim || []).map((r) => {
  const s = songById.get(r.song_id);
  return s ? { title: s.title, textage_song_id: s.textage_song_id, diff: r.diff, ex_score: r.ex_score, lamp: r.lamp, bp: r.bp } : null;
}).filter(Boolean);

const FORCE = process.argv.includes('--force');   // 엔진(persona.js) 개정 후 전체 재생성용
const R = await loadPersonaResources();
const files = fs.readdirSync('user').filter((f) => f.endsWith('.json'));
let ok = 0, nul = 0, skip = 0, fail = 0, spOk = 0, spNul = 0;
for (const f of files) {
  const p = path.join('user', f);
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  const needDp = FORCE || !(data.persona && data.persona._v);
  const needSp = FORCE || !(data.spPersona && data.spPersona._v);
  if (!needDp && !needSp) { skip++; continue; }   // 웹훅으로 이미 생성됨
  try {
    if (needDp) {
      const persona = personaFor(chartsFromGridRows(rowsOf(data.dp), R.textageMeta), R);
      data.persona = persona;
      persona ? ok++ : nul++;
    }
    if (needSp) {
      const spPersona = spPersonaFor(spChartsFromGridRows(rowsOf(data.sp), R.textageMeta), R);
      data.spPersona = spPersona;
      spPersona ? spOk++ : spNul++;
    }
    fs.writeFileSync(p, JSON.stringify(data));
  } catch (e) { fail++; console.error('실패:', f, e.message); }
}
console.log(`백필 완료: DP 생성 ${ok}/null ${nul} · SP 생성 ${spOk}/null ${spNul} / skip ${skip} / 실패 ${fail} (총 ${files.length})`);

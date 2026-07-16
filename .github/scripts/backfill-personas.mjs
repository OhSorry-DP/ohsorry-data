// backfill-personas.mjs — 기존 user/*.json 에 persona 필드 백필 (로컬 1회성).
//   supabase 재fetch 없이 덤프의 슬림 dp rows + songs.json(song_id 조인)으로 차트 복원 → persona-lib 재사용.
//   사용: node .github/scripts/backfill-personas.mjs   (repo 루트에서)
import fs from 'node:fs';
import path from 'node:path';
import { loadPersonaResources, chartsFromGridRows, personaFor, spChartsFromGridRows, spPersonaFor } from './persona-lib.mjs';

const songs = JSON.parse(fs.readFileSync('songs.json', 'utf8'));
const songById = new Map(songs.map((s) => [s.song_id, s]));

// 슬림 row → grid row 형태 복원 (title/textage_song_id 는 songs.json 조인)
const rowsOf = (slim) => (slim || []).map((r) => {
  const s = songById.get(r.song_id);
  return s ? { title: s.title, textage_song_id: s.textage_song_id, diff: r.diff, ex_score: r.ex_score, lamp: r.lamp } : null;
}).filter(Boolean);

const R = await loadPersonaResources();
const files = fs.readdirSync('user').filter((f) => f.endsWith('.json'));
let ok = 0, nul = 0, skip = 0, fail = 0, spOk = 0, spNul = 0;
for (const f of files) {
  const p = path.join('user', f);
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  const needDp = !(data.persona && data.persona._v);
  const needSp = !(data.spPersona && data.spPersona._v);
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

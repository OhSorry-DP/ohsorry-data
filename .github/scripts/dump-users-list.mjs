// dump-users-list.mjs — 전체 유저 목록(웹 fetchAllUsers 출력)을 users-list.json 으로 덤프.
//   유저별 user/{id}.json(webhook)과 달리 "전 유저 집계"라 cron 으로 주기 재생성(업로드마다 X).
//   웹 fetchAllUsersUncached 와 동일 select/transform — 결과를 그대로 쓸 수 있게 동치 유지할 것.
import fs from 'node:fs';

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 없음'); process.exit(1); }
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY };

async function fetchAllUsers() {
  const out = [];
  const pageSize = 1000;
  let offset = 0;
  while (true) {
    const url = SB
      + '/rest/v1/users?select=iidx_id,dj_name,star,ereter_star,sp_rank,dp_rank,sp_cpi,sp_star,date,'
      + 'user_ohsorry_radars(play_style,notes,chord,peak,charge,scratch,soflan,phrase,jack,trill,rand)'
      + `&order=star.desc.nullslast&limit=${pageSize}&offset=${offset}`;
    const res = await fetch(url, { headers: H });
    if (!res.ok) throw new Error(`users 목록 HTTP ${res.status}`);
    const rows = await res.json();
    for (const u of rows) {
      const dp = Array.isArray(u.user_ohsorry_radars) ? u.user_ohsorry_radars.find((r) => r.play_style === 1) : null;
      u.os_pattern_score = dp ? {
        NOTES: dp.notes, CHORD: dp.chord, PEAK: dp.peak, CHARGE: dp.charge, SCRATCH: dp.scratch,
        'SOF-LAN': dp.soflan, PHRASE: dp.phrase, JACK: dp.jack, TRILL: dp.trill, RAND: dp.rand,
      } : null;
      delete u.user_ohsorry_radars;
    }
    out.push(...rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return out;
}

const list = await fetchAllUsers();
fs.writeFileSync('users-list.json', JSON.stringify(list));
console.log('users-list.json 갱신:', list.length, '명');

// songs.json — 곡 마스터(공유). 신곡이 webhook 으로 들어와도 여기서 주기 갱신(변경 시에만 commit/upload).
const songs = [];
for (let off = 0; ; off += 1000) {
  const r = await fetch(SB + `/rest/v1/songs?select=song_id,title,ac,legen,textage_song_id,series_no&order=song_id.asc&limit=1000&offset=${off}`, { headers: H });
  if (!r.ok) throw new Error(`songs HTTP ${r.status}`);
  const rows = await r.json();
  if (!Array.isArray(rows) || !rows.length) break;
  songs.push(...rows);
  if (rows.length < 1000) break;
}
fs.writeFileSync('songs.json', JSON.stringify(songs));
console.log('songs.json 갱신:', songs.length, '곡');

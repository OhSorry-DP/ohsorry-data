// dump-users-list.mjs — 전체 유저 목록(웹 fetchAllUsers 출력)을 users-list.json 으로 덤프.
//   유저별 user/{id}.json(webhook)과 달리 "전 유저 집계"라 cron 으로 주기 재생성(업로드마다 X).
//   웹 fetchAllUsersUncached 와 동일 select/transform — 결과를 그대로 쓸 수 있게 동치 유지할 것.
//
// 산출물 2종의 **주기가 다르다** (2026-08-06):
//   users-list.json — 실시간 갱신은 dump-user 가 R2 에 증분 병합(merge-user-into-list)으로 담당하고,
//                     여기서의 전체 재생성은 **1일 1회** 정합성 보정(삭제 유저 정리·증분 누락 복구)용.
//   songs.json      — 신곡 반영이 늦으면 슬림 row 의 곡메타 조인이 비어 곡명이 안 뜬다 → **30분** 유지.
//                     (거의 안 바뀌므로 워크플로의 "변경 시만 commit" 가드에 걸려 커밋은 잘 안 생긴다)
// 그래서 무엇을 만들지 인자로 고른다:
//   node dump-users-list.mjs           → 둘 다 (기존 동작 · 수동 실행 기본값)
//   node dump-users-list.mjs --songs   → songs.json 만
//   node dump-users-list.mjs --users   → users-list.json 만
import fs from 'node:fs';

const ARGV = process.argv.slice(2);
// 둘 다 지정하거나 아무것도 안 주면 → 둘 다 생성(기존 동작 유지).
const DO_USERS = !ARGV.includes('--songs') || ARGV.includes('--users');
const DO_SONGS = !ARGV.includes('--users') || ARGV.includes('--songs');

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
      + '/rest/v1/users?select=iidx_id,dj_name,star,r_star,ereter_star,sp_rank,dp_rank,sp_cpi,sp_star,date,'
      + 'user_ohsorry_radars(play_style,notes,chord,peak,charge,scratch,soflan,phrase,jack,trill,rand)'
      + `&order=star.desc.nullslast&limit=${pageSize}&offset=${offset}`;
    const res = await fetch(url, { headers: H });
    if (!res.ok) throw new Error(`users 목록 HTTP ${res.status}`);
    const rows = await res.json();
    for (const u of rows) {
      const radars = Array.isArray(u.user_ohsorry_radars) ? u.user_ohsorry_radars : [];
      // play_style 로 명시 매칭 — 배열에 SP/DP 두 행이 함께 오므로 순서에 기대면 값이 뒤섞인다.
      const pick = (ps) => {
        const r = radars.find((x) => x.play_style === ps);
        return r ? {
          NOTES: r.notes, CHORD: r.chord, PEAK: r.peak, CHARGE: r.charge, SCRATCH: r.scratch,
          'SOF-LAN': r.soflan, PHRASE: r.phrase, JACK: r.jack, TRILL: r.trill, RAND: r.rand,
        } : null;
      };
      u.os_pattern_score = pick(1);      // DP
      u.sp_pattern_score = pick(0);      // SP — 웹 SP 분석탭 피처별 랭킹/percentile 모수
      delete u.user_ohsorry_radars;
    }
    out.push(...rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return out;
}

if (DO_USERS) {
  const list = await fetchAllUsers();
  fs.writeFileSync('users-list.json', JSON.stringify(list));
  console.log('users-list.json 갱신:', list.length, '명');
} else {
  console.log('users-list.json 재생성 skip (--songs)');
}

// songs.json — 곡 마스터(공유). 신곡이 webhook 으로 들어와도 여기서 주기 갱신(변경 시에만 commit/upload).
if (DO_SONGS) {
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
} else {
  console.log('songs.json 재생성 skip (--users)');
}

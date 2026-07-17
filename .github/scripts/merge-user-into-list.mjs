// merge-user-into-list.mjs — 단일 유저 덤프(user/{id}.json)를 users-list.json 에 병합.
//   users-list.json 은 dump-users-list cron(*/5)이 전체 재생성하지만, GitHub Actions
//   cron 스로틀로 실제 실행은 1~3시간 지연됨 → 신규 유저가 목록에 한참 안 보이는 문제.
//   webhook 덤프(dump-user) 때 해당 유저 1명을 목록에도 즉시 반영해 실시간화한다.
//   (전체 정합성·삭제 유저 정리는 계속 cron 전체 재생성이 담당.)
//
//   row 형은 dump-users-list.mjs 의 fetchAllUsers 출력과 동치 유지할 것(웹 fetchAllUsers 소비).
import fs from 'node:fs';

const path = process.argv[2];
if (!path) { console.error('user/{id}.json 경로 인자 없음'); process.exit(1); }
const dump = JSON.parse(fs.readFileSync(path, 'utf8'));
const u = dump.user;
if (!u) { console.log('user 없음 — 목록 병합 skip'); process.exit(0); }

// os_pattern_score — dump 의 osPattern(user_ohsorry_radars play_style=1) 에서 10 feature 추출.
//   dump-users-list.mjs 의 nested select 추출과 동일 키.
const dp = (Array.isArray(dump.osPattern) ? dump.osPattern : []).find((r) => r.play_style === 1) || null;
const entry = {
  iidx_id: u.iidx_id, dj_name: u.dj_name, star: u.star, ereter_star: u.ereter_star,
  sp_rank: u.sp_rank, dp_rank: u.dp_rank, sp_cpi: u.sp_cpi, sp_star: u.sp_star, date: u.date,
  os_pattern_score: dp ? {
    NOTES: dp.notes, CHORD: dp.chord, PEAK: dp.peak, CHARGE: dp.charge, SCRATCH: dp.scratch,
    'SOF-LAN': dp.soflan, PHRASE: dp.phrase, JACK: dp.jack, TRILL: dp.trill, RAND: dp.rand,
  } : null,
};

let list = [];
try { list = JSON.parse(fs.readFileSync('users-list.json', 'utf8')); } catch { /* 최초/파손 → 새로 만들지 않고 빈 배열에 추가 */ }
if (!Array.isArray(list)) list = [];
const i = list.findIndex((x) => x && x.iidx_id === u.iidx_id);
if (i >= 0) list[i] = entry; else list.push(entry);  // star=null 신규는 정렬상 뒤가 맞고, 웹은 클라이언트 재정렬하므로 append 로 충분
fs.writeFileSync('users-list.json', JSON.stringify(list));
console.log('users-list 병합:', u.iidx_id, i >= 0 ? '(기존 갱신)' : '(신규 추가)', '| 총', list.length, '명');

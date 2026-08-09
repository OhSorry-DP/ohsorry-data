// dump-user.mjs — repository_dispatch(dump-user) 로 호출되는 단일 유저 덤프.
//   지정 iidx_id 유저를 supabase 에서 받아 user/{id}.json 으로 갱신(웹 fetchUserProfile 의 jsdelivr 소스).
//   ohSorryAdmin/scripts/dump-data-repo.js 의 단일유저판 — 스키마/RPC 동일하게 유지할 것.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadPersonaResources, chartsFromGridRows, personaFor, spChartsFromGridRows, spPersonaFor } from './persona-lib.mjs';

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 없음'); process.exit(1); }
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };

async function rest(pathq) {
  const r = await fetch(SB + '/rest/v1/' + pathq, { headers: H });
  if (!r.ok) throw new Error(pathq + ' HTTP ' + r.status);
  return r.json();
}
// make_update_history RPC — 최근 92일 갱신(향상) 이력 (song_id, diff, date_kst).
//   웹 ④ 연습추천 피처 recency(방치 가점/집중 감점)용. RPC 미적용(404 등)이면 null — 필드 생략(웹이 RPC fallback).
async function rpcUpdateHistory(id, ps) {
  const r = await fetch(SB + '/rest/v1/rpc/make_update_history', {
    method: 'POST', headers: H, body: JSON.stringify({ p_iidx_id: id, p_days: 92, p_play_style: ps }),
  });
  if (!r.ok) return null;
  const rows = await r.json();
  return Array.isArray(rows) ? rows : null;
}
// make_grid_data RPC — 웹 fetchGridData 와 동일(p_iidx_id, p_play_style, limit/offset 페이징).
async function rpcGrid(id, ps) {
  const out = []; let off = 0;
  while (true) {
    const r = await fetch(SB + `/rest/v1/rpc/make_grid_data?limit=1000&offset=${off}`, {
      method: 'POST', headers: H, body: JSON.stringify({ p_iidx_id: id, p_play_style: ps }),
    });
    if (!r.ok) throw new Error(`grid ${id} ps${ps} HTTP ${r.status}`);
    const rows = await r.json(); if (!Array.isArray(rows)) break;
    out.push(...rows); if (rows.length < 1000) break; off += 1000;
  }
  return out;
}
// score row 슬림 — 곡메타는 공유 songs.json 으로 분리(웹이 song_id 조인). dump-data-repo.js 와 동일 유지.
const SCORE_KEEP = ['song_id', 'diff', 'lamp', 'ex_score', 'played_version', 'date'];
const slimRow = (r) => { const o = {}; for (const k of SCORE_KEEP) if (r[k] !== undefined) o[k] = r[k]; return o; };

// ⚠️ 단일 정본 — ohSorryAdmin/scripts/dump-data-repo.js(전체·증분 덤프)가 이 함수를 import 해서 쓴다.
//   과거 dump-data-repo.js 가 같은 스키마를 따로 구현하다 persona/spPersona/dpRecent/spRecent 를 누락해,
//   수동 덤프한 유저의 리포트가 통째로 사라진 사고가 있었다(2026-08-04, 37명). 필드 추가는 여기만 고칠 것.
// opts.baseDir — persona 산출 실패 시 기존 파일에서 값을 살려오는데, 그 user/{id}.json 의 부모 경로.
//   (Action 은 repo 루트에서 실행되므로 기본값 '.', ohSorryAdmin 은 DATA_REPO 절대경로를 넘긴다)
export async function dumpUser(id, personaRes, opts = {}) {
  const baseDir = opts.baseDir || '.';
  const eid = encodeURIComponent(id);
  const [user, radars, osPattern, dp, sp, dpRecent, spRecent] = await Promise.all([
    // dbr_pw 는 비밀(공개 repo·anon 노출 금지) → 명시 컬럼만 select(select=* 금지).
    rest(`users?iidx_id=eq.${eid}&select=iidx_id,dj_name,star,ereter_star,sp_rank,dp_rank,date,native_star,sp_cpi,sp_star`),
    rest(`user_radars?iidx_id=eq.${eid}&select=*`),
    // SP(play_style=0)/DP(1) 두 행 모두 — SP 분석탭 피처별 랭킹용. 소비처(웹 osPatternFromRows·
    //   merge-user-into-list)는 반드시 play_style 로 골라 쓸 것(순서에 기대면 SP↔DP 혼입).
    rest(`user_ohsorry_radars?iidx_id=eq.${eid}&select=*`),
    rpcGrid(id, 1),
    rpcGrid(id, 0).catch(() => []),
    rpcUpdateHistory(id, 1).catch(() => null),   // DP 갱신 이력 — RPC 미적용/실패 시 null(필드 생략)
    rpcUpdateHistory(id, 0).catch(() => null),   // SP 갱신 이력 — SP 연습추천 피처 recency 용
  ]);
  // ── persona (DP)/spPersona (SP) 성향 리포트 — raw grid rows 로 슬림 전에 산출. 실패해도 덤프 자체는 계속(기존값 유지). ──
  let persona = null, spPersona = null;
  try {
    persona = personaFor(chartsFromGridRows(dp, personaRes.textageMeta), personaRes);
  } catch (e) {
    console.error('persona 산출 실패(' + id + '):', e.message);
    try { persona = JSON.parse(fs.readFileSync(`${baseDir}/user/${id}.json`, 'utf8')).persona || null; } catch { /* 기존 파일 없음 */ }
  }
  try {
    spPersona = spPersonaFor(spChartsFromGridRows(sp, personaRes.textageMeta), personaRes);
  } catch (e) {
    console.error('spPersona 산출 실패(' + id + '):', e.message);
    try { spPersona = JSON.parse(fs.readFileSync(`${baseDir}/user/${id}.json`, 'utf8')).spPersona || null; } catch { /* 기존 파일 없음 */ }
  }
  return {
    _v: new Date().toISOString(), user: user[0] || null, radars, osPattern, persona, spPersona,
    dp: dp.map(slimRow), sp: sp.map(slimRow),
    // 최근 92일 갱신 이력 [{song_id,diff,date_kst}] — ④/SP연습 피처 recency. null 이면 키 생략(웹이 RPC fallback).
    ...(dpRecent ? { dpRecent } : {}),
    ...(spRecent ? { spRecent } : {}),
  };
}

// ─── 무손실 이력 hist/{id}.json (CF 통합 §1) ──────────────────────────────────
// user/{id}.json 의 dp/sp 는 "곡별 최신 1행 · 슬림 필드"다. 스냅샷을 아무리 떠도
//   iidx_id·date_kst·play_style 이 없어 **supabase 를 복원할 수 없다.**
//   hist 는 scores 를 전 이력·전 필드로 담아 복원 원본이 된다(계획: d:/work/docs/cf-consolidation.md §1).
// - 배열형인 이유: 키 이름 반복 제거. 전 유저 기준 객체형 102MB vs 배열형 44.5MB.
// - user/{id}.json 에 합치지 않는다 — 히스토리는 랭킹모달을 열 때만 필요한데 카드 첫 로딩에
//   매번 딸려오면 응답이 느려진다.
// - DBR(played_version=-10)도 포함 — 웹 fetchDbrScores 가 이걸로 읽는다.
export const HIST_COLS = ['song_id', 'diff', 'lamp', 'ex_score', 'played_version', 'date', 'date_kst', 'play_style'];
const HIST_DATE_I = HIST_COLS.indexOf('date');

// scores 전 행 → 배열형. score_id 오름차순으로 페이징(안정 정렬이 없으면 offset 페이징이 행을 흘린다).
export async function fetchUserHist(id) {
  const eid = encodeURIComponent(id);
  const out = []; let off = 0;
  while (true) {
    const rows = await rest(`scores?iidx_id=eq.${eid}&select=${HIST_COLS.join(',')}`
      + `&order=score_id.asc&limit=1000&offset=${off}`);
    if (!Array.isArray(rows)) break;
    for (const r of rows) out.push(HIST_COLS.map((k) => (r[k] === undefined ? null : r[k])));
    if (rows.length < 1000) break; off += 1000;
  }
  return out;
}

// 변경 프로브 — 행수(count=exact, 본문은 1행뿐) + 최신 date 1행. 응답 바이트가 사실상 0 이다.
//   webhook 은 users.date 갱신만으로도 발화하므로(INF 15분 자동동기화 포함) 점수가 안 바뀐 회차가 많다.
//   프로브 없이 매번 전체 재조회하면 덤프 1회 supabase 읽기가 **+94%** 늘어난다(실측 2026-08-09:
//   현행 516KB → 1000KB, 하루 ~70회 덤프 기준 월 800MB). egress 절감이 이 파이프라인의 존재 이유라
//   그 비용을 그냥 낼 수 없다.
export async function histProbe(id) {
  const eid = encodeURIComponent(id);
  const r = await fetch(SB + `/rest/v1/scores?iidx_id=eq.${eid}&select=score_id&limit=1`, {
    headers: { ...H, Prefer: 'count=exact', Range: '0-0' },
  });
  if (!r.ok) throw new Error(`hist count ${id} HTTP ${r.status}`);
  const n = Number((r.headers.get('content-range') || '').split('/')[1]);
  const top = await rest(`scores?iidx_id=eq.${eid}&select=date&order=date.desc&limit=1`);
  return { n: Number.isFinite(n) ? n : -1, maxDate: (top && top[0] && top[0].date) || null };
}

// 기존 hist 와 프로브가 (행수, 최신 date) 둘 다 같으면 재생성 불필요로 본다.
//   scores 는 자연키 upsert 라 점수가 갱신되면 그 행의 date 가 최신으로 바뀐다 → 행수가 그대로여도
//   maxDate 로 잡힌다. 삭제는 행수로 잡힌다. (과거 date 로 덮어쓰는 재업로드만 못 잡는데,
//   그건 행수도 date 도 안 변하는 경우라 §2 스냅샷의 sanity check 영역이다.)
export function histUnchanged(prev, probe) {
  if (!probe || !Array.isArray(prev) || !prev.length || !probe.maxDate) return false;
  if (prev.length !== probe.n) return false;
  let max = null;
  for (const r of prev) { const d = r[HIST_DATE_I]; if (d && (max === null || d > max)) max = d; }
  return max === probe.maxDate;   // 둘 다 postgres 가 같은 형식으로 내주므로 문자열 비교로 충분
}

// hist 파일 갱신. file 에 R2 현재본이 미리 놓여 있으면(워크플로가 받아둠) 변경 없을 때 전체 조회를 건너뛴다.
export async function updateHistFile(id, file) {
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 없거나 깨짐 → 재생성 */ }
  let probe = null;
  try { probe = await histProbe(id); } catch (e) { console.error('hist 프로브 실패(' + id + '):', e.message); }
  if (histUnchanged(prev, probe)) return { rebuilt: false, rows: prev.length };
  const rows = await fetchUserHist(id);
  // ⚠️ 있던 이력이 0 행으로 바뀌는 건 정상 상황이 아니다(supabase 일시 오류·필터 사고).
  //    덮어쓰면 R2 의 유일한 복원 원본이 빈 파일이 되므로 기존본을 남기고 실패로 알린다.
  if (!rows.length && prev && prev.length) {
    throw new Error(`hist 급감(${id}): ${prev.length}행 → 0행 — 기존본 유지`);
  }
  fs.writeFileSync(file, JSON.stringify(rows));
  return { rebuilt: true, rows: rows.length };
}

export { loadPersonaResources };

// CLI 로 직접 실행할 때만 동작 — import 시엔 아래 블록을 타지 않는다(dump-data-repo.js 가 import 함).
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const ids = process.argv.slice(2).filter(Boolean);
  if (!ids.length) { console.error('iidx_id 인자 없음'); process.exit(1); }
  fs.mkdirSync('user', { recursive: true });
  fs.mkdirSync('hist', { recursive: true });
  const personaRes = await loadPersonaResources();
  for (const id of ids) {
    if (!/^[A-Za-z0-9]+$/.test(id)) { console.error('잘못된 iidx_id 형식:', id); process.exit(1); }
    const data = await dumpUser(id, personaRes);
    if (!data.user) { console.error('유저 없음(삭제됨?):', id); continue; }
    fs.writeFileSync(`user/${id}.json`, JSON.stringify(data));
    const h = await updateHistFile(id, `hist/${id}.json`);
    console.log('덤프:', id, '| dp', data.dp.length, 'sp', data.sp.length, '| persona', data.persona ? 'OK' : '없음', '| spPersona', data.spPersona ? 'OK' : '없음',
      '| hist', h.rows + '행', h.rebuilt ? '(재생성)' : '(변경없음)');
  }
}

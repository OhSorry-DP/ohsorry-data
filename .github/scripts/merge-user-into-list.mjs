// merge-user-into-list.mjs — 단일 유저 덤프(user/{id}.json)를 users-list.json 에 병합하고 R2 에 올린다.
//   users-list.json 은 dump-users-list 의 1일 1회 전체 재생성이 정합성을 담당하지만, 그것만으로는
//   신규 유저가 목록에 한참 안 보인다 → webhook 덤프 때 해당 유저 1명을 즉시 반영해 실시간화한다.
//
//   row 형은 dump-users-list.mjs 의 fetchAllUsers 출력과 동치 유지할 것(웹 fetchAllUsers 소비).
//
// ⚠️ read-modify-write 레이스 (2026-08-14 실증)
//   이 파일은 "R2 현재본을 읽어 → 한 명 갈아끼우고 → 통째로 PUT" 하는 구조라, 두 실행이 겹치면
//   늦게 PUT 한 쪽이 앞 실행의 갱신을 덮는다. 종전에는 워크플로가 GET 하고(병합 스텝) 한참 뒤
//   PUT 해서(업로드 스텝) 레이스 창이 수십 초로 벌어져 있었다.
//   2026-08-14 별값 백필로 386명을 한꺼번에 UPDATE 하자 webhook 이 386번 발화 → dump-user 386개가
//   동시에 돌며 **users-list 의 40.3%(253명 중 102명)가 옛 값으로 덮였다.**
//
//   그래서 이 스크립트가 GET → merge → PUT → **검증 → 재시도** 까지 전부 담당한다:
//     - 레이스 창을 최소화(GET 직후 바로 PUT)
//     - PUT 뒤 다시 읽어 내 항목이 실제로 반영됐는지 확인하고, 아니면 지수 백오프 + 지터로 재시도
//   wrangler 가 `--if-match`(조건부 PUT)를 지원하지 않아 낙관적 잠금을 못 쓴다. 검증-재시도가
//   차선이며, 재시도해도 실패하면 1일 1회 전체 재생성이 최종 보정한다.
//
// 사용: node .github/scripts/merge-user-into-list.mjs user/{id}.json [--allow-empty] [--no-upload]
//   --allow-empty : 최초 부트스트랩 전용(빈 목록에서 시작 허용)
//   --no-upload   : R2 GET/PUT 없이 로컬 users-list.json 만 병합(테스트용)
// env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID (wrangler 인증)

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const BUCKET = 'ohsorry-data';
const KEY = 'users-list.json';
const LOCAL = 'users-list.json';
const MAX_ATTEMPTS = 5;

const argPath = process.argv[2];
const ALLOW_EMPTY = process.argv.includes('--allow-empty');
const NO_UPLOAD = process.argv.includes('--no-upload');
if (!argPath) { console.error('user/{id}.json 경로 인자 없음'); process.exit(1); }

const dump = JSON.parse(fs.readFileSync(argPath, 'utf8'));
const u = dump.user;
if (!u) { console.log('user 없음 — 목록 병합 skip'); process.exit(0); }

// os_pattern_score(DP) / sp_pattern_score(SP) — dump 의 osPattern(user_ohsorry_radars 양쪽 play_style)에서 10 feature 추출.
//   dump-users-list.mjs 의 nested select 추출과 동일 키. play_style 로 명시 매칭할 것 —
//   배열에 SP/DP 두 행이 함께 오므로 순서에 기대면 SP 값이 DP 자리로 들어간다.
const radars = Array.isArray(dump.osPattern) ? dump.osPattern : [];
const pick = (ps) => {
  const r = radars.find((x) => x.play_style === ps);
  return r ? {
    NOTES: r.notes, CHORD: r.chord, PEAK: r.peak, CHARGE: r.charge, SCRATCH: r.scratch,
    'SOF-LAN': r.soflan, PHRASE: r.phrase, JACK: r.jack, TRILL: r.trill, RAND: r.rand,
  } : null;
};
const entry = {
  iidx_id: u.iidx_id, dj_name: u.dj_name, star: u.star, r_star: u.r_star, ereter_star: u.ereter_star,
  sp_rank: u.sp_rank, dp_rank: u.dp_rank, sp_cpi: u.sp_cpi, sp_star: u.sp_star, date: u.date,
  os_pattern_score: pick(1),
  sp_pattern_score: pick(0),
};

const wrangler = (args) => execFileSync('npx', ['--yes', 'wrangler@4', ...args], {
  stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
});
const r2Get = (dest) => wrangler(['r2', 'object', 'get', `${BUCKET}/${KEY}`, `--file=${dest}`, '--remote']);
const r2Put = (src) => wrangler(['r2', 'object', 'put', `${BUCKET}/${KEY}`, `--file=${src}`,
  '--content-type=application/json; charset=utf-8', '--remote']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ⚠️ 베이스가 없거나 깨졌으면 **중단한다**.
//   종전엔 빈 배열로 시작했다. git 이 데이터를 들고 있을 때는 다음 cron 전체 재생성이 복구했지만,
//   git 데이터 커밋을 중단한 뒤로는 **R2 가 유일본**이라 빈 배열을 PUT 하면 전 유저 목록이 날아간다.
function readBase() {
  let list = null;
  try { list = JSON.parse(fs.readFileSync(LOCAL, 'utf8')); } catch (e) { list = null; }
  if (!Array.isArray(list) || (!list.length && !ALLOW_EMPTY)) {
    throw new Error('users-list.json 베이스가 없거나 비었다'
      + ' — 빈 목록을 PUT 하면 전 유저가 사라진다. R2 취득 실패를 먼저 확인할 것'
      + ' (의도적 최초 생성이면 --allow-empty).');
  }
  return list;
}

function mergeInto(list) {
  const i = list.findIndex((x) => x && x.iidx_id === u.iidx_id);
  // 모듈/R2 일시 실패로 이번 덤프의 r_star가 비었어도 목록의 정상값까지 지우지 않는다.
  const mergedEntry = i >= 0 && typeof entry.r_star !== 'number' && typeof list[i].r_star === 'number'
    ? { ...entry, r_star: list[i].r_star }
    : entry;
  // star=null 신규는 정렬상 뒤가 맞고, 웹은 클라이언트 재정렬하므로 append 로 충분
  if (i >= 0) list[i] = mergedEntry; else list.push(mergedEntry);
  return { list, isNew: i < 0 };
}

async function main() {
  if (NO_UPLOAD) {
    const { list, isNew } = mergeInto(readBase());
    fs.writeFileSync(LOCAL, JSON.stringify(list));
    console.log('users-list 병합(로컬만):', u.iidx_id, isNew ? '(신규)' : '(갱신)', '| 총', list.length, '명');
    return;
  }

  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      // 지수 백오프 + 지터 — 동시 실행이 많을수록 재충돌을 흩어놓는 게 중요하다.
      const wait = Math.round((2 ** (attempt - 1)) * 400 * (0.5 + Math.random()));
      console.log(`  재시도 ${attempt}/${MAX_ATTEMPTS} — ${wait}ms 대기`);
      await sleep(wait);
    }
    try {
      // 1) 최신본 취득 — R2 원본 직접 읽기는 read-after-write 강한 일관성이라
      //    방금 다른 실행이 올린 것도 보인다. (HTTP data.iidx.in 은 Worker 엣지 캐시 60초에 걸린다)
      fs.rmSync(LOCAL, { force: true });
      r2Get(LOCAL);
      const base = readBase();
      const before = base.length;

      // 2) 병합 → 3) 즉시 PUT (창을 최소화)
      const { list, isNew } = mergeInto(base);
      fs.writeFileSync(LOCAL, JSON.stringify(list));
      r2Put(LOCAL);

      // 4) 검증 — 다시 읽어 내 항목이 살아있는지 확인한다.
      //    다른 실행이 그 사이에 덮었으면 date 가 내 것이 아니다.
      const VERIFY = 'users-list.verify.json';
      fs.rmSync(VERIFY, { force: true });
      r2Get(VERIFY);
      const after = JSON.parse(fs.readFileSync(VERIFY, 'utf8'));
      fs.rmSync(VERIFY, { force: true });
      const mine = Array.isArray(after) ? after.find((x) => x && x.iidx_id === u.iidx_id) : null;

      if (mine && mine.date === entry.date) {
        console.log('users-list 병합:', u.iidx_id, isNew ? '(신규 추가)' : '(기존 갱신)',
          `| ${before} → ${after.length} 명 | 시도 ${attempt}회`);
        return;
      }
      lastErr = new Error(`PUT 후 검증 실패 — 다른 실행이 덮었다(내 date=${entry.date}, 현재=${mine ? mine.date : '항목없음'})`);
      console.log(`  ⚠ ${lastErr.message}`);
    } catch (e) {
      lastErr = e;
      console.log(`  ⚠ 시도 ${attempt} 실패: ${e.message.split('\n')[0]}`);
    }
  }

  // 여기까지 오면 목록 반영만 실패한 것이다. 카드(user/·hist/)는 다음 스텝이 올리므로 서빙은 멀쩡하고,
  // 목록은 1일 1회 전체 재생성이 보정한다. 조용히 넘기지 말고 실패로 끝내 로그에 남긴다.
  console.error(`::error::users-list 병합 실패(${MAX_ATTEMPTS}회) — ${lastErr ? lastErr.message : '원인 불명'}.`
    + ' 목록 반영은 1일 1회 전체 재생성으로 밀린다(카드·hist 는 정상 업로드됨).');
  process.exit(1);
}

main();

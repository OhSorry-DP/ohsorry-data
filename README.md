# ohsorry-data

오소리 정적 데이터 저장소 — supabase 덤프본을 **jsdelivr CDN** 으로 서빙해 supabase egress 를 줄인다.

> ⚠️ **자동 생성 — 직접 편집 금지.** ohSorryAdmin `scripts/dump-data-repo.js` 가 supabase 에서 덤프.

## 구조
- `user/{iidx_id}.json` — 유저별 데이터. `{ _v, user, radars, osPattern, persona, dp[], sp[] }`
  - dp/sp = **슬림 score row** `{ song_id, diff, lamp, ex_score, played_version, date }` — 곡메타(title/textage_song_id/series_no/ac/legen)는 중복 제거하고 아래 `songs.json` 으로 분리. 웹이 `song_id` 로 조인.
  - persona = **DP 성향 리포트** `{ head, oneLiner, prose, report, tags[], nCharts, _v }` — 웹훅 덤프 시 [persona-lib.mjs](.github/scripts/persona-lib.mjs) 가 gist 해석엔진(persona.js/calcWeakness.js)으로 즉시 생성. 표기용: head=헤드라인 한 줄, prose=서사 요약(X/OG 카드 ≤200자), report=상세 리포트 전문(🎯🎲⚡🛠✋📝). 표본 30차트 미만이면 null.
- `songs.json` — 곡 마스터(공유) `[{ song_id, title, ac, legen, textage_song_id, series_no }]`. 웹 `getSongsCache` 가 supabase 대신 이걸 읽음. cron(5분) 갱신.
- `users-list.json` — 전 유저 목록(웹 `fetchAllUsers` 출력). **실시간 갱신은 webhook 덤프(dump-user)가 R2 에 증분 병합**([merge-user-into-list.mjs](.github/scripts/merge-user-into-list.mjs))으로 담당하고, supabase 전체 재생성은 **1일 1회 cron**(정합성 보정 — 삭제 유저 정리·증분 누락 복구)이다. 증분의 베이스는 git 이 아니라 **R2 현재본**이라, 커밋을 건너뛴 회차의 갱신도 누적된다.
- `version.json` — 전체 덤프 타임스탬프 + 유저 수
- `persona-pop.json` — persona **usernorm(인구 정규화)** 통계 `{ dp, sp }` (각 10피처 `mean`/`sd` + `_relScale`).
  `persona-lib` 이 읽어 `profile.pop` 으로 주입 → 축별 인구 편향 제거. 없으면 persona 는 종전 동작(하위호환).
  생성: ohSorryAdmin `node scripts/buildPersonaPop.js`. 유저가 크게 늘거나 피처 정의가 바뀔 때만 재실행.
  ⚠️ 웹은 이 파일을 읽지 않는다(덤프 시점 전용) — R2 업로드 대상 아님.

## 생성/갱신
- 전체: ohSorryAdmin `node scripts/dump-data-repo.js` (전체 재덤프 + `version.json` 갱신)
- 증분(수동): ohSorryAdmin `node scripts/dump-data-repo.js <iidx_id> ...`
- **자동(실시간)**: 오소리 업로드 → supabase `users` upsert → Database Webhook → vercel `api/dump-trigger`
  → `repository_dispatch(dump-user)` → 이 repo 의 `dump-user` Action 이 그 유저만 재덤프
  → **R2 PUT(매번 — 서빙)** + **git commit/push(유저당 1일 1회 — 이력)**. 2026-08-06 부터 이 둘의 주기가 다르다.
  - Action: [.github/workflows/dump-user.yml](.github/workflows/dump-user.yml) / 덤프: [.github/scripts/dump-user.mjs](.github/scripts/dump-user.mjs)
  - users upsert(업로드 시작) 가 scores 보다 ~1s 먼저지만, Action 기동 지연(수십초)이 디바운스가 되어 race 없음.

### 자동 갱신 설정 (1회)
1. **GitHub Action secrets** (이 repo Settings → Secrets and variables → Actions):
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
2. **GitHub PAT** — 이 repo 에 `repository_dispatch` 권한(Fine-grained: Contents read/write + Metadata, 또는 Actions). vercel env `GITHUB_DISPATCH_PAT` 에 등록.
3. **vercel env** (ohSorryWeb 프로젝트): `GITHUB_DISPATCH_PAT`, `WEBHOOK_SECRET`(임의 랜덤 문자열).
4. **supabase Database Webhook** (Dashboard → Database → Webhooks → New):
   - Table `users`, Events `Insert` + `Update`
   - Type `HTTP Request`, Method `POST`, URL `https://ohsorry.iidx.in/api/dump-trigger`
   - HTTP Header `x-webhook-secret: <위 WEBHOOK_SECRET 와 동일값>`

## 서빙 (Cloudflare R2 + Worker)
```
https://data.iidx.in/user/{iidx_id}.json
https://data.iidx.in/users-list.json
https://data.iidx.in/songs.json
https://data.iidx.in/version.json
```
- Worker 소스: [cf/](cf/) (`wrangler deploy`). R2 버킷 `ohsorry-data` 를 그대로 흘려보낸다.
  허용 키만 통과(임의 객체 열람·path traversal 차단), CORS + etag 304 + `Cache-Control: max-age=60`.
- **원본은 이 repo 의 git 이력이고 R2 는 서빙 사본이다.** R2 는 객체 버저닝이 없어
  덤프 로직 사고 시 복구는 git 에서 한다(persona 37명 유실 전례).
- Action 이 commit/push 후 `wrangler r2 object put` 으로 올린다 → **PUT 즉시 반영**(purge 불필요).
  `CLOUDFLARE_API_TOKEN` secret 필요(R2 Object Read & Write). 미설정이면 warning 후 skip.

> ⚠️ 종전 jsdelivr(`@main`) 는 2026-08-04 폐기. 브랜치 별칭은 "main=어느 커밋" 해석 결과를
> 12h 캐시하는데(`x-jsd-version-type: branch` / `s-maxage=43200`) purge API 는 **파일 경로만**
> 무효화해 그 별칭 캐시를 못 푼다. 그래서 push 직후 purge 를 걸면 아직 구 커밋을 물고 있던
> 오리진이 구본을 재캐시하고 최대 12h 고착된다 — 아래 변경 이력의 두 사고가 모두 이것이다.

## 변경 이력

### 2026-08-07 — persona 배치 축 usernorm (`persona-popmean.json`)

배치/무리/지구력 축의 인구 μ/σ 를 repo 루트에 싣는다. `persona-pop.json`(10피처 usernorm)과 같은 방식 — `persona-lib.mjs` 가 로컬 파일로 읽어 profile 에 `popAxes`/`popDerived` 로 주입한다.

- 없으면 persona 가 종전 raw 경로(자기중심화만)로 폴백 — 하위호환.
- ⚠️ **DP 전용**. supabase `make_grid_data`(전 레벨) DP 잔차로 잰 통계라 SP profile 에 주입하면 스케일이 어긋난다.
- 생성은 `ohSorryRating/scripts/analyze/dp/gen-persona-popmean.js` (전수 스윕 jsonl → 2-pass). 언어화 규칙·계층 구조는 ohSorryRating CHANGELOG 참조.
- 갱신 시점: 배치 축을 추가/변경했거나 유저 모집단이 크게 늘었을 때. 상시 파이프라인 아님.

### 2026-08-06 — users-list: R2 실시간 증분 + supabase 전체 재생성은 1일 1회

바로 아래 "1일 1커밋 제한"이 만든 회귀를 막고, 목록 갱신 책임을 R2 로 옮긴다.

- **문제**: `dump-user` 의 users-list 병합 베이스가 `git reset --hard origin/main` 한 **git 본**이었다.
  커밋을 건너뛴 회차의 병합분은 git 에 없으므로, 다음 다른 유저의 실행이 그걸 덮어 **R2 의 항목이
  이전 값으로 되돌아갔다**(예: A 10:00 커밋 → A 10:15 스킵/R2만 → B 10:20 커밋 시 A 가 10:00 으로 회귀).
- **해결**: [dump-user.yml](.github/workflows/dump-user.yml) 이 병합 전에 **R2 현재본**을 베이스로 받아온다
  (`wrangler r2 object get`). R2 가 누적자가 되고 git 은 하루 1스냅샷이 된다.
  - HTTP(`data.iidx.in`)가 아니라 wrangler 직접 읽기인 이유: Worker 엣지 캐시(60초)를 우회해야 하는데
    쿼리 cache-bust 가 안 통한다(캐시 키에서 쿼리를 버림 — [cf/src/index.js](cf/src/index.js)).
    R2 원본 직접 읽기는 read-after-write 강한 일관성이라 방금 다른 실행이 올린 것도 보인다.
  - ⚠️ **취득본 검증 필수** — `merge-user-into-list` 는 파싱 실패 시 빈 배열로 시작한다. 깨지거나 빈
    파일을 베이스로 넘기면 전 유저 목록이 통째로 날아간다. "JSON 배열 + 비어있지 않음"을 확인하고
    실패 시 git 본으로 폴백한다(검증됨: 파손·빈배열 둘 다 목록 보존).
- [dump-users-list.yml](.github/workflows/dump-users-list.yml): cron 을 **둘로 분리**하고
  `github.event.schedule` 로 범위를 고른다.
  - `*/30` → **songs.json 만.** 신곡 반영이 늦으면 슬림 row 의 곡메타 조인이 비어 곡명이 안 뜬다.
    songs 는 거의 안 바뀌어 "변경 시만 commit" 가드에 걸리므로 커밋은 잘 안 생긴다.
  - `5 18 * * *`(KST 03:05) → **users-list + songs 전체 재생성.** 수동 실행(workflow_dispatch)도 전체.
  - ⚠️ 전체 재생성이 도는 몇 분 사이 들어온 업로드는 덮일 수 있다(job 시작 시점의 supabase 를 읽으므로).
    다음 dump-user 증분이 복구한다.
- [dump-users-list.mjs](.github/scripts/dump-users-list.mjs): `--songs` / `--users` 인자로 산출물 선택
  (인자 없으면 종전대로 둘 다).
- `put()` errexit 버그를 이 워크플로에도 적용 — 첫 PUT 실패에서 스텝이 죽어 뒤 파일 PUT 이 통째로
  스킵되던 문제. R2 스텝 조건도 "빌드 성공"으로 바꿔 push 실패가 서빙을 막지 않게 했다.

### 2026-08-06 — user 덤프 git 커밋을 유저당 1일 1회로 제한 (R2 PUT 은 매번 유지)

- **배경**: INF 자동동기화가 15분 주기로 **조건 없이** 업로드 → `upsert_user` 가 `date=now()` 를 쓰므로
  웹훅이 매번 발화 → 커밋이 쌓였다. 실측: 최근 auto dump 커밋 125건 중 **53.6%(67건)** 가
  타임스탬프(`_v` / `persona._v` / `spPersona._v` / `user.date`) 4개만 바뀐 무의미 커밋.
- [dump-user.yml](.github/workflows/dump-user.yml): 덤프 **전에** 커밋되어 있는 `user/{id}.json` 의 `_v` 를
  KST 날짜로 환산해 오늘과 비교 → 같으면 git 커밋/push 를 skip 한다(users-list 병합은 그대로 수행해
  R2 에는 최신 목록이 올라감). 신규 유저·`_v` 없음·JSON 파싱 실패는 **fail-open**(커밋 진행).
  - `git log -- <path>` 를 안 쓰는 이유: checkout 이 shallow(depth=1)라 파일별 이력을 못 본다.
    커밋을 건너뛴 회차는 git 에 안 들어가므로 **git 의 `_v` = "마지막으로 커밋된 덤프 시각"** 이 되어
    이 판정의 기준으로 정확히 맞는다.
- **R2 PUT 은 종전대로 매 업로드마다** — 서빙 신선도는 불변(카드/목록은 계속 15분 주기로 최신).
  대신 실행 조건을 "덤프 성공"으로 바꿨다(`if: !cancelled() && steps.dump.outcome == 'success'`).
  종전엔 push 5회 실패 → `exit 1` → 기본 `if: success()` 로 **R2 스텝이 통째로 스킵**돼,
  그 유저가 다시 업로드할 때까지 R2 가 구본으로 고착됐다(2026-08-04 동시 8건 실증).
- R2 `put()` 이 첫 실패에서 스텝을 죽여 `users-list.json` PUT 이 아예 실행되지 않던 문제 수정 —
  `... || { echo warning; return 1; }` 이 기본 셸 `bash -e` 의 errexit 에 걸렸다. 이제 둘 다 시도하고
  하나라도 실패하면 스텝을 실패로 끝낸다(`::error::`).
- ⚠️ **git 과 R2 가 의도적으로 어긋난다** — R2 는 항상 최신, git 은 유저당 최대 24시간 전 스냅샷.
  덤프 로직 사고 시 git 롤백은 최대 하루치 차이가 난다(supabase 가 SSOT 라 재덤프로 복구 가능).

### 2026-08-05 — persona 전체 재생성 (📝 요약 JA/EN 서사형 번역)
- 엔진 개정([ohSorryRating `persona.js`](https://github.com/) `buildProse(x, lang)`) — 리치 리포트 📝 요약이
  ko 만 서사형 문장이고 ja/en 은 피처 나열이었다. ko 문장 구조를 그대로 옮겨 3언어 모두 문장으로.
- `backfill-personas.mjs --force` 로 **358명 전체 재생성**(DP 263 / SP 153, 실패 0).
- 검증: 변경 354파일의 리포트 diff 가 **ja/en 요약 줄 832건뿐**((263+153)×2), ko report·prose·persona 보유 인원 변동 0.
- R2 는 워크플로(단일 유저 PUT) 경로가 아니라 **로컬 일괄 PUT** 으로 반영.

### 2026-08-04 — 서빙을 jsdelivr → Cloudflare R2 + Worker (`data.iidx.in`) 로 이전
- **문제**: jsdelivr `@main` 의 별칭 해석 캐시(12h)를 purge API 로 풀 수 없어, push 직후 purge 가
  오히려 구본을 12h 고착시켰다. 2026-07-17(유저 5명)에 이어 2026-08-04 SP 랭킹 배포에서 재발 —
  DB·GitHub·jsdelivr 오리진(`@커밋해시`)은 전부 최신인데 `@main` 만 구 커밋을 가리켰다.
  재발 방지로 넣었던 `purge_verify` 5회 루프가 역설적으로 레이스를 키우고 있었다(45분 무효화 전례도 동일 원인).
- **해결**: 서빙을 R2 로 옮기고 [cf/](cf/) Worker 가 `data.iidx.in` 으로 뿌린다. 별칭 개념이 없어
  PUT 즉시 반영이고, 캐시 정책(`max-age=60` + etag 304)도 우리가 쥔다.
  Worker 는 R2 객체를 JSON 파싱 없이 스트림 pass-through 라 무료 플랜(CPU 10ms/요청)으로 충분.
- 워크플로 2종의 `purge_verify` → `wrangler r2 object put`. **git commit/push 는 그대로 유지** —
  R2 는 객체 버저닝이 없어 롤백 수단이 git 이력뿐이다.
- 초기 업로드: `user/` 358 + `users-list`/`songs`/`version` 3.
- 짝 변경: ohSorryWeb `DATA_CDN_URL` → `https://data.iidx.in/`.

### 2026-08-04 — SP 오소리 피처 스코어 덤프 (`sp_pattern_score` / osPattern 두 행)
- [dump-user.mjs](.github/scripts/dump-user.mjs): `user_ohsorry_radars` 조회에서 **`play_style=eq.1` 필터 제거** → `osPattern` 에 SP(0)/DP(1) **두 행**이 담긴다. 오소리웹 SP 분석탭의 피처별 랭킹/상대평가용.
- [merge-user-into-list.mjs](.github/scripts/merge-user-into-list.mjs) · [dump-users-list.mjs](.github/scripts/dump-users-list.mjs): users-list 엔트리에 **`sp_pattern_score`**(play_style=0 의 10 피처) 추가. 기존 `os_pattern_score`(DP)도 `play_style` **명시 매칭**으로 정리.
- ⚠️ **소비처는 반드시 `play_style` 로 골라야 한다.** 배열 순서에 기대면 SP 값이 DP 자리로 들어간다 — 웹 `osPatternFromRows` 가 `rows[0]` 을 쓰고 있어 같이 고쳤다(ohSorryWeb 2026-08-04).
- 짝 변경: ohSorry dbConn 0.0.414(SP 계산·적재), ohSorryAdmin `sql/12_sp_feature_score.sql` + `dump-data-repo.js`, ohSorryRating SP 백필.

### 2026-07-25 — users-list cron 간격 5분 → 15분 → 30분

- [dump-users-list.yml](.github/workflows/dump-users-list.yml): `*/5` → `*/15` → `*/30`.
- 이유: `*/5` 로 적혀 있어도 GitHub Actions 스로틀로 **실제 실행이 57분~4시간 49분 간격**이었다(실측 2026-07-24: 04:21 → 09:10 = 4h49m, 하루 10여 회). 워크플로 실패는 0건 — 실행 자체가 드롭된 것.
- 고빈도 `schedule` 일수록 드롭 비율이 높으므로 **간격을 낮춰 실행률을 높이는 쪽**이 실질 반영이 빠르다. 표기와 실제의 괴리도 줄어든다.
- 목록 실시간성은 이 cron 이 아니라 webhook 병합(2026-07-17 `merge-user-into-list.mjs`)이 담당한다. 이 cron 은 전체 정합성 보정용.

### 2026-07-18 — dump-user 에 dpRecent/spRecent(최근 92일 갱신 이력) 필드 추가
- [dump-user.mjs](.github/scripts/dump-user.mjs): `make_update_history` RPC(ohSorryAdmin sql/10)로 최근 92일 갱신 이력 `[{song_id,diff,date_kst}]` 을 `dpRecent`(DP, ps=1) / `spRecent`(SP, ps=0) 필드로 덤프 — 웹 ④(DP)·SP 연습추천 피처 recency(방치 가점/집중 감점)가 소비. RPC 미적용/실패 시 필드 생략(웹이 RPC fallback → 그것도 실패면 가점 0).

### 2026-07-17 — jsdelivr purge 검증-재시도 (stale 고착 방지)
- push 직후 즉시 purge 가 jsdelivr 오리진의 구 커밋을 재캐시해 **최대 12h stale 로 고착**되는 레이스 실증(유저 5명 — 서열표/카드에 신규 데이터 미반영, "하나도 안 뜸" 증상). 재purge 로 즉시 해소됨을 확인.
- [dump-user.yml](.github/workflows/dump-user.yml) / [dump-users-list.yml](.github/workflows/dump-users-list.yml): purge 후 CDN 내용 sha1 을 로컬 파일과 대조, 불일치 시 재purge(최대 5회, 5초 간격). 실패 시 warning annotation.

### 2026-07-17 — webhook 덤프 시 users-list.json 즉시 병합
- 신규 유저(특히 SP 입력)가 유저 목록에 한참 안 보이던 문제: users-list cron(`*/5`)이 GitHub Actions 스로틀로 실제 1~3시간 간격 실행되던 것이 원인(별값 계산 자체는 정상).
- [dump-user.yml](.github/workflows/dump-user.yml): 유저 덤프 push 시 [merge-user-into-list.mjs](.github/scripts/merge-user-into-list.mjs)(신규)로 해당 유저 1명을 users-list.json 에도 병합 + jsdelivr purge 추가. 목록 실시간화(전체 정합성은 기존 cron 이 계속 보정).
- push 재시도 방식 변경: rebase → **origin/main reset 후 재적용**(users-list.json 이 단일 라인 JSON 이라 동시 실행 간 rebase 병합 불가 → 충돌 자체를 회피).

# ohsorry-data

오소리 정적 데이터 저장소 — supabase 덤프본을 **jsdelivr CDN** 으로 서빙해 supabase egress 를 줄인다.

> ⚠️ **자동 생성 — 직접 편집 금지.** ohSorryAdmin `scripts/dump-data-repo.js` 가 supabase 에서 덤프.

## 구조
- `user/{iidx_id}.json` — 유저별 데이터. `{ _v, user, radars, osPattern, persona, dp[], sp[] }`
  - dp/sp = **슬림 score row** `{ song_id, diff, lamp, ex_score, played_version, date }` — 곡메타(title/textage_song_id/series_no/ac/legen)는 중복 제거하고 아래 `songs.json` 으로 분리. 웹이 `song_id` 로 조인.
  - persona = **DP 성향 리포트** `{ head, oneLiner, prose, report, tags[], nCharts, _v }` — 웹훅 덤프 시 [persona-lib.mjs](.github/scripts/persona-lib.mjs) 가 gist 해석엔진(persona.js/calcWeakness.js)으로 즉시 생성. 표기용: head=헤드라인 한 줄, prose=서사 요약(X/OG 카드 ≤200자), report=상세 리포트 전문(🎯🎲⚡🛠✋📝). 표본 30차트 미만이면 null.
- `songs.json` — 곡 마스터(공유) `[{ song_id, title, ac, legen, textage_song_id, series_no }]`. 웹 `getSongsCache` 가 supabase 대신 이걸 읽음. cron(5분) 갱신.
- `users-list.json` — 전 유저 목록(웹 `fetchAllUsers` 출력). 집계라 **cron Action(5분)** 으로 갱신 + **webhook 덤프(dump-user) 시 해당 유저 1명 즉시 병합**([merge-user-into-list.mjs](.github/scripts/merge-user-into-list.mjs) — GitHub cron 스로틀(실제 1~3시간 지연)로 신규 유저가 목록에 안 보이던 문제 대응).
- `version.json` — 전체 덤프 타임스탬프 + 유저 수
- `persona-pop.json` — persona **usernorm(인구 정규화)** 통계 `{ dp, sp }` (각 10피처 `mean`/`sd` + `_relScale`).
  `persona-lib` 이 읽어 `profile.pop` 으로 주입 → 축별 인구 편향 제거. 없으면 persona 는 종전 동작(하위호환).
  생성: ohSorryAdmin `node scripts/buildPersonaPop.js`. 유저가 크게 늘거나 피처 정의가 바뀔 때만 재실행.
  ⚠️ 웹은 이 파일을 읽지 않는다(덤프 시점 전용) — R2 업로드 대상 아님.

## 생성/갱신
- 전체: ohSorryAdmin `node scripts/dump-data-repo.js` (전체 재덤프 + `version.json` 갱신)
- 증분(수동): ohSorryAdmin `node scripts/dump-data-repo.js <iidx_id> ...`
- **자동(실시간)**: 오소리 업로드 → supabase `users` upsert → Database Webhook → vercel `api/dump-trigger`
  → `repository_dispatch(dump-user)` → 이 repo 의 `dump-user` Action 이 그 유저만 재덤프 + push + jsdelivr purge.
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

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

## 서빙 (jsdelivr)
```
https://cdn.jsdelivr.net/gh/OhSorry-DP/ohsorry-data@main/user/{iidx_id}.json
https://cdn.jsdelivr.net/gh/OhSorry-DP/ohsorry-data@main/version.json
```

## 변경 이력

### 2026-07-25 — users-list cron 간격 5분 → 15분

- [dump-users-list.yml](.github/workflows/dump-users-list.yml): `*/5` → `*/15`.
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

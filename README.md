# ohsorry-data

오소리 정적 데이터 저장소 — supabase 덤프본을 **Cloudflare R2 + Worker(`data.iidx.in`)** 로 서빙해 supabase egress 를 줄인다. (2026-08-04 jsdelivr 에서 이전 — 아래 §서빙 참고. 이 repo 는 원본·이력 보관 겸 R2 업로드 소스다.)

> ⚠️ **자동 생성 — 직접 편집 금지.** ohSorryAdmin `scripts/dump-data-repo.js` 가 supabase 에서 덤프.

## 구조
- `user/{iidx_id}.json` — 유저별 데이터. `{ _v, user, radars, osPattern, persona, dp[], sp[] }`
  - dp/sp = **슬림 score row** `{ song_id, diff, lamp, ex_score, played_version, date }` — 곡메타(title/textage_song_id/series_no/ac/legen)는 중복 제거하고 아래 `songs.json` 으로 분리. 웹이 `song_id` 로 조인.
  - persona = **DP 성향 리포트** `{ head, oneLiner, prose, report, tags[], nCharts, _v }` — 웹훅 덤프 시 [persona-lib.mjs](.github/scripts/persona-lib.mjs) 가 gist 해석엔진(persona.js/calcWeakness.js)으로 즉시 생성. 표기용: head=헤드라인 한 줄, prose=서사 요약(X/OG 카드 ≤200자), report=상세 리포트 전문(🎯🎲⚡🛠✋📝). 표본 30차트 미만이면 null.
- `hist/{iidx_id}.json` — **무손실 점수 이력**(git 에 없음 · R2 전용). `scores` 전 행·전 필드를 배열형으로:
  `[[song_id, diff, lamp, ex_score, played_version, date, date_kst, play_style], ...]`. DBR(`played_version=-10`) 포함.
  - `user/` 의 dp/sp 는 "곡별 최신 1행 · 슬림"이라 `iidx_id`·`date_kst`·`play_style` 이 없어 **supabase 복원이 안 된다.** hist 가 그 복원 원본이다(계획: `d:/work/docs/cf-consolidation.md` §1).
  - 소비처: 웹 `fetchChartScoreHistory`(랭킹모달 점수추이). `user/` 에 합치지 않은 건 카드 첫 로딩에 매번 딸려오면 느려지기 때문.
  - DBR 행도 담지만 웹 `fetchDbrScores` 는 아직 supabase 직접 조회다 — DBR 쓰기가 `users` 웹훅을 안 깨워 다음 업로드 전까지 hist 에 안 들어오기 때문(계획 §1 참고).
  - **`.gitignore` 대상** — 전 유저 44.5MB 라 커밋하면 이미 219MB 인 `.git` 을 다시 부풀린다. 롤백은 git 이 아니라 R2 스냅샷(계획 §2)이 맡는다.
  - 갱신은 **변경분만** — 덤프 때 (행수, 최신 `date`) 프로브로 R2 현재본과 대조해 같으면 `scores` 전체 재조회를 건너뛴다. 매번 전체를 읽으면 덤프 1회 supabase 읽기가 +94% 늘어난다(실측 2026-08-09).
- `snapshot/daily/YYYY-MM-DD.tar.gz` · `snapshot/monthly/YYYY-MM.tar.gz` — **백업**(git 에 없음 · R2 전용). `user/` + `hist/` + 루트 JSON 을 한 덩어리로 압축. 보존 **일별 30 + 월별 12**.
  - **R2 는 객체 버저닝이 없다** → 계획 §4 로 git 데이터 커밋을 중단하면 이게 **유일한 롤백 수단**이다. 월별만으로는 최대 한 달치를 잃으므로 일별이 필수.
  - ⚠️ **sanity check 후에만 생성** — 유실은 스냅샷으로 복구되지만 오염은 오염을 굳힌다. 직전 스냅샷 대비 유저 수·이력 행수·persona 보유 인원이 5% 넘게 줄면 만들지 않고 실패로 알린다(persona 37명 유실 전례).
  - ⚠️ **Worker 허용키가 아니다** — `data.iidx.in` 으로 서빙되지 않는다(백업이지 컨텐츠가 아니다). 접근은 wrangler/REST 로만.
  - `snapshot/index.json` = 회차별 통계(유저 수·이력 행수·persona 보유·용량). 다음 회차 sanity check 의 기준선.
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
  → **R2 PUT(매번 — 서빙)**. git 데이터 커밋은 2026-08-09 에 중단했고, 2026-09-04 에 남아 있던 파일도 추적에서 끊었다 — **이 repo 는 코드 전용이다.**
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
https://data.iidx.in/hist/{iidx_id}.json
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

### 2026-09-04 — 데이터 파일 git 추적 종료 (`user/` 380개 · 84MB)

`dump-user` 의 `checkout` 단계가 11s 였다. **워킹트리 130MB 를 매 실행 받아오고 있었다.**

2026-08-09(§4)에 데이터 **커밋**은 중단했지만 **기존 파일은 지우지 않아** 계속 체크아웃되고 있었다. 그런데 실제로는:

- `user/$ID.json` — 받아온 직후 **R2 현재본이 덮어쓴다**(체크아웃본은 낡은 사본)
- 나머지 379개 — **한 번도 안 읽는다**
- `songs.json` · `users-list.json` — `dump-users-list.mjs` 가 **supabase 에서 새로 만들어** PUT 한다. 읽는 코드 0건

즉 84MB 를 받아 1개를 덮어쓰고 379개를 버리고 있었다. `git rm -r user songs.json users-list.json version.json` — **추적 396 → 22 파일, 워킹트리 130MB → 602KB.**

**소비처 전수 확인 후 지웠다** — CF Worker(`cf/src/index.js`)는 github raw 폴백이 없고, 다른 5개 레포에도 이 repo 를 raw 로 참조하는 곳이 0건이다. 주의할 곳 둘은 이렇게 정리했다:

- [r2-repersona.mjs](.github/scripts/r2-repersona.mjs) — 대상 목록은 **R2 `users-list.json` 이 1순위**고 git `user/` 는 폴백이었다. 코드 자신이 *"§4 이후 굳은 목록이라 신규 유저가 빠질 수 있다"* 고 경고한다. 폴백이 사라지면 `::error::` 내고 중단하는데, **굳은 목록으로 조용히 도는 것보다 낫다.**
- [backfill-personas.mjs](.github/scripts/backfill-personas.mjs) — 헤더에 *"로컬 1회성 · git 작업본 정리용"* 이라 적혀 있다. 지운 파일을 다루는 스크립트라 정의상 같이 은퇴한다.

**남긴 것** — `persona-pop.json` · `persona-popmean.json` · `persona-popmean-sp.json`(합 16KB, `persona-lib` 가 읽는다) · `cf/` · `README.md`.

🔴 **히스토리는 안 지웠다.** 과거 커밋에 파일이 그대로 있어 `git checkout <commit> -- user/` 로 언제든 꺼낼 수 있고 `.git` 224MB 도 그대로다. 되돌리기는 한 줄이다.

⚠️ `.gitignore` 에 4개를 넣었다 — 워크플로가 로컬에 만드는 중간 산출물이라, 안 넣으면 누가 `git add -A` 한 번에 84MB 가 되돌아온다.

### 2026-09-04 — wrangler 제거, R2 REST 로 교체 (업로드→웹 반영 4.5배 지연 해소)

업로드 후 웹 반영이 갑자기 느려졌다. **우리 코드 변경이 아니었다.**

- `dump-user` 실행시간 **9/3 중앙값 59s → 9/4 265s**(최대 129s → 503s). 큐 대기는 0초라 잡 자체가 느려진 것.
- 단계별로 쪼개니 **`R2 user 현재본 받기` 하나가 188s → 334s** 로 전체를 지배했다. 본문은 `npx --yes wrangler@4` 다.
- 🔴 **`wrangler 4.129.0` 이 `2026-09-03T17:50:56Z` 에 배포됐다.** 그 시각으로 자르면 배포 전 36건 중앙값 **59s** / 배포 후 62건 중앙값 **261s** 로 경계가 정확히 일치한다. 패키지가 커진 게 아니다(15.17MB → 15.18MB, deps·optionalDeps·scripts 동일) — **`@4` 라는 가변 태그가 새 버전으로 해석되며 콜드 설치가 되는 것**이다.
- 🔴 **`npx` 는 잡 안에서 캐시된다.** 그래서 첫 호출만 비싸고 이후 스텝은 5~7s 였다. 즉 **한 군데라도 남기면 비용이 그쪽으로 옮겨갈 뿐**이라 전부 걷어내야 했다.

버전 고정이 아니라 **wrangler 자체를 제거**했다. 다음 릴리스에 또 터지면 안 된다.

- [dump-user.yml](.github/workflows/dump-user.yml) — GET 2곳·PUT 1곳을 `curl` R2 REST 로. [dump-users-list.yml](.github/workflows/dump-users-list.yml) — PUT 1곳.
- [merge-user-into-list.mjs](.github/scripts/merge-user-into-list.mjs) — **자체 wrangler 래퍼**(`r2-client.mjs` 를 안 쓰고 `npx` 를 직접 부르고 있었다)를 제거하고 `getText`/`putText` 로 교체. 임시 파일 경유도 같이 사라졌다.
  - 🔴 **실패 의미가 달라져 분기를 다시 맞췄다** — 종전 `r2Get` 은 모든 실패에 throw 였지만 `getText` 는 **404 만 `null`**, 나머지는 throw. `putText` 는 **throw 하지 않고 `{ok:false}` 를 반환**한다. `res.ok` 확인을 빠뜨리면 실패가 조용히 성공이 된다.
  - "베이스가 없거나 깨졌으면 중단한다" 정책과 GET→PUT→검증→재시도(5회) 구조는 **무변경**.
- 🔴 **다운로드 실패가 무음이던 것도 같이 고쳤다** — 종전 `>/dev/null 2>&1 || rm -f` 라 토큰이 죽어도 아무도 모른 채 매번 전체 재생성만 했다. **404(정상적 부재)와 401/403/5xx 를 구분**해 후자는 `::warning::` 을 남긴다.
- `users-list.json` 은 여전히 merge 스크립트만 PUT 한다(Upload 스텝은 `user/`·`hist/` 만) — 로컬 파일 쓰기가 사라져도 안전함을 확인했다.

⚠️ **남은 wrangler 사용처** — `snapshot-r2.mjs` · `r2-repersona.mjs` · `r2-client.mjs`(REST 우선, wrangler 는 폴백) 에 남아 있다. 이번 범위 밖(다른 워크플로)이지만 **같은 함정을 그대로 안고 있다.**

### 2026-08-29 — persona 성향축(점수형↔램프형)에 `star`·`r_star` 공급

`ohSorryRating/modules/persona.js` 가 같은 날 개정돼 gist·R2 배포됐다(트랙 A-2). 엔진이 「클리어 실력 대비 점수 높음/낮음」을 판정하려면 profile 에 **클리어 별값과 점수 별값이 둘 다** 실려야 하는데, 종전 이 profile 에는 `star` 조차 없었다. 사유·실측은 ohSorryRating CHANGELOG 및 `d:/work/docs/weakness-clear-vs-score.md` 참조.

- [.github/scripts/persona-lib.mjs](.github/scripts/persona-lib.mjs) — `personaFor(allCharts, R, userRow)` 로 3번째 인자(**선택**) 추가, profile 에 `star: recBaseStar(userRow)`·`rStar: userRow.r_star` 주입. `recBaseStar` 정책은 `ohSorryWeb/user/components/helpers.js` 의 `recBaseStarOf` 와 1:1(★0.5~2 는 `star` 우선, 그 외 `native_star`). `spPersonaFor` 는 손대지 않았다 — SP 는 `r_star` 가 없다.
- [.github/scripts/dump-user.mjs](.github/scripts/dump-user.mjs) — 웹훅 즉시생성 경로에 `user[0]` 전달(이미 `star,r_star,native_star` 를 조회하고 있었다).
- [.github/scripts/backfill-personas.mjs](.github/scripts/backfill-personas.mjs) · [.github/scripts/r2-repersona.mjs](.github/scripts/r2-repersona.mjs) — `data.user` 전달.

⚠️ **인자를 안 넘기면 섹션이 생략된다**(선택 인자). 그런데 DP 는 종전 문장도 함께 사라지므로, persona.js 배포만 하고 이 repo 를 늦게 푸시하면 그 사이 플레이한 유저는 스타일 줄이 빈 persona 를 받는다. **두 배포는 붙여서 할 것.**
- 기존 유저 전수 반영(`repersona-r2`)은 **돌리지 않았다** — 각자 다음 플레이 때 `dump-user` 가 갱신한다.

### 2026-08-24 — SP persona 배치축 개편 반영 (레인 의존 축 제거 + 축연타)

`ohSorryRating/modules/persona.js` 가 같은 날 개정됐다(gist 배포). SP 는 대부분 RANDOM + 고정 손배치라 정배 기준 레인 축(나선·중앙트릴·손이동)이 의미가 없어 배치 그룹에서 빠지고, RANDOM 불변인 **축연타(`AXIS_SPEED`)** 가 들어왔다. 사유·실측은 ohSorryRating CHANGELOG 참조.

- [.github/scripts/persona-lib.mjs](.github/scripts/persona-lib.mjs) `SP_LAYOUT_DEFS` 에 `AXIS_SPEED` 공급 추가 — 웹훅 즉시생성이 새 축을 못 채우면 배치 그룹이 통째로 빈다. `ohSorryRating` 의 같은 이름 상수와 1:1.
- [persona-popmean-sp.json](persona-popmean-sp.json) 교체(n=161 → 190) — 축 목록이 바뀌면 `lay.all`/`lay.groupDev` 분포가 통째로 달라진다. 구본을 두면 `AXIS_SPEED` 가 μ/σ 없이 raw 잔차로 나와 `축연타: 약함 (-7.7 편차)` 처럼 찍힌다.
- 기존 유저 반영은 `repersona-r2` 워크플로 수동 기동(persona/spPersona 필드만 read-modify-write).

### 2026-08-16 — persona 산출 경로에서 bp(미스카운트) 누락 수정

`ohSorryRating/modules/calcWeakness.js`(같은 날 개정, gist 배포됨)가 `missCount` 있는 차트에 한해 잔차를 보정하도록 바뀌었는데, 이 repo 의 persona 산출 체인은 raw row 에서 `bp` 를 읽고도 중간에서 버리고 있어 웹훅 즉시생성·백필 어느 쪽도 보정이 반영되지 않고 있었다.

- [.github/scripts/persona-lib.mjs](.github/scripts/persona-lib.mjs) `chartsFromGridRows`: 반환 차트 객체에 `missCount: r.bp` 추가.
- [.github/scripts/backfill-personas.mjs](.github/scripts/backfill-personas.mjs), [.github/scripts/r2-repersona.mjs](.github/scripts/r2-repersona.mjs) `rowsOf`: 슬림 row → grid row 복원 시 `bp` 필드 보존(누락돼 있었음).
- 확인: `scores` 테이블 기준 현재 `bp` 보유 유저는 DP/SP 합쳐 2명(`C200074777849`, `15116402`)뿐 — bp 도입 초기라 극소수.

### 2026-08-15 — scores 에 bp(미스카운트)/note_count(총 노트수) 컬럼 추가

- [dump-user.mjs](.github/scripts/dump-user.mjs): `SCORE_KEEP`/`HIST_COLS` 끝에 `bp`, `note_count` 추가 — 기존 소비처(웹 `HIST_I` 등)가 위치기반 인덱스라 배열 중간이 아닌 끝에 추가.
- **왜** — INFOhSorry(Reflux TSV 메모리 리딩)는 이미 missCount/noteCount 를 파싱하고 있었지만 supabase upsert row 에는 빠져있어 저장이 안 되고 있었다. `scores` 테이블에 두 컬럼 추가 + `upsert_scores` RPC 재정의(`ohSorryAdmin/sql/14_scores_bp_notecount.sql`, 운영 DB 적용 완료) 후 R2 덤프 파이프라인도 맞춰 반영.
- ⚠️ INFOhSorry 쪽 실제 업로드 코드(`supabaseSync.ts`)는 아직 두 값을 안 보냄 — 당장은 두 컬럼 다 NULL 로 쌓인다. 후속 작업 필요.

### 2026-08-14 — users-list 병합에 검증-재시도 도입 (동시쓰기 레이스 실증 후)

- **무슨 일이 있었나**: 별값 백필로 `users` 386명을 한꺼번에 UPDATE → Database Webhook 이 **386번 발화** → `dump-user` 386개가 동시에 실행. `users-list.json` 은 read-modify-write 라 겹친 실행끼리 서로를 덮어써 **253명 중 102명(40.3%)이 옛 값으로 고착**됐다. 목록 자체(386명·결손 0)는 온전했지만 개별 star 값이 뒤처졌다.
- **근본 원인**: 종전 워크플로는 **병합 스텝에서 GET 하고, 한참 뒤 업로드 스텝에서 PUT** 했다. 그 사이(수십 초)가 통째로 레이스 창이었다. 평소엔 동시 실행이 드물어 잘 안 터지지만, 대량 업데이트가 한 번 들어오면 40% 가 어긋난다.
- **수정** — [merge-user-into-list.mjs](.github/scripts/merge-user-into-list.mjs) 가 **GET → merge → PUT → 검증 → 재시도**를 전부 담당한다:
  - GET 직후 바로 PUT 해 **레이스 창을 최소화**
  - PUT 뒤 다시 읽어 **내 항목의 `date` 가 실제로 반영됐는지 검증**, 덮였으면 **지수 백오프 + 지터로 최대 5회 재시도**
  - 5회 모두 실패하면 `::error::` 로 남기고 종료 — 카드(`user/`·`hist/`)는 다음 스텝이 정상 업로드하므로 서빙은 멀쩡하고, 목록만 1일 1회 전체 재생성으로 밀린다
  - `--no-upload`(로컬 병합만) 옵션 추가 — 테스트용
- [dump-user.yml](.github/workflows/dump-user.yml): 병합 스텝의 `wrangler r2 object get` 제거(스크립트가 담당), **업로드 스텝의 `users-list.json` PUT 제거** — 여기서 또 올리면 검증을 통과한 최신본을 이 잡의 낡은 로컬 사본으로 되돌린다.
- ⚠️ **`wrangler` 는 `--if-match` 를 지원하지 않는다**(옵션 자체가 없음). 낙관적 잠금(조건부 PUT)을 쓰려면 S3 API 직접 호출 + 별도 Access Key 가 필요하다. 검증-재시도는 차선책이며, 완전한 상호배제가 아니다 — 최종 보정은 여전히 1일 1회 전체 재생성이 담당한다.
- 📌 **users 를 대량 UPDATE 하는 작업(백필 등)은 webhook 을 인원수만큼 발화시킨다.** 386개가 큐에 쌓여 전부 빠지는 데 40여 분이 걸렸다. 앞으로 대량 백필 시에는 이 점을 감안할 것.

### 2026-08-10 — 스코어링 마스터 칭호 기준 교체 (persona-lib)

- [persona-lib.mjs](.github/scripts/persona-lib.mjs): `maxMinusStatsOf()` 신설 — **어나더+(ANOTHER/LEGGENDARIA) 채보 중 MAX-권(스코어율 ≥ 17/18) 비율**을 DP(`c.noteCount`)/SP(`spKeymaps.noteByKey` 조회) profile 에 `maxMinusStats: { share, tot }` 로 주입(표본 <30 이면 null). 판정 자체는 persona.js(gist) 가 `share ≥ 0.70` 으로 수행 — 종전 overallResid p90 기준 폐기.
- **왜** — SP 부여율이 인구 표류로 설계(~10%)에서 17.4%까지 벌어짐. 새 기준 실측: DP 7.9% / SP 3.8%. ⚠️ ohSorryRating 의 persona.js·dump 스크립트 2종과 **4곳 산식 1:1 동기** — 반영에는 persona.js gist 재배포 + 이 repo push + 전수 백필(r2-repersona) 필요.

### 2026-08-09 — r2-client 토큰을 `CLOUDFLARE_R2_TOKEN` 우선으로

- [r2-client.mjs](.github/scripts/r2-client.mjs): REST 토큰을 `CLOUDFLARE_R2_TOKEN`(로컬 .env) 우선, 없으면 `CLOUDFLARE_API_TOKEN`(Actions 시크릿 이름)으로.
- **왜** — 로컬 `.env` 의 CF 토큰이 용도별로 3개(DNS·Pages·R2)가 되면서 이름으로 구분하게 됐다. 종전 로컬 `CLOUDFLARE_API_TOKEN` 은 DNS 토큰이라 **R2 권한이 없어**(실측 403) 로컬 실행(dump-data-repo 등)의 REST 가 조용히 실패했다. Actions 는 R2 권한 있는 토큰이 `CLOUDFLARE_API_TOKEN` 시크릿으로 등록돼 있어 **무영향**.

### 2026-08-09 — git 데이터 커밋 중단, R2 가 유일본 (CF 통합 §4)

- [dump-user.yml](.github/workflows/dump-user.yml) / [dump-users-list.yml](.github/workflows/dump-users-list.yml): **commit/push 스텝 제거.** 권한도 `contents: write` → `read`. 덤프 산출물은 R2 PUT 만 한다.
- **왜** — `.git` 이 219.7MB / 커밋 13,571개까지 불었고 계속 늘고 있었다. 롤백 수단은 이제 **R2 스냅샷**(§2, 일별 30 + 월별 12)이 맡는다. hist 가 무손실(§1)이라 오히려 복원력이 낫다. 기존 git 이력은 지우지 않는다 — 더 늘지 않을 뿐.
- `dump-user.yml` 의 **"1일 1커밋 판정" 스텝 삭제** — 커밋 자체가 없어져 판정할 것이 없다.
- ⚠️ **`merge-user-into-list.mjs` 가 빈 베이스에서 중단한다** — 종전엔 파싱 실패 시 빈 배열로 시작했다. git 이 데이터를 들고 있을 때는 cron 전체 재생성이 복구했지만, 이제 **R2 가 유일본**이라 빈 목록을 PUT 하면 전 유저가 사라진다. 워크플로도 R2 취득 실패 시 폴백 없이 중단한다(종전엔 git 본 폴백).
  - 중단해도 서빙은 멀쩡하다 — R2 의 기존 목록이 남고, 그 유저의 `user/`·`hist/` 는 다음 스텝이 올린다. 목록 반영만 다음 회차/전체 재생성으로 밀린다.
- ⚠️ **`r2-repersona.mjs` 의 대상 목록을 R2 `users-list.json` 기준으로 변경** — 종전엔 git 의 `user/` 폴더를 readdir 했는데, 커밋을 멈추면 그 폴더가 그 시점에서 굳어 **이후 가입한 유저가 영영 대상에서 빠진다.** REST probe 도 고정 키(`users-list.json`)로 옮겨 목록 취득보다 먼저 돌게 했다.
- 📌 **repo 의 `user/`·`users-list.json`·`songs.json`·`version.json` 은 이 시점의 스냅샷으로 굳는다.** 현재값이 아니다 — 현재값은 R2(`data.iidx.in`)뿐이다. 이 파일들을 소스로 R2 에 PUT 하지 말 것(유저 점수가 롤백된다).
- 검증(2026-08-09): `dump-user` 실유저 트리거·`dump-users-list` 수동 실행 모두 전 스텝 success, **git 커밋 0**, R2 만 갱신. 서빙 확인 — users-list 371명 / songs 2,216곡 / 카드 `_v` 방금 시각 / hist 3,274행 / persona 정상.

### 2026-08-09 — gist → R2 미러 워크플로 신설 (이중 배포 안전망 · CF 통합 §3)

- **[mirror-gist-r2.mjs](.github/scripts/mirror-gist-r2.mjs)** + **[mirror-gist-r2.yml](.github/workflows/mirror-gist-r2.yml)** — gist `c3da608…` 의 현재 내용을 `lib/`·`data/` 로 미러. cron `*/30`.
- **왜** — 주요 배포 경로는 공용 퍼블리셔(ohSorryAdmin `publishAsset.js`)가 gist·R2 양쪽에 동시에 올리지만, gist 를 갱신하는 생산자는 그 외에도 있다(`parseTextage`·`fetchEreterData`·`fetchZasaData`·`uploadGist`). 생산자를 하나씩 쫓으면 **새로 생길 때마다 또 놓치므로**, gist 전체를 주기적으로 흘려보내 빠짐없이 덮는다.
- **비용** — gist 메타 1회 GET 으로 `updated_at` 을 보고 직전과 같으면 **파일을 하나도 받지 않는다.** 바뀐 회차에만 전 파일을 받아 md5 를 R2 etag 와 대조하고 다른 것만 올린다. gist 는 공개라 인증도 불필요(시크릿 하나 덜 둔다).
- `--force` 는 `updated_at` 게이트를 무시한 전수 대조 — **초기 이관도 이걸로 한다**(로컬 wrangler 로 42회 스폰하는 것보다 빠르고 안전).
- 상태는 `mirror/gist-state.json`(Worker 허용키가 아니라 비공개). **실패가 있으면 상태를 갱신하지 않는다** — 갱신하면 `updated_at` 게이트에 걸려 실패분이 영영 안 올라간다.
- ⚠️ **etag 비교 시 `W/` 접두사를 벗긴다** — node fetch 가 gzip 을 요청해 CF 가 약한 검증자를 준다. 안 벗기면 매 회차 전 파일을 재업로드한다(§1 백필에서 겪은 것과 같은 함정).
- ⚠️⚠️ **gist 쓰기를 중단하는 순간(§3 ③) 이 워크플로를 반드시 끄거나 지울 것.** 그때부터 R2 가 최신이고 gist 는 화석인데, 미러가 계속 돌면 **낡은 gist 내용으로 R2 를 되돌린다.** 같은 이유로 이중 배포 기간에는 "R2 에만" 수동 업로드해서도 안 된다.
- **초기 이관 완료(2026-08-09)** — `force=true` 로 42개 전부, 실패 0, 약 3초. 검증: content-type 확장자대로, 내용 gist 와 md5 일치, `OSR13.5+.js` 정상, 비허용 키(`lib/evil.txt`·`data/*.js`·`mirror/gist-state.json`) 전부 404. 재실행 시 게이트가 걸려 파일 취득 0.
- 📌 이 시점에서 **읽는 쪽은 아직 아무도 없다** — 웹·INF 모두 gist 를 본다.

### 2026-08-09 — Worker 에 `lib/`·`data/` 허용 + 확장자별 content-type (CF 통합 §3)

- [cf/src/index.js](cf/src/index.js): 허용키에 `lib/<name>.(js|css)` · `data/<name>.json` 추가 — 종전 gist `c3da608…` 이 뿌리던 코어 JS·데이터 JSON 42개의 이전 대상. gist raw 는 `max-age=300` 고정이라 캐시를 우리가 못 쥐었는데 R2 로 오면 Worker 가 쥔다.
- **content-type 을 확장자로 결정**하도록 변경 — 종전엔 전부 `application/json` 이었다. JSON 만 서빙할 땐 맞았지만 JS·CSS 까지 그렇게 내보내면 `<link rel=stylesheet>` 같은 소비처가 깨진다.
- 파일명 문자 클래스에 `.`·`+` 를 포함 — `OSR13.5+.js`·`patterns-dp-0810.json` 이 실재한다. `..` 는 `keyOf` 가 먼저 막으므로 traversal 위험 없음.
- 배포는 ohSorryAdmin `scripts/publishAsset.js`(gist + R2 이중 배포).

### 2026-08-09 — R2 스냅샷 백업 신설 (일별 30 + 월별 12 · CF 통합 §2)

- **[snapshot-r2.mjs](.github/scripts/snapshot-r2.mjs)** + **[snapshot-r2.yml](.github/workflows/snapshot-r2.yml)** — `user/` + `hist/` + 루트 JSON 을 tar.gz 한 덩어리로 묶어 `snapshot/` 에 보관. cron **UTC 19:00 = KST 04:00**(전체 재생성 KST 03:05 직후라 정합성 보정이 반영된 상태를 담는다). KST 1일이면 monthly 도 같이 만든다 — 다운로드를 재사용하므로 추가 비용이 없다.
- **왜** — R2 는 객체 버저닝이 없다. §4 로 git 데이터 커밋을 중단하면 이게 유일한 롤백 수단이 된다. 낱개 복사가 아니라 tar.gz 인 이유는 371×2 개를 개별로 두면 Class A 요청만 늘고 관리가 번거롭기 때문.
- ⚠️ **sanity check 후에만 생성** — 직전 스냅샷(`snapshot/index.json`) 대비 유저 수·이력 행수·persona/spPersona 보유 인원이 5%(`--max-drop`) 넘게 줄면 **만들지 않고 `::error::` 로 실패**시킨다. 임계 이하 감소는 `⚠️` 로 표시만. 첫 회차엔 대조 대상이 없으므로 **`user/` 누락 비율**을 절대 가드로 따로 본다.
- **보존 정리는 객체 목록 API 를 쓰지 않는다** — 키가 날짜로 결정되므로 지울 키를 직접 계산한다(daily 는 31~40일 전, monthly 는 13~15개월 전). 실행을 한 번 걸러도 유실 없이 정리되고, 없는 키 DELETE 는 무해하다.
- R2 접근은 **REST 우선 + wrangler 폴백** — 정본 [r2-repersona.mjs](.github/scripts/r2-repersona.mjs) 와 같은 구조. GET 이 742회라 REST 가 필수다. 단 **tar.gz 단일 PUT 은 wrangler** — 호출이 1회뿐이라 스폰 비용이 무의미하고 큰 파일 멀티파트를 알아서 처리한다.
- ⚠️ `snapshot/` 은 **Worker 허용키가 아니다** — 서빙 대상이 아니라 백업이다.
- **첫 회차 실행 완료(2026-08-09)** — `snapshot/daily/2026-08-09.tar.gz`. 371명 / hist 728,388행 / persona 267 / spPersona 164, 원본 **129.0MB → 10.9MB(8%)**. 742 GET 39초, 전체 42초. 보존 정리 13/13 키 처리. 스냅샷 42개 총량 ≈ **458MB**(계획 추정 1.34GB보다 여유).
- 검증: R2 에서 되받아 압축 해제 → `user/` 371 + `hist/` 371 + 루트 JSON 3개, 총 행수·persona 수가 실행 로그와 **정확히 일치**, hist row 8필드 온전. `data.iidx.in/snapshot/...` 은 `경로 없음`(비공개 확인).
- sanity check 4개 시나리오(dry) — 동일/소폭감소(2.2%)는 통과, 이력 6.2% 급감·persona 87.5% 급감은 차단. 보존 키 계산 정확(KST 2026-08-09 기준 daily 07-10 이전 · monthly 2025-08 이전).
- ⚠️ tar 에 절대경로를 넘기지 않는다 — GNU tar 가 `C:\` 의 콜론을 원격 호스트로 읽어 죽는다(로컬 dry 실측). `cwd` + 상대경로로 통일.

### 2026-08-09 — 무손실 점수 이력 `hist/{id}.json` 신설 (R2 전용 · CF 통합 §1)

- [dump-user.mjs](.github/scripts/dump-user.mjs): `fetchUserHist` / `histProbe` / `histUnchanged` / `updateHistFile` 추가. `scores` 전 행·전 필드를 배열형 `hist/{id}.json` 으로. DBR(`played_version=-10`) 포함, `score_id` 오름차순 페이징.
- **왜** — `user/` 덤프는 곡별 최신 1행 슬림이라 스냅샷을 떠도 supabase 를 복원할 수 없다(`iidx_id`·`date_kst`·`play_style` 없음). 계획 §2 월별/일별 스냅샷이 의미를 가지려면 이게 먼저다.
- **변경분만 재생성** — (행수 `count=exact`, 최신 `date` 1행) 프로브로 R2 현재본과 대조. 응답 본문이 사실상 없어 egress ~0. webhook 은 `users.date` 갱신만으로도 발화해(INF 15분 자동동기화) 점수가 안 바뀐 회차가 많은데, 매번 전체를 읽으면 덤프 1회 supabase 읽기가 **516KB → 1000KB(+94%)** 로 늘어난다(실측 2026-08-09, 하루 ~70회 덤프 = 월 800MB).
- [dump-user.yml](.github/workflows/dump-user.yml): 덤프 전 `wrangler r2 object get` 으로 hist 현재본 취득(실패해도 무해 — 전체 재생성으로 폴백) + R2 PUT 대상에 hist 추가.
- [cf/src/index.js](cf/src/index.js): 허용키에 `hist/[A-Za-z0-9]+.json` 추가.
- `.gitignore` 에 `hist/` — 전 유저 44.5MB. 롤백 수단은 git 이 아니라 계획 §2 스냅샷.
- 있던 이력이 0행이 되면 **덮어쓰지 않고 실패**시킨다(R2 가 유일한 보관처라 빈 파일이 곧 유실).
- 검증(2026-08-09): hist 행수 == supabase `count` (3,274), 곡·난이도·스타일 유니크 1,819 == `user/` 덤프 dp+sp 1,819. DBR 상위 5명 `fetchDbrScores` 재현 결과 전원 동일. 점수추이 `playStyle` 지정 70건 전건 동일.
- 웹 소비는 점수추이(`fetchChartScoreHistory`)만 전환. `fetchDbrScores` 는 supabase 유지 — DBR 쓰기가 `users` 웹훅을 안 깨워 다음 업로드 전까지 hist 에 반영되지 않는다.

### 2026-08-08 — SP persona 잔차 기준선을 인구 rate 기준으로 전환

`spResidRows` 가 `rate − **본인의** gameLevel 평균`(self-relative)으로 재던 것을 **인구 평균 rate**(`sp-rate-reference.json` 의 `byGameLevel`) 기준으로 바꿨다. SP 유저풀이 10~20명이던 시절의 임시안이라 실력이 값에서 지워졌고, SP★16 유저에게도 "대부분의 배치가 연습이 필요하다" 가 붙었다.

- `overallResid` 는 잔차 평균으로 통합(종전엔 여기서만 따로 계산). 이제 `feats`/`layoutProfile`/`muriProfile`/`bpmProfile`/`kensei`/스크·키리듬이 전부 인구 기준 위에 선다.
- ⚠️ `ohSorryRating/scripts/analyze/sp/dump-sp-user-personas.js` 의 `spResidRows` 와 **1:1 동기**. 한쪽만 바꾸면 분석본과 서빙본이 조용히 갈린다.
- `persona-popmean-sp.json` 은 이 기준으로 재생성한 것으로 교체(축 μ −0.4~−2.0 → −1.0~−3.0). 스케일이 다르니 **둘을 섞으면 안 된다**.
- 검증(161명): 전반 판정별 SP★ 중앙값 `골고루 12.40 / 무난 7.40 / 연습 필요 3.20`, `overallResid ↔ SP★ r = 0.782`.
- ⚠️ **`persona-pop.json` 의 sp 도 같이 재생성해야 한다**(10피처 usernorm). 기준선이 바뀌면 축 분포가 통째로 달라진다 — 실측 SP `sd 0.16 → 10.34`(65배). 옛 sd 로 새 잔차를 나누면 z 가 65배로 뻥튀기돼 `물량(-63.1, 압도적)` 같은 값이 나온다(스모크에서 잡았다). 생성은 `ohSorryAdmin/scripts/buildPersonaPop.js`. DP 는 기준선 무변경이라 `_relSd 4.844 → 4.841` 로 사실상 그대로.

### 2026-08-08 — persona 배치 그룹 재편에 맞춰 popmean 2종 재생성

ohSorryRating 이 배치 `배치·리듬`(기타 묶음) 그룹을 **손이동·고속반복·피크 중 동시치기 3개 그룹**으로 쪼개면서 파생 키가 바뀌었다. 그 산출물을 여기로 옮긴다.

- `persona-popmean.json` (DP) — n 265→**266**. `lay.jumpwide`·`lay.loopfast`·`lay.peakchord` 신설, 구 `lay.etc` 제거. `lay.groupDev` σ 0.159→0.183(그룹 수 4→6).
- `persona-popmean-sp.json` (SP) — n 159→**160**. `lay.spjump`·`lay.sploop`·`lay.sppeak` 신설.
- 두 파일 모두 **전수 재덤프 후** 생성했다(DP 266명 / SP 160명). ⚠️ 부분 덤프로 돌리면 `MIN_USERS`(30) 미달로 전 축이 빈 파일이 나온다.
- 기존 유저 반영은 `repersona-r2` 워크플로(persona.js gist 갱신 후 실행).

### 2026-08-08 — SP persona 배치 섹션 + `persona-popmean-sp.json`

`spPersonaFor` 에 `layoutProfile`(SP 배치 9축)을 붙이고 SP 전용 usernorm baseline 을 싣는다.

- ⚠️ **`persona-popmean.json`(DP)과 절대 섞지 말 것** — 실측 μ 부호가 반대(SP 음수 / DP 양수)고 σ 스케일이 5배 차이난다. SP 는 gl-mean 중심 self-relative, DP 는 rateRef 절대 잔차라서다. 그래서 파일과 주입 필드(`popmeanSp`)를 분리했다.
- `SP_LAYOUT_DEFS` 는 **3곳 동기화** — 여기 / `ohSorryRating/scripts/analyze/sp/dump-sp-user-personas.js` / `ohSorryRating/modules/persona.js`(그룹).
- 생성은 `gen-persona-popmean.js <sp-user-personas.jsonl> --sp`.

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

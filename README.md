# ohsorry-data

오소리 정적 데이터 저장소 — supabase 덤프본을 **jsdelivr CDN** 으로 서빙해 supabase egress 를 줄인다.

> ⚠️ **자동 생성 — 직접 편집 금지.** ohSorryAdmin `scripts/dump-data-repo.js` 가 supabase 에서 덤프.

## 구조
- `user/{iidx_id}.json` — 유저별 데이터. `{ _v, user, radars, osPattern, dp[], sp[] }`
  - dp/sp = **슬림 score row** `{ song_id, diff, lamp, ex_score, played_version, date }` — 곡메타(title/textage_song_id/series_no/ac/legen)는 중복 제거하고 아래 `songs.json` 으로 분리. 웹이 `song_id` 로 조인.
- `songs.json` — 곡 마스터(공유) `[{ song_id, title, ac, legen, textage_song_id, series_no }]`. 웹 `getSongsCache` 가 supabase 대신 이걸 읽음. cron(5분) 갱신.
- `users-list.json` — 전 유저 목록(웹 `fetchAllUsers` 출력). 집계라 **cron Action(5분)** 으로 갱신.
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

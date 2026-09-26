// ohsorry-data 서빙 Worker — R2 의 정적 덤프를 data.iidx.in 으로 뿌린다.
//
// 왜 jsdelivr 를 떠났나:
//   jsdelivr 의 `@main` 은 가변 포인터라 "main = 어느 커밋" 해석 결과를 12h 캐시한다
//   (응답 헤더 x-jsd-version-type: branch / s-maxage=43200). purge API 는 **파일 경로**만
//   무효화하고 이 별칭 해석 캐시는 건드리지 못한다. 그래서 push 직후 purge 를 걸면
//   아직 구 커밋을 물고 있던 오리진이 구본을 재캐시하고 최대 12h 고착된다
//   (2026-07-17 유저 5명 / 2026-08-04 users-list SP 랭킹 — 두 번 실증).
//   → 캐시 정책을 우리가 쥐려고 R2 직접 서빙으로 옮겼다. 여기엔 별칭 개념 자체가 없다.
//
// 하는 일은 R2 객체를 그대로 흘려보내는 것뿐이다(JSON 파싱 안 함). CPU 를 거의 안 써서
// Workers 무료 플랜(요청당 CPU 10ms)으로 충분하다.
//
// 원본은 이 repo 의 git. Action 이 commit/push 후 같은 파일을 R2 에 올린다.

const ALLOWED_ROOT = new Set(['users-list.json', 'users-list-slim.json', 'songs.json', 'version.json']);
const USER_RE = /^user\/[A-Za-z0-9]+\.json$/;
// hist/{id}.json — 무손실 점수 이력(scores 전 행·전 필드 배열형). 웹 랭킹모달의 점수 추이 그래프 소스이자,
//   user/ 슬림 덤프로는 불가능한 supabase 복원의 원본이다.
//   user/ 와 분리한 이유: 카드 첫 로딩에 딸려오면 응답이 느려지는데, 정작 필요한 건 모달을 열 때뿐이다.
const HIST_RE = /^hist\/[A-Za-z0-9]+\.json$/;
// lib/ · data/ — 종전 gist `c3da608…` 이 뿌리던 코어 JS·데이터 JSON (CF 통합 §3).
//   gist raw 는 `max-age=300` 고정이라 캐시를 우리가 못 쥐었다. R2 로 옮기면 Worker 가 쥔다.
//   파일명에 `.`·`+` 가 들어가는 것이 실재한다(`OSR13.5+.js`, `patterns-dp-0810.json`) → 문자 클래스에 포함.
//   `..` 는 위 keyOf 가 먼저 막으므로 여기서 `.` 을 허용해도 traversal 이 되지 않는다.
const LIB_RE = /^lib\/[A-Za-z0-9._+-]+\.(js|css)$/;
const DATA_RE = /^data\/[A-Za-z0-9._+-]+\.json$/;

// 확장자별 content-type. 종전엔 전부 application/json 으로 내보냈는데, JSON 만 서빙할 때는
//   맞았지만 lib/ 의 JS·CSS 까지 그렇게 내보내면 `<link rel=stylesheet>` 같은 소비처가 깨진다.
const CT = {
  js: 'application/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
};
const contentTypeOf = (key) => CT[key.slice(key.lastIndexOf('.') + 1).toLowerCase()] || 'application/octet-stream';

// 브라우저 캐시는 짧게 — 덤프는 webhook 으로 수시 갱신되므로 신선도가 우선.
//
// 🔴 **엣지 TTL 을 키에 따라 가른다**(2026-09-17). 종전에는 `public, max-age=60` **하나를 모든 키에**
//    똑같이 줬고 `s-maxage` 가 없어 **엣지 TTL 도 60초**였다 — `caches.default` 를 쓰고 있었는데도
//    사실상 매 요청이 R2 원본까지 갔다.
//
// 🔴 **왜 30일이 아니라 1시간인가 — purge 가 불가능하기 때문이다.** (CF 문서 실측, 2026-09-17)
//    ⓐ Cache API(`caches.default`)는 **콜로별**이다 —
//       「the contents of the cache do not replicate outside of the originating data center」
//       「`cache.delete` only purges content of the cache in the data center that the Worker was invoked」
//    ⓑ **존 단위 URL purge 는 `caches.default` 에 안 먹는다**(purge-by-URL 미지원).
//    ⓒ 전역 purge 가 되는 `ctx.cache.purge()` 는 **Workers Caching** 이라는 *다른 저장소* 용이고
//       Cache API 와 서로 영향을 주지 않는다.
//    ⇒ **무효화 수단이 없으므로 TTL 이 곧 최대 낡음이다.** 30일을 걸면 30일 낡은 것이 나갈 수 있다.
//    📌 더 길게 가려면 Worker 를 Cache API → **Workers Caching** 으로 옮기고 Cache-Tag + `cache.purge()`
//       를 써야 한다. 별건이고 「Workers Caching 활성화」가 선행 조건이다.
//
//   | 키 | 누가 쓰나 | 엣지 TTL | 근거 |
//   |---|---|---|---|
//   | `lib/` · `data/`  | 사람이 `publishAsset.js` 로 · `mirror-gist-r2.mjs`(30분, diff 시에만) | **1시간** | 사람이 올릴 때만 바뀐다. 최대 1시간 낡음을 감수. 이 무리가 **용량의 대부분**이다(`data/ohSorryRating.json` raw 2.15MB · `data/feature-scores-slim.json` 압축 1.17MB · `data/textage-meta.json`) |
//   | `songs.json`      | `dump-users-list.mjs`(30분, diff 게이트 없이 매번 PUT) | 60초 | 🔴 **신선도가 목적인 자산이다** — 신곡이 늦으면 슬림 row 의 곡메타 조인이 비어 **곡명이 안 뜬다**(그 스크립트 주석). 30분 주기에 캐시를 더하면 최악 낡음이 배가 된다 |
//   | `users-list.json` | 유저 활동마다 증분(`merge-user-into-list.mjs`) | 60초 | 진짜 고회전 |
//   | `users-list-slim.json` | `users-list.json` 과 **같은 생산자·같은 시점**(증분·전체 재생성 양쪽) | 60초 | 본체와 같은 회전이다. 🔴 본체와 TTL 을 다르게 두지 마라 — v3 검색이 랭킹보다 낡은 명단을 보게 된다 |
//   | `user/` · `hist/` | 유저별 덤프(`dump-user.yml`) | 60초 | 유저별. 업로드 직후 반영돼야 한다 |
//
// ⚠️ `version.json` 은 **R2 에 쓰는 코드가 없다**(죽은 키). 분류에서 뺀다.
// ⚠️ 브라우저 `max-age` 는 **전부 60초 그대로** 둔다 — 엣지만 길게 잡는다.
const BROWSER_MAX_AGE = 60;
const EDGE_LONG = 3600;   // 1시간. 🔴 올리기 전에 위 「purge 가 불가능하다」를 먼저 읽어라.

// 🔴 `songs.json` 을 여기 넣지 마라 — 위 표의 근거 참조.
const LONG_CACHE_PREFIX = ['lib/', 'data/'];

function cacheControlFor(key) {
  const long = LONG_CACHE_PREFIX.some((p) => key.startsWith(p));
  return long
    ? `public, max-age=${BROWSER_MAX_AGE}, s-maxage=${EDGE_LONG}`
    : `public, max-age=${BROWSER_MAX_AGE}`;
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,HEAD,OPTIONS',
    'access-control-allow-headers': 'content-type,if-none-match',
    'access-control-expose-headers': 'etag',
    'access-control-max-age': '86400',
  };
}

function notFound(msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status: 404,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders() },
  });
}

// 허용 키만 통과 — path traversal(`..`, 인코딩 우회)과 임의 객체 열람 차단.
function keyOf(pathname) {
  const key = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (key.includes('..') || key.includes('//')) return null;
  if (ALLOWED_ROOT.has(key)) return key;
  if (USER_RE.test(key)) return key;
  if (HIST_RE.test(key)) return key;
  if (LIB_RE.test(key)) return key;
  if (DATA_RE.test(key)) return key;
  return null;
}

// ── 동일 IP 연속 접속 감속 (2026-09-24) ───────────────────────────────────────
//
// 🔴 **막지 않는다 — 늦출 뿐이다.** 429 를 주면 정상 사용자가 화면을 못 보는데,
//    이 워커가 뿌리는 것은 화면을 그리는 데 *반드시* 필요한 데이터다.
//    반면 대량 수집은 **시간당 처리량**이 전부라, 한 건에 몇 초를 더하면 채산이 무너진다.
//
// 🔴 **왜 여기냐** — 이 워커는 `caches.default` 를 *자기 안에서* 쓴다.
//    즉 **캐시 히트든 미스든 모든 요청이 이 코드를 지나간다** ⇒ 연속 접속이 실제로 세어진다.
//    ⚠️ 오소리웹(CF Pages)에 걸어도 소용없다 — 데이터가 거기 있지 않다.
//
// 🔴 **저장소를 새로 두지 않는다.** CF 네이티브 Rate Limiting 바인딩이라
//    KV·Durable Object 가 필요 없다(= 추가 비용 0, 지연 사실상 0).
//    ⚠️ **콜로(데이터센터)별로 센다** — 전 세계 합계가 아니다. 한 사람이 한 콜로를 쓰는 한 유효하다.
//
// ⚠️ **한도는 추정값이다.** 실제 정상 사용 분포를 재고 넣은 것이 아니다.
//    그래서 **막지 않고 늦추는** 설계를 골랐다 — 숫자가 틀려도 최악이 「좀 느리다」에 그친다.
//    🔴 숫자를 조일 거면 먼저 재라. 월요일에 500명이 들어온 전례가 있다(평소 30명).
//
// ⚠️ **결정된 수집가는 못 막는다** — IP 를 돌리면 그만이다. 이것은 **채산을 깎는 장치**지 봉쇄가 아니다.

// 🔴🔴 **지연은 창(window)보다 *짧아야* 한다 — 안 그러면 지연이 스스로 창을 비운다.**
//    2026-09-24 라이브 실측: 두 단계 다 10초로 두었더니 **130건에 지연이 5번**밖에 안 걸렸고
//    실효 감속이 **3.4배**에 그쳤다. 10초 자는 동안 BURST 창(10초)이 통째로 흘러
//    카운터가 리셋됐기 때문이다. ⚠️ **시뮬레이션은 이것을 못 잡았다** — 지연만큼 시계를 안 돌렸다.
//    🔴 「배포됐다」와 「동작한다」는 다르다. 반드시 라이브로 재라.
//
// 🔴 2026-09-26 — 공용 자산(songs/data/lib) 감속을 **뺐다.** 전 경로 공통 한도(RL_BURST 25/10초 → +3초,
//    RL_STEADY 90/60초 → +10초)가 정상 사용자를 때렸다: v3 Recs·DBR 첫 진입이 공용 자산 15~19건을 받고
//    순차 await 단계마다 지연이 쌓여 **첫 진입 20초+**(사용자 실측, 느린 응답 TTFB 가 3초 근처로 몰림).
//    IP 단위라 한 공유기 뒤 기기가 전부 한 바구니다. 공용 자산은 공개 레포(ohsorry-data)에도 그대로 있어
//    늦출 이유가 약하다. ⇒ 브레이크는 열거 경로(RL_ENUM)에만 둔다. 공용 자산 한도를 되살리지 마라.
const ENUM_MS = 10000;       // 열거 경로 초과 — 유저 덤프 순회. 사람은 여기 거의 안 닿는다

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 🔴 `CF-Connecting-IP` 가 없으면 **감속하지 않는다.** 없을 때 한 바구니(`unknown`)에 몰면
//    서로 남남인 요청들이 같은 한도를 나눠 쓰게 되어 **무고한 감속**이 난다.
//    「모른다」와 「같다」를 섞지 않는다.
function ipOf(req) {
  return req.headers.get('CF-Connecting-IP') || null;
}

// 초과했으면 대기 시간(ms), 아니면 0. 🔴 **바인딩이 없으면 0 을 준다** —
//    감속 장치가 없다고 서빙이 죽으면 안 된다(이건 방어지 기능이 아니다).
// 🔴🔴 **열거 경로와 공용 자산을 가른다 — 이것이 이 장치의 핵심이다.**
//    2026-09-24 라이브 실측으로 알게 된 것: **지연을 얼마로 주든 처리량 상한은 `한도 ÷ 창` 으로 고정된다.**
//    STEADY 90/60초 = 1.5 req/s 이고 무제한이 6 req/s 였으니 **딱 4배**다(실측 3.8배와 일치).
//    ⇒ **지연 길이는 사실상 무의미하고, 한도를 내리면 정상 사용자가 걸린다.** 막다른 길이다.
//
//    빠져나갈 길은 **비대칭**뿐이다:
//      · 공용 자산(songs/data/lib) — 사람도 한 화면에 **19건**을 받는다. 조이면 안 된다.
//      · 유저 덤프(user/·hist/·users-list) — 사람은 한 화면에 **1~2건**, 수집기는 **유저 수만큼**.
//    ⇒ **열거 경로에만 강하게 건다.** 사람은 분당 10명을 열어보지 않는다.
//
// 🔴 `users-list*` 도 열거에 넣는다 — 그것이 **수집기의 진입점**이다(한 번 받으면 전 유저 ID 를 안다).
function isEnumerationKey(key) {
  return USER_RE.test(key) || HIST_RE.test(key)
      || key === 'users-list.json' || key === 'users-list-slim.json';
}

async function throttleDelay(req, env, key) {
  const ip = ipOf(req);
  if (!ip) return 0;
  if (!isEnumerationKey(key)) return 0;
  try {
    // 열거 경로만 감속한다(위에서 공용 자산은 이미 0 으로 돌려보냈다). 사람은 거의 안 닿는다.
    if (env.RL_ENUM && !(await env.RL_ENUM.limit({ key: ip })).success) {
      return ENUM_MS;
    }
  } catch (e) {
    return 0;   // 바인딩 이상 — 감속을 포기하고 서빙은 계속한다
  }
  return 0;
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: corsHeaders() });
    }

    const url = new URL(req.url);
    const key = keyOf(url.pathname);
    if (!key) return notFound('경로 없음');

    // 🔴 **캐시 조회 *전* 에 건다.** 뒤에 두면 캐시 히트가 세어지지 않아
    //    연타의 대부분(같은 파일 반복 요청)을 놓친다.
    const delayMs = await throttleDelay(req, env, key);
    if (delayMs) await sleep(delayMs);

    // 엣지 캐시 — 쿼리스트링은 키에서 무시(캐시 파편화 방지). 웹이 붙이는 cache-bust 도 같은 객체를 본다.
    const cacheKey = new Request(url.origin + '/' + key, req);
    const cache = caches.default;
    // purge는 콜로별 Cache API에서 URL 단위로 지원되지 않으므로, R2 원본을 직접 읽어 우회한다.
    // R2 Class B 읽기와 egress 폭증을 막기 위해 고회전·소용량인 user/hist와 users-list만 허용한다.
    const fresh = url.searchParams.get('fresh') === '1'
      && (USER_RE.test(key) || HIST_RE.test(key) || key === 'users-list.json' || key === 'users-list-slim.json');
    if (!fresh) {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    }

    const obj = await env.DATA.get(key);
    if (!obj) return notFound('덤프 없음: ' + key);

    // R2 etag 로 조건부 요청 지원 — 브라우저 재검증 시 304 로 본문 전송을 없앤다.
    const inm = req.headers.get('if-none-match');
    if (inm && inm === obj.httpEtag) {
      return new Response(null, {
        status: 304,
        headers: { etag: obj.httpEtag, 'cache-control': cacheControlFor(key), ...corsHeaders() },
      });
    }

    const res = new Response(obj.body, {
      headers: {
        'content-type': contentTypeOf(key),
        'cache-control': cacheControlFor(key),
        etag: obj.httpEtag,
        ...corsHeaders(),
      },
    });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  },
};

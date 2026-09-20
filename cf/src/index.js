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

const ALLOWED_ROOT = new Set(['users-list.json', 'songs.json', 'version.json']);
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

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: corsHeaders() });
    }

    const url = new URL(req.url);
    const key = keyOf(url.pathname);
    if (!key) return notFound('경로 없음');

    // 엣지 캐시 — 쿼리스트링은 키에서 무시(캐시 파편화 방지). 웹이 붙이는 cache-bust 도 같은 객체를 본다.
    const cacheKey = new Request(url.origin + '/' + key, req);
    const cache = caches.default;
    // purge는 콜로별 Cache API에서 URL 단위로 지원되지 않으므로, R2 원본을 직접 읽어 우회한다.
    // R2 Class B 읽기와 egress 폭증을 막기 위해 고회전·소용량인 user/hist와 users-list만 허용한다.
    const fresh = url.searchParams.get('fresh') === '1'
      && (USER_RE.test(key) || HIST_RE.test(key) || key === 'users-list.json');
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

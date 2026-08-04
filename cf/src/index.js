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

// 브라우저 캐시는 짧게 — 덤프는 webhook 으로 수시 갱신되므로 신선도가 우선.
//   엣지(Cache API)도 같은 값으로 두어 R2 Class B 읽기를 줄인다.
const CACHE_CONTROL = 'public, max-age=60';

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
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    const obj = await env.DATA.get(key);
    if (!obj) return notFound('덤프 없음: ' + key);

    // R2 etag 로 조건부 요청 지원 — 브라우저 재검증 시 304 로 본문 전송을 없앤다.
    const inm = req.headers.get('if-none-match');
    if (inm && inm === obj.httpEtag) {
      return new Response(null, {
        status: 304,
        headers: { etag: obj.httpEtag, 'cache-control': CACHE_CONTROL, ...corsHeaders() },
      });
    }

    const res = new Response(obj.body, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': CACHE_CONTROL,
        etag: obj.httpEtag,
        ...corsHeaders(),
      },
    });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  },
};

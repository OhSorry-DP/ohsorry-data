// mirror-gist-r2.mjs — gist 2개(GIST_TARGETS)의 현재 내용을 R2(`lib/`·`data/`)로 미러
//   ① `c3da608…`(코드번들+대용량 JSON, CF 통합 §3 이중 배포 안전망, 전 파일) — 아래 "왜 미러가 필요한가" 참고.
//   ② `30c3ba6f…`(운영 메타 gist)의 series-name.json·service-status.json 만 — 브라우저 직결 익명 fetch 가
//      GitHub 쪽 429 로 막히기 시작해(2026-08-17) R2 CDN 경유로 안정화. gist 는 계속 수동편집 정본, 이 미러가
//      30분 cron 으로 뒤따라 R2 를 갱신(GIST_TARGETS 의 `only` 로 이 2파일만 필터).
//
// 왜 미러가 필요한가(① 기준):
//   §3 은 gist 파일 42개를 R2 로 옮기는데, INFOhSorry 구버전이 계속 gist 를 보므로 당분간 **양쪽을
//   같은 내용으로 유지**해야 한다. 주요 배포 경로는 공용 퍼블리셔(ohSorryAdmin/scripts/publishAsset.js)가
//   양쪽에 동시에 올리지만, gist 를 갱신하는 생산자는 그 외에도 있다 —
//   `parseTextage.js`(textage-meta) · `fetchEreterData.js`(ereter-data) · `fetchZasaData.js`(zasa-data) ·
//   `uploadGist.js`(범용). 이들을 하나씩 고치면 **앞으로 새 생산자가 생길 때마다 또 놓친다.**
//   그래서 생산자를 쫓는 대신 gist 전체를 주기적으로 R2 로 흘려보내 빠짐없이 덮는다.
//
// ⚠️⚠️ **gist 쓰기를 중단하는 순간(§3 ③) 이 워크플로를 반드시 끄거나 지울 것.**
//   그때부터는 R2 가 최신이고 gist 가 화석이 되는데, 미러가 계속 돌면 **낡은 gist 내용으로 R2 를
//   되돌린다.** 같은 이유로 이중 배포 기간에도 "R2 에만" 수동 업로드하면 안 된다(다음 미러가 되돌린다).
//
// 비용 설계:
//   gist 메타 1회 GET 으로 `updated_at` 을 보고, 직전과 같으면 **파일을 하나도 받지 않고 끝낸다.**
//   바뀌었을 때만 전 파일을 받아 md5 를 R2 etag 와 대조하고 **다른 것만** 올린다.
//   (파일별 크기 비교로 더 아끼려 해봐야 같은 크기 수정을 놓치므로, 변경 회차에만 전수 대조가 맞다.)
//
// 사용: node .github/scripts/mirror-gist-r2.mjs [--dry] [--force] [--concurrency=N]
//   --force = updated_at 게이트 무시하고 전수 대조(상태 파일이 어긋났을 때 복구용)

import crypto from 'node:crypto';

const BUCKET = 'ohsorry-data';
const CDN = 'https://data.iidx.in/';

// gist 에만 남는 파일 — 이관 대상이 아니다(publishAsset.js 의 GIST_ONLY 와 같은 목록).
//   ohsorry.js = 북마클릿 본체(사용자 즐겨찾기에 raw URL 이 박혀 회수 불가) · 2-calc-score.js = 그 구버전 redirect.
const GIST_ONLY = new Set(['ohsorry.js', '2-calc-score.js']);

// 미러 대상 gist 목록 — 상태 파일(mirror/…)이 gist 별로 따로 있어야 updated_at 게이트가 서로 안 섞인다.
//   ⚠ 상태 파일 키는 Worker 허용키가 아니라 공개되지 않는다(`mirror/` 는 allowlist 에 없음).
const GIST_TARGETS = [
  {
    // 코드번들 + 대용량 JSON 데이터 gist(§3 이중 배포 안전망 본래 대상). 전 파일 미러.
    id: 'c3da608194c44f431abd2f1a7a4a9f5e',
    stateKey: 'mirror/gist-state.json',
    only: null,
  },
  {
    // 운영용 메타 gist(offsets/series-name/service-status/view-count-map). 이 중 브라우저가 직접
    // 읽는 두 파일만 R2 로도 미러 — GitHub gist raw 익명 요청이 429 로 막히기 시작해(2026-08-17) 안정화.
    // offsets.json(INF 전용) · view-count-map.json(동결·미사용)은 미러 대상 아님.
    id: '30c3ba6f87df9847291c42ea216a8d2a',
    stateKey: 'mirror/gist-state-ops.json',
    only: new Set(['series-name.json', 'service-status.json']),
  },
];

const arg = (n, d = null) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');
const CONC = Number(arg('concurrency', '6'));

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!ACCOUNT || !TOKEN) { console.error('::error::CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN 없음'); process.exit(1); }
const REST_BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets/${BUCKET}/objects/`;

// 429/5xx 재시도 — 정본 r2-repersona.mjs 와 같은 구조.
async function restFetch(key, init, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(REST_BASE + key, {
      ...init,
      headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) },
    });
    if (r.status === 429 || r.status >= 500) {
      if (i === tries - 1) return r;
      await new Promise((s) => setTimeout(s, 500 * (i + 1) * (i + 1)));
      continue;
    }
    return r;
  }
}
async function r2GetText(key) {
  const r = await restFetch(key, { method: 'GET' });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`R2 GET ${key} — HTTP ${r.status}`);
  return await r.text();
}
async function r2Put(key, body, contentType) {
  const r = await restFetch(key, { method: 'PUT', body, headers: { 'Content-Type': contentType } });
  return r.ok ? { ok: true } : { ok: false, msg: `HTTP ${r.status} ${(await r.text()).slice(0, 200)}` };
}

// 배치 규칙 — Worker 허용키(cf/src/index.js LIB_RE/DATA_RE) · publishAsset.js 와 반드시 일치.
function r2KeyOf(name) {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'js' || ext === 'css') return `lib/${name}`;
  if (ext === 'json') return `data/${name}`;
  return null;
}
const CT = { js: 'application/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8' };
const ctOf = (n) => CT[n.slice(n.lastIndexOf('.') + 1).toLowerCase()] || 'application/octet-stream';

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

// R2 etag = 단일 PUT 객체의 md5.
//   ⚠️ `W/` 접두사를 반드시 벗긴다 — node fetch 는 Accept-Encoding: gzip 을 보내고 CF 는 압축 응답에
//   **약한 검증자** `W/"<md5>"` 를 붙인다. 따옴표만 벗기면 절대 안 맞아 매 회차 전 파일을 재업로드하게 된다.
async function cdnEtag(key) {
  try {
    const r = await fetch(CDN + key, { method: 'HEAD' });
    if (!r.ok) return null;
    return String(r.headers.get('etag') || '').replace(/^W\//i, '').replace(/"/g, '') || null;
  } catch { return null; }
}

async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  });
  await Promise.all(workers);
}

// gist 는 공개라 인증 없이 읽는다(토큰 불필요 = 시크릿을 하나 덜 둔다).
//   미인증 API 는 IP 당 60req/h 인데 이 스크립트는 회차당 1회만 쓴다.
async function gistGet(gistId) {
  const r = await fetch(`https://api.github.com/gists/${gistId}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'mirror-gist-r2/1.0' },
  });
  if (!r.ok) throw new Error(`gist GET HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
// gist API 는 1MB 넘는 파일을 truncated 로 준다 — raw_url 로 받아야 내용이 잘리지 않는다.
async function gistFileText(f) {
  if (f.truncated && f.raw_url) {
    const r = await fetch(f.raw_url);
    return r.ok ? await r.text() : null;
  }
  return f.content ?? null;
}

// gist 1개를 R2 로 미러. 반환값 { fail } 로 실패 건수를 바깥 집계에 전달.
async function mirrorOne(target) {
  const prefix = `[${target.id.slice(0, 8)}]`;
  const meta = await gistGet(target.id);
  const updatedAt = meta.updated_at;

  let state = null;
  try { const t = await r2GetText(target.stateKey); state = t ? JSON.parse(t) : null; } catch { /* 없거나 깨짐 → 전수 */ }

  if (!FORCE && state && state.updatedAt === updatedAt) {
    console.log(`${prefix} gist 변경 없음 (updated_at ${updatedAt}) — 파일 취득 없이 종료`);
    return { fail: 0 };
  }
  console.log(`${prefix} gist updated_at ${updatedAt}` + (state ? ` (직전 ${state.updatedAt})` : ' (상태 없음 — 전수 대조)') + (FORCE ? ' [force]' : ''));

  const names = Object.keys(meta.files || {}).sort()
    .filter((n) => !GIST_ONLY.has(n) && r2KeyOf(n) && (!target.only || target.only.has(n)));

  let put = 0, same = 0, fail = 0, skipped = 0;
  const fails = [];
  await pool(names, CONC, async (name) => {
    const key = r2KeyOf(name);
    try {
      const text = await gistFileText(meta.files[name]);
      if (text == null) { fail++; fails.push(`${name}: 내용 취득 실패`); return; }
      const remote = await cdnEtag(key);
      if (remote && remote === md5(text)) { same++; return; }
      if (DRY) { console.log(`${prefix}  [dry] ${name} → ${key} (${text.length}B)`); put++; return; }
      const r = await r2Put(key, text, ctOf(name));
      if (r.ok) { console.log(`${prefix}  ✓ ${name} → ${key} (${text.length}B)`); put++; }
      else { fail++; fails.push(`${name}: ${r.msg}`); }
    } catch (e) { fail++; fails.push(`${name}: ${e.message}`); }
  });

  console.log(`${prefix} 미러 완료: 갱신 ${put} / 동일 ${same} / 실패 ${fail}` + (skipped ? ` / skip ${skipped}` : ''));
  if (fails.length) console.error(`${prefix} ::error::` + fails.slice(0, 10).join(' | '));

  // ⚠️ 실패가 있으면 상태를 갱신하지 않는다 — 다음 회차가 다시 시도하게 둔다.
  //    (갱신해버리면 updated_at 게이트에 걸려 실패분이 영영 안 올라간다.)
  if (!DRY && !fail) {
    await r2Put(target.stateKey, JSON.stringify({ updatedAt, at: new Date().toISOString(), files: names.length }),
      'application/json; charset=utf-8');
  } else if (fail) {
    console.error(`${prefix} ::error::실패가 있어 상태를 갱신하지 않는다 — 다음 회차가 재시도한다`);
  }
  return { fail };
}

(async () => {
  let anyFail = false;
  for (const target of GIST_TARGETS) {
    try {
      const r = await mirrorOne(target);
      if (r.fail) anyFail = true;
    } catch (e) {
      console.error(`[${target.id.slice(0, 8)}] ::error::미러 실패:`, e.message);
      anyFail = true;
    }
  }
  if (anyFail) process.exitCode = 1;
})().catch((e) => { console.error('::error::미러 실패:', e.message); process.exit(1); });

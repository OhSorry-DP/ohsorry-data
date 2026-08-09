// r2-client.mjs — R2 접근 공용 클라이언트 (REST 우선 + wrangler 폴백).
//
// 왜 모듈로 뽑았나:
//   같은 로직이 r2-repersona.mjs / backfillHist.js / publishAsset.js / mirror-gist-r2.mjs 에 각각
//   복제돼 있었다. 복제본마다 함정을 따로 밟는다 — 실제로 **etag 의 `W/` 접두사**를 안 벗겨
//   스킵이 통째로 죽은 사고가 있었다(backfillHist, 371건 전부 불필요 재업로드).
//   새 소비처는 이 모듈을 쓰고, 남은 복제본은 순차로 옮긴다.
//
// 함정 세 가지가 여기 모여 있다:
//   ① **프로세스 스폰 금지** — 객체마다 wrangler 를 띄우면 스폰 비용이 지배한다(369개 30분 /
//      371개 8.6분, 두 번 실증). REST 는 스폰이 없고 동시 실행도 된다. wrangler 는 폴백일 뿐이고,
//      **단일 대용량 PUT**(스냅샷 tar.gz 같은 것)에만 우위가 있다(멀티파트 자동 처리).
//   ② **etag 의 `W/`** — node fetch 는 Accept-Encoding: gzip 을 보내고 CF 는 압축 응답에 약한 검증자
//      `W/"<md5>"` 를 붙인다. 따옴표만 벗기면 md5 와 절대 안 맞는다.
//   ③ **429/5xx 재시도** — Cloudflare API 는 계정 단위 rate limit 이 있다.
//
// 환경: CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN 이 있으면 REST, 없으면 wrangler 폴백.
// CJS 에서도 쓸 수 있다 — `await import(pathToFileURL(p).href)` (dump-data-repo.js 선례).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const BUCKET = 'ohsorry-data';
export const CDN = 'https://data.iidx.in/';

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || '607eea1b073bea6747e6e9b76f2d7b41';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const REST_BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets/${BUCKET}/objects/`;

export const useRest = !!(ACCOUNT && TOKEN);

const CT = {
  js: 'application/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  gz: 'application/gzip',
};
export const contentTypeOf = (key) => CT[key.slice(key.lastIndexOf('.') + 1).toLowerCase()] || 'application/octet-stream';
export const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

// wrangler 폴백 — npx 가 아니라 진입 스크립트를 node 로 직접 실행한다.
//   Windows 의 Node 20+ 는 `.cmd`(npx.cmd)를 shell 없이 spawn 하지 못하고(spawn EINVAL),
//   shell:true 는 인자 이스케이프가 사라지는 데다 동시 실행 시 libuv 가 죽는다.
//   설치 위치가 repo 마다 달라 후보를 순서대로 찾는다.
function wranglerEntry() {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const cands = [
    path.join(here, '..', '..', 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
    path.join(here, '..', '..', '..', 'ohSorryAdmin', 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
  ];
  return cands.find((p) => fs.existsSync(p)) || null;
}
function wrangler(args) {
  const entry = wranglerEntry();
  const cmd = entry ? [process.execPath, [entry, ...args]] : ['npx', ['--yes', 'wrangler@4', ...args]];
  return execFileSync(cmd[0], cmd[1], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
}

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

// 없으면 null. (호출부가 "미덤프"와 "실패"를 구분할 수 있게 404 만 null 이고 나머지는 throw)
export async function getText(key) {
  if (useRest) {
    const r = await restFetch(key, { method: 'GET' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`R2 GET ${key} — HTTP ${r.status}`);
    return await r.text();
  }
  const f = path.join(os.tmpdir(), 'r2get-' + key.replace(/[/\\]/g, '_'));
  try { wrangler(['r2', 'object', 'get', `${BUCKET}/${key}`, `--file=${f}`, '--remote']); }
  catch { return null; }
  try { return fs.readFileSync(f, 'utf8'); } finally { try { fs.unlinkSync(f); } catch { /* 무시 */ } }
}

// 반환 { ok, msg? } — 호출부가 부분 실패를 집계할 수 있게 throw 하지 않는다.
export async function putText(key, body, contentType = null) {
  const ct = contentType || contentTypeOf(key);
  if (useRest) {
    const r = await restFetch(key, { method: 'PUT', body, headers: { 'Content-Type': ct } });
    return r.ok ? { ok: true } : { ok: false, msg: `HTTP ${r.status} ${(await r.text()).slice(0, 200)}` };
  }
  const tmp = path.join(os.tmpdir(), 'r2put-' + key.replace(/[/\\]/g, '_'));
  fs.writeFileSync(tmp, body);
  try { return putFile(key, tmp, ct); } finally { try { fs.unlinkSync(tmp); } catch { /* 무시 */ } }
}

// 파일 경로로 PUT. **대용량 단일 객체는 이쪽이 낫다** — wrangler 가 멀티파트를 알아서 처리한다.
export function putFile(key, absPath, contentType = null) {
  const ct = contentType || contentTypeOf(key);
  try {
    wrangler(['r2', 'object', 'put', `${BUCKET}/${key}`, `--file=${absPath}`, `--content-type=${ct}`, '--remote']);
    return { ok: true };
  } catch (e) { return { ok: false, msg: String(e.stderr || e.message).slice(0, 300) }; }
}

export async function del(key) {
  if (useRest) {
    const r = await restFetch(key, { method: 'DELETE' });
    return r.ok || r.status === 404;
  }
  try { wrangler(['r2', 'object', 'delete', `${BUCKET}/${key}`, '--remote']); return true; }
  catch { return false; }
}

// 공개 CDN 의 etag(= 단일 PUT 객체의 md5). 없으면 null.
//   ⚠️ `W/` 를 반드시 벗긴다 — 안 그러면 md5 와 절대 안 맞아 "변경 없음" 판정이 통째로 죽는다.
export async function cdnEtag(key) {
  try {
    const r = await fetch(CDN + key, { method: 'HEAD' });
    if (!r.ok) return null;
    return String(r.headers.get('etag') || '').replace(/^W\//i, '').replace(/"/g, '') || null;
  } catch { return null; }
}

// 내용이 이미 같으면 올리지 않는다. 반환 { ok, skipped }
export async function putIfChanged(key, body, contentType = null) {
  const remote = await cdnEtag(key);
  if (remote && remote === md5(body)) return { ok: true, skipped: true };
  const r = await putText(key, body, contentType);
  return { ...r, skipped: false };
}

// 동시 실행 풀 — 순서 무관한 작업용. (r2-repersona.mjs 의 것과 같은 형태)
export async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  });
  await Promise.all(workers);
}

// snapshot-r2.mjs — R2 서빙본(user/ + hist/ + 공유 JSON)을 tar.gz 한 덩어리로 묶어 R2 에 보관.
//
// 왜 필요한가:
//   **R2 버킷에는 객체 버저닝이 없다**(2026-08-09 확인). CF 통합 계획 §4 로 git 데이터 커밋을
//   중단하면 롤백 수단이 통째로 사라지므로, 이 스냅샷이 **유일한 복구 경로**가 된다.
//   개별 파일 복사가 아니라 tar.gz 한 덩어리인 이유는 371×2 개를 낱개로 두면 Class A 요청만
//   늘고 보존 관리가 번거롭기 때문이다.
//   계획 정본: d:/work/docs/cf-consolidation.md §2
//
// ⚠️ **sanity check 없이는 만들지 않는다.** 유실은 스냅샷으로 복구되지만 **오염은 오염된 값을
//    그대로 굳힌다.** 월별이면 최대 한 달치가 오염된 채 남는다(이 repo 에는 persona 37명 유실 전례).
//    직전 스냅샷 대비 유저 수·이력 행수·persona 보유 인원이 급감하면 **만들지 말고 실패로 알린다.**
//
// 보존: daily 30개 + monthly 12개 (계획 §2). git 커밋도 유저당 1일 1회였으므로 복구 입도가 같고,
//   스냅샷 쪽은 hist 가 무손실(§1)이라 오히려 복원력이 낫다. 용량 ~32MB × 42 ≈ 1.34GB (R2 무료 10GB 내).
//
// 사용: node .github/scripts/snapshot-r2.mjs [--kind=daily|monthly|auto] [--dry] [--concurrency=N] [--max-drop=5] [--limit=N]
//   auto(기본) = 항상 daily, KST 1일이면 monthly 도 함께.
//   --limit 은 **스모크 전용** — 일부만 받으므로 실제 스냅샷을 만들면 안 된다(--dry 강제).
//
// ⚠️ snapshot/ 은 **Worker 허용키가 아니다** — data.iidx.in 으로 서빙되지 않는다(백업이지 컨텐츠가 아니다).
//    접근은 wrangler / REST 로만.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { gunzip as gunzipCallback } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { validateCandidate, sha256Hex } from './score-buffer.mjs';

const gunzip = promisify(gunzipCallback);

export function buildDeleteManifest(entries) {
  const candidates = [];
  for (const entry of entries) {
    if (typeof entry?.key !== 'string' || !/^meta\/scores-delete-[A-Za-z0-9]+\.json$/.test(entry.key)
      || !(entry.bytes instanceof Uint8Array) || typeof entry.histKey !== 'string'
      || !(entry.histBytes instanceof Uint8Array)) throw new TypeError('invalid delete manifest entry');
    const id = entry.key.slice('meta/scores-delete-'.length, -'.json'.length);
    let candidate;
    try { candidate = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes)); }
    catch { throw new TypeError(`invalid candidate JSON: ${entry.key}`); }
    validateCandidate(candidate, id);
    if (candidate.hist.key !== entry.histKey || candidate.hist.sha256 !== sha256Hex(entry.histBytes)) {
      throw new TypeError(`candidate hist mismatch: ${entry.key}`);
    }
    candidates.push({ key: entry.key, sha256: sha256Hex(entry.bytes), hist: { key: entry.histKey, sha256: sha256Hex(entry.histBytes) } });
  }
  candidates.sort((a, b) => a.key.localeCompare(b.key));
  return { candidates };
}

function parseTar(bytes) {
  const files = new Map();
  const text = (b) => { const end = b.indexOf(0); return b.subarray(0, end < 0 ? b.length : end).toString('utf8'); };
  const octal = (b) => {
    const s = text(b).trim();
    if (!s) return 0;
    if (!/^[0-7]+$/.test(s)) throw new Error('invalid tar numeric field');
    return Number.parseInt(s, 8);
  };
  let offset = 0, zeroBlocks = 0;
  while (offset + 512 <= bytes.length) {
    const h = bytes.subarray(offset, offset + 512);
    if (h.every((v) => v === 0)) { zeroBlocks++; offset += 512; if (zeroBlocks === 2) break; continue; }
    if (zeroBlocks) throw new Error('invalid tar after end marker');
    const expected = octal(h.subarray(148, 156));
    let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== expected) throw new Error('tar checksum mismatch');
    const name = text(h.subarray(0, 100));
    const prefix = text(h.subarray(345, 500));
    const rawName = prefix ? `${prefix}/${name}` : name;
    const type = h[156];
    const size = octal(h.subarray(124, 136));
    const magic = h.subarray(257, 263).toString('ascii');
    if (magic !== 'ustar\0' && magic !== 'ustar ') throw new Error('unsupported tar format');
    if (type === 53) {
      if (size !== 0) throw new Error('directory with body');
      continue;
    }
    if (type !== 0 && type !== 48) throw new Error('tar link or unsupported member type');
    const normalized = rawName.replace(/^\.\//, '').replace(/\/$/, '');
    if (!normalized || normalized === '.') continue;
    if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').some((part) => part === '..' || part === '.')) throw new Error('unsafe tar path');
    if (files.has(normalized)) throw new Error(`duplicate tar path: ${normalized}`);
    const start = offset + 512, end = start + size;
    if (end > bytes.length) throw new Error('truncated tar body');
    files.set(normalized, bytes.subarray(start, end));
    offset = start + Math.ceil(size / 512) * 512;
  }
  if (zeroBlocks < 2 || offset > bytes.length) throw new Error('truncated tar archive');
  if (bytes.subarray(offset).some((v) => v !== 0)) throw new Error('invalid trailing tar data');
  return files;
}

export async function verifyDeleteSnapshot({ snapshotKey, tarBytes, expectedManifest }) {
  if (!(tarBytes instanceof Uint8Array)) throw new TypeError('tarBytes must be bytes');
  if (!expectedManifest || !Array.isArray(expectedManifest.candidates)) throw new TypeError('invalid expected manifest');
  const tarSha256 = sha256Hex(tarBytes);
  const unpacked = await gunzip(tarBytes);
  const files = parseTar(unpacked);
  const manifestBytes = files.get('scores-delete-manifest.json');
  if (!manifestBytes) throw new Error('delete manifest missing from snapshot');
  let manifest;
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)); }
  catch { throw new Error('invalid delete manifest JSON'); }
  if (JSON.stringify(manifest) !== JSON.stringify(expectedManifest)) throw new Error('delete manifest mismatch');
  const candidates = [];
  for (const item of expectedManifest.candidates) {
    const bytes = files.get(item.key);
    if (!bytes || sha256Hex(bytes) !== item.sha256) throw new Error(`candidate missing or hash mismatch: ${item.key}`);
    const id = item.key.slice('meta/scores-delete-'.length, -'.json'.length);
    let candidate;
    try { candidate = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new Error(`invalid candidate JSON: ${item.key}`); }
    validateCandidate(candidate, id);
    const histBytes = files.get(item.hist.key);
    if (!histBytes || sha256Hex(histBytes) !== item.hist.sha256 || candidate.hist.key !== item.hist.key
      || candidate.hist.sha256 !== item.hist.sha256) throw new Error(`candidate hist mismatch: ${item.key}`);
    candidates.push({ iidxId: id, candidateKey: item.key, candidateBytes: Buffer.from(bytes), histBytes: Buffer.from(histBytes) });
  }
  return { snapshotKey, tarSha256, candidates };
}

const BUCKET = 'ohsorry-data';
const INDEX_KEY = 'snapshot/index.json';
// 스냅샷에 같이 넣는 루트 JSON — 슬림 row 는 song_id 만 들고 있어 songs.json 없이는 곡을 못 되살린다.
const ROOT_FILES = ['users-list.json', 'songs.json', 'version.json'];

const arg = (n, d = null) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };

// ── R2 접근 — REST 우선, 실패 시 wrangler 폴백 ────────────────────────────────
//   ⚠️ 정본 = r2-repersona.mjs 의 같은 구조. 객체마다 wrangler 프로세스를 띄우면 스폰 비용이
//      지배해 수백 개에서 수십 분이 된다(369명 30분 / 371명 8.6분, 두 번 실증).
//      여기선 GET 이 742회라 REST 가 필수다. 단, **tar.gz 단일 PUT 은 wrangler 를 쓴다** —
//      호출이 1회뿐이라 스폰 비용이 무의미하고, 큰 파일의 멀티파트를 wrangler 가 알아서 처리한다.
let ACCOUNT, TOKEN, REST_BASE, useRest;

function wrangler(args) {
  return execFileSync('npx', ['--yes', 'wrangler@4', ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
}
// 429/5xx 는 잠깐 쉬고 재시도 — Cloudflare API 는 계정 단위 rate limit 이 있다.
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
// dry 검증 전용 읽기 경로 — 토큰 없이 돌려볼 때만. 스냅샷 대상 키(user/·hist/·루트 JSON)는
//   전부 Worker 허용키라 공개 CDN 으로 읽을 수 있다. **실제 스냅샷에는 쓰지 않는다** —
//   Worker 엣지 캐시(60초)를 타서 "지금 이 순간의 R2" 라는 보장이 없기 때문이다.
const CDN = 'https://data.iidx.in/';
let VIA_CDN = false;

async function r2GetText(key) {
  if (useRest) {
    const r = await restFetch(key, { method: 'GET' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`R2 GET ${key} — HTTP ${r.status}`);
    return await r.text();
  }
  if (VIA_CDN) {
    const r = await fetch(CDN + key, { cache: 'no-store' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`CDN GET ${key} — HTTP ${r.status}`);
    return await r.text();
  }
  const f = path.join(TMP, key.replace(/[/\\]/g, '_'));
  try { wrangler(['r2', 'object', 'get', `${BUCKET}/${key}`, `--file=${f}`, '--remote']); }
  catch { return null; }
  return fs.readFileSync(f, 'utf8');
}
async function r2PutText(key, text) {
  if (useRest) {
    const r = await restFetch(key, { method: 'PUT', body: text, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    if (!r.ok) throw new Error(`R2 PUT ${key} — HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    return;
  }
  const f = path.join(TMP, key.replace(/[/\\]/g, '_'));
  fs.writeFileSync(f, text);
  wrangler(['r2', 'object', 'put', `${BUCKET}/${key}`, `--file=${f}`, '--content-type=application/json; charset=utf-8', '--remote']);
}
async function r2Delete(key) {
  if (useRest) {
    const r = await restFetch(key, { method: 'DELETE' });
    return r.ok || r.status === 404;
  }
  try { wrangler(['r2', 'object', 'delete', `${BUCKET}/${key}`, '--remote']); return true; }
  catch { return false; }
}

// 동시 실행 풀 — 순서 무관(유저별 독립)이라 단순 워커 N개로 충분. (backfillHist.js / r2-repersona.mjs 와 동일)
async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  });
  await Promise.all(workers);
}

// KST 기준 날짜 — repo 전체가 KST 로 하루를 센다(dump-user.yml 의 1일 1커밋 판정과 동일 기준).
function kstNow() { return new Date(Date.now() + 9 * 3600 * 1000); }
const ymd = (d) => d.toISOString().slice(0, 10);
const ym = (d) => d.toISOString().slice(0, 7);
const mb = (b) => (b / 1024 / 1024).toFixed(1);

let TMP, SNAP;

export async function main() {
const KIND = arg('kind', 'auto');
const MAX_DROP = Number(arg('max-drop', '5')) / 100;
const LIMIT = Number(arg('limit', '0'));
const DRY = process.argv.includes('--dry') || LIMIT > 0;
ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
TOKEN = process.env.CLOUDFLARE_API_TOKEN;
REST_BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets/${BUCKET}/objects/`;
useRest = !!(ACCOUNT && TOKEN);
VIA_CDN = DRY && !useRest;
TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ohsorry-snap-'));
SNAP = path.join(TMP, 'snap');
fs.mkdirSync(path.join(SNAP, 'user'), { recursive: true });
fs.mkdirSync(path.join(SNAP, 'hist'), { recursive: true });

// ── 1. 대상 유저 목록 ────────────────────────────────────────────────────────
const listText = await r2GetText('users-list.json');
if (!listText) { console.error('::error::users-list.json 취득 실패 — 스냅샷 중단'); process.exit(1); }
let users;
try { users = JSON.parse(listText); } catch (e) { console.error('::error::users-list.json 파싱 실패:', e.message); process.exit(1); }
if (!Array.isArray(users) || !users.length) { console.error('::error::users-list.json 이 비었다 — 스냅샷 중단'); process.exit(1); }
let ids = users.map((u) => u.iidx_id).filter((x) => /^[A-Za-z0-9]+$/.test(String(x || '')));
const totalUsers = ids.length;
if (LIMIT > 0) ids = ids.slice(0, LIMIT);

const CONC = Number(arg('concurrency', useRest ? '8' : '1'));
console.log(`대상 ${ids.length}명${LIMIT > 0 ? ` (전체 ${totalUsers} 중 스모크 — DRY 강제)` : ''}`
  + ` (${useRest ? 'REST' : (VIA_CDN ? 'CDN(dry 전용)' : 'wrangler')} / 동시 ${CONC}${DRY ? ' / DRY RUN' : ''})`);
if (!useRest && !VIA_CDN) console.warn('::warning::CLOUDFLARE_API_TOKEN 미설정 — wrangler 폴백은 객체당 프로세스 스폰이라 매우 느리다');

// ── 2. 내려받기 + 통계 집계 (한 번만 훑는다) ──────────────────────────────────
const stat = { users: 0, histRows: 0, persona: 0, spPersona: 0, missUser: 0, missHist: 0, bytes: 0 };
const fails = [];
const deleteEntries = [];
const scoreBufferEnabled = process.env.SCORE_BUFFER_PREPARE === '1' && !DRY && (KIND === 'daily' || KIND === 'auto');
await pool(ids, CONC, async (id) => {
  try {
    const [uText, hText] = await Promise.all([r2GetText(`user/${id}.json`), r2GetText(`hist/${id}.json`)]);
    if (uText == null) { stat.missUser++; } else {
      fs.writeFileSync(path.join(SNAP, 'user', `${id}.json`), uText);
      stat.bytes += Buffer.byteLength(uText);
      stat.users++;
      const u = JSON.parse(uText);
      if (u.persona) stat.persona++;
      if (u.spPersona) stat.spPersona++;
    }
    if (hText == null) { stat.missHist++; } else {
      fs.writeFileSync(path.join(SNAP, 'hist', `${id}.json`), hText);
      stat.bytes += Buffer.byteLength(hText);
      const h = JSON.parse(hText);
      if (Array.isArray(h)) stat.histRows += h.length;
    }
    if (scoreBufferEnabled && uText != null && hText != null) {
      const candidateKey = `meta/scores-delete-${id}.json`;
      const candidateResponse = await restFetch(candidateKey, { method: 'GET' });
      if (candidateResponse.status !== 404) {
        if (!candidateResponse.ok) throw new Error(`R2 GET ${candidateKey} — HTTP ${candidateResponse.status}`);
        const candidateBytes = Buffer.from(await candidateResponse.arrayBuffer());
        const histBytes = Buffer.from(hText, 'utf8');
        const candidate = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(candidateBytes));
        validateCandidate(candidate, id);
        if (candidate.hist.sha256 !== sha256Hex(histBytes)) throw new Error(`candidate hist hash mismatch: ${id}`);
        deleteEntries.push({ key: candidateKey, bytes: candidateBytes, histKey: `hist/${id}.json`, histBytes });
      }
    }
  } catch (e) { fails.push(`${id}: ${e.message}`); }
});
for (const f of ROOT_FILES) {
  const t = await r2GetText(f);
  if (t == null) { console.warn(`::warning::${f} 없음 — 스냅샷에서 생략`); continue; }
  fs.writeFileSync(path.join(SNAP, f), t);
  stat.bytes += Buffer.byteLength(t);
}
let expectedManifest = null;
if (scoreBufferEnabled) {
  expectedManifest = buildDeleteManifest(deleteEntries);
  for (const item of deleteEntries) fs.writeFileSync(path.join(SNAP, item.key), item.bytes);
  fs.writeFileSync(path.join(SNAP, 'scores-delete-manifest.json'), JSON.stringify(expectedManifest));
  stat.bytes += deleteEntries.reduce((n, e) => n + e.bytes.length, 0)
    + Buffer.byteLength(JSON.stringify(expectedManifest));
}
console.log(`  받음: user ${stat.users} / hist 행 ${stat.histRows.toLocaleString()} / persona ${stat.persona} / spPersona ${stat.spPersona}`);
console.log(`  원본 ${mb(stat.bytes)} MB` + (stat.missUser || stat.missHist ? ` · 누락 user ${stat.missUser} / hist ${stat.missHist}` : ''));
if (fails.length) {
  console.error(`::error::취득 실패 ${fails.length}건 — 스냅샷 중단 (${fails.slice(0, 5).join(' | ')})`);
  process.exit(1);
}
// 직전 스냅샷과 무관한 **절대 가드** — 첫 회차엔 비교 대상이 없어 sanity check 가 못 잡는다.
//   user/ 가 대량으로 비어 있는 상태를 기준선으로 굳히면 이후 모든 대조가 무의미해진다.
if (stat.missUser / ids.length > MAX_DROP) {
  console.error(`::error::user/ 누락 ${stat.missUser}/${ids.length} (${(stat.missUser / ids.length * 100).toFixed(1)}%) — 스냅샷 중단.`
    + ' users-list 에 있는데 덤프가 없는 유저가 많다는 뜻이다(웹훅 체인 실패 의심).');
  process.exit(1);
}

// ── 3. sanity check — 직전 스냅샷 대비 급감이면 만들지 않는다 ────────────────
let index = [];
const idxText = await r2GetText(INDEX_KEY);
if (idxText) { try { index = JSON.parse(idxText); } catch { index = []; } }
if (!Array.isArray(index)) index = [];
const prev = index.length ? index[index.length - 1] : null;

if (prev) {
  const checks = [
    ['유저 수', stat.users, prev.users],
    ['이력 행수', stat.histRows, prev.histRows],
    ['persona 보유', stat.persona, prev.persona],
    ['spPersona 보유', stat.spPersona, prev.spPersona],
  ];
  let bad = false;
  for (const [name, now, before] of checks) {
    if (!before) continue;                       // 직전 값이 0/없음이면 비교 의미 없음
    const drop = (before - now) / before;
    const tag = drop > MAX_DROP ? '❌' : (now < before ? '⚠️' : '✅');
    console.log(`  ${tag} ${name}: ${before.toLocaleString()} → ${now.toLocaleString()} (${(drop * 100).toFixed(1)}% 감소)`);
    if (drop > MAX_DROP) bad = true;
  }
  if (bad) {
    console.error(`::error::직전 스냅샷(${prev.key}) 대비 ${(MAX_DROP * 100).toFixed(0)}% 초과 급감 — 스냅샷을 만들지 않는다.`
      + ' 오염된 스냅샷은 오염을 그대로 굳힌다. 덤프 파이프라인을 먼저 확인할 것.');
    process.exit(1);
  }
} else {
  console.log('  직전 스냅샷 없음 — 첫 회차라 대조 생략(이번 값이 다음 회차의 기준이 된다)');
}

// ── 4. tar.gz ────────────────────────────────────────────────────────────────
const now = kstNow();
const targets = [];
if (KIND === 'daily' || KIND === 'auto') targets.push({ kind: 'daily', key: `snapshot/daily/${ymd(now)}.tar.gz` });
if (KIND === 'monthly' || (KIND === 'auto' && now.getUTCDate() === 1)) targets.push({ kind: 'monthly', key: `snapshot/monthly/${ym(now)}.tar.gz` });
if (!targets.length) { console.error('::error::생성 대상 없음 (--kind 확인)'); process.exit(1); }

const tarPath = path.join(TMP, 'snapshot.tar.gz');
// ⚠️ tar 에 절대경로를 넘기지 않는다 — GNU tar 는 `C:\...` 의 콜론을 **원격 호스트 지정**으로 읽어
//   "Cannot connect to C: resolve failed" 로 죽는다(Windows 로컬 dry 실행 실측). cwd + 상대경로면 양쪽 다 안전.
execFileSync('tar', ['-czf', 'snapshot.tar.gz', '-C', 'snap', '.'], { cwd: TMP, stdio: 'inherit' });
const tarBytes = fs.statSync(tarPath).size;
console.log(`\ntar.gz ${mb(tarBytes)} MB (원본 ${mb(stat.bytes)} MB → ${(tarBytes / stat.bytes * 100).toFixed(0)}%)`);

// ── 5. 업로드 + index 갱신 ───────────────────────────────────────────────────
const entry = {
  at: new Date().toISOString(), kst: ymd(now),
  users: stat.users, histRows: stat.histRows, persona: stat.persona, spPersona: stat.spPersona,
  rawBytes: stat.bytes, gzBytes: tarBytes,
};
for (const t of targets) {
  if (DRY) { console.log(`  [dry] PUT ${t.key}`); continue; }
  // 단일 대용량 PUT 은 wrangler — 호출 1회라 스폰 비용이 무의미하고 멀티파트를 알아서 처리한다.
  try {
    wrangler(['r2', 'object', 'put', `${BUCKET}/${t.key}`, `--file=${tarPath}`,
      '--content-type=application/gzip', '--remote']);
    console.log(`  R2 OK: ${t.key}`);
  } catch (e) {
    console.error(`::error::스냅샷 업로드 실패: ${t.key} — ${String(e.stderr || e.message).slice(0, 300)}`);
    process.exit(1);
  }
  if (scoreBufferEnabled && t.kind === 'daily') {
    const response = await restFetch(t.key, { method: 'GET', headers: { 'Accept-Encoding': 'identity' } });
    if (!response.ok) throw new Error(`R2 snapshot GET ${t.key} — HTTP ${response.status}`);
    const proof = await verifyDeleteSnapshot({ snapshotKey: t.key, tarBytes: Buffer.from(await response.arrayBuffer()), expectedManifest });
    console.log(`  원본 tar 검증: ${proof.candidates.length} 후보 / SHA256 ${proof.tarSha256}`);
  }
}
if (!DRY) {
  index.push({ ...entry, key: targets[targets.length - 1].key, kinds: targets.map((t) => t.kind) });
  if (index.length > 60) index = index.slice(-60);   // 보존 42개보다 넉넉히
  await r2PutText(INDEX_KEY, JSON.stringify(index));
  console.log(`  index 갱신: ${index.length}건`);
}

// ── 6. 보존 정책 — daily 30 / monthly 12 ─────────────────────────────────────
//   객체 목록 API 를 쓰지 않는다. 키가 날짜로 결정되므로 **지울 키를 직접 계산**하면 되고,
//   그게 실행을 한 번 걸렀을 때도 안전하다(없는 키 DELETE 는 무해). 여유분까지 훑어 유실 없이 정리한다.
const KEEP_DAILY = 30, KEEP_MONTHLY = 12;
const pruned = [];
for (let i = KEEP_DAILY; i < KEEP_DAILY + 10; i++) {
  const d = new Date(now.getTime() - i * 86400000);
  pruned.push(`snapshot/daily/${ymd(d)}.tar.gz`);
}
for (let i = KEEP_MONTHLY; i < KEEP_MONTHLY + 3; i++) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
  pruned.push(`snapshot/monthly/${ym(d)}.tar.gz`);
}
if (DRY) {
  console.log(`\n[dry] 정리 대상 ${pruned.length}키 (없는 키 DELETE 는 무해)`);
  for (const k of pruned) console.log(`    - ${k}`);
} else {
  let del = 0;
  await pool(pruned, 4, async (key) => { if (await r2Delete(key)) del++; });
  console.log(`\n보존 정리: daily ${KEEP_DAILY}개 + monthly ${KEEP_MONTHLY}개 유지 (${del}/${pruned.length} 키 정리 요청 완료)`);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n완료.');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();

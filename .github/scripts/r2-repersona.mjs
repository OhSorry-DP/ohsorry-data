// r2-repersona.mjs — R2 서빙본의 persona/spPersona 재생성 (DP 배치만 Supabase 전량 조회).
//
// 왜 git → R2 단순 PUT 이면 안 되는가:
//   dump-user 는 **R2 는 매 덤프마다 PUT / git 은 유저당 1일 1커밋** 이다(dump-user.yml 주석).
//   즉 R2 가 git 보다 최신일 수 있고, git 본을 그대로 올리면 그 유저의 점수가
//   "마지막으로 커밋된 스냅샷" 으로 **롤백**된다. 그래서 read-modify-write 로만 건드린다.
//     ① R2 GET → ② 그 안의 dp/sp rows 로 persona 재생성 → ③ persona/spPersona 만 갈아끼워 PUT.
//   점수·램프 등 나머지 필드는 R2 원본 그대로다.
//
// 사용: node .github/scripts/r2-repersona.mjs [--limit=N] [--only=id,id] [--dry]
//   (repo 루트에서. wrangler r2 write 권한이 있는 환경 = GitHub Actions 전용.)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { calculateOfficialScores } from './official-score.mjs';
import { mergeScoreHistory } from './score-history.mjs';
import { mergeSlowUser } from './dump-fast-publish.mjs';
import { s3R2Client } from './r2-client.mjs';

const validId = (value) => /^[A-Za-z0-9]+$/.test(String(value || ''));
const lightGuardOn = () => process.env.FAST_DUMP_LIGHT_GUARD === '1';

function s3ResponseEtag(response) {
  const value = response.headers?.get?.('etag');
  return typeof value === 'string' && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value) ? value : null;
}

async function s3ReadUser(s3, key) {
  const response = await s3.request(key, { method: 'GET' });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`S3 user GET HTTP ${response.status}`);
  const etag = s3ResponseEtag(response);
  if (!etag) return null;
  return { body: await response.text(), etag };
}

export async function guardedSlowUserPut({ client, key, source, local, s3 }) {
  if (!lightGuardOn()) {
    await client.put(key, JSON.stringify(local), source.etag);
    return true;
  }
  try { s3 ||= s3R2Client({ retries: 0 }); } catch { return false; }
  if (!s3) return false;
  for (let attempt = 0; attempt < 3; attempt++) {
    let latest, current;
    try { latest = await s3ReadUser(s3, key); } catch { return false; }
    if (!latest) return false;
    try { current = JSON.parse(latest.body); } catch { return false; }
    if (!current || typeof current !== 'object' || Array.isArray(current)) return false;
    const merged = mergeSlowUser(current, local);
    try {
      const response = await s3.request(key, { method: 'PUT', body: JSON.stringify(merged),
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'If-Match': latest.etag } });
      if (response.ok) return true;
      if (response.status !== 412) return false;
    } catch (error) {
      if (!/HTTP 412\b/.test(String(error?.message || error))) return false;
    }
  }
  return false;
}

export function parseArgs(args) {
  const options = { dry: false, coachOnly: false, limit: Infinity, concurrency: 4 };
  for (const arg of args) {
    if (arg === '--dry') options.dry = true;
    else if (arg === '--coach-only') options.coachOnly = true;
    else if (arg.startsWith('--only=')) options.only = new Set(arg.slice(7).split(',').filter(Boolean));
    else if (arg.startsWith('--limit=')) options.limit = Number(arg.slice(8));
    else if (arg.startsWith('--requests-per-second=')) options.requestsPerSecond = Number(arg.slice(22));
    else if (arg.startsWith('--concurrency=')) options.concurrency = Number(arg.slice(14));
    else if (arg.startsWith('--web-root=')) options.webRoot = path.resolve(arg.slice(11));
    else throw new Error(`알 수 없는 옵션: ${arg}`);
  }
  if ((!Number.isSafeInteger(options.limit) && options.limit !== Infinity) || options.limit < 0) throw new Error('--limit은 0 이상의 정수여야 한다');
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) throw new Error('--concurrency는 양의 정수여야 한다');
  if (options.coachOnly && !args.some(arg => arg.startsWith('--concurrency='))) options.concurrency = 2;
  if (options.requestsPerSecond !== undefined && (!Number.isFinite(options.requestsPerSecond) || options.requestsPerSecond <= 0)) throw new Error('양의 requests-per-second 필요');
  return options;
}

export function selectIds(list, { only, limit = Infinity } = {}) {
  if (!Array.isArray(list)) throw new Error('users-list 형식이 배열이 아님');
  const ids = [...new Set(list.map(user => user?.iidx_id).filter(validId))].sort();
  return ids.filter(id => !only || only.has(id)).slice(0, limit);
}

export async function runCoachOnly({ ids, options, producer = './coach-precompute.mjs', producerMain, client }) {
  if (!ids.length) { console.log('coach-only 대상 0명 — 종료'); return []; }
  const invoke = producerMain || (await import(pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), producer)))).main;
  const args = [...(options.webRoot ? ['--web-root', options.webRoot] : []), '--only', ids.join(','), '--concurrency', String(options.concurrency), '--requests-per-second', String(options.requestsPerSecond ?? 3), ...(options.dry ? ['--dry'] : [])];
  const started = performance.now();
  const results = await invoke(args, { client });
  const wallMs = performance.now() - started;
  const successes = results.filter(result => result.ok && !result.skipped).length;
  const failures = results.filter(result => !result.ok);
  const childCpuMs = results.reduce((sum, result) => sum + Number(result.cpu_ms || 0), 0);
  const puts = results.reduce((sum, result) => sum + Number(result.puts || 0), 0);
  console.log(`coach-only 완료: 성공 ${successes}/${results.length} / skipped ${results.filter(result => result.skipped).length} / 실패 ${failures.length} / PUT ${puts} / child CPU ${childCpuMs.toFixed(1)}ms / 부모 batch wall ${wallMs.toFixed(1)}ms`);
  for (const result of failures) console.error(`coach-only 실패 ${result.id}: ${result.reason || 'unknown'} (engine ${result.engine_sha256 || '없음'})`);
  if (failures.length) process.exitCode = 1;
  return results;
}

// Single-user mode never seeds R2 from git; retry a stale ETag once with fresh rows.
const OFFICIAL_USER_FIELDS = ['star', 'native_star', 'r_star', 'sp_cpi', 'sp_star', 'sp_r_star', 'sp_r_star_model_id', 'sp_r_star_formula_version'];
const officialSnapshot = (data) => JSON.stringify([
  data.persona, data.spPersona, [Object.hasOwn(data, 'reachNps'), data.reachNps],
  ...OFFICIAL_USER_FIELDS.map(field => [Object.hasOwn(data.user || {}, field), data.user?.[field]]),
  [Object.hasOwn(data, 'osPattern'), data.osPattern],
]);

export async function updateSinglePersona(id, { client, calculate, official = false, dry = false, s3 } = {}) {
  if (!validId(id)) throw new Error('Invalid single-user id');
  const key = `user/${id}.json`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const source = await client.read(key);
    if (!source) throw new Error(`R2 user missing: ${id}`);
    const data = JSON.parse(source.body);
    if (String(data.user?.iidx_id) !== id) throw new Error('R2 user identity mismatch');
    const histSource = official ? await client.read(`hist/${id}.json`) : null;
    if (official && !histSource) throw new Error(`R2 hist missing: ${id}`);
    let histRows;
    if (official) {
      try { histRows = JSON.parse(histSource.body); } catch (error) { throw new Error(`R2 hist JSON invalid: ${id}`, { cause: error }); }
      if (!Array.isArray(histRows)) throw new TypeError(`R2 hist must be an array: ${id}`);
      mergeScoreHistory(histRows, []);
    }
    const before = official ? officialSnapshot(data) : JSON.stringify([data.persona, data.spPersona]);
    const fields = official ? await calculate(data, { histRows }) : await calculate(data);
    // Null/failed calculations preserve the previous persona, as dumpUser does.
    if (fields.persona != null) data.persona = fields.persona;
    if (fields.spPersona != null) data.spPersona = fields.spPersona;
    if (official) {
      if (fields.reachNps !== undefined) data.reachNps = fields.reachNps;
      data.user = { ...data.user };
      for (const field of OFFICIAL_USER_FIELDS) if (Object.hasOwn(fields.userFields || {}, field)) data.user[field] = fields.userFields[field];
      if (fields.osPattern !== undefined) data.osPattern = fields.osPattern;
    }
    const after = official ? officialSnapshot(data) : JSON.stringify([data.persona, data.spPersona]);
    if (after === before) return dry ? { dry: true, changed: false } : { unchanged: true };
    if (dry) return { dry: true, changed: true };
    try {
      if (!await guardedSlowUserPut({ client, key, source, local: data, s3 })) {
        if (lightGuardOn()) return { conflicted: true };
        throw new Error('user PUT rejected');
      }
      return { updated: true };
    } catch (error) {
      if (!/HTTP 412\b/.test(error.message)) throw error;
      if (attempt === 1) {
        console.warn(`::warning::persona contention: ${id}; deferred to next dump`);
        return { conflicted: true };
      }
    }
  }
}

export function personaFields(data, R, songById, arrange, engine, dpCharts) {
  const rowsOf = (rows) => (rows || []).map(row => {
    const song = songById.get(row.song_id);
    return song ? { ...row, title: song.title, textage_song_id: song.textage_song_id } : null;
  }).filter(Boolean);
  dpCharts ??= engine.chartsFromGridRows(engine.attachArrange(rowsOf(data.dp), arrange), R.textageMeta);
  return {
    persona: engine.personaFor(dpCharts, R, data.user),
    spPersona: engine.spPersonaFor(engine.spChartsFromGridRows(rowsOf(data.sp), R.textageMeta), R),
  };
}

export function historyPersonaFields(id, data, histRows, songs, arrange, R, engine) {
  const { historyInputs, personaFor, spPersonaFor, reachNpsFor } = engine;
  const inputs = historyInputs(id, histRows, songs, arrange, R);
  const official = calculateOfficialScores({ id, inputs, R, previousUser: data.user, previousOsPattern: data.osPattern });
  const user = { ...data.user, ...official.userFields };
  return {
    persona: personaFor(inputs.dpCharts, R, user),
    spPersona: spPersonaFor(inputs.spCharts, R),
    reachNps: reachNpsFor(inputs.dpCharts, R),
    userFields: official.userFields,
    osPattern: official.osPattern,
  };
}

export async function runHistoryBatch({ ids, client, R, songs, engine, arrangeFor, dry = false, concurrency = 4, s3 }) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be a positive integer');
  const results = new Array(ids.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
    while (next < ids.length) {
      const index = next++;
      const id = ids[index];
      try {
        let firstArrange;
        const result = await updateSinglePersona(id, { client, official: true, dry, s3,
          calculate: async (data, { histRows }) => {
            const arrange = firstArrange === undefined ? (firstArrange = await arrangeFor(id)) : await arrangeFor(id);
            return historyPersonaFields(id, data, histRows, songs, arrange, R, engine);
          } });
        results[index] = { id, ...result };
      } catch (error) { results[index] = { id, error }; }
    }
  });
  await Promise.all(workers);
  return results;
}

async function runSingle(id) {
  if (!validId(id)) throw new Error('Invalid single-user id');
  const engine = await import('./persona-lib.mjs');
  const { fetchDpArrange } = await import('./dp-arrange.mjs');
  const { conditionalR2Client } = await import('./r2-client.mjs');
  const client = conditionalR2Client({ account: process.env.CLOUDFLARE_ACCOUNT_ID,
    token: process.env.CLOUDFLARE_API_TOKEN });
  const official = process.env.SCORE_BUFFER_PREPARE === '1';
  const R = await engine.loadPersonaResources(official ? { official: true } : undefined);
  if (official) {
    const { fetchDpArrange } = await import('./dp-arrange.mjs');
    return updateSinglePersona(id, { client, official,
      calculate: async (data, { histRows }) => {
        const [songsSource, arrange] = await Promise.all([client.read('songs.json'), fetchDpArrange(id)]);
        if (!songsSource) throw new Error('R2 songs.json missing');
        const songs = JSON.parse(songsSource.body);
        if (!Array.isArray(songs)) throw new TypeError('R2 songs.json must be an array');
        return historyPersonaFields(id, data, histRows, songs, arrange, R, engine);
      } });
  }
  const [songs, arrange] = await Promise.all([client.read('songs.json'), fetchDpArrange(id)]);
  if (!songs) throw new Error('R2 songs.json missing');
  const songById = new Map(JSON.parse(songs.body).map(song => [song.song_id, song]));
  let attempt = 0;
  return updateSinglePersona(id, { client,
    calculate: async data => personaFields(data, R, songById,
      attempt++ === 0 ? arrange : await fetchDpArrange(id), engine) });
}

export async function main(args = process.argv.slice(2), deps = {}) {
  const single = args.find(arg => arg.startsWith('--single='));
  if (single) {
    if (args.length !== 1) throw new Error('--single requires exactly one argument');
    return runSingle(single.slice(9));
  }
  if (args.includes('--coach-only')) {
    const options = parseArgs(args);
    const { createClient } = await import('./coach-precompute.mjs');
    const { createRequestGate } = await import('./r2-client.mjs');
    const client = createClient(process.env, fetch, { requestGate: createRequestGate({ recheckDefer: true, intervalMs: 1000 / (options.requestsPerSecond ?? 3) }) });
    const source = await client.read('users-list.json');
    const ids = selectIds(source ? JSON.parse(source.bytes.toString('utf8')) : null, options);
    return runCoachOnly({ ids, options, producer: deps.producer, producerMain: deps.producerMain, client });
  }
  if (process.env.SCORE_BUFFER_PREPARE === '1') {
    const options = parseArgs(args);
    const { conditionalR2Client } = await import('./r2-client.mjs');
    const client = deps.client || conditionalR2Client({ account: process.env.CLOUDFLARE_ACCOUNT_ID,
      token: process.env.CLOUDFLARE_R2_TOKEN || process.env.CLOUDFLARE_API_TOKEN });
    const listSource = await client.read('users-list.json');
    if (!listSource) throw new Error('R2 users-list.json missing');
    const ids = selectIds(JSON.parse(listSource.body), options);
    const engine = deps.engine || await import('./persona-lib.mjs');
    const R = deps.R || await engine.loadPersonaResources({ official: true });
    const songsSource = await client.read('songs.json');
    if (!songsSource) throw new Error('R2 songs.json missing');
    const songs = JSON.parse(songsSource.body);
    if (!Array.isArray(songs)) throw new TypeError('R2 songs.json must be an array');
    const { fetchDpArrange } = await import('./dp-arrange.mjs');
    const results = await runHistoryBatch({ ids, client, R, songs, engine, dry: options.dry,
      concurrency: options.concurrency, arrangeFor: deps.arrangeFor || fetchDpArrange });
    const failed = results.filter(result => result.error || result.conflicted);
    const unchanged = results.filter(result => result.unchanged || (result.dry && !result.changed)).length;
    const changed = results.filter(result => result.updated || (result.dry && result.changed)).length;
    console.log(`공식 batch 완료: 성공 ${changed} / 무변화 ${unchanged} / 충돌 ${results.filter(result => result.conflicted).length} / 실패 ${results.filter(result => result.error).length}${options.dry ? ' / DRY RUN' : ''}`);
    for (const result of failed) console.error(`batch 실패 ${result.id}: ${result.conflicted ? 'conflicted' : result.error.message}`);
    if (failed.length) process.exitCode = 1;
    return results;
  }
  const { loadPersonaResources, attachArrange, chartsFromGridRows, personaFor, spChartsFromGridRows, spPersonaFor, reachNpsFor } = await import('./persona-lib.mjs');
  const { fetchDpArrangeByUser } = await import('./dp-arrange.mjs');
  // 자격 누락/조회 실패/불완전한 페이지는 R2 작업 전에 중단한다. 배치 없음으로 대체하지 않는다.
  const arrangeByUser = await fetchDpArrangeByUser();

  const BUCKET = 'ohsorry-data';
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'r2repersona-'));
  const DRY = args.includes('--dry');
  const limArg = args.find((a) => a.startsWith('--limit='));
  const onlyArg = args.find((a) => a.startsWith('--only='));
  const LIMIT = limArg ? Number(limArg.slice(8)) : Infinity;
  const ONLY = onlyArg ? new Set(onlyArg.slice(7).split(',')) : null;

  // ── R2 접근 — REST 우선, 실패 시 wrangler 폴백 ────────────────────────────────
  //   ⚠️ 종전엔 유저당 `npx --yes wrangler@4` 를 2번(GET/PUT) 불렀다. npx 가 호출마다 패키지를
  //      재해석해 **호출당 2~4초** 가 붙어 369명에 30분이 걸렸다(736회 스폰이 지배적).
  //      REST 는 프로세스 스폰이 없고 동시 실행도 되므로 수 분대로 떨어진다.
  //   폴백을 남기는 이유 — 토큰 스코프에 따라 REST object API 가 막힐 수 있다. 시작 시 1회 probe 해
  //   안 되면 통째로 wrangler 경로로 내려간다(종전 동작과 동일, 느릴 뿐 결과는 같다).
  const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
  const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
  const REST_BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets/${BUCKET}/objects/`;
  let useRest = !!(ACCOUNT && TOKEN);

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
  async function r2GetText(key) {
    if (useRest) {
      const r = await restFetch(key, { method: 'GET' });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`R2 GET ${key} — HTTP ${r.status}`);
      return await r.text();
    }
    const f = path.join(TMP, key.replace(/[/\\]/g, '_'));
    try { wrangler(['r2', 'object', 'get', `${BUCKET}/${key}`, `--file=${f}`, '--remote']); }
    catch { return null; }
    return fs.readFileSync(f, 'utf8');
  }
  async function r2PutText(key, text) {
    if (useRest) {
      const r = await restFetch(key, {
        method: 'PUT', body: text,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
      if (!r.ok) throw new Error(`R2 PUT ${key} — HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
      return;
    }
    const f = path.join(TMP, key.replace(/[/\\]/g, '_'));
    fs.writeFileSync(f, text);
    wrangler(['r2', 'object', 'put', `${BUCKET}/${key}`, `--file=${f}`,
      '--content-type=application/json; charset=utf-8', '--remote']);
  }
  async function guardedR2UserPut(id, local, source) {
    if (!lightGuardOn()) { await r2PutText(`user/${id}.json`, JSON.stringify(local)); return true; }
    return guardedSlowUserPut({ client: null, key: `user/${id}.json`, source, local, s3: deps.s3 });
  }
  // 동시 실행 풀 — 순서 무관(유저별 독립)이라 단순 워커 N개로 충분.
  async function pool(items, n, fn) {
    let i = 0;
    const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
    });
    await Promise.all(workers);
  }

  // 슬림 row → grid row 복원 (backfill-personas.mjs 와 동일)
  const rowsOf = (slim) => (slim || []).map((r) => {
    const s = songById.get(r.song_id);
    return s ? { song_id: r.song_id, title: s.title, textage_song_id: s.textage_song_id, diff: r.diff, ex_score: r.ex_score, lamp: r.lamp, bp: r.bp } : null;
  }).filter(Boolean);

  const R = await loadPersonaResources();
  if (!R.popmean) console.warn('::warning::persona-popmean.json 미로드 — DP 가 raw 경로로 생성된다');
  if (!R.popmeanSp) console.warn('::warning::persona-popmean-sp.json 미로드 — SP 가 raw 경로로 생성된다');

  // REST probe — 고정 키(users-list.json)를 1회 GET 해 본다. 401/403 이면 토큰이 object API 를
  //   못 쓰는 것 → wrangler 폴백. **유저 목록보다 먼저** 해야 한다(아래 목록 취득도 이 경로를 탄다).
  if (useRest) {
    try {
      const r = await restFetch('users-list.json', { method: 'GET' });
      if (r.status === 401 || r.status === 403) {
        console.warn(`::warning::R2 REST ${r.status} — wrangler 폴백(느림). 토큰에 R2 오브젝트 권한을 주면 빨라진다`);
        useRest = false;
      }
    } catch (e) { console.warn('::warning::R2 REST probe 실패 — wrangler 폴백:', e.message); useRest = false; }
  }

  // 슬림 row 복원용 곡 마스터. 🔴 2026-09-04 에 songs.json 은 git 추적이 끊겼다(R2 가 유일본) —
  //   종전처럼 fs 로 읽으면 체크아웃에 없어 ENOENT 로 즉사한다. R2 에서 받는다(backfill-user-rstar.mjs 와 같은 사상).
  //   ⚠️ 반드시 REST probe 뒤에 와야 한다 — 이 GET 도 그 경로를 탄다.
  //   🔴 없으면 중단한다 — 빈 맵으로 진행하면 모든 유저의 차트가 0건이 돼 persona 를 통째로 지우며 PUT 한다.
  const songsText = await r2GetText('songs.json');
  if (!songsText) { console.error('::error::R2 songs.json 없음 — 슬림 row 를 차트로 복원할 수 없다'); process.exit(1); }
  const songById = new Map(JSON.parse(songsText).map((s) => [s.song_id, s]));

  // 대상 유저 목록은 **R2 의 users-list.json** 에서 받는다.
  //   ⚠️ 종전엔 git 의 `user/` 폴더를 readdir 했는데, §4(2026-08-09)로 데이터 커밋을 중단해
  //   그 폴더가 그 시점에서 굳었다. 그대로 두면 이후 가입한 유저가 영영 대상에서 빠진다.
  //   R2 취득에 실패하면 굳은 git 폴더로 폴백한다(없는 것보다는 낫다 — 경고를 남긴다).
  let ids = [];
  try {
    const listText = await r2GetText('users-list.json');
    const list = listText ? JSON.parse(listText) : null;
    if (!Array.isArray(list) || !list.length) throw new Error('users-list 비었음');
    ids = list.map((u) => u.iidx_id).filter((x) => /^[A-Za-z0-9]+$/.test(String(x || '')));
    console.log(`대상 목록 = R2 users-list.json (${ids.length}명)`);
  } catch (e) {
    console.warn(`::warning::R2 users-list 취득 실패(${e.message}) — git user/ 폴더로 폴백(§4 이후 굳은 목록이라 신규 유저가 빠질 수 있다)`);
    try { ids = fs.readdirSync('user').filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); }
    catch { ids = []; }
  }
  if (!ids.length) { console.error('::error::대상 유저 목록이 비었다 — 중단'); process.exit(1); }
  if (ONLY) ids = ids.filter((i) => ONLY.has(i));
  ids = ids.slice(0, LIMIT);
  // wrangler 폴백은 프로세스 스폰이라 동시 실행 이득이 없다(오히려 메모리만 먹는다) → 1.
  const conArg = args.find((a) => a.startsWith('--concurrency='));
  const CONC = conArg ? Number(conArg.slice(14)) : (useRest ? 4 : 1);
  console.log(`대상 ${ids.length}명 (R2 read-modify-write / ${useRest ? 'REST' : 'wrangler'} / 동시 ${CONC}${DRY ? ' / DRY RUN' : ''})`);

  let put = 0, miss = 0, same = 0, fail = 0, dpOk = 0, spOk = 0, done = 0;
  await pool(ids, CONC, async (id) => {
    const key = `user/${id}.json`;
    let text;
    try { text = await r2GetText(key); }
    catch (e) { fail++; console.error('GET 실패', id, e.message); return; }
    if (text == null) {
      // R2 에 없는 유저 — git 본을 그대로 올린다(신규/누락 보정). 롤백 위험 없음(R2 가 비어 있으므로).
      const gp = path.join('user', `${id}.json`);
      if (lightGuardOn()) { fail++; console.error('GUARD: user 원본 없음', id); return; }
      if (!fs.existsSync(gp)) { miss++; return; }
      if (DRY) { put++; return; }
      try { await r2PutText(key, fs.readFileSync(gp, 'utf8')); put++; }
      catch (e) { fail++; console.error('PUT 실패(신규)', id, e.message); }
      return;
    }
    let data;
    try { data = JSON.parse(text); } catch (e) { fail++; console.error('파싱 실패', id, e.message); return; }
    // 🔴 비교 대상에 reachNps 를 꼭 넣는다 — 빼면 persona 가 같은 유저는 도달 NPS 가 새로 생겨도 PUT 이 생략된다.
    const snap = () => JSON.stringify([data.persona, data.spPersona, data.reachNps ?? null]);
    const before = snap();
    try {
      const dpCharts = chartsFromGridRows(attachArrange(rowsOf(data.dp), arrangeByUser.get(String(id)) || []), R.textageMeta);
      const fields = personaFields(data, R, songById, arrangeByUser.get(String(id)) || [],
        { attachArrange, chartsFromGridRows, personaFor, spChartsFromGridRows, spPersonaFor }, dpCharts);
      data.persona = fields.persona;
      if (data.persona) dpOk++;
      // 도달 NPS — dump-user 와 같은 helper·같은 차트 배열로 재산출해 값을 일치시킨다(nps-reach.md §8.1).
      data.reachNps = reachNpsFor(dpCharts, R);
      data.spPersona = fields.spPersona;
      if (data.spPersona) spOk++;
    } catch (e) { fail++; console.error('persona 실패', id, e.message); return; }
    if (snap() === before) { same++; return; }   // 변화 없으면 PUT 생략
    if (DRY) { put++; return; }
    try {
      if (!await guardedR2UserPut(id, data, { etag: null })) { fail++; console.error('GUARD: S3 CAS user PUT 실패', id); return; }
      put++;
    }
    catch (e) { fail++; console.error('PUT 실패', id, e.message); }
    if (++done % 50 === 0) console.log(`  ${done}/${ids.length} 처리 (PUT ${put} / 무변화 ${same} / 실패 ${fail})`);
  });
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`완료: PUT ${put} / 무변화 ${same} / R2·git 모두없음 ${miss} / 실패 ${fail} (DP ${dpOk} · SP ${spOk} 생성)`);
  if (fail) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

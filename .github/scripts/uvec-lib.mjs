import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const digest = (body) => createHash('sha256').update(body).digest('hex');
export const etag = (value) => String(value || '').replace(/^W\//i, '').replace(/^"|"$/g, '');
export const inputKey = (modules, assets) => digest(JSON.stringify([...Object.entries(modules), ...Object.entries(assets)].sort(([a], [b]) => a.localeCompare(b))));

// 문자열·주석을 토큰으로 분리해 정적 import/export와 리터럴 동적 import를 찾는다.
// 실행 시에만 정해지는 import는 그래프를 보장할 수 없으므로 중단한다.
export function imports(source) {
  const tokens = source.match(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|[^\s]/g) || [];
  const t = tokens.filter((x) => !x.startsWith('//') && !x.startsWith('/*'));
  const refs = [];
  const literal = (x) => x && (x[0] === '"' || x[0] === "'");
  const add = (x) => {
    if (!literal(x) || x.includes('\\')) throw new Error('지원하지 않는 import 지정자');
    const ref = x.slice(1, -1);
    if (!ref.startsWith('./') && !ref.startsWith('../')) throw new Error(`상대 import만 허용: ${ref}`);
    refs.push(ref);
  };
  for (let i = 0; i < t.length; i++) {
    if (!['import', 'export'].includes(t[i]) || t[i - 1] === '.') continue;
    if (t[i] === 'import' && t[i + 1] === '.') continue;
    if (t[i] === 'import' && t[i + 1] === '(') { add(t[i + 2]); continue; }
    if (t[i] === 'import' && literal(t[i + 1])) { add(t[i + 1]); continue; }
    if (t[i] === 'export' && !['*', '{'].includes(t[i + 1])) continue;
    for (let j = i + 1; j < t.length && t[j] !== ';'; j++) {
      if (t[j] === 'from' && literal(t[j + 1])) { add(t[j + 1]); break; }
      if (j > i + 1 && ['export', 'import'].includes(t[j])) break;
    }
  }
  return [...new Set(refs)];
}

export function createNetwork(fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  let tail = Promise.resolve();
  return (url, init) => {
    const job = tail.then(async () => {
      for (let n = 0; n < 5; n++) {
        await sleep(250);
        const response = await fetchImpl(url, init);
        if (response.status !== 429 || n === 4) return response;
        const value = response.headers.get('retry-after');
        const ms = value === null ? 1000 : /^\d+(\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
        await response.arrayBuffer();
        await sleep(Number.isFinite(ms) ? Math.max(0, ms) : 1000);
      }
    });
    tail = job.catch(() => {});
    return job;
  };
}

export async function collectGraph(webBase, network, options = {}) {
  if (!webBase && options.mode === 'coach') return collectR2CoachGraph(options.client);

  const base = /^https?:\/\//.test(webBase) ? new URL(webBase.endsWith('/') ? webBase : webBase + '/') : pathToFileURL(path.resolve(webBase) + path.sep);
  const coach = options.mode === 'coach' || options.entry === 'functions/api/[iidxId]/[resource].js';
  const entryPath = options.entry || (coach ? 'functions/api/[iidxId]/[resource].js' : 'v3/services/uvec-slice.js');
  if (coach && base.protocol !== 'file:') throw new Error('coach 그래프는 로컬 checkout만 허용');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uvec-'));
  const modules = {}, sources = {}, destinations = new Map();
  const visit = async (url) => {
    if (destinations.has(url.href)) return;
    if (!url.href.startsWith(base.href) || url.search || url.hash) throw new Error(`웹 루트 밖 import: ${url.href}`);
    const relative = decodeURIComponent(url.href.slice(base.href.length)).replaceAll(path.sep, '/');
    if (coach && path.isAbsolute(relative)) throw new Error(`웹 루트 밖 import: ${url.href}`);
    const destination = path.join(dir, relative);
    destinations.set(url.href, destination);
    const generated = coach && ['functions/_shared/coach-precompute-engine.js', 'functions/_shared/coach-precompute-engine.generated.js'].includes(relative);
    if (generated) {
      // Exclude generated bindings and their imports just like the web build.
      // The temporary calculation graph deliberately uses onRequestCalculated.
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, 'export const COACH_RECS_ENGINE_SHA256 = null;\n');
      return;
    }
    if (coach) {
      const realRoot = await fs.realpath(fileURLToPath(base));
      const realSource = await fs.realpath(fileURLToPath(url));
      if (!realSource.startsWith(realRoot + path.sep)) throw new Error(`Coach import escapes root: ${relative}`);
    }
    let source, tag;
    if (url.protocol === 'file:') { source = await fs.readFile(fileURLToPath(url), 'utf8'); tag = digest(source); }
    else {
      const r = await network(url.href, { cache: 'no-cache' });
      if (!r.ok) throw new Error(`웹 모듈 ${url.href}: HTTP ${r.status}`);
      source = await r.text(); tag = etag(r.headers.get('etag')) || digest(source);
    }
    modules[url.href] = tag;
    if (coach) sources[relative] = source.replace(/\r\n?/g, '\n');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    if (coach && /\bmodule\.exports\s*=/.test(source) && !/^\s*(?:import|export)\b/m.test(source)) {
      await fs.writeFile(destination + '.cjs', source);
      await fs.writeFile(destination, `export { default } from './${path.basename(destination)}.cjs';\n`);
    } else await fs.writeFile(destination, source);
    for (const ref of imports(source)) await visit(new URL(ref, url));
  };
  try {
    await fs.writeFile(path.join(dir, 'package.json'), '{"type":"module"}');
    const sourceEntry = new URL(entryPath, base);
    await visit(sourceEntry);
    const coachSources = coach ? Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b)).map(([name, source]) => [name, digest(source)])) : undefined;
    const canonical = coach ? (await import(new URL('functions/_shared/coach-precompute-contract.js', base).href)).graphCanonical : null;
    const coachFingerprint = coach ? digest(canonical(Object.entries(coachSources))) : undefined;
    return { modules, ...(coach ? { coachSources, coachFingerprint } : {}), entry: pathToFileURL(destinations.get(sourceEntry.href)).href,
      cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
  } catch (error) { await fs.rm(dir, { recursive: true, force: true }); throw error; }
}

// data.iidx.in 공개 CDN 은 Actions(데이터센터 IP)에서 존 보호에 403 으로 막힌다(2026-10-02 실측).
//   같은 키의 R2 원본을 REST 로 읽는다 — Worker 는 R2 객체를 그대로 내보내므로 바이트가 같다. 입력 키는 본문 해시.
export const DATA_HOST = 'data.iidx.in';
const dataKey = (url) => decodeURIComponent(url.pathname.replace(/^\//, ''));

export async function probeAssets(previous, network, readAsset = null) {
  const assets = {};
  for (const url of Object.keys(previous)) {
    const parsed = new URL(url);
    if (readAsset && parsed.host === DATA_HOST) {
      const body = await readAsset(dataKey(parsed));
      assets[url] = body === null ? 'status:404' : digest(body);
      continue;
    }
    let r = await network(url, { method: 'HEAD', cache: 'no-cache' });
    if (r.status === 404) { assets[url] = 'status:404'; continue; }
    const tag = etag(r.headers.get('etag'));
    if (r.ok && tag) { assets[url] = tag; continue; }
    r = await network(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`입력 자산 ${url}: HTTP ${r.status}`);
    assets[url] = etag(r.headers.get('etag')) || digest(await r.text());
  }
  return assets;
}

export function createSliceFetch({ read, readAsset = null, network, assets, base = 'https://iidx.in/' }) {
  const cache = new Map();
  const failures = [];
  const fetchSlice = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), base);
    const key = url.pathname.replace(/^\//, '');
    // R2 REST(r2-client)는 계산 입력이 아니다 — 웹 쪽이 계산 동안 전역 fetch 를 이 함수로 바꾸므로
    //   여기서도 그대로 통과시킨다(자산으로 기록하면 다음 회차 HEAD 가 인증 없이 실패한다).
    if (url.host === 'api.cloudflare.com') return network(input, init);
    const method = init?.method || (input instanceof Request ? input.method : 'GET');
    if (method !== 'GET' && method !== 'HEAD') throw new Error(`계산 중 쓰기 요청 금지: ${method}`);
    if (/^(user|arrange)\/[A-Za-z0-9]+\.json$/.test(key)) {
      let body;
      try { body = await read(key); } catch (error) { failures.push(error); throw error; }
      return new Response(body, { status: body === null ? 404 : 200, headers: { 'content-type': 'application/json' } });
    }
    if (!cache.has(url.href)) cache.set(url.href, (async () => {
      if (readAsset && url.host === DATA_HOST) {
        const text = await readAsset(dataKey(url));
        assets[url.href] = text === null ? 'status:404' : digest(text);
        const body = text === null ? new ArrayBuffer(0) : new TextEncoder().encode(text).buffer;
        return { body, status: text === null ? 404 : 200, headers: { 'content-type': 'application/octet-stream' } };
      }
      const r = await network(input instanceof Request ? input : url.href, init);
      if (!r.ok && r.status !== 404) {
        const error = new Error(`입력 자산 ${url.href}: HTTP ${r.status}`);
        throw error;
      }
      const body = await r.arrayBuffer();
      assets[url.href] = r.status === 404 ? 'status:404' : etag(r.headers.get('etag')) || digest(Buffer.from(body));
      return { body, status: r.status, headers: r.headers };
    })().catch((error) => { failures.push(error); throw error; }));
    const r = await cache.get(url.href);
    return new Response(r.body.slice(0), r);
  };
  fetchSlice.failures = failures;
  return fetchSlice;
}

export function selectTargets(users, arrangements, state, key) {
  const targets = [];
  for (const [id, userEtag] of users) {
    const old = state.users[id], arrangeEtag = arrangements.get(id) ?? null;
    if (!old || old.userEtag !== userEtag || old.arrangeEtag !== arrangeEtag || old.inputKey !== key) targets.push(id);
  }
  return targets.sort();
}

// Verify all bundle sources before importing, then verify the route closure.
export async function collectR2CoachGraph(client) {
  const pointer = await client.read('engine/coach-recs/current.json');
  if (!pointer) return null;
  const current = JSON.parse(pointer.body ?? Buffer.from(pointer.bytes).toString('utf8'));
  const hash = current.engine_sha256;
  if (current.schema !== 'coach-recs-engine/1' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('engine_pointer_invalid');
  const object = await client.read(`engine/coach-recs/${hash}.json`);
  if (!object) throw new Error('engine_bundle_missing');
  const bundle = JSON.parse(object.body ?? Buffer.from(object.bytes).toString('utf8'));
  if (bundle.schema !== 'coach-recs-engine/1' || bundle.engine_sha256 !== hash || !bundle.files || Array.isArray(bundle.files)) throw new Error('engine_bundle_invalid');
  const entries = Object.entries(bundle.files).map(([name, source]) => {
    if (!name || name.includes('\\') || name.includes(':') || name.split('/').some(part => !part || part.startsWith('.')) || typeof source !== 'string'
      || /coach-precompute-engine(?:\.generated)?\.js$/.test(name)) throw new Error('engine_bundle_path_invalid');
    return [name, digest(source.replace(/\r\n?/g, '\n'))];
  }).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  // graphCanonical root-relative path/hash ordering; do not execute unverified sources.
  if (digest(JSON.stringify(entries)) !== hash) throw new Error('engine_mismatch');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coach-engine-'));
  let graph;
  try {
    await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
    for (const [name, source] of Object.entries(bundle.files)) {
      const target = path.join(root, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, source.replace(/\r\n?/g, '\n'), 'utf8');
    }
    graph = await collectGraph(root, fetch, { mode: 'coach' });
    if (graph.coachFingerprint !== hash || JSON.stringify(Object.entries(graph.coachSources).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) !== JSON.stringify(entries)) throw new Error('engine_mismatch');
    return graph;
  } catch (error) { await graph?.cleanup(); throw error; }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

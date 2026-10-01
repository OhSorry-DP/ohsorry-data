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

export async function collectGraph(webBase, network) {
  const base = /^https?:\/\//.test(webBase) ? new URL(webBase.endsWith('/') ? webBase : webBase + '/') : pathToFileURL(path.resolve(webBase) + path.sep);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uvec-'));
  const modules = {}, destinations = new Map();
  const visit = async (url) => {
    if (destinations.has(url.href)) return;
    if (!url.href.startsWith(base.href) || url.search || url.hash) throw new Error(`웹 루트 밖 import: ${url.href}`);
    const relative = decodeURIComponent(url.href.slice(base.href.length));
    const destination = path.join(dir, relative);
    destinations.set(url.href, destination);
    let source, tag;
    if (url.protocol === 'file:') { source = await fs.readFile(fileURLToPath(url), 'utf8'); tag = digest(source); }
    else {
      const r = await network(url.href, { cache: 'no-cache' });
      if (!r.ok) throw new Error(`웹 모듈 ${url.href}: HTTP ${r.status}`);
      source = await r.text(); tag = etag(r.headers.get('etag')) || digest(source);
    }
    modules[url.href] = tag;
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, source);
    for (const ref of imports(source)) await visit(new URL(ref, url));
  };
  try {
    await fs.writeFile(path.join(dir, 'package.json'), '{"type":"module"}');
    await visit(new URL('v3/services/uvec-slice.js', base));
    return { modules, entry: pathToFileURL(destinations.get(new URL('v3/services/uvec-slice.js', base).href)).href,
      cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
  } catch (error) { await fs.rm(dir, { recursive: true, force: true }); throw error; }
}

export async function probeAssets(previous, network) {
  const assets = {};
  for (const url of Object.keys(previous)) {
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

export function createSliceFetch({ read, network, assets, base = 'https://iidx.in/' }) {
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

import { pathToFileURL } from 'node:url';
import * as r2 from './r2-client.mjs';
import { collectGraph, createNetwork, createSliceFetch, probeAssets, selectTargets, inputKey, etag } from './uvec-lib.mjs';

export function parseArgs(args) {
  const options = { apply: false, webBase: 'https://iidx.in/', maxUsers: 100 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') options.apply = true;
    else if (args[i] === '--dry-run') options.apply = false;
    else if (args[i] === '--web-base') options.webBase = args[++i];
    else if (args[i] === '--max-users') options.maxUsers = Number(args[++i]);
    else throw new Error(`알 수 없는 옵션: ${args[i]}`);
  }
  if (!options.webBase || !Number.isInteger(options.maxUsers) || options.maxUsers < 1) throw new Error('web-base / max-users 옵션 오류');
  return options;
}

// 모든 R2 호출과 실제 HTTP 요청을 감속한다. 전역 fetch도 교체해 웹의 기본 로더와
// r2-client 내부 페이지·재시도가 감속을 우회하지 못하게 한다.
export async function run({ apply = false, webBase = 'https://iidx.in/', maxUsers = 100,
  client = r2, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console } = {}) {
  if (!Number.isInteger(maxUsers) || maxUsers < 1) throw new Error('max-users는 양의 정수');
  const network = createNetwork(fetchImpl, sleep);
  const io = Object.fromEntries(['getText', 'listEntries', 'putText', 'del'].map((name) => [name, async (...args) => { await sleep(250); return client[name](...args); }]));
  const originalFetch = globalThis.fetch, originalWindow = globalThis.window;
  globalThis.fetch = network; globalThis.window = globalThis;
  let graph;
  const stats = { targets: 0, computed: 0, puts: 0, skips: 0, deletes: 0, failures: 0 };
  try {
    const raw = await io.getText('meta/uvec-state.json');
    let savedStateBody = raw;
    const state = raw === null ? { v: 1, users: {}, assets: {} } : JSON.parse(raw);
    if (state.v !== 1 || !state.users || !state.assets || Array.isArray(state.users) || Array.isArray(state.assets)) throw new Error('uvec 상태 형식 오류');
    const ids = (prefix, entries) => new Map(entries.filter(({ key }) => new RegExp(`^${prefix}/[A-Za-z0-9]+\\.json$`).test(key))
      .map(({ key, etag: tag }) => { if (!etag(tag)) throw new Error(`ETag 없음: ${key}`); return [key.slice(prefix.length + 1, -5), etag(tag)]; }));
    const users = ids('user', await io.listEntries('user/'));
    const arrangements = ids('arrange', await io.listEntries('arrange/'));
    const remote = new Map((await io.listEntries('uslice/')).filter(({ key }) => /^uslice\/[A-Za-z0-9]+-vec-dp\.json$/.test(key)).map(({ key, etag: tag }) => [key, etag(tag)]));
    graph = await collectGraph(webBase, network);
    const assets = await probeAssets(state.assets, network);
    const key = inputKey(graph.modules, assets);
    const targets = selectTargets(users, arrangements, state, key);
    stats.targets = targets.length;
    const readCache = new Map();
    const readInput = async (objectKey) => {
      if (!readCache.has(objectKey)) readCache.set(objectKey, (async () => {
        const body = await io.getText(objectKey);
        const id = objectKey.slice(objectKey.indexOf('/') + 1, -5);
        const expected = (objectKey.startsWith('user/') ? users : arrangements).get(id);
        if ((body === null) !== (expected === undefined)
          || (body !== null && /^[a-f\d]{32}$/i.test(expected) && r2.md5(body) !== expected.toLowerCase())) throw new Error(`목록 이후 입력 변경: ${objectKey}`);
        return body;
      })());
      return readCache.get(objectKey);
    };
    const sliceFetch = createSliceFetch({ read: readInput, network, assets });
    // REST 호출은 계산 자산으로 기록하지 않는다.
    globalThis.fetch = (url, init) => /^https:\/\/api\.cloudflare\.com\//.test(String(url instanceof Request ? url.url : url)) ? network(url, init) : sliceFetch(url, init);
    const { computeUvecSlice } = await import(graph.entry);
    if (typeof computeUvecSlice !== 'function') throw new Error('computeUvecSlice export 없음');
    const save = async () => {
      if (!apply) return;
      state.modules = graph.modules; state.assets = assets;
      const body = JSON.stringify(state);
      if (savedStateBody !== null && r2.md5(savedStateBody) === r2.md5(body)) return;
      const r = await io.putText('meta/uvec-state.json', body);
      if (!r?.ok) throw new Error(`상태 PUT 실패: ${r?.msg || ''}`);
      savedStateBody = body;
    };
    for (const id of Object.keys(state.users)) {
      if (!users.has(id) && !remote.has(`uslice/${id}-vec-dp.json`)) delete state.users[id];
    }
    // 삭제도 동일한 회당 예산을 소비한다. 실제 vec만 대상으로 요약/shard는 보존한다.
    let budget = maxUsers;
    for (const objectKey of remote.keys()) {
      const id = objectKey.slice(7, -12);
      if (users.has(id) || budget === 0) continue;
      if (apply && !await io.del(objectKey)) throw new Error(`vec DELETE 실패: ${objectKey}`);
      delete state.users[id]; stats.deletes++; budget--;
      await save();
    }
    const completed = [];
    try {
      for (const id of targets.slice(0, budget)) {
        let slice;
        try { slice = await computeUvecSlice(id, { fetchImpl: sliceFetch, fetch: sliceFetch }); }
        catch (error) {
          // 입력·자산 조회 장애는 회차 중단. 그 유저 데이터 때문에 계산만 실패하면 건너뛴다 —
          //   정렬 순서상 같은 유저가 매 회차 앞에 서서 뒤 유저 전부를 막지 않게(상태 미갱신 → 다음 회차 재시도).
          if (sliceFetch.failures.length) throw sliceFetch.failures[0];
          stats.failures++; log.warn(`[uvec] ${id} 계산 실패 — 건너뜀: ${error?.message || error}`);
          continue;
        }
        if (sliceFetch.failures.length) throw sliceFetch.failures[0];
        if (!slice || slice.v !== 1 || slice.id !== id || !Object.hasOwn(slice, 'date') || !Object.hasOwn(slice, 'arrangeSig') || !Object.hasOwn(slice, 'vec')) throw new Error(`벡터 계약 오류: ${id}`);
        const body = JSON.stringify(slice), objectKey = `uslice/${id}-vec-dp.json`;
        if (remote.get(objectKey) === r2.md5(body)) stats.skips++;
        else {
          if (apply) { const r = await io.putText(objectKey, body); if (!r?.ok) throw new Error(`vec PUT 실패: ${id}`); }
          stats.puts++;
        }
        state.users[id] = { userEtag: users.get(id), arrangeEtag: arrangements.get(id) ?? null, inputKey: inputKey(graph.modules, assets) };
        completed.push(id); stats.computed++;
        await save();
      }
    } finally {
      // 새로 발견한 공통 자산도 이번 회차의 모든 완료 유저에 동일하게 반영한다.
      const finalKey = inputKey(graph.modules, assets);
      for (const id of completed) state.users[id].inputKey = finalKey;
      await save();
    }
    log.log(JSON.stringify({ apply, ...stats }));
    return { ...stats, state };
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
    await graph?.cleanup();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    if (!r2.useRest) throw new Error('R2 REST 토큰 필요 (wrangler 폴백 금지)');
    await run(parseArgs(process.argv.slice(2)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

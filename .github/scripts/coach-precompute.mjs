import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { collectGraph, digest } from './uvec-lib.mjs';
import { conditionalR2Client, pool } from './r2-client.mjs';

// 조건부 클라이언트의 ETag 검증을 유지하면서 디코딩 전 원본도 보존한다.
export function createClient(env = process.env, fetchImpl = fetch) {
  const raw = new Map();
  const client = conditionalR2Client({ account: env.CLOUDFLARE_ACCOUNT_ID,
    token: env.CLOUDFLARE_R2_TOKEN || env.CLOUDFLARE_API_TOKEN,
    fetchImpl: async (url, init) => {
      const response = await fetchImpl(url, init);
      if (init.method === 'GET' && response.ok && !String(url).includes('?')) {
        const key = decodeURIComponent(new URL(url).pathname.split('/objects/')[1]);
        raw.set(key, Buffer.from(await response.clone().arrayBuffer()));
      }
      return response;
    } });
  return { ...client, async read(key) {
    raw.delete(key);
    const object = await client.read(key);
    return object && { ...object, bytes: raw.get(key) };
  } };
}

export function parseArgs(args) {
  const options = { dry: false, concurrency: 4 };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--dry') options.dry = true;
    else if (['--web-root', '--only', '--concurrency'].includes(key)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${key}: 값 없음`);
      if (key === '--web-root') options.webRoot = path.resolve(value);
      if (key === '--only') options.only = value.split(',');
      if (key === '--concurrency') options.concurrency = Number(value);
    } else throw new Error(`알 수 없는 옵션: ${key}`);
  }
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) throw new Error('양의 concurrency 필요');
  return options;
}

const bytesOf = (object) => Buffer.from(object.bytes ?? object.body);
const decoded = (bytes) => (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString('utf8');
const cpuMs = (start) => { const cpu = process.cpuUsage(start); return (cpu.user + cpu.system) / 1000; };

export async function produceUser({ webRoot, id, client, dry = false, env = process.env }) {
  id = String(id).replaceAll('-', '').trim().toUpperCase();
  const wall = performance.now(), cpu = process.cpuUsage();
  const result = { id, dry, puts: 0, cells: [], attempts: 0 };
  const originalFetch = globalThis.fetch;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      result.attempts++;
      const graph = await collectGraph(webRoot, originalFetch, { mode: 'coach', client });
      if (!graph) { console.warn('::warning::engine/coach-recs/current.json missing; coach precompute skipped'); result.ok = true; result.skipped = true; return result; }
      try {
        const graphRoot = new URL('../../../', graph.entry);
        const contract = await import(new URL('functions/_shared/coach-precompute-contract.js', graphRoot));
        const { EXPECTED_CONTRACT } = await import(new URL('functions/_shared/coach-recs-phys.js', graphRoot));
        const { onRequestCalculated } = await import(graph.entry);
        const { CELLS, normalizeCellQuery, normalizePhysicalPolicy, indexPath, bodyPath, validateIndex, MAX_BODY_BYTES } = contract;
        const indexKey = indexPath(id);
        if (!indexKey) throw new Error('invalid_id');
        result.engine_sha256 = graph.coachFingerprint;
        if (env.COACH_RECS_ENGINE_SHA256 && env.COACH_RECS_ENGINE_SHA256 !== graph.coachFingerprint) throw new Error('engine_mismatch');
        const previous = await client.read(indexKey);
        const snapshot = new Map(), failures = [];
        const read = async (key) => {
          if (!snapshot.has(key)) snapshot.set(key, (async () => {
            try {
              const object = await client.read(key);
              if (object && !object.etag) throw new Error(`source_etag_missing: ${key}`);
              return object && { bytes: bytesOf(object), etag: object.etag };
            } catch (error) { failures.push(error); throw error; }
          })());
          return snapshot.get(key);
        };
        const object = async (key) => {
          const source = await read(key);
          if (!source) return null;
          const bytes = source.bytes;
          return { etag: source.etag, httpEtag: source.etag, size: bytes.length, uploaded: new Date(0),
            body: new Response(bytes).body,
            json: async () => JSON.parse(decoded(bytes)), text: async () => decoded(bytes),
            arrayBuffer: async () => Uint8Array.from(bytes).buffer };
        };
        const bucket = { get: object, head: object };
        globalThis.fetch = async (input, init) => {
          try {
            const url = new URL(input instanceof Request ? input.url : String(input));
            const method = init?.method || (input instanceof Request ? input.method : 'GET');
            if (url.hostname !== 'data.iidx.in' || !['GET', 'HEAD'].includes(method)) throw new Error(`fetch_bridge_rejected: ${url}`);
            const source = await read(decodeURIComponent(url.pathname.slice(1)));
            return new Response(method === 'HEAD' || !source ? null : source.bytes,
              { status: source ? 200 : 404, headers: { 'content-type': 'application/json' } });
          } catch (error) { failures.push(error); throw error; }
        };
        const bodies = new Map(), cells = {};
        result.cells = [];
        for (const cell of CELLS) {
          const [group, layout, explain] = cell.split('.');
          const query = new URLSearchParams(normalizeCellQuery(group, { layout, ...(explain === 'full' ? { explain } : {}) }));
          query.delete('explain');
          if (explain === 'full') query.set('explain', 'full');
          query.set('kind', group.startsWith('C-') ? 'clear' : group === 'P' ? 'practice' : 'ladder');
          const start = performance.now(), cellCpu = process.cpuUsage();
          const response = await onRequestCalculated({ request: new Request(`https://iidx.in/api/${id}/recommend?${query}`),
            params: { iidxId: id, resource: 'recommend' }, env: { ...env, DATA: bucket }, waitUntil() {} });
          const bytes = Buffer.from(await response.arrayBuffer());
          result.cells.push({ cell, wall_ms: performance.now() - start, cpu_ms: cpuMs(cellCpu), bytes: bytes.length });
          if (failures.length) throw failures[0];
          if (response.status !== 200 || response.headers.get('content-type')?.split(';')[0] !== 'application/json') throw new Error(`cell_response: ${cell} HTTP ${response.status}`);
          if (bytes.length > MAX_BODY_BYTES) throw new Error(`body_too_large: ${cell}`);
          const parsed = JSON.parse(bytes.toString('utf8'));
          // 점수 축 입력 부재는 엔진의 결정적인 200 응답이며 원래 bytes를 저장한다.
          if (parsed.error && parsed.error !== 'no_r_star') throw new Error(`cell_error: ${cell} ${parsed.error}`);
          bodies.set(cell, bytes);
          cells[cell] = { status: 'ready', content_type: 'application/json', byte_length: bytes.length, body_sha256: digest(bytes) };
        }
        globalThis.fetch = originalFetch;
        const sources = await Promise.all([...snapshot].map(async ([key, promise]) => {
          const source = await promise;
          return [key, source ? digest(source.bytes) : null];
        }));
        sources.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
        const policy = normalizePhysicalPolicy(env);
        const generation = digest(JSON.stringify([graph.coachFingerprint, EXPECTED_CONTRACT, policy, sources, CELLS.map(cell => [cell, cells[cell].body_sha256])]));
        const index = { schema: 'coach-recs-precompute/1', id, engine_sha256: graph.coachFingerprint,
          physical_contract: EXPECTED_CONTRACT, physical_policy: policy, generation, cells };
        if (!validateIndex(index, { id, engine_sha256: graph.coachFingerprint })) throw new Error('invalid_index');
        result.generation = generation;
        if (!dry) for (const [cell, bytes] of bodies) {
          const key = bodyPath(id, generation, cell);
          const existing = await client.read(key);
          if (existing) {
            if (!bytesOf(existing).equals(bytes)) throw new Error(`immutable_conflict: ${key}`);
          } else { await client.put(key, bytes, null); result.puts++; }
        }
        let changed = false;
        for (const [key, promise] of snapshot) {
          const source = await promise, current = await client.read(key);
          if ((source?.etag ?? null) !== (current?.etag ?? null)) changed = true;
        }
        if (changed) {
          if (attempt === 0) continue;
          throw new Error('source_changed');
        }
        if (!dry) { await client.put(indexKey, JSON.stringify(index), previous?.etag ?? null); result.puts++; }
        result.ok = true;
        return result;
      } finally { globalThis.fetch = originalFetch; await graph.cleanup(); }
    }
  } catch (error) { result.ok = false; result.reason = error.message; return result; }
  finally { globalThis.fetch = originalFetch; result.wall_ms = performance.now() - wall; result.cpu_ms = cpuMs(cpu); }
}

export async function main(args = process.argv.slice(2), deps = {}) {
  const options = parseArgs(args);
  const client = deps.client || createClient();
  const graph = await collectGraph(options.webRoot, fetch, { mode: 'coach', client });
  if (!graph) { console.warn('::warning::engine/coach-recs/current.json missing; coach precompute skipped'); return []; }
  let contract;
  try { contract = await import(new URL('../../_shared/coach-precompute-contract.js', graph.entry)); }
  finally { await graph.cleanup(); }
  const ids = [...new Set(options.only || (await client.listEntries('user/')).map(({ key }) => /^user\/([^/]+)\.json$/.exec(key)?.[1]).filter(Boolean))]
    .map(id => id.replaceAll('-', '').trim().toUpperCase()).sort();
  if (ids.some(id => !contract.indexPath(id))) throw new Error('invalid_id');
  const results = [];
  await pool(ids, options.concurrency, async (id) => {
    const result = await new Promise((resolve) => {
      const child = fork(fileURLToPath(import.meta.url), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: process.env });
      let output;
      child.on('message', value => { output = value; });
      child.on('error', error => resolve({ id, ok: false, reason: error.message }));
      child.on('exit', code => resolve(output || { id, ok: false, reason: `child_exit: ${code}` }));
      child.send({ ...options, id });
    });
    results.push(result);
    console.log(JSON.stringify(result));
  });
  if (results.some(result => !result.ok)) process.exitCode = 1;
  return results;
}

if (process.send) process.once('message', async options => {
  const result = await produceUser({ ...options, client: createClient() });
  process.send(result, () => process.disconnect());
});
else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

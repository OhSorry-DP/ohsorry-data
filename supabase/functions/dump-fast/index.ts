type Env = (name: string) => string | undefined;
type Row = Record<string, unknown>;
type Deps = {
  getEnv: Env;
  selectBuffer: (id: string, offset: number) => Promise<{ rows: Row[]; total: number }>;
  getR2: (key: string) => Promise<Uint8Array>;
  prepareFastDump: (input: any) => Record<string, any>;
};

const HIST_COLS = ['song_id', 'diff', 'lamp', 'ex_score', 'played_version', 'date', 'date_kst', 'play_style', 'bp', 'note_count'];
const R2_KEYS = (id: string) => [`hist/${id}.json`, `user/${id}.json`, 'meta/song-aliases.json', 'songs.json'];
const noStore = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' };
const response = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify({ histMatch: null, userMatch: null, calculatedHistHash: null, publishedHistHash: null, calculatedUserHash: null, publishedUserHash: null, bufferRows: null, ...body }), { status, headers: noStore });
const inconclusive = (reason: string, extras: Record<string, unknown> = {}) => ({ status: 'inconclusive', matched: null, reason, ...extras });

function deterministic(value: any): string {
  if (Array.isArray(value)) return `[${value.map(deterministic).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${deterministic(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function fields(user: any) {
  const keys = ['dp', 'sp', 'dpRecent', 'spRecent'];
  if (!user || keys.some(k => !Object.hasOwn(user, k))) throw new Incompatible();
  return deterministic(Object.fromEntries(keys.map(k => [k, user[k]])));
}
class Incompatible extends Error {}
class Incomplete extends Error {}
class Missing extends Error {}
class External extends Error {}

async function readBuffer(deps: Deps, id: string) {
  let offset = 0, total: number | undefined, pages = 0, lastId = -1;
  const rows: Row[] = [], seen = new Set<number>();
  while (true) {
    if (pages >= 51) throw new Incomplete();
    const page = await deps.selectBuffer(id, offset) as { rows: Row[]; total: number };
    pages++;
    if (!page || !Array.isArray(page.rows)) throw new Incomplete();
    const count = page.total;
    if (!Number.isSafeInteger(count) || count < 0 || (total !== undefined && total !== count)) throw new Incomplete();
    total = count;
    if (count > 50_000 || page.rows.length > 1000 || page.rows.length !== Math.min(1000, Math.max(0, count - offset))) throw new Incomplete();
    for (const row of page.rows) {
      if (!row || typeof row !== 'object') throw new Incomplete();
      const idNum = row.score_id;
      if (typeof idNum !== 'number' || !Number.isSafeInteger(idNum) || idNum <= lastId || seen.has(idNum)) throw new Incomplete();
      lastId = idNum; seen.add(idNum); rows.push(row);
    }
    if (rows.length > 50_000) throw new Incomplete();
    if (page.rows.length < 1000) break;
    offset += 1000;
  }
  if (rows.length !== total) throw new Incomplete();
  const fingerprint = await digest(new TextEncoder().encode(deterministic(rows.map(r => ['score_id','iidx_id',...HIST_COLS].map(k => r[k] === undefined ? null : r[k])))));
  return { rows, fingerprint };
}
async function digest(bytes: Uint8Array) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, '0')).join('');
}
function parse(bytes: Uint8Array) { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }

export function createDumpFastHandler(options: Pick<Deps, 'getEnv'> & Partial<Omit<Deps, 'getEnv'>> & { loadReads?: () => Promise<Omit<Deps, 'getEnv'>> }) {
  return async (request: Request): Promise<Response> => {
    const { getEnv } = options;
    const mode = getEnv('FAST_DUMP_MODE');
    const publish = mode === 'publish';
    const responseMode = publish ? 'publish' : 'shadow';
    if (mode !== 'shadow' && !publish) return response(503, { mode: 'shadow', status: 'unavailable', reason: 'mode_unavailable' });
    if (publish) {
      const secret = getEnv('FAST_DUMP_LIGHT_SECRET');
      if (!secret || secret.length < 32) return response(503, { mode: responseMode, status: 'unavailable', reason: 'configuration_unavailable' });
      if (request.headers.get('x-fast-dump-light-secret') !== secret) return response(401, { mode: responseMode, status: 'unauthorized', reason: 'unauthorized' });
      if (request.method !== 'POST') return response(405, { mode: responseMode, status: 'rejected', reason: 'method_not_allowed' });
      if ((request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') return response(415, { mode: responseMode, status: 'rejected', reason: 'unsupported_media_type' });
      let bytes: Uint8Array;
      try {
        const reader = request.body?.getReader(), chunks: Uint8Array[] = [];
        let size = 0;
        if (reader) while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 4096) { await reader.cancel(); return response(413, { mode: responseMode, status: 'rejected', reason: 'body_too_large' }); }
          chunks.push(value);
        }
        bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      } catch { return response(400, { mode: responseMode, status: 'rejected', reason: 'invalid_body' }); }
      let body: any;
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return response(400, { mode: responseMode, status: 'rejected', reason: 'invalid_json' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 3 || !Object.hasOwn(body, 'iidxId') || !Object.hasOwn(body, 'generation') || !Object.hasOwn(body, 'since') || typeof body.iidxId !== 'string' || !/^[A-Za-z0-9]+$/.test(body.iidxId) || typeof body.generation !== 'string' || !/^[1-9][0-9]*$/.test(body.generation) || typeof body.since !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(body.since) || !Number.isFinite(Date.parse(body.since)) || new Date(Date.parse(body.since)).toISOString() !== body.since) return response(400, { mode: responseMode, status: 'rejected', reason: 'invalid_request' });
      let deps: Deps;
      try { deps = { getEnv, ...(options.loadReads ? await options.loadReads() : options) } as Deps; }
      catch { return response(503, { mode: responseMode, status: 'unavailable', reason: 'configuration_unavailable' }); }
      try {
        const [{ runLightDump }, { createR2S3Adapter }] = await Promise.all([import('../_shared/dump-fast-worker.ts'), import('../_shared/r2-s3.ts')]);
        const r2 = createR2S3Adapter({ accountId: getEnv('R2_ACCOUNT_ID')!, accessKeyId: getEnv('R2_ACCESS_KEY_ID')!, secretAccessKey: getEnv('R2_SECRET_ACCESS_KEY')!, bucket: getEnv('R2_BUCKET')!, fetchImpl: fetch });
        const read = async (key: string) => {
          if (!R2_KEYS(body.iidxId).includes(key) && key !== `pending/${body.iidxId}.json`) throw new Error('invalid R2 key');
          const result = await r2.get(key);
          return { body: new TextDecoder('utf-8', { fatal: true }).decode(result.value!), etag: result.etag ?? null };
        };
        const put = async (key: string, value: string, etag: string) => {
          if (key !== `user/${body.iidxId}.json` && key !== `pending/${body.iidxId}.json`) throw new Error('invalid R2 write key');
          await r2.put(key, new TextEncoder().encode(value), { ifMatch: etag });
        };
        const result = await runLightDump({ id: body.iidxId, G: body.generation, since: body.since, deps: { readBuffer: id => readBuffer(deps, id), read, put, prepareFastDump: deps.prepareFastDump } });
        return response(result.ok ? 200 : 409, { mode: responseMode, status: result.ok ? 'complete' : 'skipped', ...result, value: undefined });
      } catch { return response(502, { mode: responseMode, status: 'error', reason: 'publication_failed' }); }
    }
    const secret = getEnv('FAST_DUMP_SHADOW_SECRET');
    if (!secret || secret.length < 32) return response(503, { mode: responseMode, status: 'unavailable', reason: 'configuration_unavailable' });
    if (request.headers.get('x-fast-dump-shadow-secret') !== secret) return response(401, { mode: responseMode, status: 'unauthorized', reason: 'unauthorized' });
    if (request.method !== 'POST') return response(405, { mode: 'shadow', status: 'rejected', reason: 'method_not_allowed' });
    if ((request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') return response(415, { mode: responseMode, status: 'rejected', reason: 'unsupported_media_type' });
    let bytes: Uint8Array;
    try {
      const reader = request.body?.getReader(), chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 4096) { await reader.cancel(); return response(413, { mode: responseMode, status: 'rejected', reason: 'body_too_large' }); }
        chunks.push(value);
      }
      bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    } catch { return response(400, { mode: responseMode, status: 'rejected', reason: 'invalid_body' }); }
    if (bytes.length > 4096) return response(413, { mode: responseMode, status: 'rejected', reason: 'body_too_large' });
    let body: any;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return response(400, { mode: responseMode, status: 'rejected', reason: 'invalid_json' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'iidxId') || typeof body.iidxId !== 'string' || !/^[A-Za-z0-9]+$/.test(body.iidxId)) return response(400, { mode: 'shadow', status: 'rejected', reason: 'invalid_request' });
    const id = body.iidxId;
    let deps: Deps;
    try { deps = { getEnv, ...(options.loadReads ? await options.loadReads() : options) } as Deps; }
    catch { return response(503, { mode: 'shadow', status: 'unavailable', reason: 'configuration_unavailable' }); }
    let firstBuffer: Awaited<ReturnType<typeof readBuffer>>;
    try { firstBuffer = await readBuffer(deps, id); } catch (e: any) { if (e instanceof Incomplete) return response(200, { mode: 'shadow', ...inconclusive('buffer_incomplete', { bufferRows: null }) }); if (e?.code === 'credentials_missing') return response(503, { mode: 'shadow', status: 'unavailable', reason: 'configuration_unavailable' }); return response(502, { mode: 'shadow', status: 'error', reason: 'upstream_read_failed' }); }
    let firstObjects: Uint8Array[];
    try { firstObjects = await Promise.all(R2_KEYS(id).map(k => deps.getR2(k))); } catch (e) { if (e instanceof Missing) return response(200, { mode: 'shadow', ...inconclusive('reference_missing', { bufferRows: firstBuffer.rows.length }) }); return response(502, { mode: 'shadow', status: 'error', reason: 'upstream_read_failed' }); }
    const [histBytes, userBytes, aliasesBytes, songsBytes] = firstObjects;
    try {
      const hist = parse(histBytes), user = parse(userBytes), aliases = parse(aliasesBytes), songs = parse(songsBytes);
      const nowMs = typeof user?._v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(user._v) ? Date.parse(user._v) : NaN;
      if (!Number.isFinite(nowMs) || new Date(nowMs).toISOString() !== user._v) throw new Incompatible();
      const histHash = await digest(histBytes);
      const run = (restRows: Row[]) => deps.prepareFastDump({ iidxId: id, previousHistRows: hist, restRows, aliases, aliasesBytes, songs, previousUser: user, generation: 1, nowMs });
      const baseline = run([]);
      const baselineHash = await digest(baseline.histBytes);
      if (baselineHash !== histHash) throw new Incompatible();
      const candidate = run(firstBuffer.rows);
      const calcHistHash = await digest(candidate.histBytes);
      const calcFields = fields(candidate.fastPatch), publishedFields = fields(user);
      const firstUserHash = await digest(new TextEncoder().encode(publishedFields));
      let afterBuffer, afterObjects;
      try { [afterBuffer, afterObjects] = await Promise.all([readBuffer(deps, id), Promise.all(R2_KEYS(id).map(k => deps.getR2(k)))]); }
      catch (e) {
        if (e instanceof Missing) return response(200, { mode: 'shadow', ...inconclusive('reference_missing') });
        if (!(e instanceof Incomplete)) return response(502, { mode: 'shadow', status: 'error', reason: 'upstream_read_failed' });
        return response(200, { mode: 'shadow', ...inconclusive('inputs_changed', { histMatch: null, userMatch: null, calculatedHistHash: calcHistHash, publishedHistHash: histHash, bufferRows: firstBuffer.rows.length }) });
      }
      const afterHashes = await Promise.all(afterObjects.map(digest));
      const originalHashes = await Promise.all(firstObjects.map(digest));
      if (afterBuffer.fingerprint !== firstBuffer.fingerprint || afterHashes.some((h, i) => h !== originalHashes[i])) return response(200, { mode: 'shadow', ...inconclusive('inputs_changed', { histMatch: null, userMatch: null, calculatedHistHash: calcHistHash, publishedHistHash: histHash, bufferRows: firstBuffer.rows.length }) });
      if (calcHistHash !== histHash && firstBuffer.rows.length) return response(200, { mode: 'shadow', ...inconclusive('buffer_not_reflected_or_reference_drift', { histMatch: false, userMatch: null, calculatedHistHash: calcHistHash, publishedHistHash: histHash, bufferRows: firstBuffer.rows.length }) });
      const userMatch = calcFields === publishedFields;
      if (calcHistHash === histHash && !userMatch) return response(409, { mode: 'shadow', status: 'mismatch', matched: false, reason: 'user_fast_fields_differ', histMatch: true, userMatch: false, calculatedHistHash: calcHistHash, publishedHistHash: histHash, calculatedUserHash: await digest(new TextEncoder().encode(calcFields)), publishedUserHash: firstUserHash, bufferRows: firstBuffer.rows.length });
      if (calcHistHash !== histHash) return response(200, { mode: 'shadow', ...inconclusive('reference_incompatible', { histMatch: false, userMatch: null, calculatedHistHash: calcHistHash, publishedHistHash: histHash, bufferRows: firstBuffer.rows.length }) });
      return response(200, { mode: 'shadow', status: 'matched', matched: true, reason: null, histMatch: true, userMatch: true, calculatedHistHash: calcHistHash, publishedHistHash: histHash, calculatedUserHash: firstUserHash, publishedUserHash: firstUserHash, bufferRows: firstBuffer.rows.length });
    } catch (e) {
      if (e instanceof Incompatible) return response(200, { mode: 'shadow', ...inconclusive('reference_incompatible', { histMatch: null, userMatch: null, bufferRows: firstBuffer.rows.length }) });
      return response(500, { mode: 'shadow', status: 'error', reason: 'calculation_failed' });
    }
  };
}

export function createReadAdapters({ getEnv, fetchImpl, r2Get }: { getEnv: Env; fetchImpl: typeof fetch; r2Get: (key: string) => Promise<Uint8Array> }) {
  const getOnly = async (url: string, headers?: HeadersInit) => { const response = await fetchImpl(url, { method: 'GET', headers }); if (!response.ok) { const error: any = new External(); error.status = response.status; throw error; } return response; };
  const selectBuffer = async (id: string, offset: number) => {
    const base = getEnv('SUPABASE_URL'), key = getEnv('SUPABASE_SERVICE_ROLE_KEY');
    if (!base || !key) { const error: any = new Error('credentials_missing'); error.code = 'credentials_missing'; throw error; }
    const query = `scores?iidx_id=eq.${encodeURIComponent(id)}&played_version=neq.-10&select=score_id,iidx_id,${HIST_COLS.join(',')}&order=score_id.asc&limit=1000&offset=${offset}`;
    let res: Response;
    try { res = await getOnly(`${base.replace(/\/$/, '')}/rest/v1/${query}`, { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact' }); } catch (error) { if ((error as any)?.code === 'credentials_missing') throw error; throw new External(); }
    const range = res.headers.get('content-range')?.match(/^(?:(\d+)-(\d+)|\*)\/(\d+)$/);
    if (!range) throw new Incomplete();
    let rows: unknown; try { rows = await res.json(); } catch { throw new Incomplete(); }
    if (!Array.isArray(rows) || (rows.length ? Number(range[1]) !== offset || Number(range[2]) !== offset + rows.length - 1 : range[1] !== undefined)) throw new Incomplete();
    return { rows: rows as Row[], total: Number(range[3]) };
  };
  const getR2 = async (key: string) => {
    if (!/^hist\/[A-Za-z0-9]+\.json$/.test(key) && !/^user\/[A-Za-z0-9]+\.json$/.test(key) && key !== 'songs.json' && key !== 'meta/song-aliases.json') throw new Error('invalid R2 key');
    try { return await r2Get(key); } catch (e: any) { if (e?.status === 404) throw new Missing(); throw new External(); }
  };
  return { selectBuffer, getR2 };
}

export function getOnlyFetch(fetchImpl: typeof fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (method.toUpperCase() !== 'GET' || init?.body != null) throw new Error('GET only');
    return fetchImpl(input, { ...init, method: 'GET' });
  }) as typeof fetch;
}

export async function loadDefaultReads(getEnv: Env, fetchImpl: typeof fetch = fetch) {
  for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']) {
    if (!getEnv(key)) throw new Error('credentials_missing');
  }
  const { Buffer } = await import('node:buffer');
  (globalThis as any).Buffer = Buffer;
  const { prepareFastDump } = await import('../../../.github/scripts/dump-fast-core.mjs');
  const { createR2S3Adapter } = await import('../_shared/r2-s3.ts');
  const readFetch = getOnlyFetch(fetchImpl);
  const r2 = createR2S3Adapter({ accountId: getEnv('R2_ACCOUNT_ID')!, accessKeyId: getEnv('R2_ACCESS_KEY_ID')!, secretAccessKey: getEnv('R2_SECRET_ACCESS_KEY')!, bucket: getEnv('R2_BUCKET')!, fetchImpl: readFetch });
  const adapters = createReadAdapters({ getEnv, fetchImpl: readFetch, r2Get: async key => (await r2.get(key)).value! });
  return { ...adapters, prepareFastDump };
}

export function serveDumpFast() {
  const getEnv: Env = name => Deno.env.get(name);
  Deno.serve(createDumpFastHandler({ getEnv, loadReads: () => loadDefaultReads(getEnv) }));
}

if (typeof Deno !== 'undefined' && import.meta.main) await serveDumpFast();

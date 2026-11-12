import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const validId = id => typeof id === 'string' && /^[A-Za-z0-9]+$/.test(id);

export function parseArgs(args) {
  const options = { write: false, limit: Infinity, concurrency: 4, nullPolicy: 'keep' };
  for (const arg of args) {
    if (arg === '--write') options.write = true;
    else if (arg.startsWith('--only=')) options.only = new Set(arg.slice(7).split(',').filter(Boolean));
    else if (arg.startsWith('--limit=')) options.limit = Number(arg.slice(8));
    else if (arg.startsWith('--concurrency=')) options.concurrency = Number(arg.slice(14));
    else if (arg.startsWith('--null-policy=')) options.nullPolicy = arg.slice(14);
    else if (arg.startsWith('--out=')) options.out = path.resolve(arg.slice(6));
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.out) throw new Error('--out=<folder> is required');
  if ((!Number.isSafeInteger(options.limit) && options.limit !== Infinity) || options.limit < 0) throw new Error('--limit must be a non-negative integer');
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) throw new Error('--concurrency must be a positive integer');
  if (!['keep', 'clear'].includes(options.nullPolicy)) throw new Error('--null-policy must be keep or clear');
  for (const id of options.only || []) if (!validId(id)) throw new Error(`Invalid id: ${id}`);
  return options;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}

export function makeSql(rows) {
  const lines = ['BEGIN;', "SET LOCAL ohsorry_internal.official_user_write = '1';"];
  if (!rows.length) lines.push('-- No users to update.');
  else {
    const values = rows.map(({ id, new: value }) => `  ('${id.replaceAll("'", "''")}', ${value.sp_cpi === null ? 'NULL::integer' : `${value.sp_cpi}::integer`}, ${value.sp_star === null ? 'NULL::numeric' : `${value.sp_star}::numeric`})`);
    lines.push('UPDATE public.users AS u SET sp_cpi = v.sp_cpi, sp_star = v.sp_star', 'FROM (VALUES', `${values.join(',\n')}`, ') AS v(iidx_id, sp_cpi, sp_star)', 'WHERE u.iidx_id = v.iidx_id;');
  }
  lines.push('COMMIT;', '');
  return lines.join('\n');
}

export async function main(args = process.argv.slice(2), deps = {}) {
  const options = parseArgs(args);
  const client = deps.client || (await import('./r2-client.mjs')).conditionalR2Client({
    account: process.env.CLOUDFLARE_ACCOUNT_ID,
    token: process.env.CLOUDFLARE_R2_TOKEN || process.env.CLOUDFLARE_API_TOKEN,
  });
  const read = async (key, label) => {
    const source = await client.read(key);
    if (!source) throw new Error(`R2 ${label} missing`);
    return { source, value: JSON.parse(source.body) };
  };
  const { value: list } = await read('users-list.json', 'users-list.json');
  if (!Array.isArray(list)) throw new TypeError('R2 users-list.json must be an array');
  const ids = [...new Set(list.map(row => row?.iidx_id).filter(validId))].sort()
    .filter(id => !options.only || options.only.has(id)).slice(0, options.limit);
  const { value: songs } = await read('songs.json', 'songs.json');
  if (!Array.isArray(songs)) throw new TypeError('R2 songs.json must be an array');
  let engine = deps.engine, R = deps.R;
  if (!deps.calculate) {
    engine ||= await import('./persona-lib.mjs');
    R ||= await engine.loadPersonaResources({ official: true });
  }
  const calculate = deps.calculate || (async ({ id, data, histRows, arrange }) => {
    const inputs = engine.historyInputs(id, histRows, songs, arrange, R);
    const result = (deps.calculateOfficialScores || (await import('./official-score.mjs')).calculateOfficialScores)({
      id, inputs, R, previousUser: { ...data.user, sp_cpi: null, sp_star: null }, previousOsPattern: data.osPattern,
    });
    return result.userFields;
  });
  const arrangeFor = deps.arrangeFor || (await import('./dp-arrange.mjs')).fetchDpArrange;
  const merge = deps.mergeScoreHistory || (await import('./score-history.mjs')).mergeScoreHistory;
  const results = new Array(ids.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(options.concurrency, ids.length) }, async () => {
    while (next < ids.length) {
      const index = next++, id = ids[index];
      const result = { id, dj_name: null, old: null, new: null, status: 'error' };
      try {
        const { source, value: data } = await read(`user/${id}.json`, `user/${id}.json`);
        if (!data || typeof data !== 'object' || !data.user || typeof data.user !== 'object' || String(data.user.iidx_id) !== id) throw new Error(`R2 user identity mismatch: ${id}`);
        result.dj_name = data.user.dj_name ?? null;
        result.old = { sp_cpi: data.user.sp_cpi ?? null, sp_star: data.user.sp_star ?? null };
        const { value: histRows } = await read(`hist/${id}.json`, `hist/${id}.json`);
        if (!Array.isArray(histRows)) throw new TypeError(`R2 hist must be an array: ${id}`);
        merge(histRows, []);
        const arrange = await arrangeFor(id);
        const fields = await calculate({ id, data, histRows, songs, arrange, R });
        result.new = { sp_cpi: fields.sp_cpi ?? null, sp_star: fields.sp_star ?? null };
        if (result.new.sp_star === null) result.status = result.old.sp_star === null ? 'no_sp' : 'new_null';
        else if (result.new.sp_cpi === result.old.sp_cpi && result.new.sp_star === result.old.sp_star) result.status = 'unchanged';
        else result.status = 'changed';
        result.userSource = source;
        if (options.write && (result.status === 'changed' || (result.status === 'new_null' && options.nullPolicy === 'clear'))) {
          data.user.sp_cpi = result.new.sp_cpi;
          data.user.sp_star = result.new.sp_star;
          try {
            await client.put(`user/${id}.json`, JSON.stringify(data), source.etag);
            result.write = 'updated';
            const slice = await client.read(`uslice/${id}.json`);
            if (!slice) result.usliceWrite = 'skipped';
            else {
              const summary = JSON.parse(slice.body);
              if (!summary.u || typeof summary.u !== 'object') throw new Error(`Invalid uslice summary: ${id}`);
              summary.u.sp_star = result.new.sp_star;
              try { await client.put(`uslice/${id}.json`, JSON.stringify(summary), slice.etag); result.usliceWrite = 'updated'; }
              catch (error) { if (/HTTP 412\b/.test(String(error?.message || error))) result.usliceWrite = 'conflicted'; else throw error; }
            }
          } catch (error) {
            if (/HTTP 412\b/.test(String(error?.message || error))) result.write = 'conflicted';
            else throw error;
          }
        } else if (options.write) result.write = 'skipped';
      } catch (error) { result.error = String(error?.message || error); }
      delete result.userSource;
      results[index] = result;
    }
  }));
  const targets = results.filter(row => (row.status === 'changed' || (row.status === 'new_null' && options.nullPolicy === 'clear')) && row.write !== 'conflicted');
  const deltas = results.filter(row => row.status === 'changed' && typeof row.old?.sp_star === 'number' && typeof row.new?.sp_star === 'number').map(row => row.new.sp_star - row.old.sp_star).sort((a, b) => a - b);
  const median = deltas.length ? (deltas.length % 2 ? deltas[(deltas.length - 1) / 2] : (deltas[deltas.length / 2 - 1] + deltas[deltas.length / 2]) / 2) : null;
  const summary = Object.fromEntries(['unchanged', 'changed', 'new_null', 'no_sp', 'error'].map(status => [status, results.filter(row => row.status === status).length]));
  summary.conflicted = results.filter(row => row.write === 'conflicted' || row.usliceWrite === 'conflicted').length;
  summary.written = results.filter(row => row.write === 'updated').length;
  const report = { generatedAt: new Date().toISOString(), mode: options.write ? 'write' : 'dry', nullPolicy: options.nullPolicy, summary,
    deltaStats: { n: deltas.length, median, p10: percentile(deltas, 0.1), p90: percentile(deltas, 0.9), maxAbs: deltas.length ? Math.max(...deltas.map(Math.abs)) : null }, users: results };
  await fs.mkdir(options.out, { recursive: true });
  await fs.writeFile(path.join(options.out, 'backfill-sp-star-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(options.out, 'backfill-sp-star.sql'), makeSql(targets), 'utf8');
  console.log(`SP star backfill ${options.write ? 'write' : 'dry'}: ${JSON.stringify(summary)}`);
  if (summary.error) process.exitCode = 1;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}

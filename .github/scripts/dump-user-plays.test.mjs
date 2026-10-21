import assert from 'node:assert/strict';
import test from 'node:test';

const plays = [
  { columns: ['오래됨', '한글', '"quoted"', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '17', '18'] },
  { columns: ['new', '새판', '따옴표 "유지"', '22', '23', '24', '25', '26', '27', '28', '29', '30', '31', '32', '33', '34', '35', '36'] },
];
const baseUser = {
  iidx_id: 'tester', dj_name: '한글 이름', star: 1, r_star: 2, ereter_star: 3,
  sp_rank: 4, dp_rank: 5, date: '2026-10-14', native_star: 6, sp_cpi: 7, sp_star: 8,
  sp_r_star: 12, sp_r_star_model_id: 'model-sp', sp_r_star_formula_version: 'sp-v1',
};

process.env.SUPABASE_URL = 'https://supabase.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
process.env.CLOUDFLARE_R2_TOKEN = 'test-r2-token';

const { dumpUser, fetchUserHist, histProbe, updateHistFile, HIST_COLS } = await import('./dump-user.mjs');

async function run(user) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({ target, options });
    if (target.includes('/rest/v1/users?')) return response([user]);
    if (target.includes('/rest/v1/user_radars?')) return response([]);
    if (target.includes('/rest/v1/user_ohsorry_radars?')) return response([]);
    if (target.includes('/rest/v1/rpc/make_grid_data')) return response([]);
    if (target.includes('/rest/v1/rpc/make_update_history')) return response([]);
    if (target.includes('/rest/v1/chart_arrange?')) return response([], { 'content-range': '*/0' });
    if (target.includes('/r2/buckets/ohsorry-data/objects/user/tester.json')) {
      return textResponse(JSON.stringify({ user: { ...baseUser, plays } }));
    }
    throw new Error(`Unexpected network request: ${target}`);
  };
  try {
    const result = await dumpUser('tester', { textageMeta: {} }, { deferPersona: true });
    return { result, calls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function response(value, headers = {}) {
  return { ok: true, json: async () => value, headers: { get: (name) => headers[name.toLowerCase()] ?? headers[name] ?? null } };
}

function textResponse(value, headers = {}) {
  return { ok: true, status: 200, text: async () => value, headers: { get: (name) => headers[name.toLowerCase()] ?? headers[name] ?? null } };
}

test('dumpUser selects and passes plays unchanged in user object', async () => {
  const { result, calls } = await run({ ...baseUser, plays });
  assert.deepEqual(result.user, { ...baseUser, plays });
  assert.deepEqual(result.user.plays, plays);
  assert.equal(result.user.plays[0].columns.length, 18);
  assert.equal(result.user.plays[1].columns.length, 18);
  assert.equal(result.user.plays[0].columns[0], '오래됨');
  assert.equal(result.user.plays[0].columns[1], '한글');
  assert.equal(result.user.plays[0].columns[2], '"quoted"');
  assert.equal(result.user.plays[1].columns[0], 'new');
  assert.equal(result.user.plays[1].columns[1], '새판');
  assert.equal(result.user.plays[1].columns[2], '따옴표 "유지"');
  const usersRequest = calls.find(({ target }) => target.includes('/rest/v1/users?'));
  assert.ok(usersRequest, 'users REST request was made');
  assert.match(usersRequest.target, /select=[^&]*sp_star,sp_r_star,sp_r_star_model_id,sp_r_star_formula_version,plays(?:&|$)/);
  assert.equal(calls.some(({ options }) => options.method === 'PUT'), false);
});

test('dumpUser preserves null plays', async () => {
  const { result } = await run({ ...baseUser, plays: null });
  assert.deepEqual(result.user, { ...baseUser, plays: null });
});

test('dumpUser preserves absent plays as absent', async () => {
  const { result } = await run({ ...baseUser });
  assert.deepEqual(result.user, baseUser);
  assert.equal(Object.hasOwn(result.user, 'plays'), false);
});

test('hist fetch and both probes exclude DBR with the same filter', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url); calls.push({ target, options });
    if (options.headers?.Prefer) return response([], { 'content-range': '0-0/0' });
    return response([]);
  };
  try {
    await fetchUserHist('tester');
    await histProbe('tester');
  } finally { globalThis.fetch = originalFetch; }
  const scores = calls.map(({ target }) => target).filter((target) => target.includes('/rest/v1/scores?'));
  assert.equal(scores.length, 3);
  for (const target of scores) assert.match(target, /played_version=neq\.\-10/);
});

function histRow(version) {
  const row = Array(HIST_COLS.length).fill(null);
  row[0] = 1; row[1] = 0; row[HIST_COLS.indexOf('played_version')] = version;
  row[HIST_COLS.indexOf('date')] = '2026-10-14T00:00:00Z';
  return row;
}

async function runHistUpdate(previous, incoming) {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-retire-'));
  const file = path.join(dir, 'hist.json');
  fs.writeFileSync(file, JSON.stringify(previous));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (options.headers?.Prefer) return response([], { 'content-range': '0-0/0' });
    if (target.includes('select=date')) return response([]);
    if (target.includes('select=' + HIST_COLS.join(','))) return response(incoming.map((r) => Object.fromEntries(HIST_COLS.map((c, i) => [c, r[i]]))));
    throw new Error(`Unexpected network request: ${target}`);
  };
  try { return { result: await updateHistFile('tester', file), file, fs }; }
  catch (error) { return { error, file, fs }; }
  finally { globalThis.fetch = originalFetch; }
}

test('mixed old hist is rebuilt without DBR rows', async () => {
  const previous = [histRow(1), histRow(-10)];
  const incoming = [histRow(1)];
  const { result, file, fs } = await runHistUpdate(previous, incoming);
  assert.equal(result.rebuilt, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), incoming);
});

test('DBR-only previous hist may transition to an empty array', async () => {
  const { result, file, fs } = await runHistUpdate([histRow(-10)], []);
  assert.equal(result.rows, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), []);
});

test('previous non-DBR hist still rejects a drop to zero rows', async () => {
  const { error } = await runHistUpdate([histRow(1)], []);
  assert.match(error.message, /hist 급감/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeOfficialUser } from './write-official-user.mjs';

const id = '12345678';
const current = { iidx_id: id, dj_name: 'KEEP', star: 10, native_star: 9, r_star: 8, ereter_star: 7, sp_rank: 6, dp_rank: 5,
  plays: [34], sp_cpi: 100, sp_star: 4, sp_r_star: 3, sp_r_star_model_id: 'm1', sp_r_star_formula_version: 'f1' };
const feature = (style, notes, hands) => Object.fromEntries(['notes', 'chord', 'peak', 'charge', 'scratch', 'soflan', 'phrase', 'jack', 'trill', 'rand',
  'stair_up_l', 'stair_up_r', 'stair_dn_l', 'stair_dn_r', 'k1_l', 'k1_r', 'k2_l', 'k2_r', 'k3_l', 'k3_r', 'k4_l', 'k4_r', 'k5_l', 'k5_r', 'k6_l', 'k6_r',
  'k7_l', 'k7_r', 'double_stair_l', 'double_stair_r', 'keima_l', 'keima_r', 'hstair_onehand', 'hstair_sync', 'hstair_sameshape', 'hstair_diffshape', 'hands']
  .map((f) => [`os_${f}`, f === 'notes' ? notes : f === 'hands' ? hands : null]).concat([['iidx_id', id], ['play_style', style]]));
const emptyRadar = (style, notes, hands) => Object.fromEntries(['notes', 'chord', 'peak', 'charge', 'scratch', 'soflan', 'phrase', 'jack', 'trill', 'rand',
  'stair_up_l', 'stair_up_r', 'stair_dn_l', 'stair_dn_r', 'k1_l', 'k1_r', 'k2_l', 'k2_r', 'k3_l', 'k3_r', 'k4_l', 'k4_r', 'k5_l', 'k5_r', 'k6_l', 'k6_r',
  'k7_l', 'k7_r', 'double_stair_l', 'double_stair_r', 'keima_l', 'keima_r', 'hstair_onehand', 'hstair_sync', 'hstair_sameshape', 'hstair_diffshape', 'hands']
  .map((f) => [f, f === 'notes' ? notes : f === 'hands' ? hands : null]).concat([['iidx_id', id], ['play_style', style]]));
const dump = { _v: 1, user: { ...current, star: 11, native_star: 10, r_star: 9, sp_cpi: 200, sp_star: 5,
  sp_r_star: null, sp_r_star_model_id: 'm2', sp_r_star_formula_version: 'f2' }, osPattern: [feature(1, 21, 16), feature(0, 11, null)] };
const initialRadars = [emptyRadar(1, 20, 15), emptyRadar(0, 10, null)];
const response = (value) => Response.json(value);
const success = () => new Response(null, { status: 204 });
const fail = () => Response.json({ code: 'P0001', details: null, hint: null, message: 'fixture failure' }, { status: 400 });

function fixture({ users = [current], radars = initialRadars, failUsers = false, failUserPost = false, failDp = false, failSp = false, radarError = false } = {}) {
  const calls = [], db = { user: structuredClone(users?.[0] ?? current), radars: structuredClone(radars) };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url); calls.push({ url: u, init });
    if (u.pathname.endsWith('/users')) return failUsers ? fail() : response(users?.length === 1 ? [db.user] : users);
    if (u.pathname.endsWith('/user_ohsorry_radars')) return radarError ? fail() : response(db.radars);
    if (u.pathname.endsWith('/rpc/upsert_user')) {
      if (failUserPost) return fail();
      const p = JSON.parse(init.body);
      for (const [arg, key] of [['p_star', 'star'], ['p_native_star', 'native_star'], ['p_r_star', 'r_star'], ['p_sp_cpi', 'sp_cpi'], ['p_sp_star', 'sp_star']]) if (p[arg] !== null) db.user[key] = p[arg];
      const nullTuple = p.p_sp_r_star === null && p.p_sp_r_star_model_id === null && p.p_sp_r_star_formula_version === null;
      if (!nullTuple) {
        const same = db.user.sp_r_star_model_id === p.p_sp_r_star_model_id && db.user.sp_r_star_formula_version === p.p_sp_r_star_formula_version;
        db.user.sp_r_star = same && db.user.sp_r_star !== null && p.p_sp_r_star !== null ? Math.max(Number(db.user.sp_r_star), Number(p.p_sp_r_star)) : p.p_sp_r_star;
        db.user.sp_r_star_model_id = p.p_sp_r_star_model_id; db.user.sp_r_star_formula_version = p.p_sp_r_star_formula_version;
      }
      return success();
    }
    if (u.pathname.endsWith('/rpc/upsert_user_feature_score')) {
      const p = JSON.parse(init.body), style = p.p_play_style;
      if ((style === 1 && failDp) || (style === 0 && failSp)) return fail();
      const row = db.radars.find((x) => x.play_style === style) ?? { iidx_id: id, play_style: style };
      for (const [arg, value] of Object.entries(p)) if (arg.startsWith('p_os_') && value !== null) row[arg.slice(5)] = value;
      if (!db.radars.includes(row)) db.radars.push(row);
      return success();
    }
    throw new Error(`unexpected URL ${url}`);
  };
  return { calls, db, fetchImpl };
}

const opts = (f) => ({ fetchImpl: f.fetchImpl, supabaseUrl: 'https://supabase.invalid', serviceRoleKey: 'test-key', preparing: true });

test('disabled mode skips without validation, environment, or fetch', async () => {
  let calls = 0;
  assert.deepEqual(await writeOfficialUser('bad', null, { preparing: false, fetchImpl: () => calls++ }), { skipped: true });
  assert.equal(calls, 0);
});

test('sends exact users and 39 feature arguments, preserving protected values and empty 204 responses', async () => {
  const f = fixture();
  const input = structuredClone(dump);
  input.user.ereter_star = 99;
  const result = await writeOfficialUser(id, input, opts(f));
  const posts = f.calls.filter((x) => x.init.method === 'POST');
  const user = JSON.parse(posts.find((x) => x.url.pathname.endsWith('/upsert_user')).init.body);
  assert.deepEqual(Object.keys(user), ['p_iidx_id', 'p_dj_name', 'p_star', 'p_ereter_star', 'p_sp_rank', 'p_dp_rank', 'p_native_star', 'p_sp_cpi', 'p_sp_star', 'p_r_star', 'p_plays', 'p_sp_r_star', 'p_sp_r_star_model_id', 'p_sp_r_star_formula_version']);
  assert.equal(user.p_dj_name, 'KEEP'); assert.equal(user.p_ereter_star, 7); assert.equal(user.p_sp_rank, 6); assert.deepEqual(user.p_plays, [34]);
  assert.equal(user.p_dp_rank, 5);
  const dp = JSON.parse(posts.find((x) => x.url.pathname.endsWith('/upsert_user_feature_score') && JSON.parse(x.init.body).p_play_style === 1).init.body);
  const sp = JSON.parse(posts.find((x) => x.url.pathname.endsWith('/upsert_user_feature_score') && JSON.parse(x.init.body).p_play_style === 0).init.body);
  assert.equal(Object.keys(dp).length, 39); assert.equal(Object.keys(sp).length, 39); assert.equal(dp.p_os_hands, 16); assert.equal(sp.p_os_hands, null);
  assert.deepEqual(result.stylesWritten, [1, 0]);
  for (const call of f.calls) if (call.init.method === 'POST') assert.equal(call.init.headers.Authorization, 'Bearer test-key');
  assert.equal(f.calls.some((x) => x.url.pathname.includes('/scores') || x.url.pathname.includes('make_grid_data')), false);
});

test('effective RPC state prevents repeat writes after the first successful application', async () => {
  for (const nullable of ['native_star', 'sp_cpi']) {
    const f = fixture();
    const input = structuredClone(dump);
    Object.assign(input.user, { star: current.star, native_star: current.native_star, r_star: current.r_star,
      sp_cpi: current.sp_cpi, sp_star: current.sp_star, sp_r_star: current.sp_r_star,
      sp_r_star_model_id: current.sp_r_star_model_id, sp_r_star_formula_version: current.sp_r_star_formula_version });
    input.user[nullable] = null;
    input.osPattern = [];
    const result = await writeOfficialUser(id, input, opts(f));
    assert.equal(f.calls.filter((x) => x.init.method === 'POST' && x.url.pathname.endsWith('/rpc/upsert_user')).length, 0,
      `${nullable}: COALESCE 보존 시 users POST 생략`);
    assert.equal(result.usersWritten, false);
  }
  const f = fixture();
  const input = structuredClone(dump);
  Object.assign(input.user, { star: current.star, native_star: current.native_star, r_star: current.r_star,
    sp_cpi: current.sp_cpi, sp_star: current.sp_star, sp_r_star: null,
    sp_r_star_model_id: null, sp_r_star_formula_version: null });
  input.osPattern = [];
  const result = await writeOfficialUser(id, input, opts(f));
  assert.equal(f.calls.filter((x) => x.init.method === 'POST' && x.url.pathname.endsWith('/rpc/upsert_user')).length, 0,
    'all-null SP tuple preserves the stored tuple and skips users POST');
  assert.equal(result.usersWritten, false);
});

test('null, zero, COALESCE, same-model ratchet and model tuple transitions are compared correctly', async () => {
  const cases = [
    { label: 'zero is distinct from null', old: 0, incoming: null, model: 'm2', formula: 'f2', changed: true },
    { label: 'same tuple ratchets upward', old: 5, incoming: 4, model: 'm1', formula: 'f1', changed: false },
    { label: 'same tuple higher value', old: 3, incoming: 4, model: 'm1', formula: 'f1', changed: true },
    { label: 'few plays stores null tuple identity', old: 8, incoming: null, model: 'm2', formula: 'f2', changed: true },
    { label: 'ordinary null preserves old value', old: 8, incoming: 9, model: 'm2', formula: 'f2', changed: true },
  ];
  for (const c of cases) {
    const old = { ...current, star: 11, native_star: 10, r_star: 9, sp_cpi: 200, sp_star: 5, sp_r_star: c.old,
      sp_r_star_model_id: c.label === 'few plays stores null tuple identity' ? 'm1' : c.model,
      sp_r_star_formula_version: c.label === 'few plays stores null tuple identity' ? 'f1' : c.formula };
    const d = structuredClone(dump); d.osPattern = [];
    d.user.sp_r_star = c.incoming; d.user.sp_r_star_model_id = c.model; d.user.sp_r_star_formula_version = c.formula;
    const f = fixture({ users: [old], radars: [] });
    const result = await writeOfficialUser(id, d, opts(f));
    assert.equal(f.calls.filter((x) => x.url.pathname.endsWith('/rpc/upsert_user')).length, c.changed ? 1 : 0, c.label);
  }
});

test('writes are independent and AggregateError retains both RPC failures; CLI exits nonzero', async () => {
  const f = fixture({ failDp: true, failUserPost: true });
  await assert.rejects(writeOfficialUser(id, dump, opts(f)), (error) => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 2);
    assert.match(error.errors[0].message, /upsert_user/); assert.match(error.errors[1].message, /style 1/); return true;
  });
  assert.equal(f.calls.filter((x) => x.init.method === 'POST' && x.url.pathname.endsWith('/rpc/upsert_user')).length, 1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-official-'));
  const dumpPath = path.join(dir, 'dump.json'); fs.writeFileSync(dumpPath, JSON.stringify(dump));
  const child = spawnSync(process.execPath, [new URL('./write-official-user.mjs', import.meta.url).pathname, id, dumpPath], {
    encoding: 'utf8', env: { ...process.env, SCORE_BUFFER_PREPARE: '1', SUPABASE_URL: 'https://supabase.invalid', SUPABASE_SERVICE_ROLE_KEY: 'test-key' },
  });
  assert.notEqual(child.status, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('invalid users and radar reads retain failures and never synthesize users', async () => {
  for (const users of [[], null, [{ ...current, star: 'NaN' }]]) {
    const f = fixture({ users, radars: [] });
    await assert.rejects(writeOfficialUser(id, dump, opts(f)), AggregateError);
    assert.equal(f.calls.some((x) => x.url.pathname.endsWith('/rpc/upsert_user')), false, JSON.stringify(users));
  }
  const f = fixture({ radarError: true });
  await assert.rejects(writeOfficialUser(id, dump, opts(f)), (error) => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 1); assert.match(error.errors[0].message, /user_ohsorry_radars GET/); return true;
  });
  assert.equal(f.calls.some((x) => x.url.pathname.endsWith('/rpc/upsert_user')), true);
});

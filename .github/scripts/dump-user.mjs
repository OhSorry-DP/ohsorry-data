// dump-user.mjs — repository_dispatch(dump-user) 로 호출되는 단일 유저 덤프.
//   지정 iidx_id 유저를 supabase 에서 받아 user/{id}.json 으로 갱신(웹 fetchUserProfile 의 jsdelivr 소스).
//   ohSorryAdmin/scripts/dump-data-repo.js 의 단일유저판 — 스키마/RPC 동일하게 유지할 것.
import fs from 'node:fs';

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 없음'); process.exit(1); }
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };

async function rest(pathq) {
  const r = await fetch(SB + '/rest/v1/' + pathq, { headers: H });
  if (!r.ok) throw new Error(pathq + ' HTTP ' + r.status);
  return r.json();
}
// make_grid_data RPC — 웹 fetchGridData 와 동일(p_iidx_id, p_play_style, limit/offset 페이징).
async function rpcGrid(id, ps) {
  const out = []; let off = 0;
  while (true) {
    const r = await fetch(SB + `/rest/v1/rpc/make_grid_data?limit=1000&offset=${off}`, {
      method: 'POST', headers: H, body: JSON.stringify({ p_iidx_id: id, p_play_style: ps }),
    });
    if (!r.ok) throw new Error(`grid ${id} ps${ps} HTTP ${r.status}`);
    const rows = await r.json(); if (!Array.isArray(rows)) break;
    out.push(...rows); if (rows.length < 1000) break; off += 1000;
  }
  return out;
}
async function dumpUser(id) {
  const eid = encodeURIComponent(id);
  const [user, radars, osPattern, dp, sp] = await Promise.all([
    // dbr_pw 는 비밀(공개 repo·anon 노출 금지) → 명시 컬럼만 select(select=* 금지).
    rest(`users?iidx_id=eq.${eid}&select=iidx_id,dj_name,star,ereter_star,sp_rank,dp_rank,date,native_star,sp_cpi,sp_star`),
    rest(`user_radars?iidx_id=eq.${eid}&select=*`),
    rest(`user_ohsorry_radars?iidx_id=eq.${eid}&play_style=eq.1&select=*`),
    rpcGrid(id, 1),
    rpcGrid(id, 0).catch(() => []),
  ]);
  return { _v: new Date().toISOString(), user: user[0] || null, radars, osPattern, dp, sp };
}

const ids = process.argv.slice(2).filter(Boolean);
if (!ids.length) { console.error('iidx_id 인자 없음'); process.exit(1); }
fs.mkdirSync('user', { recursive: true });
for (const id of ids) {
  if (!/^[A-Za-z0-9]+$/.test(id)) { console.error('잘못된 iidx_id 형식:', id); process.exit(1); }
  const data = await dumpUser(id);
  if (!data.user) { console.error('유저 없음(삭제됨?):', id); continue; }
  fs.writeFileSync(`user/${id}.json`, JSON.stringify(data));
  console.log('덤프:', id, '| dp', data.dp.length, 'sp', data.sp.length);
}

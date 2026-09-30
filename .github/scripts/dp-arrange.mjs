// DP 배치는 DB가 정본이다. 단일 덤프와 전수 재계산이 같은 페이징 검증을 사용한다.
export async function fetchDpArrange(id, {
  supabaseUrl = process.env.SUPABASE_URL,
  serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 없음');
  }
  const allUsers = id === undefined;
  const label = allUsers ? '전체 DP' : String(id);
  const query = allUsers ? '' : `iidx_id=eq.${encodeURIComponent(id)}&`;
  const columns = `${allUsers ? 'iidx_id,' : ''}song_id,diff,play_style,arrange`;
  const order = `${allUsers ? 'iidx_id.asc,' : ''}song_id.asc,diff.asc`;
  const out = [];
  let total = null;
  while (true) {
    const off = out.length;
    const r = await fetchImpl(supabaseUrl + `/rest/v1/chart_arrange?${query}`
      + `play_style=eq.1&select=${columns}&order=${order}&limit=1000&offset=${off}`, {
      headers: { apikey: serviceRoleKey, Authorization: 'Bearer ' + serviceRoleKey,
        'Content-Type': 'application/json', Prefer: 'count=exact' },
    });
    if (!r.ok) throw new Error(`chart_arrange ${label} HTTP ${r.status}`);
    const rows = await r.json();
    const range = /^(?:(\d+)-(\d+)|\*)\/(\d+)$/.exec(r.headers.get('content-range') || '');
    if (!Array.isArray(rows) || !range || !Number.isSafeInteger(Number(range[3]))) {
      throw new Error(`chart_arrange ${label}: 응답 배열/정확한 전체 행수 없음`);
    }
    const count = Number(range[3]);
    if (total !== null && total !== count) throw new Error(`chart_arrange ${label}: 전체 행수 변경`);
    total = count;
    if (total === 0 && off === 0 && rows.length === 0 && range[1] === undefined) return out;
    if (!rows.length || Number(range[1]) !== off || Number(range[2]) !== off + rows.length - 1
      || off + rows.length > total || rows.length > 1000) {
      throw new Error(`chart_arrange ${label}: 페이지 범위/행수 불일치`);
    }
    out.push(...rows);
    if (out.length === total) return out;
  }
}

// 실행당 한 번 전량을 조회한다. 실패는 전파하고, 검증된 0행만 빈 Map으로 반환한다.
export async function fetchDpArrangeByUser(options) {
  const rows = await fetchDpArrange(undefined, options);
  const byUser = new Map();
  for (const row of rows) {
    if (row?.iidx_id == null || String(row.iidx_id) === '' || row.play_style !== 1) {
      throw new Error('chart_arrange 전체 DP: iidx_id/play_style 불일치');
    }
    const id = String(row.iidx_id);
    if (!byUser.has(id)) byUser.set(id, []);
    byUser.get(id).push(row);
  }
  return byUser;
}

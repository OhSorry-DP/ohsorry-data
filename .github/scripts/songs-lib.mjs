// songs.json 생성의 단일 구현. 선택 컬럼·정렬·직렬화 형식을 유지한다.
export async function fetchAllSongs({
  supabaseUrl = process.env.SUPABASE_URL,
  serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!supabaseUrl || !serviceRoleKey) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 없음');
  const headers = { apikey: serviceRoleKey, Authorization: 'Bearer ' + serviceRoleKey };
  const songs = [];
  for (let off = 0; ; off += 1000) {
    const r = await fetchImpl(supabaseUrl + `/rest/v1/songs?select=song_id,title,ac,legen,textage_song_id,series_no&order=song_id.asc&limit=1000&offset=${off}`, { headers });
    if (!r.ok) throw new Error(`songs HTTP ${r.status}`);
    const rows = await r.json();
    // 잘못된 페이지를 끝으로 간주하면 부분 목록을 정상 결과로 올릴 수 있다.
    if (!Array.isArray(rows)) throw new Error('songs 응답이 배열이 아님');
    if (!rows.length) break;
    songs.push(...rows);
    if (rows.length < 1000) break;
  }
  return songs;
}

export const serializeSongs = (songs) => JSON.stringify(songs);

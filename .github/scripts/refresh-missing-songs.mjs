import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { getText, putText } from './r2-client.mjs';
import { fetchAllSongs, serializeSongs } from './songs-lib.mjs';

const validId = (id) => (typeof id === 'number' && Number.isFinite(id)) || (typeof id === 'string' && id.length > 0);

function songIds(songs) {
  if (!Array.isArray(songs) || songs.some((row) => !row || !validId(row.song_id))) {
    throw new Error('songs 목록 또는 song_id 형식이 잘못됨');
  }
  return new Set(songs.map((row) => String(row.song_id)));
}

// 읽기·생성·업로드 실패는 경고로 끝내고 본 덤프의 후속 작업을 계속한다.
export async function refreshMissingSongs(id, {
  readFile = fs.readFile,
  get = getText,
  rebuild = fetchAllSongs,
  put = putText,
  log = console.log,
  warn = console.warn,
} = {}) {
  try {
    if (!/^[A-Za-z0-9]+$/.test(id || '')) throw new Error('잘못된 iidx_id');
    const dump = JSON.parse(await readFile(`user/${id}.json`, 'utf8'));
    const hist = JSON.parse(await readFile(`hist/${id}.json`, 'utf8'));
    if (!Array.isArray(dump.dp) || !Array.isArray(dump.sp) || !Array.isArray(hist)) {
      throw new Error('유저 덤프의 점수 배열이 잘못됨');
    }
    // hist는 HIST_COLS의 첫 컬럼인 song_id를 사용한다(DBR·과거 점수 포함).
    const ids = [...dump.dp, ...dump.sp].map((row) => row.song_id).concat(hist.map((row) => row[0]));
    if (ids.some((songId) => !validId(songId))) throw new Error('점수의 song_id 형식이 잘못됨');
    const referenced = new Set(ids.map(String));
    const text = await get('songs.json');
    if (text === null) throw new Error('R2 songs.json 없음: 기존 곡 수를 확인할 수 없음');
    const current = JSON.parse(text);
    const known = songIds(current);
    const missing = [...referenced].filter((songId) => !known.has(songId));
    if (!missing.length) {
      log('songs.json 비교 완료: 누락 없음');
      return { status: 'unchanged' };
    }
    log('songs.json 누락 song_id: ' + missing.join(', '));
    const songs = await rebuild();
    const rebuiltIds = songIds(songs);
    if (!songs.length) throw new Error('songs 재생성 결과가 비었음');
    if (songs.length < current.length) throw new Error(`songs 곡 수 감소: ${current.length} → ${songs.length}`);
    const remaining = missing.filter((songId) => !rebuiltIds.has(songId));
    if (remaining.length) warn('::warning::재생성 후에도 없는 song_id: ' + remaining.join(', '));
    // 재생성으로 새로 찾은 곡이 하나도 없으면 올리지 않는다 — 지워진 곡을 가리키는 옛 기록이 있으면
    //   그 유저 업로드마다 같은 목록을 다시 올리게 된다.
    if (remaining.length === missing.length) {
      log('songs.json 재생성 결과에 새 곡 없음 — 업로드 생략');
      return { status: 'unchanged', remaining };
    }
    const result = await put('songs.json', serializeSongs(songs));
    if (!result?.ok) throw new Error('R2 songs.json PUT 실패: ' + (result?.msg || '결과 없음'));
    log(`songs.json 갱신: ${songs.length}곡`);
    return { status: 'updated', remaining };
  } catch (error) {
    warn('::warning::songs.json 갱신 생략: ' + (error?.message || String(error)));
    return { status: 'failed' };
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await refreshMissingSongs(process.argv[2]);
}

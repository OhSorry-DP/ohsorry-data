// 곡 상세 공용 메타 계약 v1. 원본 순서는 변종 선택과 제목 폴백의 일부다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

export const SOURCE_KEYS = ['songs.json', 'data/textage-meta.json', 'data/ohSorryRating-slim.json', 'data/series-name.json', 'data/zasa-data.json'];
export const PREFIX = 'data/song-meta-';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
const songFields = ['song_id', 'title', 'ac', 'legen', 'textage_song_id', 'series_no'];
const ratingFields = ['title', 'diff', 'gameLevel', 'zasaLevel', 'estEc', 'estHc', 'estExh'];

// 목록 페이지·재시도를 포함한 실제 요청 시작 간격을 보장한다.
export function pacedFetch(fetchImpl, { sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = {}) {
  let tail = Promise.resolve();
  let last = null;
  return (...input) => {
    const request = tail.then(async () => {
      const delay = last === null ? 0 : Math.max(0, 250 - (now() - last));
      if (delay) await sleep(delay);
      last = now();
      return fetchImpl(...input);
    });
    tail = request.catch(() => {});
    return request;
  };
}

// norm 은 호출부가 R2 `lib/normTitle.js`(마스터 게시본 OhsorryNorm.norm)에서 넣는다 — 손사본을 두면 동기화 구멍이 생긴다(INF 앱 곡 중복 전례).
export function buildSongMeta([songs, textage, rating, seriesNames, zasa], { norm: normTitle } = {}) {
  if (typeof normTitle !== 'function') throw new Error('norm 함수 필요 — lib/normTitle.js 를 넣어라');
  if (!Array.isArray(songs) || !songs.length || !object(textage?.songs) || !Object.keys(textage.songs).length ||
      !Array.isArray(rating?.ratings) || !object(seriesNames) || !Array.isArray(zasa?.charts)) throw new Error('메타 원본 스키마 오류');
  const seen = new Set();
  for (const song of songs) {
    if (!Number.isSafeInteger(song?.song_id) || song.song_id < 0 || typeof song.title !== 'string' || !song.title || seen.has(song.song_id)) throw new Error('곡 마스터 id/title 오류');
    seen.add(song.song_id);
  }
  const groups = new Map();
  const normalized = new Map();
  const norm = title => {
    if (!normalized.has(title)) normalized.set(title, normTitle(title));
    return normalized.get(title);
  };
  for (const song of songs) {
    const key = norm(song.title);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(song);
  }
  const output = new Map();
  for (const [key, variants] of groups) {
    const titles = new Set(variants.map(song => song.title.toLowerCase()));
    // SP의 norm 모듈 미등록 시 lowercase 폴백도 같은 후보·순서를 보존한다.
    const matches = title => typeof title === 'string' && (norm(title) === key || titles.has(title.toLowerCase()));
    const txIds = new Set(variants.map(song => song.textage_song_id));
    const txSongs = Object.fromEntries(Object.entries(textage.songs).filter(([id, song]) => txIds.has(id) ||
      matches(song?.title) || matches(String(song?.title || '').replace(/<[^>]*>/g, '')))
      .map(([id, song]) => [id, pick(song, ['title', 'levels', 'notes', 'bpm'])]));
    const names = Object.fromEntries(variants.map(song => String(song.series_no)).filter(no => Object.hasOwn(seriesNames, no)).map(no => [no, seriesNames[no]]));
    const common = { songs: variants.map(song => pick(song, songFields)), textageMeta: { songs: txSongs },
      ratingData: { ratings: rating.ratings.filter(row => matches(row?.title)).map(row => pick(row, ratingFields)) },
      seriesNames: names, zasaData: { charts: zasa.charts.filter(row => matches(row?.title)).map(row => pick(row, ['title', 'diff', 'gameLevel', 'level'])) } };
    for (const song of variants) output.set(`${PREFIX}${song.song_id}.json`, JSON.stringify({ v: 1, songId: song.song_id, ...common }));
  }
  return output;
}

// 원본 전부와 목록을 성공적으로 읽고 생성한 뒤에만 쓰기 단계에 들어간다.
// R2 에 게시된 마스터 norm(UMD)을 받아 require 한다. 웹·코치가 쓰는 것과 같은 게시본이다.
export async function loadR2Norm(getText) {
  const text = await getText('lib/normTitle.js');
  if (typeof text !== 'string' || !text) throw new Error('lib/normTitle.js 없음');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'song-meta-norm-'));
  const file = path.join(dir, 'normTitle.js');
  fs.writeFileSync(file, text);
  const { norm } = createRequire(file)(file);
  if (typeof norm !== 'function') throw new Error('lib/normTitle.js 에 norm 없음');
  return norm;
}

// 원본이 순간적으로 줄어든 덤프(곡 마스터 일부 유실)로 묶음을 대량 삭제하지 않는다 — 기존 묶음 대비 이 비율을 넘는 삭제는 중단.
export const MAX_DELETE_RATIO = 0.05;
export const MAX_DELETE_FLOOR = 20;   // 곡 병합(dedup) 같은 정상 소량 삭제는 통과

export async function publishSongMeta({ client, apply = false, maxWrites = 500, intervalMs = 250,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), loadNorm = null } = {}) {
  if (!Number.isSafeInteger(maxWrites) || maxWrites < 1 || !Number.isFinite(intervalMs) || intervalMs < 250) throw new Error('상한/요청 간격 오류');
  let started = false;
  const call = async (fn, ...args) => { if (started) await sleep(intervalMs); started = true; return fn(...args); };
  const sources = [];
  for (const key of SOURCE_KEYS) {
    const text = await call(client.getText, key);
    if (text === null) throw new Error(`메타 원본 없음: ${key}`);
    sources.push(JSON.parse(text));
  }
  const norm = await (loadNorm ? loadNorm() : call(loadR2Norm, client.getText));
  const bundles = buildSongMeta(sources, { norm });
  const entries = await call(client.listEntries, PREFIX);
  const remote = new Map(entries.map(entry => [entry.key, String(entry.etag || '').replace(/^W\//i, '').replace(/"/g, '').toLowerCase()]));
  const deletes = entries.filter(entry => /^data\/song-meta-\d+\.json$/.test(entry.key) && !bundles.has(entry.key)).map(entry => ({ type: 'delete', key: entry.key }));
  const existing = entries.filter(entry => /^data\/song-meta-\d+\.json$/.test(entry.key)).length;
  if (deletes.length > Math.max(MAX_DELETE_FLOOR, existing * MAX_DELETE_RATIO)) throw new Error(`삭제 ${deletes.length}건이 기존 ${existing}건의 ${MAX_DELETE_RATIO * 100}% 초과 — 원본 이상 의심, 중단`);
  const puts = [...bundles].filter(([key, body]) => remote.get(key) !== client.md5(body)).map(([key, body]) => ({ type: 'put', key, body }));
  const pending = [...deletes, ...puts];
  const selected = pending.slice(0, maxWrites);
  let written = 0;
  if (apply) for (const change of selected) {
    const result = change.type === 'put' ? await call(client.putText, change.key, change.body) : await call(client.del, change.key);
    if (change.type === 'put' ? !result?.ok : result !== true) throw new Error(`R2 ${change.type} 실패: ${change.key}`);
    written++;
  }
  return { objects: bundles.size, puts: puts.length, deletes: deletes.length, selected: selected.length, written, remaining: pending.length - (apply ? written : 0) };
}

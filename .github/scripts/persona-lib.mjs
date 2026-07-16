// persona-lib.mjs — gist 모듈+데이터로 유저 성향 리포트(persona)를 산출하는 공용 라이브러리.
//   dump-user.mjs(웹훅 즉시 생성)와 백필 스크립트가 공유. 해석엔진 정본 = ohSorryRating/modules/persona.js (gist 호스팅).
//   프로파일 스냅샷 로직은 ohSorryRating/scripts/analyze/dp/dump-all-user-personas.js 와 동일 유지.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const GIST_RAW = 'https://gist.githubusercontent.com/OhSorry-DP/c3da608194c44f431abd2f1a7a4a9f5e/raw';

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ' HTTP ' + r.status);
  return r.text();
}
const fetchJson = async (url) => JSON.parse(await fetchText(url));

export const DIFF_INT_TO_STR = { 0: 'BEGINNER', 1: 'NORMAL', 2: 'HYPER', 3: 'ANOTHER', 4: 'LEGGENDARIA' };
const DIFF_TO_TEXTAGE = { BEGINNER: 'DB', NORMAL: 'DN', HYPER: 'DH', ANOTHER: 'DA', LEGGENDARIA: 'DX' };
const MIN_CHARTS = 30;   // 표본 부족 시 persona 생략 (cold-start)

// gist 에서 해석엔진 모듈(UMD/CommonJS)·데이터 일괄 로드. Actions 1회 실행당 1번만 호출.
export async function loadPersonaResources() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-'));
  const bust = '?t=' + Date.now();
  const mods = ['calcWeakness.js', 'persona.js', 'normTitle.js'];
  await Promise.all(mods.map(async (n) => {
    fs.writeFileSync(path.join(tmp, n), await fetchText(`${GIST_RAW}/${n}${bust}`));
  }));
  const req = createRequire(path.join(tmp, 'x.js'));
  const weaknessLib = req(path.join(tmp, 'calcWeakness.js'));
  const personaLib = req(path.join(tmp, 'persona.js'));
  const { norm } = req(path.join(tmp, 'normTitle.js'));
  const [textageMeta, ratingJson, zasaRaw, band1, band2, band3, featScoresJson, rateRef] = await Promise.all([
    fetchJson(`${GIST_RAW}/textage-meta.json${bust}`),
    fetchJson(`${GIST_RAW}/ohSorryRating.json${bust}`),
    fetchJson(`${GIST_RAW}/zasa-data.json${bust}`),
    // patterns 는 웹과 같은 3밴드 사용(patterns-all-slim 은 gist 미갱신 사본이라 사용 금지) — c(차트) 레벨 딥머지.
    fetchJson(`${GIST_RAW}/patterns-dp-0810.json${bust}`),
    fetchJson(`${GIST_RAW}/patterns-dp-1112.json${bust}`),
    fetchJson(`${GIST_RAW}/patterns-dp-rest.json${bust}`),
    fetchJson(`${GIST_RAW}/feature-scores-slim.json${bust}`),
    fetchJson(`${GIST_RAW}/rate-reference-slim.json${bust}`).catch(() => null),   // 없으면 self-relative
  ]);
  const patternsMap = {};
  for (const band of [band1, band2, band3]) {
    for (const sid in band) {
      const src = band[sid];
      if (!patternsMap[sid]) { patternsMap[sid] = { ...src, c: { ...(src.c || {}) } }; continue; }
      for (const cn in src.c || {}) if (src.c[cn] != null) patternsMap[sid].c[cn] = src.c[cn];
    }
  }
  return {
    weaknessLib, personaLib, norm, textageMeta,
    ratingData: ratingJson.ratings,
    zasaData: Array.isArray(zasaRaw.charts) ? zasaRaw.charts : zasaRaw,
    patternsMap, featScores: featScoresJson.scores, rateRef,
  };
}

// make_grid_data raw row(title/diff/ex_score/lamp/textage_song_id) → calcUserWeakness 입력 차트 배열.
export function chartsFromGridRows(rows, textageMeta) {
  const out = [];
  for (const r of rows) {
    if (!r.title || r.diff == null) continue;
    const diff = DIFF_INT_TO_STR[r.diff]; if (!diff) continue;
    let noteCount = null, gameLevel = null;
    if (r.textage_song_id) {
      const m = textageMeta.songs[r.textage_song_id];
      const tk = DIFF_TO_TEXTAGE[diff];
      if (m) {
        if (m.notes && m.notes[tk] > 0) noteCount = m.notes[tk];
        if (m.levels && m.levels[tk] > 0) gameLevel = m.levels[tk];
      }
    }
    if (!noteCount) continue;
    const lampNum = typeof r.lamp === 'number' ? r.lamp : 0;
    out.push({
      title: r.title, diff, exScore: typeof r.ex_score === 'number' ? r.ex_score : 0,
      noteCount, gameLevel, lamp: lampNum, lampNum,
    });
  }
  return out;
}

// 차트 배열 → persona 필드. 표본 부족/실패 시 null.
//   반환: { head, oneLiner, prose, report, tags, nCharts, _v }
export function personaFor(allCharts, R) {
  if (!Array.isArray(allCharts) || allCharts.length < MIN_CHARTS) return null;
  const vec = R.weaknessLib.calcUserWeakness({
    allCharts, patternsMap: R.patternsMap, normFn: R.norm,
    ratingMap: R.ratingData, zasaMap: R.zasaData, rateRef: R.rateRef,
  });
  // ── 프로파일 스냅샷 (dump-all-user-personas.js 와 동일) ──
  const feats = {}, mirror = {};
  for (const k of Object.keys(vec)) {
    if (k.startsWith('__')) continue;
    if (R.weaknessLib.FEATS.includes(k)) feats[k] = vec[k];
    else mirror[k] = vec[k];
  }
  const resids = (vec.__entries || []).map((e) => e && e.residual).filter((v) => typeof v === 'number');
  const overallResid = resids.length ? resids.reduce((a, b) => a + b, 0) / resids.length : null;
  // HSTAIR 배치 적성(36dim 미포함 내부값) — featScores 가중 잔차 + 본인 평균 중심화.
  const HSTAIR_DEFS = [
    { key: 'HSTAIR_ONEHAND', label: '한손계단' }, { key: 'HSTAIR_SYNC', label: '쌍계단' },
    { key: 'HSTAIR_SAMESHAPE', label: '대칭계단' }, { key: 'HSTAIR_DIFFSHAPE', label: '비대칭계단' },
  ];
  let layoutProfile = null;
  if (overallResid != null) {
    layoutProfile = [];
    for (const def of HSTAIR_DEFS) {
      let sumRW = 0, sumW = 0, n = 0;
      for (const e of vec.__entries || []) {
        if (!e || typeof e.residual !== 'number' || !e.chartId) continue;
        const [sid, cn] = e.chartId.split('|');
        const sc = R.featScores[sid] && R.featScores[sid][cn];
        const v = sc && typeof sc[def.key] === 'number' ? sc[def.key] : 0;
        if (v < 40) continue;   // 해당 축이 유의미한 곡만(quantile 40+)
        const w = v / 100;
        sumRW += e.residual * w; sumW += w; n++;
      }
      if (sumW <= 0 || n < 10) continue;
      layoutProfile.push({ key: def.key, label: def.label, mean: sumRW / sumW - overallResid, n });
    }
    if (!layoutProfile.length) layoutProfile = null;
  }
  const profile = {
    nCharts: allCharts.length, overallResid, feats, mirror,
    featsL: vec.__vecL || null, featsR: vec.__vecR || null,
    bpmProfile: vec.__bpmProfile || null, kensei: vec.__kensei || null,
    scratchProfile: vec.__scratchProfile || null, trillProfile: vec.__trillProfile || null,
    jackProfile: vec.__jackProfile || null, streamProfile: vec.__streamProfile || null,
    mixProfile: vec.__mixProfile || null, muriProfile: vec.__muriProfile || null,
    layoutProfile,
  };
  const rich = R.personaLib.richReportOf(profile);
  const P = rich.persona;
  return {
    head: rich.head, oneLiner: P.oneLiner, prose: P.prose, report: rich.report,
    tags: P.tags, nCharts: allCharts.length, _v: new Date().toISOString(),
  };
}

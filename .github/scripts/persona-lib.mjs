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

// ── SP 상수 (ohSorryRating scripts/analyze/sp/dump-sp-user-personas.js 와 동일 유지) ──
const SP_FEATS = ['NOTES', 'CHORD', 'PEAK', 'CHARGE', 'SCRATCH', 'SOF-LAN', 'PHRASE', 'JACK', 'TRILL', 'RAND'];
const SP_DIFF_TO_KEY = { NORMAL: 'SP_NOR', HYPER: 'SP_HYP', ANOTHER: 'SP_ANO', LEGGENDARIA: 'SP_LEG' };
const SP_TKEY = { NORMAL: 'SN', HYPER: 'SH', ANOTHER: 'SA', LEGGENDARIA: 'SX' };
const SEC_TIER = { s_lo: '저속', s8: '저속', s11: '저속', s14: '중속', s18: '중속', s22: '고속', s27: '고속', s33: '초고속', s40: '초고속' };
const TIERS = ['저속', '중속', '고속', '초고속'];

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
  const [textageMeta, ratingJson, zasaRaw, band1, band2, band3, featScoresJson, rateRef, spSlimRaw, spArrange] = await Promise.all([
    fetchJson(`${GIST_RAW}/textage-meta.json${bust}`),
    fetchJson(`${GIST_RAW}/ohSorryRating.json${bust}`),
    fetchJson(`${GIST_RAW}/zasa-data.json${bust}`),
    // patterns 는 웹과 같은 3밴드 사용(patterns-all-slim 은 gist 미갱신 사본이라 사용 금지) — c(차트) 레벨 딥머지.
    fetchJson(`${GIST_RAW}/patterns-dp-0810.json${bust}`),
    fetchJson(`${GIST_RAW}/patterns-dp-1112.json${bust}`),
    fetchJson(`${GIST_RAW}/patterns-dp-rest.json${bust}`),
    fetchJson(`${GIST_RAW}/feature-scores-slim.json${bust}`),
    fetchJson(`${GIST_RAW}/rate-reference-slim.json${bust}`).catch(() => null),   // 없으면 self-relative
    // SP persona 용 — 실패해도 DP 는 계속(spKeymaps null → spPersona 생략).
    fetchJson(`${GIST_RAW}/sp-feature-scores-slim.json${bust}`).catch(() => null),
    fetchJson(`${GIST_RAW}/sp-arrange.json${bust}`).catch(() => null),
  ]);
  const patternsMap = {};
  for (const band of [band1, band2, band3]) {
    for (const sid in band) {
      const src = band[sid];
      if (!patternsMap[sid]) { patternsMap[sid] = { ...src, c: { ...(src.c || {}) } }; continue; }
      for (const cn in src.c || {}) if (src.c[cn] != null) patternsMap[sid].c[cn] = src.c[cn];
    }
  }
  // SP 키맵 — scoresByKey(norm|diff → 피처/리듬) / noteByKey / bpmByNorm / offByKey(무리 정배 성분).
  let spKeymaps = null;
  if (spSlimRaw && textageMeta && textageMeta.songs) {
    const spSlim = spSlimRaw.scores || spSlimRaw;
    const meta = textageMeta.songs;
    const scoresByKey = new Map(), noteByKey = new Map(), bpmByNorm = new Map(), offByKey = new Map();
    for (const id in spSlim) {
      if (id === '_meta') continue;
      const m = meta[id]; if (!m || !m.title) continue;
      for (const diff in SP_DIFF_TO_KEY) {
        const sc = spSlim[id][SP_DIFF_TO_KEY[diff]];
        if (sc) scoresByKey.set(norm(m.title) + '|' + diff, sc);
      }
    }
    for (const id in meta) {
      const m = meta[id]; if (!m || !m.title) continue;
      const nk = norm(m.title);
      const bs = String(m.bpm == null ? '' : m.bpm).trim();
      if (!bpmByNorm.has(nk)) bpmByNorm.set(nk, /^\d+$/.test(bs) ? parseInt(bs, 10) : null);
      if (m.notes) for (const diff in SP_TKEY) { const nc = m.notes[SP_TKEY[diff]]; if (nc > 0) { const k = nk + '|' + diff; if (!noteByKey.has(k)) noteByKey.set(k, nc); } }
    }
    if (spArrange) {
      for (const id in spArrange) {
        if (id === '_meta') continue;
        const e = spArrange[id]; if (!e || !e.title || !e.charts) continue;
        for (const diff in SP_DIFF_TO_KEY) {
          const c = e.charts[SP_DIFF_TO_KEY[diff]];
          if (c && c.cat && c.cat.off) offByKey.set(norm(e.title) + '|' + diff, c.cat.off);
        }
      }
    }
    spKeymaps = { scoresByKey, noteByKey, bpmByNorm, offByKey };
  }
  return {
    weaknessLib, personaLib, norm, textageMeta,
    ratingData: ratingJson.ratings,
    zasaData: Array.isArray(zasaRaw.charts) ? zasaRaw.charts : zasaRaw,
    patternsMap, featScores: featScoresJson.scores, rateRef, spKeymaps,
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

// ── SP persona (dump-sp-user-personas.js 이식 — self-relative 잔차, mirror/손별/overallResid 없음) ──

// SP raw grid rows(play_style=0) → ownSp 차트 배열 (gameLevel 은 textage 레벨).
export function spChartsFromGridRows(rows, textageMeta) {
  const out = [];
  for (const r of rows) {
    const diff = DIFF_INT_TO_STR[r.diff];
    if (!diff || diff === 'BEGINNER' || !r.title) continue;
    const m = r.textage_song_id ? textageMeta.songs[r.textage_song_id] : null;
    const gl = m && m.levels ? (m.levels[SP_TKEY[diff]] || 0) : 0;
    out.push({ title: r.title, diff, exScore: r.ex_score || 0, lampNum: r.lamp || 0, gameLevel: gl });
  }
  return out;
}

function spResidRows(ownSp, R) {
  const { noteByKey, scoresByKey } = R.spKeymaps;
  const rows = [];
  for (const c of ownSp) {
    if (!c || !c.title || !c.diff) continue;
    if (typeof c.exScore !== 'number' || c.exScore <= 0) continue;
    const key = R.norm(c.title) + '|' + c.diff;
    const nc = noteByKey.get(key); if (typeof nc !== 'number' || nc <= 0) continue;
    const sc = scoresByKey.get(key); if (!sc || (!sc.SARA_RHYTHM && !sc.KEY_RHYTHM)) continue;
    const gl = (typeof c.gameLevel === 'number' && c.gameLevel > 0) ? c.gameLevel : 0;
    rows.push({ rate: c.exScore / (nc * 2) * 100, gl, key, sc });
  }
  if (!rows.length) return [];
  const glAgg = {};
  for (const r of rows) { if (!glAgg[r.gl]) glAgg[r.gl] = { sum: 0, n: 0 }; glAgg[r.gl].sum += r.rate; glAgg[r.gl].n++; }
  const glMean = {}; for (const g in glAgg) glMean[g] = glAgg[g].sum / glAgg[g].n;
  for (const r of rows) r.resid = r.rate - glMean[r.gl];
  return rows;
}
// 피처 적성(강도 가중 잔차) — 웹 spUserProfile(클리어 구성)과 다름, 리포트 목적의 적성 축.
function spFeatAptitude(residRows) {
  const acc = {}, wsum = {}; for (const f of SP_FEATS) { acc[f] = 0; wsum[f] = 0; }
  let n = 0;
  for (const r of residRows) {
    for (const f of SP_FEATS) {
      const w = (Number(r.sc[f]) || 0) / 100;
      if (w <= 0) continue;
      acc[f] += r.resid * w; wsum[f] += w;
    }
    n++;
  }
  if (n < MIN_CHARTS) return null;
  const prof = {}; for (const f of SP_FEATS) prof[f] = wsum[f] > 0 ? acc[f] / wsum[f] : 0; return prof;
}
function spKeyRhythmHist(sc, blocks) {
  const kr = sc && sc.KEY_RHYTHM; if (!kr) return null;
  let out = null, tot = 0;
  for (const b of blocks) {
    const blk = kr[b]; const h = b === 'tr' ? (blk && blk.ioiSec) : blk;
    if (!h) continue; if (!out) out = {};
    for (const k in h) { out[k] = (out[k] || 0) + h[k]; tot += h[k]; }
  }
  return (out && tot >= 20) ? out : null;
}
function tierSharesOfHist(h) {
  if (!h) return null;
  const ts = { 저속: 0, 중속: 0, 고속: 0, 초고속: 0 }; let tot = 0;
  for (const b in h) { const t = SEC_TIER[b]; if (!t) continue; ts[t] += h[b]; tot += h[b]; }
  if (tot <= 0) return null;
  return { 저속: ts.저속 / tot, 중속: ts.중속 / tot, 고속: ts.고속 / tot, 초고속: ts.초고속 / tot };
}
function tierProfileOf(rows, sharesFn) {
  const agg = {}; for (const t of TIERS) agg[t] = { wsum: 0, w: 0, keys: new Set() };
  for (const r of rows) {
    const shares = sharesFn(r.sc); if (!shares) continue;
    for (const t of TIERS) { const sh = shares[t]; if (sh <= 0) continue; agg[t].wsum += r.resid * sh; agg[t].w += sh; if (sh >= 0.15) agg[t].keys.add(r.key); }
  }
  const inc = []; let cSum = 0, cW = 0;
  for (const t of TIERS) { const a = agg[t]; if (a.keys.size < 3 || a.w <= 0) continue; inc.push({ t, raw: a.wsum / a.w, w: a.w, charts: a.keys.size }); cSum += a.wsum; cW += a.w; }
  const center = cW > 0 ? cSum / cW : 0;
  const profile = {};
  for (const it of inc) profile[it.t] = { mean: it.raw - center, absMean: it.raw, n: Math.round(it.w), charts: it.charts };
  return profile;
}
function computeSpMixProfile(rows) {
  let sumRW = 0, sumW = 0, n = 0, absSum = 0, allSum = 0, allN = 0;
  for (const r of rows) {
    allSum += r.resid; allN++;
    const shares = tierSharesOfHist(spKeyRhythmHist(r.sc, ['all'])); if (!shares) continue;
    const top = Math.max(shares.저속, shares.중속, shares.고속, shares.초고속);
    const mixed = 1 - top; if (mixed < 0.40) continue;
    sumRW += r.resid * mixed; sumW += mixed; absSum += r.resid; n++;
  }
  if (sumW <= 0 || n < 3 || allN <= 0) return null;
  return { mean: sumRW / sumW - allSum / allN, absMean: absSum / n, n };
}
function computeSpKensei(rows) {
  let sumRW = 0, sumW = 0, n = 0, absSum = 0, allSum = 0, allN = 0;
  for (const r of rows) {
    allSum += r.resid; allN++;
    const sr = r.sc.SARA_RHYTHM; if (!sr) continue;
    const ev = (sr.rollN || 0) + (sr.interN || 0); if (ev < 20) continue;
    const ir = sr.interN / ev; if (ir < 0.30) continue;
    sumRW += r.resid * ir; sumW += ir; absSum += r.resid; n++;
  }
  if (sumW <= 0 || n < 3 || allN <= 0) return null;
  return { mean: sumRW / sumW - allSum / allN, absMean: absSum / n, n };   // self-relative — 자체 중심화
}
const SP_MURI_DEFS = [
  { key: 'denim', label: '데님', gate: 3, scale: 20, of: (o) => o.denim || 0 },
  { key: 'chordT', label: '한손몰림', gate: 2, scale: 10, of: (o) => o.chordT || 0 },
  { key: 'hardTrill', label: '무리트릴', gate: 2, scale: 10, of: (o) => (o.hardL || 0) + (o.hardR || 0) },
  { key: 'stair', label: '겹계단', gate: 2, scale: 10, of: (o) => o.stair || 0 },
];
function computeSpMuriProfile(rows, offByKey) {
  let allSum = 0, allN = 0;
  for (const r of rows) { allSum += r.resid; allN++; }
  if (allN <= 0) return null;
  const center = allSum / allN;
  const out = [];
  for (const def of SP_MURI_DEFS) {
    let sumRW = 0, sumW = 0, n = 0, absSum = 0;
    for (const r of rows) {
      const off = offByKey.get(r.key); if (!off) continue;
      const v = def.of(off); if (v < def.gate) continue;
      const w = Math.min(1, v / def.scale);
      sumRW += r.resid * w; sumW += w; absSum += r.resid; n++;
    }
    if (sumW <= 0 || n < 3) continue;
    out.push({ key: def.key, label: def.label, mean: sumRW / sumW - center, absMean: absSum / n, n });
  }
  return out.length ? out : null;
}
function computeSpBpmProfile(rows, bpmByNorm) {
  const agg = {};
  for (const r of rows) {
    const b = bpmByNorm.get(r.key.split('|')[0]);
    if (typeof b !== 'number') continue;
    const bk = Math.floor(b / 10) * 10;
    if (!agg[bk]) agg[bk] = { sum: 0, n: 0, keys: new Set() };
    agg[bk].sum += r.resid; agg[bk].n++; agg[bk].keys.add(r.key);
  }
  let tot = 0, totN = 0;
  for (const k in agg) { tot += agg[k].sum; totN += agg[k].n; }
  const center = totN ? tot / totN : 0;
  const out = {};
  for (const k in agg) {
    const a = agg[k];
    if (a.keys.size < 3) continue;
    out[k] = { bpm: +k, mean: a.sum / a.n - center, absMean: a.sum / a.n, n: a.n, charts: a.keys.size };
  }
  return Object.keys(out).length ? out : null;
}

// SP 차트 배열 → spPersona 필드. 표본/키맵 부족 시 null.
export function spPersonaFor(ownSp, R) {
  if (!R.spKeymaps || !Array.isArray(ownSp) || ownSp.length < MIN_CHARTS) return null;
  const resid = spResidRows(ownSp, R);
  if (resid.length < MIN_CHARTS) return null;
  const feats = spFeatAptitude(resid);
  if (!feats) return null;
  const profile = {
    nCharts: ownSp.length,
    overallResid: null,   // self-relative — 램프/스코어 지향 판정 생략
    feats, mirror: null, featsL: null, featsR: null,
    bpmProfile: computeSpBpmProfile(resid, R.spKeymaps.bpmByNorm),
    kensei: computeSpKensei(resid),
    scratchProfile: tierProfileOf(resid, (sc) => { const sr = sc.SARA_RHYTHM; if (!sr || (sr.rollN || 0) < 20) return null; return tierSharesOfHist(sr.ioiSec); }),
    trillProfile: tierProfileOf(resid, (sc) => tierSharesOfHist(spKeyRhythmHist(sc, ['tr']))),
    jackProfile: tierProfileOf(resid, (sc) => tierSharesOfHist(spKeyRhythmHist(sc, ['jack', 'axis']))),
    streamProfile: tierProfileOf(resid, (sc) => tierSharesOfHist(spKeyRhythmHist(sc, ['all']))),
    mixProfile: computeSpMixProfile(resid),
    muriProfile: computeSpMuriProfile(resid, R.spKeymaps.offByKey),
  };
  const rich = R.personaLib.richReportOf(profile);
  const P = rich.persona;
  return {
    head: rich.head, oneLiner: P.oneLiner, prose: P.prose, report: rich.report,
    tags: P.tags, nCharts: ownSp.length, _v: new Date().toISOString(),
  };
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
  // 배치 적성(36dim 미포함 내부값) — featScores 가중 잔차 + 본인 평균 중심화.
  //   HSTAIR 4축(chart-level) + 나선계단 2축(손별 _L/_R → max, 계약 외 EXTRA 필드. up=오른방향(1→7)/dn=왼방향).
  const LAYOUT_DEFS = [
    { key: 'HSTAIR_ONEHAND', label: '한손계단', of: (sc) => sc.HSTAIR_ONEHAND },
    { key: 'HSTAIR_SYNC', label: '쌍계단', of: (sc) => sc.HSTAIR_SYNC },
    { key: 'HSTAIR_SAMESHAPE', label: '대칭계단', of: (sc) => sc.HSTAIR_SAMESHAPE },
    { key: 'HSTAIR_DIFFSHAPE', label: '비대칭계단', of: (sc) => sc.HSTAIR_DIFFSHAPE },
    { key: 'SPIRAL_UP', label: '오른나선', of: (sc) => Math.max(sc.SPIRAL_UP_L || 0, sc.SPIRAL_UP_R || 0) },
    { key: 'SPIRAL_DN', label: '왼나선', of: (sc) => Math.max(sc.SPIRAL_DN_L || 0, sc.SPIRAL_DN_R || 0) },
  ];
  let layoutProfile = null;
  if (overallResid != null) {
    layoutProfile = [];
    for (const def of LAYOUT_DEFS) {
      let sumRW = 0, sumW = 0, n = 0;
      for (const e of vec.__entries || []) {
        if (!e || typeof e.residual !== 'number' || !e.chartId) continue;
        const [sid, cn] = e.chartId.split('|');
        const sc = R.featScores[sid] && R.featScores[sid][cn];
        const raw = sc ? def.of(sc) : 0;
        const v = typeof raw === 'number' ? raw : 0;
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

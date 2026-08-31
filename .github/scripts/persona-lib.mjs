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

// clearStar 정책은 ohSorryWeb/user/components/helpers.js:16 recBaseStarOf 및
// ohSorryRating/scripts/analyze/dp/poc-user-score-vs-clear-axis.js 와 동일 유지.
function recBaseStar(user) {
  const star = typeof user?.star === 'number' ? user.star : null;
  const nativeStar = typeof user?.native_star === 'number' ? user.native_star : null;
  return star != null && star >= 0.5 && star < 2 ? star : (nativeStar != null ? nativeStar : star);
}

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
  // r★ 모듈은 신규 배포 전 과도기에도 기존 덤프를 막지 않도록 optional. 없으면 호출부가 이전값을 보존한다.
  let userRateStarLib = null;
  try {
    fs.writeFileSync(path.join(tmp, 'userRateStar.js'), await fetchText(`${GIST_RAW}/userRateStar.js${bust}`));
    userRateStarLib = req(path.join(tmp, 'userRateStar.js'));
  } catch { /* 아직 미배포 */ }
  const [textageMeta, ratingJson, zasaRaw, band1, band2, band3, featScoresJson, rateRef, spSlimRaw, spArrange, spRateRefRaw] = await Promise.all([
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
    fetchJson(`${GIST_RAW}/sp-rate-reference.json${bust}`).catch(() => null),   // SP 스코어링 마스터용 인구 rate 기준(gameLevel별). 없으면 SP overallResid null
  ]);
  // SP rate 인구 기준 — gameLevel(int) → 평균 rate. spPersonaFor 가 SP overallResid(스코어링 마스터) 계산에 사용.
  const spRateRef = (spRateRefRaw && spRateRefRaw.byGameLevel) ? spRateRefRaw.byGameLevel : null;
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
  // persona usernorm 인구 통계 — repo 루트 persona-pop.json(있으면). { dp: {NOTES:{mean,sd},.., _relSd}, sp: {..} }
  //   축별 인구 편향("누구나 낮은 축"이 전원 약점으로 잡히는 문제)을 걷어내는 데 쓴다.
  //   없으면 persona 는 종전대로 본인 평균 중심화만 한다(하위호환) — 생성은 ohSorryAdmin/scripts/buildPersonaPop.js.
  //   ⚠️ 실행 위치가 둘이다 — Action 은 repo 루트(cwd), ohSorryAdmin 은 자기 폴더에서 dump-data-repo.js 를
  //      돌린다. cwd 만 보면 후자가 pop 을 못 찾아 조용히 종전 동작으로 떨어진다 → 이 파일 기준 경로도 시도.
  const localJson = (name) => {
    const cands = [
      path.join(process.cwd(), name),
      path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', name),
    ];
    for (const pp of cands) { try { return JSON.parse(fs.readFileSync(pp, 'utf8')); } catch { /* 다음 후보 */ } }
    return null;
  };
  const pop = localJson('persona-pop.json');
  // 배치/무리/지구력 축 usernorm — repo 루트 persona-popmean.json (ohSorryRating gen-persona-popmean.js 산출물).
  //   ⚠️ **DP 전용**. supabase make_grid_data(전 레벨) DP 잔차로 잰 통계라 SP 에 주입하면 스케일이 어긋난다.
  //   없으면 persona 는 종전 raw 경로(자기중심화만) — 하위호환.
  const popmean = localJson('persona-popmean.json');
  const popmeanSp = localJson('persona-popmean-sp.json');   // SP 판 — 축·스케일이 달라 파일이 별개다
  return {
    weaknessLib, personaLib, userRateStarLib, norm, textageMeta,
    ratingData: ratingJson.ratings,
    rateStarScale: ratingJson.rateStar && ratingJson.rateStar.scale,
    zasaData: Array.isArray(zasaRaw.charts) ? zasaRaw.charts : zasaRaw,
    patternsMap, featScores: featScoresJson.scores, rateRef, spKeymaps, spRateRef, pop, popmean, popmeanSp,
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
      missCount: typeof r.bp === 'number' ? r.bp : null,   // bp(미스카운트) — calcUserWeakness 의 bp 반영 보정용
    });
  }
  return out;
}

// 스코어링 마스터 칭호용 — 어나더+(ANOTHER/LEGGENDARIA) 채보 중 MAX-권(스코어율 ≥ 17/18) 비율.
//   noteOf(c): 차트 → 노트수 (DP 는 c.noteCount 직접, SP 는 spKeymaps.noteByKey 조회). 표본 <30 이면 null(소표본 방지).
//   ⚠️ ohSorryRating dump-all/dump-sp 스크립트의 동명 계산과 1:1 동기.
function maxMinusStatsOf(charts, noteOf) {
  let hit = 0, tot = 0;
  for (const c of charts) {
    if (!c || (c.diff !== 'ANOTHER' && c.diff !== 'LEGGENDARIA')) continue;
    if (typeof c.exScore !== 'number' || c.exScore <= 0) continue;
    const nc = noteOf(c);
    if (typeof nc !== 'number' || nc <= 0) continue;
    tot++;
    if (c.exScore / (nc * 2) >= 17 / 18) hit++;
  }
  return tot >= 30 ? { share: hit / tot, tot } : null;
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
  // 잔차 기준선(2026-08-08) — R.spRateRef(인구 평균 rate)가 있으면 **인구 대비**로 잰다(DP rateRef 와 같은 사상).
  //   종전 self-relative 는 SP 유저풀이 10~20명이던 시절의 임시안. 실력이 값에서 지워져 고수에게도
  //   "대부분의 배치가 연습이 필요하다" 가 붙었다. 표에 없는 gameLevel 만 self 로 폴백한다.
  //   ⚠️ ohSorryRating/scripts/analyze/sp/dump-sp-user-personas.js 의 spResidRows 와 1:1 동기.
  for (const r of rows) {
    const pm = R.spRateRef ? R.spRateRef[r.gl] : null;
    r.resid = r.rate - (typeof pm === 'number' ? pm : glMean[r.gl]);
  }
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
  // 표본 하한 없음 — DP(personaFor)와 대칭. DP 는 "친 곡 30곡" 게이트 하나뿐이고 계산 표본에 추가 하한을
  //   두지 않는다. SP 만 여기와 spPersonaFor 에 resid 30 게이트가 더 있어, SP 를 587곡 친 유저도 SP12
  //   feature score 매칭이 24곡이면 리포트가 안 나왔다(LIMT./1899/VVV). 0곡일 때만 막는다.
  if (n === 0) return null;
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
// 배치 적성 축 (2026-08-08) — sp-feature-scores 의 SP 배치축 가중 잔차 + 본인 평균 중심화.
//   ⚠️ ohSorryRating/scripts/analyze/sp/dump-sp-user-personas.js 의 SP_LAYOUT_DEFS 및
//      persona.js SP_LAYOUT_GROUPS 와 **3곳이 1:1** 이어야 한다. 한쪽만 바꾸면 그룹 평균이 조용히 빈다.
//   ⚠️ KEIMA(계마)는 DP 전용 개념이라 제외. HSTAIR/HANDS 는 DP 의 1P↔2P 상호작용이라 SP 에 없다.
const SP_LAYOUT_DEFS = [
  { key: 'DOUBLE_STAIR', label: '겹계단' },
  //   축연타 (2026-08-24) — RANDOM 불변 축. sp-feature-scores 의 AXIS_SPEED 를 노출만 추가.
  { key: 'AXIS_SPEED', label: '축연타' },
  //   ⚠️ 나선 2·중앙트릴 3·JUMP_WIDE 는 persona.js SP_LAYOUT_GROUPS 에서 빠졌다(레인 의존). 공급만 유지.
  { key: 'SPIRAL_UP', label: '오른나선' },
  { key: 'SPIRAL_DN', label: '왼나선' },
  { key: 'TRILL_K4', label: '중앙트릴34' },
  { key: 'TRILL_K35', label: '중앙트릴35' },
  { key: 'TRILL_K24', label: '중앙트릴24' },
  { key: 'JUMP_WIDE', label: '도약' },
  { key: 'PHRASE_LOOP_FAST', label: '고속반복' },
  { key: 'PEAK_CHORD_SIZE', label: '최대동시' },
  // 차지 세부 6축 (2026-08-08) — 배치 축이 아니라 CHARGE 하위 축(persona.js CN_AXES 가 소비).
  //   ⚠️ SP 는 1P-side 단일이라 `_L`/`_R` 이 없다. ohSorryRating dump-sp-user-personas.js 와 1:1.
  { key: 'CN_SOLO', label: '단독차지' },
  { key: 'CN_CHORD', label: '차지동시' },
  { key: 'CN_MIX', label: '차지혼재' },
  { key: 'CN_REPEAT', label: '차지연타' },
  { key: 'CN_SHAPE', label: '차지이동' },
  { key: 'CN_HOLD', label: '누른채처리' },
];
function computeSpLayoutProfile(rows) {
  if (!rows.length) return null;
  let allSum = 0;
  for (const r of rows) allSum += r.resid;
  const center = allSum / rows.length;
  const out = [];
  for (const def of SP_LAYOUT_DEFS) {
    let sumRW = 0, sumW = 0, n = 0;
    for (const r of rows) {
      const v = (r.sc && r.sc[def.key]) || 0;
      if (v < 40) continue;
      const w = v / 100;
      sumRW += r.resid * w; sumW += w; n++;
    }
    if (sumW <= 0 || n < 10) continue;
    out.push({ key: def.key, label: def.label, mean: sumRW / sumW - center, n });
  }
  return out.length ? out : null;
}

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
// SP lamp 통계 (풀콤보/EX하드 마스터 칭호용) — **SP12(gameLevel 12) 곡** 중 FC/PFC·EX하드+ 비중.
//   "SP12 곡의 80% 이상이 그 램프"면 칭호. 12레벨 표본 <10 이면 null(소표본 노이즈 방지).
function spLampStats(ownSp) {
  let fc = 0, exh = 0, tot = 0;
  for (const c of ownSp) {
    if (!c || !c.title || !c.diff || c.gameLevel !== 12) continue;   // SP12 곡만
    tot++; const ln = c.lampNum || 0;
    if (ln >= 7) fc++;
    if (ln >= 6) exh++;
  }
  return tot >= 10 ? { fcShare: fc / tot, exhShare: exh / tot, tot } : null;
}

export function spPersonaFor(ownSp, R) {
  // 게이트는 "친 SP 곡 30곡"(ownSp) 하나뿐 — DP(personaFor)와 대칭.
  //   과거엔 resid(= SP feature score 매칭 + exScore>0, 사실상 SP12 중심) 에도 30 하한이 있어, SP 를
  //   587곡 친 유저가 매칭 24곡이라는 이유로 리포트를 못 받았다. SP12 를 30곡 안 쳐도 생성한다.
  if (!R.spKeymaps || !Array.isArray(ownSp) || ownSp.length < MIN_CHARTS) return null;
  const resid = spResidRows(ownSp, R);
  const feats = spFeatAptitude(resid);
  if (!feats) return null;
  // SP overallResid — 인구 rate 기준 대비 잔차 평균. 스코어링 마스터(SP) 판정 + 배치/무리 축 중심화 기준.
  //   2026-08-08 부터 resid 자체가 인구 기준이라 그 평균이 곧 overallResid 다(종전엔 여기서만 따로 계산했다).
  let spOverallResid = null;
  if (R.spRateRef && resid.length) spOverallResid = resid.reduce((a, r) => a + r.resid, 0) / resid.length;
  const profile = {
    pop: (R.pop && R.pop.sp) || null,   // usernorm 인구 통계(위 DP 와 동일 취지)
    nCharts: ownSp.length,
    isSp: true,                   // SP 분기용 (견제스크 용어·배치 임계 완화 등)
    overallResid: spOverallResid, // 인구 rate 기준 대비(만능형 하한·스코어/램프지향 문구·중심화용)
    feats, mirror: null, featsL: null, featsR: null,
    lampStats: spLampStats(ownSp),   // 풀콤보/EX하드 마스터 칭호 (SP scores lamp 비중)
    // 스코어링 마스터 — 어나더+ MAX-권 비율 (노트수는 SP 키맵 조회. 2026-08-10 기준 교체)
    maxMinusStats: maxMinusStatsOf(ownSp, (c) => R.spKeymaps.noteByKey.get(R.norm(c.title) + '|' + c.diff)),
    bpmProfile: computeSpBpmProfile(resid, R.spKeymaps.bpmByNorm),
    kensei: computeSpKensei(resid),
    scratchProfile: tierProfileOf(resid, (sc) => { const sr = sc.SARA_RHYTHM; if (!sr || (sr.rollN || 0) < 20) return null; return tierSharesOfHist(sr.ioiSec); }),
    trillProfile: tierProfileOf(resid, (sc) => tierSharesOfHist(spKeyRhythmHist(sc, ['tr']))),
    jackProfile: tierProfileOf(resid, (sc) => tierSharesOfHist(spKeyRhythmHist(sc, ['jack', 'axis']))),
    streamProfile: tierProfileOf(resid, (sc) => tierSharesOfHist(spKeyRhythmHist(sc, ['all']))),
    mixProfile: computeSpMixProfile(resid),
    muriProfile: computeSpMuriProfile(resid, R.spKeymaps.offByKey),
    layoutProfile: computeSpLayoutProfile(resid),
    // 배치/무리 축 usernorm — **SP 전용 파일**. DP 것(persona-popmean.json)과 섞으면 안 된다:
    //   실측 μ 부호가 반대고(SP 음수 / DP 양수) 스케일이 5배 차이난다.
    popAxes: (R.popmeanSp && R.popmeanSp.axes) || null,
    popDerived: (R.popmeanSp && R.popmeanSp.derived) || null,
  };
  const rich = R.personaLib.richReportOf(profile);
  const P = rich.persona;
  const i18n = {};   // ja/en 본문(head/report) — 웹 언어 버튼용. ko 는 최상위 head/report.
  for (const lang of ['ja', 'en']) { const r = R.personaLib.richReportOf(profile, lang); i18n[lang] = { head: r.head, report: r.report }; }
  return {
    head: rich.head, oneLiner: P.oneLiner, prose: P.prose, report: rich.report,
    tags: P.tags, nCharts: ownSp.length, _v: new Date().toISOString(), i18n,
  };
}

// persona 의 10피처 프로파일(feats)만 산출 — **usernorm 인구 통계 생성 전용**.
//   personaFor/spPersonaFor 는 리포트까지 만들어 무겁고 feats 를 반환하지 않으므로, 그 앞부분(피처 계산)만
//   떼어낸다. 계산식은 각 함수와 동일하게 유지할 것(어긋나면 인구 통계와 실제 persona 축이 달라진다).
//   반환: { NOTES..RAND } 또는 null(표본 부족).
export function featsFor(charts, R, isSp) {
  if (!Array.isArray(charts) || charts.length < MIN_CHARTS) return null;
  if (isSp) {
    if (!R.spKeymaps) return null;
    return spFeatAptitude(spResidRows(charts, R));
  }
  const vec = R.weaknessLib.calcUserWeakness({
    allCharts: charts, patternsMap: R.patternsMap, normFn: R.norm,
    ratingMap: R.ratingData, zasaMap: R.zasaData, rateRef: R.rateRef,
  });
  const feats = {};
  for (const k of Object.keys(vec)) {
    if (!k.startsWith('__') && R.weaknessLib.FEATS.includes(k)) feats[k] = vec[k];
  }
  return Object.keys(feats).length ? feats : null;
}

// 차트 배열 → persona 필드. 표본 부족/실패 시 null.
//   반환: { head, oneLiner, prose, report, tags, nCharts, _v }
export function personaFor(allCharts, R, userRow = null) {
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
    // §11-6 — legacy 길이 일치 축은 DB 36dim 호환용으로 retire하고, 실제 방향 대칭 축으로 교체.
    { key: 'HSTAIR_SYM', label: '대칭동기계단', of: (sc) => sc.HSTAIR_SYM },
    { key: 'HSTAIR_ASYM', label: '비대칭동기계단', of: (sc) => sc.HSTAIR_ASYM },
    { key: 'SPIRAL_UP', label: '오른나선', of: (sc) => Math.max(sc.SPIRAL_UP_L || 0, sc.SPIRAL_UP_R || 0) },
    { key: 'SPIRAL_DN', label: '왼나선', of: (sc) => Math.max(sc.SPIRAL_DN_L || 0, sc.SPIRAL_DN_R || 0) },
    // 2026-08-07 확장 — ohSorryRating dump-all-user-personas.js LAYOUT_DEFS 와 동일 유지.
    //   HANDS 계층 7(양손 상호작용) + 배치/리듬 3. 손별(_L/_R)은 max 로 한 축 취급(SPIRAL 동형).
    { key: 'HANDS_LHAND', label: '왼손주도', of: (sc) => sc.HANDS_LHAND },
    { key: 'HANDS_RHAND', label: '오른손주도', of: (sc) => sc.HANDS_RHAND },
    { key: 'HANDS_SAME', label: '대칭계단', of: (sc) => sc.HANDS_SAME },
    { key: 'HANDS_DIFF', label: '비대칭계단', of: (sc) => sc.HANDS_DIFF },
    { key: 'HANDS_CROSS', label: '교차', of: (sc) => sc.HANDS_CROSS },
    { key: 'HANDS_INDEP', label: '양손독립', of: (sc) => sc.HANDS_INDEP },
    { key: 'HANDS_ROLE', label: '역할분리', of: (sc) => sc.HANDS_ROLE },
    { key: 'JUMP_WIDE', label: '도약', of: (sc) => Math.max(sc.JUMP_WIDE_L || 0, sc.JUMP_WIDE_R || 0) },
    { key: 'PHRASE_LOOP_FAST', label: '고속반복', of: (sc) => Math.max(sc.PHRASE_LOOP_FAST_L || 0, sc.PHRASE_LOOP_FAST_R || 0) },
    { key: 'PEAK_CHORD_SIZE', label: '최대동시', of: (sc) => Math.max(sc.PEAK_CHORD_SIZE_L || 0, sc.PEAK_CHORD_SIZE_R || 0) },
    // 차지 세부 6축 (2026-08-08) — 산식이 같아 여기 얹지만 **배치 축이 아니다**.
    //   persona.js 는 LAYOUT_GROUPS 에 넣지 않고 🎲개인차의 '차지 상세' 줄에서만 소비한다(CN_AXES).
    //   ⚠️ ohSorryRating dump-all-user-personas.js LAYOUT_DEFS 와 동일 유지.
    { key: 'CN_SOLO', label: '단독차지', of: (sc) => Math.max(sc.CN_SOLO_L || 0, sc.CN_SOLO_R || 0) },
    { key: 'CN_CHORD', label: '차지동시', of: (sc) => Math.max(sc.CN_CHORD_L || 0, sc.CN_CHORD_R || 0) },
    { key: 'CN_MIX', label: '차지혼재', of: (sc) => Math.max(sc.CN_MIX_L || 0, sc.CN_MIX_R || 0) },
    { key: 'CN_REPEAT', label: '차지연타', of: (sc) => Math.max(sc.CN_REPEAT_L || 0, sc.CN_REPEAT_R || 0) },
    { key: 'CN_SHAPE', label: '차지이동', of: (sc) => Math.max(sc.CN_SHAPE_L || 0, sc.CN_SHAPE_R || 0) },
    { key: 'CN_HOLD', label: '누른채처리', of: (sc) => Math.max(sc.CN_HOLD_L || 0, sc.CN_HOLD_R || 0) },
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
    // usernorm 인구 통계(있으면) — persona.js 가 축별 z 로 편향 제거 후 본인 평균 중심화한다.
    pop: (R.pop && R.pop.dp) || null,
    // 배치(16축)/무리/지구력 축 usernorm — DP 전용. 없으면 persona 가 종전 raw 경로로 폴백.
    popAxes: (R.popmean && R.popmean.axes) || null,
    popDerived: (R.popmean && R.popmean.derived) || null,
    star: recBaseStar(userRow), rStar: userRow?.r_star ?? null,
    nCharts: allCharts.length, overallResid, feats, mirror,
    featsL: vec.__vecL || null, featsR: vec.__vecR || null,
    bpmProfile: vec.__bpmProfile || null, kensei: vec.__kensei || null,
    scratchProfile: vec.__scratchProfile || null, trillProfile: vec.__trillProfile || null,
    jackProfile: vec.__jackProfile || null, streamProfile: vec.__streamProfile || null,
    mixProfile: vec.__mixProfile || null, muriProfile: vec.__muriProfile || null,
    layoutProfile,
    notesProfile: vec.__notesProfile || null,   // 지구력(노트수) 축
    lampStats: vec.__lampStats || null,          // 풀콤보/EX하드 마스터 칭호용 FC/PFC 비중
    maxMinusStats: maxMinusStatsOf(allCharts, (c) => c.noteCount),   // 스코어링 마스터 — 어나더+ MAX-권 비율 (2026-08-10 기준 교체)
  };
  const rich = R.personaLib.richReportOf(profile);
  const P = rich.persona;
  const i18n = {};   // ja/en 본문(head/report) — 웹 언어 버튼용. ko 는 최상위 head/report.
  for (const lang of ['ja', 'en']) { const r = R.personaLib.richReportOf(profile, lang); i18n[lang] = { head: r.head, report: r.report }; }
  return {
    head: rich.head, oneLiner: P.oneLiner, prose: P.prose, report: rich.report,
    tags: P.tags, nCharts: allCharts.length, _v: new Date().toISOString(), i18n,
  };
}

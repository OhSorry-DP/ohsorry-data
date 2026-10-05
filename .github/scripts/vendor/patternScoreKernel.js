// patternScoreKernel.js — computePatternScoreVec 계열의 공용 math kernel (단일 정본, 구조개편 Phase 3-1).
//
// chart_score × score_rate 의 feature 별 top-N 가중합 = user_ohsorry_radars 36 컬럼 업로드값 산식.
//   - 4벌(ohSorry dbConn / ohSorryRating calcWeakness / backfill / ohSorryAdmin)의 중복 kernel 통합.
//   - rows/charts 입력 어댑터는 각 호출부가 보유. 이 모듈은 lookup/skip 을 하지 않는 순수 함수.
//   - 입력 entries = 매칭+skip 이 끝난 차트 목록 [{ scoreRate, chartScores }].
//       chartScores = feature 키 → quantile score(0~100) 맵.
//   - 출력 { vec(36키), matched } 또는 { vec:null, matched:0 }  (null=skip 정책으로 통일).
//
// Node 소비처(backfill / ohSorryAdmin)는 이 파일을 require 해서 실제 공유한다.
// 브라우저 소비처(dbConn / calcWeakness)는 동기 호출 + standalone gist 로드 제약상 같은 kernel 을
//   inline 으로 유지하되 동작이 byte-level 동일 — golden 패리티 테스트가 이를 강제한다
//   (ohSorryRating/scripts/test/pattern-kernel-parity.js).
//
// ⚠️ UPSERT_FEATS 순서 / UPSERT_WEIGHTS / TOP_N / s<=0 skip / desc 정렬 / 가중합 / matched=0→null
//    — DB 업로드값·추천 정렬에 직결되므로 단 1비트도 바꾸지 말 것.
//    차기 feature 확장(36→N)은 이 파일 + 각 inline 사본을 동시 갱신하고 패리티 테스트를 통과시킬 것.
'use strict';

// 36 dim — user_ohsorry_radars 컬럼 (mirror-invariant 10 + mirror 11 stem × L/R 22 + chart-level invariant 4(HSTAIR)).
//   ⚠️ 순서 = dump-feature-scores OUTPUT_FEATS / SQL 컬럼 / upsert_user_feature_score 37-arg 와 정확히 일치.
var UPSERT_FEATS = [
  'NOTES', 'CHORD', 'PEAK', 'CHARGE', 'SCRATCH', 'SOF-LAN', 'PHRASE', 'JACK', 'TRILL', 'RAND',
  'STAIR_UP_L', 'STAIR_UP_R', 'STAIR_DN_L', 'STAIR_DN_R',
  'K1_L', 'K1_R', 'K2_L', 'K2_R', 'K3_L', 'K3_R',
  'K4_L', 'K4_R', 'K5_L', 'K5_R', 'K6_L', 'K6_R', 'K7_L', 'K7_R',
  'DOUBLE_STAIR_L', 'DOUBLE_STAIR_R', 'KEIMA_L', 'KEIMA_R',
  'HSTAIR_ONEHAND', 'HSTAIR_SYNC', 'HSTAIR_SAMESHAPE', 'HSTAIR_DIFFSHAPE',
  'HANDS',
];

var TOP_N = 30;

// 가중치: 1~5위 = 1.0, 6~30위 = 0.90 → 0.05 선형 감소 (25 step).
var UPSERT_WEIGHTS = (function () {
  var ws = [];
  for (var i = 0; i < 5; i++) ws.push(1.0);
  for (var j = 0; j < 25; j++) {
    var pct = 90 - j * (90 - 5) / 24;  // j=0 → 90, j=24 → 5
    ws.push(pct / 100);
  }
  return ws;
})();

// entries: [{ scoreRate, chartScores }]  — 매칭+skip 이 끝난 차트별 (EX rate + feature-score 객체).
//   각 chartScores[f] 가 number 이고 > 0 일 때만 points = score × scoreRate 누적.
// return: { vec: {36키}, matched } 또는 { vec: null, matched: 0 }.
function collectPatternPoints(entries, withRecords) {
  var pointsByFeat = {};
  for (var fa = 0; fa < UPSERT_FEATS.length; fa++) pointsByFeat[UPSERT_FEATS[fa]] = [];
  var matched = 0;
  entries = entries || [];
  for (var ei = 0; ei < entries.length; ei++) {
    var e = entries[ei];
    if (!e || !e.chartScores) continue;
    var cs = e.chartScores;
    var rate = e.scoreRate;
    matched++;
    for (var fb = 0; fb < UPSERT_FEATS.length; fb++) {
      var f = UPSERT_FEATS[fb];
      var s = cs[f];
      if (typeof s !== 'number' || s <= 0) continue;
      var point = s * rate;
      pointsByFeat[f].push(withRecords ? { point: point, entry: e } : point);
    }
  }
  return { pointsByFeat: pointsByFeat, matched: matched };
}

// 점수와 기록 수는 같은 포함 조건·정렬·상위 개수 제한을 사용한다.
function topPatternPoints(points, withRecords) {
  return points.sort(function (a, b) {
    return withRecords ? b.point - a.point : b - a;
  }).slice(0, TOP_N);
}

function computePatternScoreKernel(entries) {
  var collected = collectPatternPoints(entries, false);
  var pointsByFeat = collected.pointsByFeat;
  var matched = collected.matched;
  if (matched === 0) return { vec: null, matched: 0 };
  var vec = {};
  for (var fc = 0; fc < UPSERT_FEATS.length; fc++) {
    var ff = UPSERT_FEATS[fc];
    var top = topPatternPoints(pointsByFeat[ff], false);
    var acc = 0;
    for (var ti = 0; ti < top.length; ti++) acc += top[ti] * UPSERT_WEIGHTS[ti];
    vec[ff] = acc;
  }
  return { vec: vec, matched: matched };
}

// 생산자는 매칭·skip을 마친 기존 entries에 원천 song_id·diff를 함께 전달한다.
// 상위 항목 중 가중 기여값이 0인 항목은 제외하고 버전·날짜 중복은 같은 채보로 센다.
function countPatternScoreRecords(entries) {
  var collected = collectPatternPoints(entries, true);
  var counts = {};
  for (var fi = 0; fi < UPSERT_FEATS.length; fi++) {
    var f = UPSERT_FEATS[fi];
    var top = topPatternPoints(collected.pointsByFeat[f], true);
    var keys = new Set();
    for (var ti = 0; ti < top.length; ti++) {
      var contribution = top[ti].point * UPSERT_WEIGHTS[ti];
      if (!Number.isFinite(contribution) || contribution === 0) continue;
      var e = top[ti].entry;
      if (!((typeof e.song_id === 'string' && e.song_id) || Number.isInteger(e.song_id))
        || !Number.isInteger(e.diff) || e.diff < 0 || e.diff > 4) {
        throw new Error('기여 채보의 song_id·diff가 유효하지 않습니다');
      }
      keys.add(JSON.stringify([String(e.song_id), e.diff]));
    }
    counts[f] = keys.size;
  }
  return counts;
}

module.exports = {
  UPSERT_FEATS: UPSERT_FEATS,
  TOP_N: TOP_N,
  UPSERT_WEIGHTS: UPSERT_WEIGHTS,
  computePatternScoreKernel: computePatternScoreKernel,
  countPatternScoreRecords: countPatternScoreRecords,
};

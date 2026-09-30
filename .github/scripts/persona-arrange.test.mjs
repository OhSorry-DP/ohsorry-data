import test from 'node:test';
import assert from 'node:assert/strict';
import { attachArrange, chartsFromGridRows, personaFor, reachNpsFor } from './persona-lib.mjs';

function fixture() {
  const rows = Array.from({ length: 30 }, (_, i) => Object.freeze({
    song_id: i + 1, diff: 3, title: `곡${i}`, textage_song_id: `tx${i}`,
    ex_score: i < 10 ? 200 : 100, lamp: 5, bp: i,
  }));
  const songs = Object.fromEntries(rows.map((r) => [r.textage_song_id, {
    notes: { DA: 100 }, levels: { DA: 12 },
  }]));
  return { rows: Object.freeze(rows), meta: { songs } };
}

function resources(vec = { NOTES: 0.25, __entries: [] }) {
  const calls = { weakness: [], profiles: [], arrange: [] };
  const R = {
    patternsMap: {}, ratingData: {}, zasaData: [], rateRef: {}, featScores: {},
    norm: (s) => s,
    weaknessLib: {
      FEATS: ['NOTES'],
      calcUserWeakness: (input) => { calls.weakness.push(input); return vec; },
      arrangeFeatureScores: (sc, arrange) => {
        calls.arrange.push({ sc, arrange });
        return { ...sc, HANDS_LHAND: sc.HANDS_RHAND, HANDS_RHAND: sc.HANDS_LHAND,
          SPIRAL_UP_L: sc.SPIRAL_DN_L, SPIRAL_DN_L: sc.SPIRAL_UP_L };
      },
    },
    personaLib: {
      richReportOf: (profile, lang = 'ko') => {
        calls.profiles.push(profile);
        return { head: lang, report: JSON.stringify(profile), persona: {
          oneLiner: '요약', prose: '본문', tags: ['태그'],
        } };
      },
    },
  };
  return { R, calls };
}

test('결합은 song_id·diff int 키와 DP만 사용하고 원본을 수정하지 않는다', () => {
  const { rows, meta } = fixture();
  const before = JSON.stringify(rows);
  const joined = attachArrange(rows, [
    { song_id: 1, diff: 3, play_style: 1, arrange: 5 },
    { song_id: 1, diff: 2, play_style: 1, arrange: 7 },
    { song_id: 2, diff: 3, play_style: 0, arrange: 2 },
    { song_id: 999, diff: 3, play_style: 1, arrange: 1 },
  ]);
  assert.notEqual(joined[0], rows[0]);
  assert.equal(joined[0].arrange, 5);
  assert.equal(joined[1], rows[1]);
  assert.equal(joined.length, rows.length);
  assert.equal(chartsFromGridRows(joined, meta)[0].arrange, 5);
  assert.equal(JSON.stringify(rows), before);
  assert.ok(rows.every((r) => !Object.hasOwn(r, 'arrange')));
});

test('배치 값은 정배·랜덤 비트·무효값까지 해석 없이 calcUserWeakness로 전달한다', () => {
  const { rows, meta } = fixture();
  const values = [0, 1, 2, 3, 4, 5, 6, 7, -1, 8, 32, 127, 128, -2, 1.5, '3', null];
  const charts = chartsFromGridRows(attachArrange(rows, values.map((arrange, i) => ({
    song_id: i + 1, diff: 3, play_style: 1, arrange,
  }))), meta);
  const { R, calls } = resources();
  personaFor(charts, R);
  assert.equal(calls.weakness[0].allCharts, charts);
  assert.deepEqual(charts.slice(0, values.length).map((c) => c.arrange), values);
  assert.ok(charts.slice(values.length).every((c) => !Object.hasOwn(c, 'arrange')));
  assert.equal(charts.length, 30);
  assert.equal(calls.weakness[0].patternsMap, R.patternsMap);
  assert.equal(calls.weakness[0].normFn, R.norm);
});

test('빈 배열이 아닌 조회 실패값을 배치 없음으로 삼키지 않는다', () => {
  const { rows } = fixture();
  for (const value of [null, undefined, {}, '']) assert.throws(() => attachArrange(rows, value), TypeError);
});

test('배치 없음은 기존 차트 JSON과 키 순서까지 동일하다', () => {
  const { rows, meta } = fixture();
  assert.equal(attachArrange(rows, []), rows);
  const expected = rows.map((r) => ({
    title: r.title, textageSongId: r.textage_song_id, diff: 'ANOTHER', exScore: r.ex_score,
    noteCount: 100, gameLevel: 12, lamp: 5, lampNum: 5, missCount: r.bp,
  }));
  const actual = chartsFromGridRows(attachArrange(rows, []), meta);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
  assert.ok(actual.every((c) => !Object.hasOwn(c, 'arrange')));
});

test('배치 없음은 persona 입력·출력과 layoutProfile 경로를 유지한다', (t) => {
  // 시간 필드까지 포함한 JSON 바이트 비교를 위해 두 호출의 시각을 고정한다.
  t.mock.method(Date.prototype, 'toISOString', () => '2026-09-30T00:00:00.000Z');
  const { rows, meta } = fixture();
  const entries = rows.map((r, i) => ({ chartId: `${r.textage_song_id}|DP_ANO`, residual: i < 10 ? 1 : 0 }));
  const { R, calls } = resources({ NOTES: 0.25, __entries: entries });
  for (const r of rows) R.featScores[r.textage_song_id] = { DP_ANO: { HANDS_LHAND: 80 } };
  const baseline = personaFor(chartsFromGridRows(rows, meta), R);
  const actual = personaFor(chartsFromGridRows(attachArrange(rows, []), meta), R);
  assert.equal(JSON.stringify(calls.profiles[0]), JSON.stringify(calls.profiles[3]));
  assert.equal(JSON.stringify(actual), JSON.stringify(baseline));
  assert.equal(calls.arrange.length, 0);
});

test('layoutProfile은 entry.arrange로 변환된 손·나선 피처와 잔차 가중치를 읽는다', () => {
  const { rows, meta } = fixture();
  const entries = rows.map((r, i) => ({
    chartId: `${r.textage_song_id}|DP_ANO`, residual: i < 10 ? 1 : 0,
    ...(i < 10 ? { arrange: 2 } : {}),
  }));
  const { R, calls } = resources({ NOTES: 0.25, __entries: entries });
  for (const r of rows) R.featScores[r.textage_song_id] = Object.freeze({
    DP_ANO: Object.freeze({ HANDS_LHAND: 80, HANDS_RHAND: 0, SPIRAL_UP_L: 80, SPIRAL_DN_L: 0 }),
  });
  const before = JSON.stringify(R.featScores);
  personaFor(chartsFromGridRows(rows, meta), R);
  const layout = Object.fromEntries(calls.profiles[0].layoutProfile.map((p) => [p.key, p]));
  assert.equal(layout.HANDS_LHAND.n, 20);
  assert.equal(layout.HANDS_RHAND.n, 10);
  assert.equal(layout.SPIRAL_UP.n, 20);
  assert.equal(layout.SPIRAL_DN.n, 10);
  assert.ok(Math.abs(layout.HANDS_LHAND.mean + 1 / 3) < 1e-12);
  assert.ok(Math.abs(layout.HANDS_RHAND.mean - 2 / 3) < 1e-12);
  assert.ok(Math.abs(layout.SPIRAL_DN.mean - 2 / 3) < 1e-12);
  assert.ok(calls.arrange.length > 0);
  assert.ok(calls.arrange.every((c) => c.arrange === 2));
  assert.equal(JSON.stringify(R.featScores), before);
});

test('랜덤 제외는 weakness의 entries에 맡기고 nCharts·MAX- 통계는 전체 차트를 센다', () => {
  const { rows, meta } = fixture();
  const charts = chartsFromGridRows(attachArrange(rows, rows.slice(0, 10).map((r) => ({
    song_id: r.song_id, diff: r.diff, play_style: 1, arrange: -1,
  }))), meta);
  // calcWeakness가 랜덤 10곡을 제외한 결과를 반환하는 경계를 고정한다.
  const entries = rows.slice(10).map((r) => ({ chartId: `${r.textage_song_id}|DP_ANO`, residual: 0.5 }));
  const { R, calls } = resources({ NOTES: 0.25, __entries: entries });
  const result = personaFor(charts, R);
  assert.equal(calls.weakness[0].allCharts.length, 30);
  assert.equal(result.nCharts, 30);
  assert.equal(calls.profiles[0].nCharts, 30);
  assert.deepEqual(calls.profiles[0].maxMinusStats, { share: 1 / 3, tot: 30 });
  assert.equal(calls.profiles[0].overallResid, 0.5);
  assert.deepEqual(Object.keys(result), ['head', 'oneLiner', 'prose', 'report', 'tags', 'nCharts', '_v', 'i18n']);
});

test('reachNps는 배치 유무와 랜덤값에 무관하게 전체 차트를 전달한다', () => {
  const { rows, meta } = fixture();
  const { R } = resources();
  for (const r of rows) R.patternsMap[r.textage_song_id] = { c: { DP_ANO: { nps: { a: 5, p: 10 } } } };
  const calls = [];
  const criteria = ['ec', 'hc', 'exh', 'a', 'aa', 'aaa'];
  R.reachNpsLib = (records) => {
    calls.push(records);
    const values = Object.fromEntries(criteria.map((k) => [k, 5]));
    const cellMeta = Object.fromEntries(criteria.map((k) => [k, { fallback: false, total: records.length, gate: 1 }]));
    return { avg: values, peak: values, meta: { avg: cellMeta, peak: cellMeta } };
  };
  const baseline = reachNpsFor(chartsFromGridRows(rows, meta), R);
  const arranged = reachNpsFor(chartsFromGridRows(attachArrange(rows, rows.map((r) => ({
    song_id: r.song_id, diff: r.diff, play_style: 1, arrange: -1,
  }))), meta), R);
  assert.equal(calls[0].length, rows.length);
  assert.equal(JSON.stringify(calls[0]), JSON.stringify(calls[1]));
  assert.equal(JSON.stringify(baseline), JSON.stringify(arranged));
});

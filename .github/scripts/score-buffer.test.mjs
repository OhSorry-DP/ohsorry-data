import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCandidate, rowsFromRest, sha256Hex, validateCandidate } from './score-buffer.mjs';

const fixtureDate = '2026-10-22T01:02:03.123456+00:00';
const fixtureRow = [1000, 3, 4, 1234, 33, fixtureDate, '2026-10-22', 1, null, 1500];
const fixtureRest = [{ score_id: 101, song_id: 1000, diff: 3, lamp: 4, ex_score: 1234, played_version: 33,
  date: fixtureDate, date_kst: '2026-10-22', play_style: 1, bp: null, note_count: 1500 }];
const bytes = (rows) => new TextEncoder().encode(JSON.stringify(rows));
const candidateFor = (iidxId, restRows, rows) => {
  const histBytes = bytes(rows);
  return buildCandidate({ iidxId, restRows, publishedHistBytes: histBytes, downloadedHistBytes: histBytes });
};

test('전체 REST 이력을 검증하고 입력을 변경하지 않으며 이번 ID와 실제 해시를 반환한다', () => {
  const rests = [
    { ...fixtureRest[0], score_id: 101 },
    { ...fixtureRest[0], score_id: 102, date: '2026-10-22T02:02:03.123456+01:00', date_kst: '2026-10-22', played_version: 34 },
    { ...fixtureRest[0], score_id: 103, date: '2026-10-22T01:02:03.123457+00:00', played_version: 35 },
  ];
  const rows = [fixtureRow, [...fixtureRow], [...fixtureRow]];
  rows[1][5] = '2026-10-22T01:02:03.123456Z';
  rows[1][6] = '2026-10-22';
  rows[1][4] = 34;
  rows[2][5] = '2026-10-22T01:02:03.123457Z';
  rows[2][6] = '2026-10-22';
  rows[2][4] = 35;
  const beforeRest = structuredClone(rests);
  const beforeRows = structuredClone(rows);
  const out = candidateFor('u1', rests, rows);
  assert.deepEqual(out, { score_ids: [101, 102, 103], hist: { key: 'hist/u1.json', sha256: sha256Hex(bytes(rows)) } });
  assert.deepEqual(rests, beforeRest);
  assert.deepEqual(rows, beforeRows);
});

test('동일 instant 표기는 허용하고 1마이크로초 차이는 거부한다', () => {
  const equal = { ...fixtureRest[0], date: '2026-10-22T01:02:03.123456Z' };
  assert.deepEqual(candidateFor('1234', [equal], [fixtureRow]).score_ids, [101]);
  const different = { ...fixtureRest[0], date: '2026-10-22T01:02:03.123457+00:00' };
  assert.throws(() => candidateFor('1234', [different], [fixtureRow]), /date differs/);
});

test('누락, 10열 값 변조, 중복 자연키와 잘못된 REST ID 및 DBR을 거부한다', () => {
  assert.throws(() => candidateFor('u1', [], [fixtureRow]), /absent from REST/);
  const changed = [...fixtureRow]; changed[9] = 1501;
  assert.throws(() => candidateFor('u1', fixtureRest, [changed]), /value differs/);
  assert.throws(() => candidateFor('u1', fixtureRest, [fixtureRow, fixtureRow]), /duplicate natural key/);
  assert.throws(() => rowsFromRest([{ ...fixtureRest[0], score_id: -1 }]));
  assert.throws(() => rowsFromRest([{ ...fixtureRest[0], score_id: Number.MAX_SAFE_INTEGER + 1 }]));
  assert.throws(() => rowsFromRest([fixtureRest[0], fixtureRest[0]]), /duplicate score_id/);
  assert.throws(() => rowsFromRest([{ ...fixtureRest[0], played_version: -10 }]));
});

test('바이트 불일치, 잘못된 UTF-8과 잘못된 REST/hist 형태를 거부한다', () => {
  const good = bytes([fixtureRow]);
  assert.throws(() => buildCandidate({ iidxId: 'u1', restRows: fixtureRest, publishedHistBytes: good,
    downloadedHistBytes: bytes([]) }), /bytes differ/);
  assert.throws(() => buildCandidate({ iidxId: 'u1', restRows: fixtureRest, publishedHistBytes: good,
    downloadedHistBytes: new Uint8Array([0xff]) }), /bytes differ/);
  const badUtf8 = new Uint8Array([0xff]);
  assert.throws(() => buildCandidate({ iidxId: 'u1', restRows: [], publishedHistBytes: badUtf8,
    downloadedHistBytes: badUtf8 }), /UTF-8/);
  assert.throws(() => candidateFor('u1', [fixtureRest[0]], [[...fixtureRow, 0]]), /10 columns/);
  assert.throws(() => rowsFromRest([[101, ...fixtureRow]]));
});

test('candidate 스키마가 정확하고 빈 목록을 허용하며 전달된 유저 ID를 강제한다', () => {
  const empty = candidateFor('Ab12', [], []);
  assert.deepEqual(empty, { score_ids: [], hist: { key: 'hist/Ab12.json', sha256: sha256Hex(bytes([])) } });
  assert.equal(validateCandidate(empty, 'Ab12'), empty);
  assert.throws(() => validateCandidate({ ...empty, extra: true }, 'Ab12'));
  assert.throws(() => validateCandidate({ ...empty, hist: { ...empty.hist, key: 'hist/Other.json' } }, 'Ab12'));
  assert.throws(() => validateCandidate({ ...empty, score_ids: [2, 1] }, 'Ab12'));
  assert.deepEqual(candidateFor('u1', fixtureRest, [fixtureRow]).score_ids, [101]);
});

test('기본 꺼짐: import와 순수 함수 호출은 fetch 및 파일 IO를 일으키지 않는다', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (...args) => { calls += 1; return originalFetch(...args); };
  try {
    const mod = await import(`./score-buffer.mjs?pure=${Date.now()}`);
    const rowBytes = bytes([fixtureRow]);
    mod.buildCandidate({ iidxId: 'u1', restRows: fixtureRest, publishedHistBytes: rowBytes, downloadedHistBytes: rowBytes });
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

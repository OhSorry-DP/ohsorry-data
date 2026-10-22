import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCandidate, rowsFromRest, sha256Hex, validateCandidate } from './score-buffer.mjs';

const iidxId = '89388691';
const fixtureDate = '2026-10-22T01:02:03.123456+00:00';
const fixtureRow = [100, 3, 5, 2000, 33, fixtureDate, '2026-10-22', 1, null, 1500];
const fixtureRest = [{ score_id: 12345, iidx_id: iidxId, song_id: 100, diff: 3, played_version: 33,
  play_style: 1, ex_score: 2000, lamp: 5, bp: null, note_count: 1500, date: fixtureDate, date_kst: '2026-10-22' }];
const songs = [100, 200, 300, 400].map((song_id) => ({ song_id }));
const noAliases = { v: 1, rules: [] };
const aliasesBytes = (aliases = noAliases) => Buffer.from(JSON.stringify(aliases), 'utf8');
const rowBytes = (rows) => Buffer.from(JSON.stringify(rows), 'utf8');
const restObject = (scoreId, overrides = {}) => ({ ...fixtureRest[0], score_id: scoreId, ...overrides });
const candidateFor = ({ iidx = iidxId, rest = fixtureRest, previous = [], aliases = noAliases,
  histRows, published = rowBytes(histRows ?? [...previous, ...rest.map((r) => [r.song_id, r.diff, r.lamp,
    r.ex_score, r.played_version, r.date, r.date_kst, r.play_style, r.bp, r.note_count])]),
  downloaded = published } = {}) => buildCandidate({ iidxId: iidx, restRows: rest, previousHistRows: previous,
  aliases, aliasesBytes: aliasesBytes(aliases), songs, publishedHistBytes: published, downloadedHistBytes: downloaded });

test('1. nullable 키 누락은 거부하고 명시 null은 허용한다', () => {
  const missing = { ...fixtureRest[0] };
  delete missing.bp;
  assert.throws(() => rowsFromRest([missing], iidxId), /missing required key/);
  assert.deepEqual(candidateFor().rows[0].bp, null);
  assert.equal(candidateFor().rows[0].note_count, 1500);
});

test('2. date 마이크로초 원문, 사용자 일치, DBR 보존과 안전 정수를 검사한다', () => {
  assert.equal(candidateFor().rows[0].date, fixtureDate);
  assert.throws(() => candidateFor({ rest: [restObject(12345, { iidx_id: 'other' })] }), /iidx_id differs/);
  assert.throws(() => rowsFromRest([restObject(Number.MAX_SAFE_INTEGER + 1)], iidxId), /safe integer/);
  const dbr = [-10, 3, 5, 2000, -10, fixtureDate, '2026-10-22', 1, null, 1500];
  const dbrHist = [dbr, fixtureRow];
  const got = candidateFor({ previous: [dbr], histRows: dbrHist });
  assert.equal(got.hist.sha256, sha256Hex(rowBytes(dbrHist)));
  assert.equal(got.rows[0].song_id, 100);
  assert.throws(() => candidateFor({ rest: [restObject(12345, { song_id: Number.MAX_SAFE_INTEGER + 1 })] }), /safe integer/);
});

test('3. 중복 ID, 순서 불일치, ID 목록 불일치와 v1 후보를 거부한다', () => {
  assert.throws(() => rowsFromRest([fixtureRest[0], fixtureRest[0]], iidxId), /duplicate score_id/);
  const valid = candidateFor();
  assert.throws(() => validateCandidate({ ...valid, score_ids: [12346, 12345] }, iidxId), /ascending/);
  assert.throws(() => validateCandidate({ ...valid, score_ids: [12346] }, iidxId), /same ascending set/);
  assert.throws(() => validateCandidate({ ...valid, v: 1 }, iidxId), /v2/);
});

test('4. 무향상 ID도 수록하고 NULL 보충 및 200행 초과 과거 hist를 허용한다', () => {
  const prior = [...fixtureRow]; prior[8] = null;
  const rest = [restObject(12345, { bp: 12 })];
  const completed = [...fixtureRow]; completed[8] = 12;
  const out = candidateFor({ rest, previous: [prior], histRows: [completed] });
  assert.deepEqual(out.score_ids, [12345]);
  assert.equal(out.rows[0].bp, 12);

  const oldRows = Array.from({ length: 205 }, (_, index) => [10000 + index, 3, 1, 100, 32,
    fixtureDate, '2026-10-22', 1, null, 1500]);
  const many = candidateFor({ rest: [], previous: oldRows, histRows: oldRows });
  assert.deepEqual(many.score_ids, []);
  assert.equal(many.hist.sha256, sha256Hex(rowBytes(oldRows)));
});

test('5. 지문은 별칭 전 원본 song_id, 별칭 바이트 해시와 기대 병합을 검증한다', () => {
  const aliases = { v: 1, rules: [{ from: 100, to: 200, scope: 'song' }] };
  const expectedHist = [[200, 3, 5, 2000, 33, fixtureDate, '2026-10-22', 1, null, 1500]];
  const out = candidateFor({ aliases, histRows: expectedHist });
  assert.equal(out.rows[0].song_id, 100);
  assert.equal(out.aliases_sha256, sha256Hex(aliasesBytes(aliases)));
  assert.throws(() => candidateFor({ aliases, histRows: [fixtureRow] }), /expected normalized replay/);
});

test('6. 원본 byte 불일치를 거부하고 재전송은 멱등이며 played_version 33을 받는다', () => {
  const exact = rowBytes([fixtureRow]);
  const pretty = Buffer.from(JSON.stringify([fixtureRow], null, 2), 'utf8');
  assert.throws(() => candidateFor({ published: exact, downloaded: pretty }), /bytes differ/);
  const first = candidateFor({ rest: [restObject(12345, { played_version: 33 })] });
  const retry = candidateFor({ rest: [restObject(12345, { played_version: 33 })] });
  assert.deepEqual(retry, first);
  assert.equal(first.rows[0].played_version, 33);
});

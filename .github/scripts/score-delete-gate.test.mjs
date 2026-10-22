import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { runScoreDeleteGate, validateDeleteResponse } from './score-delete-gate.mjs';
import { buildDeleteManifest, verifyDeleteSnapshot } from './snapshot-r2.mjs';
import { sha256Hex } from './score-buffer.mjs';

const id = '89388691';
const histText = '[[100,3,5,2000,33,"2026-10-22T01:02:03.123456+00:00","2026-10-22",1,null,1500]]';
const histBytes = Buffer.from(histText, 'utf8');
const aliasesBytes = Buffer.from('{"v":1,"rules":[{"from":100,"to":200,"scope":"song"},{"from":300,"to":400,"scope":"chart-ac","diff":3}]}', 'utf8');
const rawRow = (score_id) => ({ score_id, iidx_id: id, song_id: 100, diff: 3, played_version: 33, play_style: 1,
  ex_score: 2000, lamp: 5, bp: null, note_count: 1500,
  date: '2026-10-22T01:02:03.123456+00:00', date_kst: '2026-10-22' });
const candidateBytes = (ids = [12345], alter = {}) => Buffer.from(JSON.stringify({ v: 2,
  score_ids: ids, rows: ids.map(rawRow), hist: { key: `hist/${id}.json`, sha256: sha256Hex(histBytes) },
  aliases_sha256: sha256Hex(aliasesBytes), ...alter }), 'utf8');

function tarEntry(name, body) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8'); header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii'); header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii'); header.fill(32, 148, 156);
  header[156] = 48; header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii');
  let sum = 0; for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512); body.copy(padded);
  return Buffer.concat([header, padded]);
}

async function verified(ids = [12345], options = {}) {
  const key = options.snapshotKey || 'snapshot/daily/2026-10-23.tar.gz';
  const cBytes = candidateBytes(ids, options.candidateAlter);
  const hist = options.histBytes || histBytes;
  const manifest = buildDeleteManifest([{ key: `meta/scores-delete-${id}.json`, bytes: cBytes,
    histKey: `hist/${id}.json`, histBytes: hist }]);
  const files = [
    ['meta/scores-delete-' + id + '.json', cBytes], ['hist/' + id + '.json', hist],
    ['scores-delete-manifest.json', Buffer.from(JSON.stringify(manifest), 'utf8')],
  ];
  const tarBytes = gzipSync(Buffer.concat([...files.map(([name, body]) => tarEntry(name, body)), Buffer.alloc(1024)]));
  return verifyDeleteSnapshot({ snapshotKey: key, tarBytes, expectedManifest: options.manifest || manifest });
}

const execute = (proof, extra = {}) => runScoreDeleteGate({ iidxId: id, verifiedSnapshot: proof, execute: true, ...extra });
const response = (rows, deleted = rows.map((row) => row.score_id), kept = []) => ({ requested: rows.length,
  deleted_ids: deleted, kept_ids: kept });

test('OFF plans only; execution requires a fresh verified daily snapshot and exact allowlist', async () => {
  let calls = 0;
  const proof = await verified();
  const prepared = await runScoreDeleteGate({ iidxId: id, verifiedSnapshot: proof, deleteScoreRows: async () => { calls++; } });
  assert.equal(prepared.status, 'prepared'); assert.equal(calls, 0);
  for (const proof of [structuredClone(await verified()), await verified([1, 2]), await verified([1], { snapshotKey: 'snapshot/monthly/2026-10.tar.gz' })]) {
    await assert.rejects(execute(proof, { deleteScoreRows: async () => { calls++; } }), /fresh verified snapshot/);
  }
  await assert.rejects(execute(await verified(), { iidxId: '89388692', deleteScoreRows: async () => { calls++; } }), /fresh verified snapshot/);
  assert.equal(calls, 0);
});

test('candidate v2 requires all nullable fields and exact ascending ID-to-row membership', async () => {
  const good = JSON.parse(candidateBytes().toString());
  for (const candidate of [
    { ...good, v: 1 }, (() => { const x = structuredClone(good); delete x.rows[0].date; return x; })(),
    (() => { const x = structuredClone(good); delete x.rows[0].bp; return x; })(),
    { ...good, score_ids: [12346] },
  ]) await assert.rejects(verified([12345], { candidateAlter: candidate }), /candidate|manifest|fingerprint|invalid|missing required key|same ascending set/i);
});

test('tar, hist bytes, fingerprints, and unbranded proof tampering are rejected', async () => {
  const proof = await verified();
  await assert.rejects(verified([12345], { histBytes: Buffer.from('[]') }), /hist mismatch|fingerprint/i);
  const forged = structuredClone(proof);
  await assert.rejects(execute(forged, { deleteScoreRows: async () => response([{ score_id: 12345 }]) }), /fresh verified snapshot/);
  const tampered = await verified(); tampered.candidates[0].candidateBytes = candidateBytes([12346]);
  await assert.rejects(execute(tampered, { deleteScoreRows: async () => ({ requested: 1, deleted_ids: [12345], kept_ids: [] }) }), /fresh verified snapshot/);
});

test('401 rows batch 200/200/1, preserve version 33 raw fingerprints, and ignore outside candidates', async () => {
  const ids = Array.from({ length: 401 }, (_, i) => i + 1);
  const proof = await verified(ids);
  const batches = [];
  const out = await runScoreDeleteGate({ iidxId: id, verifiedSnapshot: proof });
  assert.deepEqual(out.batches.map((rows) => rows.length), [200, 200, 1]);
  assert.equal(out.batches[0][0].played_version, 33);
  assert.equal(out.batches[0][0].song_id, 100);
  assert.deepEqual(out.batches.flat().map((row) => row.score_id), ids);
});

test('zero deletes and invalid response partitions fail closed', async () => {
  const rows = [rawRow(12345), rawRow(12346)];
  assert.deepEqual(validateDeleteResponse(response(rows, [], [12345, 12346]), rows), response(rows, [], [12345, 12346]));
  for (const invalid of [
    { requested: 2, deleted_ids: [12345], kept_ids: [12347] },
    { requested: 2, deleted_ids: [12345], kept_ids: [12345] },
    { requested: 2, deleted_ids: [12346, 12345], kept_ids: [] },
    { requested: 2, deleted_ids: [12345], kept_ids: [] },
  ]) {
    assert.throws(() => validateDeleteResponse(invalid, rows), /delete/);
  }
});

test('second batch failure or lost response is blocked until an uploaded daily snapshot is available', async () => {
  const ids = Array.from({ length: 401 }, (_, i) => i + 1);
  for (const failure of [new Error('adapter outage'), new Error('response lost')]) {
    await assert.rejects(execute(await verified(ids), { deleteScoreRows: async () => { throw failure; } }), /fresh verified snapshot/);
  }
});

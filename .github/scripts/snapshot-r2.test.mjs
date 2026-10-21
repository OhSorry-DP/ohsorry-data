import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { buildCandidate } from './score-buffer.mjs';
import { buildDeleteManifest, verifyDeleteSnapshot } from './snapshot-r2.mjs';

const id = '12345678';
const histKey = `hist/${id}.json`;
const candidateKey = `meta/scores-delete-${id}.json`;
const histBytes = Buffer.from('[[1000,3,4,1234,33,"2026-10-22T01:02:03.123456+00:00","2026-10-22",1,null,1500]]', 'utf8');
const restRows = [{ score_id: 101, song_id: 1000, diff: 3, lamp: 4, ex_score: 1234, played_version: 33,
  date: '2026-10-22T01:02:03.123456+00:00', date_kst: '2026-10-22', play_style: 1, bp: null, note_count: 1500 }];
const candidateBytes = Buffer.from(JSON.stringify(buildCandidate({ iidxId: id, restRows,
  publishedHistBytes: histBytes, downloadedHistBytes: histBytes })), 'utf8');
const entry = () => ({ key: candidateKey, bytes: candidateBytes, histKey, histBytes });
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function tar(entries) {
  const blocks = [];
  for (const { name, body, type = '0' } of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header.fill(0x20, 148, 156);
    header[156] = type.charCodeAt(0);
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    const sum = header.reduce((total, value) => total + value, 0);
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const manifest = () => buildDeleteManifest([entry()]);
const goodTar = () => tar([
  { name: 'scores-delete-manifest.json', body: Buffer.from(JSON.stringify(manifest())) },
  { name: candidateKey, body: candidateBytes }, { name: histKey, body: histBytes },
]);
const verify = (tarBytes = goodTar(), expectedManifest = manifest()) => verifyDeleteSnapshot({
  snapshotKey: 'snapshot/daily/test.tar.gz', tarBytes, expectedManifest,
});

test('import만 하면 main의 fetch와 process.exit을 호출하지 않는다', async () => {
  const originalFetch = globalThis.fetch;
  const originalExit = process.exit;
  let fetchCalls = 0, exitCalls = 0;
  globalThis.fetch = async (...args) => { fetchCalls++; return originalFetch(...args); };
  process.exit = () => { exitCalls++; throw new Error('process.exit called'); };
  try {
    await import(`./snapshot-r2.mjs?import-test=${Date.now()}`);
    assert.equal(fetchCalls, 0);
    assert.equal(exitCalls, 0);
  } finally { globalThis.fetch = originalFetch; process.exit = originalExit; }
});

test('정상 후보 매니페스트와 hist hash 및 key 검증', () => {
  assert.deepEqual(manifest(), { candidates: [{ key: candidateKey, sha256: digest(candidateBytes),
    hist: { key: histKey, sha256: digest(histBytes) } }] });
  assert.throws(() => buildDeleteManifest([{ ...entry(), histBytes: Buffer.from('[]') }]), /candidate hist mismatch/);
  assert.throws(() => buildDeleteManifest([{ ...entry(), key: '../scores-delete-12345678.json' }]), /invalid delete manifest entry/);
});

test('정상 스냅샷을 후보와 원본 tar gzip 바이트 해시까지 검증', async () => {
  const bytes = goodTar();
  const result = await verify(bytes);
  assert.equal(result.snapshotKey, 'snapshot/daily/test.tar.gz');
  assert.equal(result.tarSha256, digest(bytes));
  assert.deepEqual(result.candidates, [{ iidxId: id, candidateKey, candidateBytes, histBytes }]);
});

test('매니페스트 누락·불일치 및 후보·hist 변조를 거부', async () => {
  const noManifest = tar([{ name: candidateKey, body: candidateBytes }, { name: histKey, body: histBytes }]);
  await assert.rejects(verify(noManifest), /delete manifest missing/);
  await assert.rejects(verify(goodTar(), { candidates: [] }), /delete manifest mismatch/);
  const alteredCandidate = Buffer.from(candidateBytes); alteredCandidate[0] ^= 1;
  await assert.rejects(verify(tar([{ name: 'scores-delete-manifest.json', body: Buffer.from(JSON.stringify(manifest())) },
    { name: candidateKey, body: alteredCandidate }, { name: histKey, body: histBytes }])), /candidate missing or hash mismatch/);
  const alteredHist = Buffer.from(histBytes); alteredHist[0] ^= 1;
  await assert.rejects(verify(tar([{ name: 'scores-delete-manifest.json', body: Buffer.from(JSON.stringify(manifest())) },
    { name: candidateKey, body: candidateBytes }, { name: histKey, body: alteredHist }])), /candidate hist mismatch/);
});

test('위험한 경로·중복 경로·symlink·잘린 tar를 거부', async () => {
  const archive = (members) => tar([{ name: 'scores-delete-manifest.json', body: Buffer.from(JSON.stringify(manifest())) }, ...members]);
  await assert.rejects(verify(archive([{ name: '../x', body: Buffer.from('x') }])));
  await assert.rejects(verify(archive([{ name: 'dupe', body: Buffer.from('a') }, { name: 'dupe', body: Buffer.from('b') }])));
  await assert.rejects(verify(archive([{ name: 'link', body: Buffer.from('x'), type: '2' }])));
  await assert.rejects(verify(gzipSync(Buffer.alloc(512))));
});

test('빈 후보 목록 매니페스트도 정상 검증', async () => {
  const empty = { candidates: [] };
  const bytes = tar([{ name: 'scores-delete-manifest.json', body: Buffer.from(JSON.stringify(empty)) }]);
  const result = await verify(bytes, empty);
  assert.equal(result.tarSha256, digest(bytes));
  assert.deepEqual(result.candidates, []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { buildDeleteManifest, verifyDeleteSnapshot } from './snapshot-r2.mjs';

const id = '89388691';
const histKey = `hist/${id}.json`;
const candidateKey = `meta/scores-delete-${id}.json`;
const histBytes = Buffer.from('[[100,3,5,2000,33,"2026-10-22T01:02:03.123456+00:00","2026-10-22",1,null,1500]]', 'utf8');
const restRows = [{ score_id: 12345, iidx_id: id, song_id: 100, diff: 3, played_version: 33, play_style: 1,
  ex_score: 2000, lamp: 5, bp: null, note_count: 1500, date: '2026-10-22T01:02:03.123456+00:00', date_kst: '2026-10-22' }];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const aliasesBytes = Buffer.from('{"v":1,"rules":[{"from":100,"to":200,"scope":"song"},{"from":300,"to":400,"scope":"chart-ac","diff":3}]}');
const candidate = { v: 2, score_ids: [12345], rows: restRows,
  hist: { key: histKey, sha256: digest(histBytes) }, aliases_sha256: digest(aliasesBytes) };
const candidateBytes = Buffer.from(JSON.stringify(candidate), 'utf8');
const entry = () => ({ key: candidateKey, bytes: candidateBytes, histKey, histBytes });

function tar(entries) {
  const blocks = [];
  for (const { name, body = Buffer.alloc(0), type = '0' } of entries) {
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
const goodTar = (extra = []) => tar([
  { name: 'scores-delete-manifest.json', body: Buffer.from(JSON.stringify(manifest())) },
  ...extra, { name: candidateKey, body: candidateBytes }, { name: histKey, body: histBytes },
]);
const verify = (tarBytes = goodTar(), expectedManifest = manifest()) => verifyDeleteSnapshot({
  snapshotKey: 'snapshot/daily/2026-10-22.tar.gz', tarBytes, expectedManifest,
});

test('import has no side effects; valid tar with directory entry and empty candidate manifest verify', async () => {
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
  const bytes = goodTar([{ name: 'users/', type: '5' }]);
  const result = await verify(bytes);
  assert.equal(result.snapshotKey, 'snapshot/daily/2026-10-22.tar.gz');
  assert.equal(result.tarSha256, digest(bytes));
  const empty = { v: 2, candidates: [] };
  const emptyBytes = tar([{ name: 'scores-delete-manifest.json', body: Buffer.from(JSON.stringify(empty)) }]);
  assert.deepEqual((await verify(emptyBytes, empty)).candidates, []);
});

test('candidate v2, exact original row fingerprints, and ten column hist hash populate manifest v2', () => {
  const built = manifest();
  assert.deepEqual(candidate, { v: 2, score_ids: [12345], rows: restRows,
    hist: { key: histKey, sha256: digest(histBytes) }, aliases_sha256: digest(aliasesBytes) });
  assert.deepEqual(built, { v: 2, candidates: [{ key: candidateKey, candidate_sha256: digest(candidateBytes),
    hist_sha256: digest(histBytes), aliases_sha256: digest(aliasesBytes), rows: restRows,
    hist: { key: histKey, sha256: digest(histBytes) } }] });
  assert.throws(() => buildDeleteManifest([{ ...entry(), histBytes: Buffer.from('[]') }]), /candidate hist mismatch/);
  assert.throws(() => buildDeleteManifest([{ ...entry(), key: '../scores-delete-89388691.json' }]), /invalid delete manifest entry/);
});

test('tar verification binds manifest, candidate, hist, and exact tar bytes; rejects tampering', async () => {
  const bytes = goodTar();
  const result = await verify(bytes);
  assert.equal(result.tarSha256, digest(bytes));
  assert.deepEqual(result.candidates[0], { iidxId: id, candidateKey, candidate_sha256: digest(candidateBytes),
    hist_sha256: digest(histBytes), aliases_sha256: digest(aliasesBytes), rows: restRows, candidateBytes, histBytes });
  await assert.rejects(verify(tar([{ name: candidateKey, body: candidateBytes }, { name: histKey, body: histBytes }])), /delete manifest missing/);
  await assert.rejects(verify(goodTar(), { v: 2, candidates: [] }), /delete manifest mismatch/);
  for (const [key, bytesToAlter, expected] of [[candidateKey, candidateBytes, /candidate missing or hash mismatch/],
    [histKey, histBytes, /candidate hist mismatch/]]) {
    const altered = Buffer.from(bytesToAlter); altered[0] ^= 1;
    const members = [{ name: 'scores-delete-manifest.json', body: Buffer.from(JSON.stringify(manifest())) },
      { name: candidateKey, body: key === candidateKey ? altered : candidateBytes },
      { name: histKey, body: key === histKey ? altered : histBytes }];
    await assert.rejects(verify(tar(members)), expected);
  }
  const changedRows = structuredClone(manifest()); changedRows.candidates[0].rows[0].lamp = 4;
  await assert.rejects(verify(goodTar(), changedRows), /delete manifest mismatch/);
});

test('unsafe paths, duplicate paths, links, and malformed archives are rejected', async () => {
  const archive = (members) => tar([{ name: 'scores-delete-manifest.json', body: Buffer.from(JSON.stringify(manifest())) }, ...members]);
  await assert.rejects(verify(archive([{ name: '../x', body: Buffer.from('x') }])));
  await assert.rejects(verify(archive([{ name: 'dupe', body: Buffer.from('a') }, { name: 'dupe', body: Buffer.from('b') }])));
  await assert.rejects(verify(archive([{ name: 'link', body: Buffer.from('x'), type: '2' }])));
  await assert.rejects(verify(gzipSync(Buffer.alloc(512))));
});

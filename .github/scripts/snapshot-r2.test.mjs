import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { buildDeleteManifest, verifyDeleteSnapshot, main } from './snapshot-r2.mjs';
import { sha256Hex } from './score-buffer.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

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

test('main executes exact allowlisted rows from uploaded daily tar, stops on batch failure, and OFF never calls RPC', async () => {
  const savedEnv = { ...process.env };
  const savedArgv = process.argv;
  const savedFetch = globalThis.fetch;
  const savedExecFileSync = childProcess.execFileSync;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-r2-main-test-'));
  const uploaded = path.join(temp, 'uploaded.tar.gz');
  childProcess.execFileSync = (command, args, options) => {
    if (command === 'npx' && args[0] === '--yes' && args[1] === 'wrangler@4'
      && args[2] === 'r2' && args[3] === 'object' && args[4] === 'put') {
      const file = args.find((value) => value.startsWith('--file='))?.slice(7);
      fs.copyFileSync(file, uploaded);
      return '';
    }
    return savedExecFileSync(command, args, options);
  };
  syncBuiltinESMExports();

  const makeCandidate = (scoreIds) => {
    const rows = scoreIds.map((score_id) => ({ score_id, iidx_id: id, song_id: score_id,
      diff: 3, played_version: 33, play_style: 1, ex_score: 2000, lamp: 5, bp: null, note_count: 1500,
      date: '2026-10-22T01:02:03.123456+00:00', date_kst: '2026-10-22' }));
    return Buffer.from(JSON.stringify({ v: 2, score_ids: scoreIds, rows,
      hist: { key: histKey, sha256: digest(histBytes) }, aliases_sha256: digest(aliasesBytes) }));
  };
  const scoreIds = Array.from({ length: 401 }, (_, i) => i + 1);

  async function run({ execute, failBatch = 0 }) {
    const candidateByUser = { [id]: makeCandidate(scoreIds), '123': Buffer.from('{}') };
    const calls = [];
    let tarBytes = null;
    globalThis.fetch = async (url, init = {}) => {
      const key = decodeURIComponent(String(url).split('/objects/')[1] || '');
      const method = init.method || 'GET';
      if (key === 'users-list.json' && method === 'GET') return new Response(JSON.stringify([{ iidx_id: id }, { iidx_id: '123' }]), { status: 200 });
      if (key === 'user/89388691.json' || key === 'user/123.json') return new Response('{}', { status: 200 });
      if (key === histKey || key === 'hist/123.json') return new Response(histBytes, { status: 200 });
      if (key === 'songs.json' || key === 'version.json' || key === 'snapshot/index.json') return new Response(key.endsWith('index.json') ? '[]' : '{}', { status: 200 });
      if (key === candidateKey) return new Response(candidateByUser[id], { status: 200 });
      if (key === 'meta/scores-delete-123.json') return new Response(candidateByUser['123'], { status: 200 });
      if (key.startsWith('snapshot/daily/') && method === 'GET') return new Response(fs.readFileSync(uploaded), { status: 200 });
      if (key === 'snapshot/index.json' && method === 'PUT') return new Response('', { status: 200 });
      if (key === 'delete_score_buffer_exact' || String(url).includes('/rpc/delete_score_buffer_exact')) {
        const body = JSON.parse(init.body);
        calls.push(body);
        if (failBatch && calls.length === failBatch) return new Response('failure', { status: 500 });
        return new Response(JSON.stringify({ requested: body.p_rows.length,
          deleted_ids: body.p_rows.map((row) => row.score_id), kept_ids: [] }), { status: 200 });
      }
      if (method === 'DELETE') return new Response('', { status: 404 });
      if (method === 'PUT') { tarBytes = Buffer.from(init.body); return new Response('', { status: 200 }); }
      throw new Error(`unexpected mock request: ${method} ${url}`);
    };
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account'; process.env.CLOUDFLARE_API_TOKEN = 'token';
    process.env.SUPABASE_URL = 'https://supabase.test'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
    process.env.SCORE_BUFFER_PREPARE = '1'; process.env.SCORE_BUFFER_DELETE_EXECUTE = execute ? '1' : '0';
    process.env.SCORE_BUFFER_DELETE_USERS = '89388691';
    process.argv = [process.execPath, 'snapshot-r2.mjs', '--kind=daily'];
    let rejected;
    try { await main(); } catch (error) { rejected = error; }
    if (execute && !rejected) tarBytes = fs.readFileSync(uploaded);
    return { calls, rejected, tarBytes };
  }

  try {
    process.env.TZ = 'UTC';
    const successful = await run({ execute: true });
    assert.equal(successful.rejected, undefined);
    assert.deepEqual(successful.calls.map((call) => call.p_rows.length), [200, 200, 1]);
    assert.deepEqual(successful.calls.map((call) => call.p_iidx_id), [id, id, id]);
    const uploadedTar = fs.readFileSync(uploaded);
    const proof = await verifyDeleteSnapshot({ snapshotKey: `snapshot/daily/${new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10)}.tar.gz`,
      tarBytes: uploadedTar, expectedManifest: buildDeleteManifest([{ key: candidateKey,
        bytes: makeCandidate(scoreIds), histKey, histBytes }]) });
    assert.equal(proof.tarSha256, digest(uploadedTar));
    assert.deepEqual(successful.calls.flatMap((call) => call.p_rows.map((row) => row.score_id)), scoreIds);
    assert.deepEqual(successful.calls.flatMap((call) => call.p_rows), proof.candidates[0].rows);
    assert.equal(successful.calls.some((call) => call.p_iidx_id === '123'), false);
    assert.deepEqual(successful.calls[0].p_rows[0], {
      score_id: 1, iidx_id: id, song_id: 1, diff: 3, played_version: 33, play_style: 1,
      ex_score: 2000, lamp: 5, bp: null, note_count: 1500,
      date: '2026-10-22T01:02:03.123456+00:00', date_kst: '2026-10-22' });

    const failed = await run({ execute: true, failBatch: 2 });
    assert.match(failed.rejected?.result?.reason || '', /HTTP 500/);
    assert.equal(failed.calls.length, 2);
    const off = await run({ execute: false });
    assert.equal(off.rejected, undefined);
    assert.equal(off.calls.length, 0);
  } finally {
    globalThis.fetch = savedFetch;
    childProcess.execFileSync = savedExecFileSync;
    syncBuiltinESMExports();
    process.argv = savedArgv;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

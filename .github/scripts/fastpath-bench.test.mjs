import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const indexPath = path.join(root, 'supabase/functions/fastpath-bench/index.ts');
const source = await readFile(indexPath, 'utf8');
const hash = async (file) => createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');

test('provenance hashes match the exact current module bytes', async () => {
  const entries = {
    songAliases: '.github/scripts/song-aliases.mjs', scoreHistory: '.github/scripts/score-history.mjs',
    scoreBuffer: '.github/scripts/score-buffer.mjs', dumpFastCore: '.github/scripts/dump-fast-core.mjs',
    r2S3: 'supabase/functions/_shared/r2-s3.ts', denoJson: 'supabase/functions/fastpath-bench/deno.json',
  };
  const expected = Object.fromEntries(await Promise.all(Object.entries(entries).map(async ([k, f]) => [k, await hash(f)])));
  for (const [key, value] of Object.entries(expected)) assert.match(source, new RegExp(`${key}: "${value}"`), `${key} provenance stale`);
});

test('source has required direct imports, allowlist validation and timing stages', () => {
  for (const p of ['../../../.github/scripts/song-aliases.mjs', '../../../.github/scripts/score-history.mjs', '../../../.github/scripts/score-buffer.mjs', '../../../.github/scripts/dump-fast-core.mjs']) assert.ok(source.includes(p));
  assert.ok(!source.includes('dump-user.mjs') && !source.includes('r2-client.mjs'));
  assert.match(source, /function valid\(body: any\)/);
  assert.match(source, /downloadAssumption: \{ performedReget: false/);
  assert.match(source, /buildCandidate1/);
  assert.match(source, /buildCandidate2/);
  assert.match(source, /Promise\.allSettled/);
  assert.match(source, /ifMatch: '\"wrong-etag\"'/);
});

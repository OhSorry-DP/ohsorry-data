import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const vendorPath = fileURLToPath(new URL('../vendor/physLine.js', import.meta.url));
const ratingPath = fileURLToPath(new URL('../../../../ohSorryRating/modules/physLine.js', import.meta.url));

test('Rating canonical and Data vendor are byte-identical with matching SHA256', async () => {
  const [canonical, vendor] = await Promise.all([readFile(ratingPath), readFile(vendorPath)]);
  assert.ok(canonical.equals(vendor));
  assert.equal(createHash('sha256').update(canonical).digest('hex'), createHash('sha256').update(vendor).digest('hex'));
});

test('vendor loads the pure calculation API', () => {
  const api = require(vendorPath);
  assert.equal(typeof api.computePhysLine, 'function');
  assert.equal(typeof api.validateConfig, 'function');
});

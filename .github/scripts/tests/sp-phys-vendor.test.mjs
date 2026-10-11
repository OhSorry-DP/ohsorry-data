import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const vendorPath = fileURLToPath(new URL('../vendor/physLine.js', import.meta.url));
const ratingPath = fileURLToPath(new URL('../../../../ohSorryRating/modules/physLine.js', import.meta.url));
const canonical = require(ratingPath);
const vendor = require(vendorPath);

test('sp-phys-vendor/1', async () => {
  const [sourceBytes, vendorBytes] = await Promise.all([readFile(ratingPath), readFile(vendorPath)]);
  assert.equal(vendorBytes.equals(sourceBytes), true);
});

test('sp-phys-vendor/2', () => {
  assert.deepEqual(vendor.AXES_SP, canonical.AXES_SP);
  assert.deepEqual(vendor.UNIT_SP, canonical.UNIT_SP);
  assert.deepEqual(vendor.CONFIG_SP, canonical.CONFIG_SP);
  assert.deepEqual(vendor.computePhysLine({ rows: [], config: vendor.CONFIG_SP }), canonical.computePhysLine({ rows: [], config: canonical.CONFIG_SP }));
});

test('sp-phys-vendor/3', () => {
  for (const config of ['CONFIG', 'CONFIG_V2']) {
    assert.deepEqual(vendor[config], canonical[config]);
    const rows = [{ chartKey: 'song|HYPER', lampNum: 7, features: Object.fromEntries(vendor[config].axes.map((axis, i) => [axis, { meanNps: i + 1 }])) }];
    assert.deepEqual(vendor.computePhysLine({ rows, config: vendor[config] }), canonical.computePhysLine({ rows, config: canonical[config] }));
  }
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const vendorPath = fileURLToPath(new URL('../vendor/physTheta.js', import.meta.url));
const require = createRequire(import.meta.url);

test('vendor bytes match the local Rating canonical module when available', async t => {
  const canonicalPath = 'D:/work/ohSorryRating/modules/physTheta.js';
  let canonical;
  try {
    canonical = await readFile(canonicalPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      t.skip('local Rating checkout is unavailable');
      return;
    }
    throw error;
  }
  assert.deepEqual(await readFile(vendorPath), canonical);
});

test('vendor imports from a data-only temporary directory and exposes the calculation API', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'phys-vendor-data-'));
  try {
    await writeFile(path.join(tempDir, 'model.json'), JSON.stringify({ fixture: 'm-fixture' }), 'utf8');
    await writeFile(path.join(tempDir, 'rows.json'), JSON.stringify([{ fixture: 'q-fixture' }]), 'utf8');
    await writeFile(path.join(tempDir, 'revision.json'), JSON.stringify({ fixture: 't-fixture' }), 'utf8');
    const imported = require(vendorPath);
    assert.equal(imported.AXES.length, 10);
    assert.equal(typeof imported.fitUser, 'function');
    assert.deepEqual(JSON.parse(await readFile(path.join(tempDir, 'model.json'), 'utf8')), { fixture: 'm-fixture' });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('vendor import without Rating performs no network or filesystem reads', () => {
  const probe = String.raw`
    const fs = require('node:fs');
    const fsp = require('node:fs/promises');
    const net = require('node:net');
    const tls = require('node:tls');
    const Module = require('node:module');
    const calls = [];
    let monitoring = false;
    for (const [object, names, label] of [
      [fsp, ['readFile', 'open', 'readdir', 'stat', 'access'], 'fsp'],
      [net, ['connect', 'createConnection'], 'net'],
      [tls, ['connect'], 'tls'],
    ]) for (const name of names) {
      const original = object[name];
      object[name] = function (...args) { if (monitoring) calls.push(label + '.' + name); return original.apply(this, args); };
    }
    for (const name of ['readFileSync', 'openSync', 'readdirSync', 'statSync', 'accessSync']) {
      const original = fs[name];
      fs[name] = function (...args) { if (monitoring) calls.push('fs.' + name); return original.apply(this, args); };
    }
    monitoring = true;
    const mod = require(process.argv[1]);
    monitoring = false;
    if (mod.AXES.length !== 10 || typeof mod.fitUser !== 'function') process.exit(3);
    if (calls.length) { process.stderr.write(calls.join(',') + '\n'); process.exit(4); }
  `;
  const result = spawnSync(process.execPath, ['-e', probe, vendorPath], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || `exit ${result.status}`);
});

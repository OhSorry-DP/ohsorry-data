import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { main, makeSql } from './backfill-sp-star.mjs';

function fixture(config = {}) {
  const objects = new Map(), calls = [], conflicts = new Set(config.conflicts || []);
  const ids = ['A1', 'B2', 'C3', 'D4', 'E5', 'F6', ...(config.extraIds || [])];
  const expected = new Map([['A1', [101, 1]], ['B2', [202, 2]], ['C3', [303, null]], ['D4', [404, 4]], ['E5', [505, 5]], ['F6', [606, null]]]);
  for (const id of ids) {
    const [sp_cpi, sp_star] = expected.get(id) || [1, 1];
    objects.set(`user/${id}.json`, { body: JSON.stringify({ user: { iidx_id: id, dj_name: `DJ ${id}`, sp_cpi, sp_star, extra: true }, osPattern: [], keep: 1 }), etag: `"u-${id}-0"` });
    objects.set(`hist/${id}.json`, { body: '[]', etag: `"h-${id}"` });
    if (config.slices !== false && id !== 'E5') objects.set(`uslice/${id}.json`, { body: JSON.stringify({ id, u: { sp_star, extra: 3 }, keep: true }), etag: `"s-${id}-0"` });
  }
  objects.set('users-list.json', { body: JSON.stringify(ids.map(iidx_id => ({ iidx_id }))), etag: '"list"' });
  objects.set('songs.json', { body: '[]', etag: '"songs"' });
  const client = {
    async read(key) { const value = objects.get(key); return value ? { ...value } : null; },
    async put(key, body, etag) {
      calls.push({ key, body, etag });
      if (conflicts.has(key)) throw new Error(`R2 PUT ${key} HTTP 412`);
      const current = objects.get(key);
      if (!current || current.etag !== etag) throw new Error(`R2 PUT ${key} HTTP 412`);
      const n = Number((current.etag.match(/-(\d+)"$/) || [])[1] || 0) + 1;
      objects.set(key, { body, etag: `"updated-${n}"` });
    },
  };
  const scores = { A1: [111, 1.1], B2: [202, 2], C3: [333, 3], D4: [null, null], E5: [555, 5.5], F6: [null, null] };
  const calculate = async ({ id, data }) => {
    if (id === config.errorId) throw new Error('calculation exploded');
    if (config.capturePrevious) config.capturePrevious.push({ sp_cpi: null, sp_star: null });
    const [sp_cpi, sp_star] = scores[id] || [2, 2];
    return { sp_cpi, sp_star };
  };
  return { objects, calls, client, calculate, arrangeFor: async () => [], mergeScoreHistory: () => {}, expected };
}

async function run(config, extra = []) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'backfill-sp-star-'));
  const data = fixture(config);
  const report = await main(['--out=' + dir, '--concurrency=2', ...extra], data);
  return { ...data, report, dir, sql: await fs.readFile(path.join(dir, 'backfill-sp-star.sql'), 'utf8'), json: await fs.readFile(path.join(dir, 'backfill-sp-star-report.json'), 'utf8') };
}

test('dry writes report and SQL without PUT and classifies all five statuses', async () => {
  const result = await run({});
  assert.equal(result.calls.length, 0);
  assert.deepEqual(result.report.users.map(row => row.status), ['changed', 'unchanged', 'changed', 'new_null', 'changed', 'no_sp']);
  assert.match(result.sql, /BEGIN;[\s\S]*SET LOCAL ohsorry_internal\.official_user_write = '1';[\s\S]*COMMIT;/);
  assert.match(result.sql, /\('A1', 111::integer, 1\.1::numeric\)/);
  assert.equal(JSON.parse(result.json).users.length, 6);
  assert.equal(makeSql([]).includes('UPDATE public.users'), false);
  const noSp = fixture({}); noSp.calculate = async ({ id }) => id === 'A1' ? { sp_cpi: null, sp_star: null } : ({ sp_cpi: 1, sp_star: 1 });
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'backfill-sp-star-empty-'));
  await main(['--out=' + out, '--only=A1'], noSp);
  assert.match(await fs.readFile(path.join(out, 'backfill-sp-star.sql'), 'utf8'), /No users to update/);
});

test('write updates only changed user fields, keeps key order, handles slice and skips unchanged/no_sp', async () => {
  const result = await run({});
  const before = JSON.parse(result.objects.get('user/A1.json').body);
  const originalKeys = ['user', 'osPattern', 'keep'];
  assert.deepEqual(Object.keys(before), originalKeys);
  const written = await run({}, ['--write']);
  assert.deepEqual(written.calls.map(call => call.key), ['user/A1.json', 'uslice/A1.json', 'user/C3.json', 'uslice/C3.json', 'user/E5.json']);
  const after = JSON.parse(written.objects.get('user/A1.json').body);
  assert.deepEqual(Object.keys(after), originalKeys);
  assert.deepEqual(Object.keys(after.user), ['iidx_id', 'dj_name', 'sp_cpi', 'sp_star', 'extra']);
  assert.deepEqual([after.user.sp_cpi, after.user.sp_star, after.user.extra, after.keep], [111, 1.1, true, 1]);
  assert.deepEqual(JSON.parse(written.objects.get('uslice/A1.json').body).u, { sp_star: 1.1, extra: 3 });
  assert.equal(written.report.users.find(row => row.id === 'B2').write, 'skipped');
  assert.equal(written.report.users.find(row => row.id === 'E5').usliceWrite, 'skipped');
  assert.equal(written.sql.includes("'B2'"), false);
});

test('new_null keep skips writes and SQL; clear writes null with SQL casts, and no --write remains dry', async () => {
  const keep = await run({}, ['--write', '--null-policy=keep']);
  assert.equal(keep.calls.some(call => call.key.includes('D4')), false);
  assert.equal(keep.sql.includes("'D4'"), false);
  const clear = await run({}, ['--write', '--null-policy=clear']);
  assert.equal(JSON.parse(clear.objects.get('user/D4.json').body).user.sp_star, null);
  assert.match(clear.sql, /NULL::integer, NULL::numeric/);
  const dryClear = await run({}, ['--null-policy=clear']);
  assert.equal(dryClear.calls.length, 0);
  assert.match(dryClear.sql, /'D4'/);
});

test('412 records conflicts once and continues; calculation errors are reported and set exit code', async () => {
  const data = fixture({ conflicts: ['user/A1.json'] });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'backfill-sp-star-conflict-'));
  const report = await main(['--out=' + dir, '--write'], data);
  assert.equal(report.users[0].write, 'conflicted');
  assert.equal(data.calls.filter(call => call.key === 'user/A1.json').length, 1);
  assert.ok(data.calls.some(call => call.key === 'user/C3.json'));
  const previous = [];
  const err = fixture({ errorId: 'C3', capturePrevious: previous });
  const errorDir = await fs.mkdtemp(path.join(os.tmpdir(), 'backfill-sp-star-error-'));
  process.exitCode = 0;
  const failed = await main(['--out=' + errorDir], err);
  assert.equal(failed.users.find(row => row.id === 'C3').status, 'error');
  assert.match(failed.users.find(row => row.id === 'C3').error, /calculation exploded/);
  assert.equal(failed.summary.error, 1);
  assert.equal(process.exitCode, 1);
  assert.equal(previous.every(user => user.sp_cpi === null && user.sp_star === null), true);
  process.exitCode = 0;
});

test('uslice 412 is reported separately and SQL has transaction wrapper and empty target behavior', async () => {
  const data = fixture({ conflicts: ['uslice/A1.json'] });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'backfill-sp-star-slice-conflict-'));
  const report = await main(['--out=' + dir, '--write'], data);
  assert.equal(report.users[0].write, 'updated');
  assert.equal(report.users[0].usliceWrite, 'conflicted');
  assert.equal(data.calls.filter(call => call.key === 'uslice/A1.json').length, 1);
  const sql = await fs.readFile(path.join(dir, 'backfill-sp-star.sql'), 'utf8');
  assert.ok(sql.startsWith('BEGIN;\nSET LOCAL'));
  assert.ok(sql.endsWith('COMMIT;\n'));
  assert.equal(makeSql([]).includes('UPDATE'), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mergeInto } from '../merge-user-into-list.mjs';

const incoming = (changes = {}) => ({
  iidx_id: 'A', dj_name: 'new name', star: 2, r_star: 3, date: 'new-date',
  dp_feature_nps: { ignored: true }, sp_feature_nps: { ignored: true },
  ...changes,
});

test('preserves both NPS values and applies current star/r_star including null', () => {
  const prior = { iidx_id: 'A', dp_feature_nps: { NOTES: 1 }, sp_feature_nps: { NOTES: 2 }, star: 9 };
  const { list } = mergeInto([prior], incoming({ star: null, r_star: null }));
  assert.deepEqual(list[0].dp_feature_nps, prior.dp_feature_nps);
  assert.deepEqual(list[0].sp_feature_nps, prior.sp_feature_nps);
  assert.equal(list[0].star, null);
  assert.equal(list[0].r_star, null);
});

test('mergeInto passes the latest SP tuple including zero and explicit nulls', () => {
  const tuple = { sp_r_star:0, sp_r_star_model_id:'new-model', sp_r_star_formula_version:'v3' };
  const { list } = mergeInto([{ iidx_id:'A', sp_r_star:9, sp_r_star_model_id:'old', sp_r_star_formula_version:'v1' }], incoming(tuple));
  assert.deepEqual([list[0].sp_r_star, list[0].sp_r_star_model_id, list[0].sp_r_star_formula_version], [0, 'new-model', 'v3']);
  const cleared = mergeInto([{ iidx_id:'A', sp_r_star:9, sp_r_star_model_id:'old', sp_r_star_formula_version:'v1' }], incoming({ sp_r_star:null, sp_r_star_model_id:null, sp_r_star_formula_version:null }));
  assert.deepEqual([cleared.list[0].sp_r_star, cleared.list[0].sp_r_star_model_id, cleared.list[0].sp_r_star_formula_version], [null, null, null]);
});

test('CLI dump to makeEntry path carries SP tuple and ignores incoming NPS', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-sp-tuple-'));
  try {
    fs.writeFileSync(path.join(dir, 'users-list.json'), JSON.stringify([{ iidx_id:'A', dp_feature_nps:{ NOTES:7 }, sp_feature_nps:{ NOTES:8 } }]));
    fs.writeFileSync(path.join(dir, 'incoming.json'), JSON.stringify({ user: {
      iidx_id:'A', dj_name:'A', star:2, r_star:3, date:'now', sp_r_star:0,
      sp_r_star_model_id:'model-2', sp_r_star_formula_version:'v2',
      dp_feature_nps:{ ignored:true }, sp_feature_nps:{ ignored:true },
    }, osPattern:[] }));
    const script = new URL('../merge-user-into-list.mjs', import.meta.url);
    const result = spawnSync(process.execPath, [decodeURIComponent(script.pathname.slice(1)), 'incoming.json', '--no-upload'], { cwd:dir, encoding:'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const row = JSON.parse(fs.readFileSync(path.join(dir, 'users-list.json'), 'utf8'))[0];
    assert.deepEqual([row.sp_r_star, row.sp_r_star_model_id, row.sp_r_star_formula_version], [0, 'model-2', 'v2']);
    assert.deepEqual(row.dp_feature_nps, { NOTES:7 });
    assert.deepEqual(row.sp_feature_nps, { NOTES:8 });
  } finally { fs.rmSync(dir, { recursive:true, force:true }); }
});

test('preserves explicitly present null and initializes only absent NPS fields', () => {
  const { list } = mergeInto([{ iidx_id: 'A', dp_feature_nps: null }], incoming());
  assert.equal(list[0].dp_feature_nps, null);
  assert.equal(list[0].sp_feature_nps, null);
});

test('new rows initialize NPS fields to null and ignore values in incoming dump row', () => {
  const { list, isNew } = mergeInto([], incoming());
  assert.equal(isNew, true);
  assert.equal(list[0].dp_feature_nps, null);
  assert.equal(list[0].sp_feature_nps, null);
});

test('--no-upload uses local files, preserves other rows, and writes the four-key after-based slim list', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-list-'));
  try {
    fs.writeFileSync(path.join(dir, 'users-list.json'), JSON.stringify([
      { iidx_id: 'A', dj_name: 'old', star: 8, r_star: 7, dp_feature_nps: null },
      { iidx_id: 'B', dj_name: 'other', star: 5, r_star: 4, extra: true },
    ]));
    fs.writeFileSync(path.join(dir, 'incoming.json'), JSON.stringify({ user: {
      iidx_id: 'A', dj_name: 'new', star: null, r_star: 1, date: 'now',
    }, osPattern: [] }));
    const script = new URL('../merge-user-into-list.mjs', import.meta.url);
    const result = spawnSync(process.execPath, [decodeURIComponent(script.pathname.slice(1)), 'incoming.json', '--no-upload'], {
      cwd: dir, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const list = JSON.parse(fs.readFileSync(path.join(dir, 'users-list.json'), 'utf8'));
    assert.equal(list.length, 2);
    assert.equal(list[0].star, null);
    assert.equal(list[0].dp_feature_nps, null);
    assert.equal(list[0].sp_feature_nps, null);
    assert.deepEqual(list[1], { iidx_id: 'B', dj_name: 'other', star: 5, r_star: 4, extra: true });
    const slim = JSON.parse(fs.readFileSync(path.join(dir, 'users-list-slim.json'), 'utf8'));
    assert.deepEqual(Object.keys(slim[0]), ['iidx_id', 'dj_name', 'star', 'r_star']);
    assert.equal(slim[0].star, null);
    assert.equal(slim[1].iidx_id, 'B');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

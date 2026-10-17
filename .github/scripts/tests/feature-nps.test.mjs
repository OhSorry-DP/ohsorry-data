import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFeatureNps, projectFeatureNps, NPS_FEATS } from '../feature-nps.mjs';

const axes = (unit = 'notes/s/hand') => Object.fromEntries(NPS_FEATS.map((feat, i) => [feat, { line: i, unit }]));
function record(id = 'U', style = 'DP', changes = {}) {
  const sp = style === 'SP';
  return { schema_version: 'coach-skill-evidence/1', iidx_id: id, play_style: style,
    absolute: { status: 'ready', stale: false, model_version: sp ? 'phys-line-sp-v1' : 'phys-line-v2',
      line_version: sp ? 'phys-line-sp-v1' : 'phys-line-v2', mean_version: sp ? 'mean-os-pattern-span-sp-v1' : 'mean-os-pattern-span-v2',
      axes: axes(sp ? 'notes/s/side' : 'notes/s/hand'), ...changes } };
}

test('DP returns exactly nine features and excludes SOF-LAN/other axes', () => {
  const projected = projectFeatureNps(record('U', 'DP', { axes: { ...axes(), SOF_LAN: { line: 999, unit: 'notes/s/hand' } } }), 'U', 'DP');
  assert.deepEqual(Object.keys(projected), NPS_FEATS);
  assert.equal(projected.RAND, 8);
  assert.equal('SOF_LAN' in projected, false);
});

test('SP is validated and projected independently', () => {
  assert.equal(projectFeatureNps(record('U', 'SP'), 'U', 'SP').NOTES, 0);
  assert.equal(projectFeatureNps(record('U', 'SP'), 'U', 'DP'), null);
});

test('zero is valid and invalid axes become null', () => {
  const r = record('U', 'DP');
  r.absolute.axes.NOTES.line = 0;
  r.absolute.axes.CHORD.line = '2';
  r.absolute.axes.PEAK.line = Infinity;
  r.absolute.axes.CHARGE.unit = 'wrong';
  const p = projectFeatureNps(r, 'U', 'DP');
  assert.equal(p.NOTES, 0);
  for (const feat of ['CHORD', 'PEAK', 'CHARGE']) assert.equal(p[feat], null);
});

test('rejects mismatched IDs, versions, and stale evidence', () => {
  assert.equal(projectFeatureNps(record('OTHER'), 'U', 'DP'), null);
  const wrongVersion = record(); wrongVersion.absolute.model_version = 'wrong';
  const stale = record(); stale.absolute.stale = true;
  assert.equal(projectFeatureNps(wrongVersion, 'U', 'DP'), null);
  assert.equal(projectFeatureNps(stale, 'U', 'DP'), null);
});

test('404 null is preserved and DP/SP reads are sequential', async () => {
  const calls = [];
  let active = 0, maxActive = 0;
  const result = await loadFeatureNps('A /', { getText: async key => {
    calls.push(key); active++; maxActive = Math.max(active, maxActive);
    await Promise.resolve(); active--;
    return calls.length === 1 ? JSON.stringify(record('A /')) : null;
  } });
  assert.deepEqual(calls, ['phys/user/A%20%2F.json', 'phys/user-sp/A%20%2F.json']);
  assert.equal(maxActive, 1);
  assert.equal(result.DP.NOTES, 0);
  assert.equal(result.SP, null);
});

test('transport and JSON errors propagate', async () => {
  await assert.rejects(loadFeatureNps('U', { getText: async () => { throw new Error('network'); } }), /network/);
  let n = 0;
  await assert.rejects(loadFeatureNps('U', { getText: async () => ++n === 1 ? '{' : null }), SyntaxError);
});

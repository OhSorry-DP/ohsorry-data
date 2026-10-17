import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichUsersWithFeatureNps } from '../dump-users-list.mjs';

const feats = ['NOTES','CHORD','PEAK','CHARGE','SCRATCH','PHRASE','JACK','TRILL','RAND'];
const nps = value => Object.fromEntries(feats.map((feat, i) => [feat, i === 0 ? value : null]));

test('enriches both NPS styles while preserving fields and input', async () => {
  const rows = [
    { iidx_id:'a', dj_name:'A', star:10, r_star:8, dp_rank:1, sp_star:4, os_pattern_score:{ NOTES:2 }, existing:'keep' },
    { iidx_id:'b', dj_name:'B', star:5, r_star:3, dp_rank:2, sp_star:2, os_pattern_score:null },
    { iidx_id:'deleted', star:null, r_star:null, dp_rank:null, sp_star:null },
  ];
  const original = structuredClone(rows);
  const enriched = await enrichUsersWithFeatureNps(rows, async id => id === 'deleted' ? { DP:null, SP:null } : { DP:nps(id === 'a' ? 10 : 0), SP:nps(2) });
  assert.deepEqual(rows, original);
  assert.equal(enriched.length, 3);
  assert.deepEqual(enriched.map(row => row.iidx_id), rows.map(row => row.iidx_id));
  assert.deepEqual(Object.keys(enriched.find(row => row.iidx_id === 'a').dp_feature_nps), feats);
  assert.equal(enriched.find(row => row.iidx_id === 'a').existing, 'keep');
  const priorKeys = Object.keys(rows[0]);
  const actualKeys = Object.keys(enriched[0]);
  assert.deepEqual(actualKeys.slice().sort(), [...priorKeys, 'dp_feature_nps', 'sp_feature_nps'].sort());
  assert.ok(actualKeys.every(key => !key.includes('percentile') && key !== 'dp_feature_nps_mean' && key !== 'dp_composite_percentile'));
  assert.equal(enriched.find(row => row.iidx_id === 'a').sp_feature_nps.NOTES, 2);
});

test('fails the whole enrichment on one request error', async () => {
  await assert.rejects(enrichUsersWithFeatureNps([{iidx_id:'ok'}, {iidx_id:'bad'}], async id => {
    if (id === 'bad') throw new Error('request failed');
    return { DP:null, SP:null };
  }), /request failed/);
});

test('runs at most four loads concurrently and preserves order', async () => {
  const rows = Array.from({length:12}, (_, i) => ({iidx_id:String(i)}));
  let active = 0, maximum = 0;
  const out = await enrichUsersWithFeatureNps(rows, async id => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 3));
    active--;
    return { DP:null, SP:null, marker:id };
  });
  assert.ok(maximum > 1);
  assert.ok(maximum <= 4);
  assert.deepEqual(out.map(row => row.iidx_id), rows.map(row => row.iidx_id));
  assert.deepEqual(rows.map(row => Object.keys(row)), Array(12).fill(['iidx_id']));
});

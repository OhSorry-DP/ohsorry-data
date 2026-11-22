import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { updateSinglePersona, personaFields } from '../r2-repersona.mjs';
process.env.CLOUDFLARE_API_TOKEN = 'test';
const { conditionalR2Client, md5 } = await import('../r2-client.mjs');
import * as engine from '../persona-lib.mjs';

const original = () => ({ _v: '2026-10-09T00:00:00.000Z', user: { iidx_id: '123' },
  dp: [{ song_id: 1, ex_score: 10 }], sp: [], persona: { old: 'dp' }, spPersona: { old: 'sp' }, reachNps: { old: true }, spReachNps: { old: 'sp-nps' } });

test('single persona uses If-Match and recomputes fresh data once; second contention abandons PUT', async () => {
  for (const conflicts of [1, 2]) {
    let data = original(), etag = '"initial"', puts = 0, reads = 0;
    const calculated = [];
    const client = conditionalR2Client({ account: 'account', token: 'token', fetchImpl: async (url, init) => {
      if (init.method === 'GET' && url.endsWith('/user/123.json')) {
        reads++;
        return new Response(JSON.stringify(data), { headers: { etag } });
      }
      if (init.method === 'PUT') {
        assert.equal(init.headers['If-Match'], etag);
        puts++;
        if (puts <= conflicts) {
          data = { ...original(), dp: [{ song_id: 1, ex_score: 99 }], _v: 'new dump' };
          etag = '"new-dump"';
          return new Response('', { status: 412 });
        }
        data = JSON.parse(init.body); etag = `"${md5(init.body)}"`;
        return new Response('');
      }
      return Response.json({ result: [{ key: 'user/123.json', etag: etag.replaceAll('"', '') }], result_info: {} });
    } });
    const result = await updateSinglePersona('123', { client, calculate: async current => {
      calculated.push(current.dp[0].ex_score);
      return { persona: { score: current.dp[0].ex_score }, spPersona: { fresh: true } };
    } });
    assert.deepEqual(calculated, [10, 99]); assert.equal(puts, 2); assert.equal(reads, 2);
    assert.deepEqual(result, conflicts === 1 ? { updated: true } : { conflicted: true });
    assert.equal(data.dp[0].ex_score, 99); assert.equal(data._v, 'new dump');
    assert.deepEqual(data.reachNps, { old: true });
    assert.deepEqual(data.persona, conflicts === 1 ? { score: 99 } : { old: 'dp' });
  }
});

test('deferred dump preserves both previous personas and fails closed on unreadable previous dump', async t => {
  process.env.SUPABASE_URL = 'https://supabase.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
  process.env.CLOUDFLARE_API_TOKEN = 'test';
  const { dumpUser } = await import('../dump-user.mjs');
  const saved = globalThis.fetch; t.after(() => { globalThis.fetch = saved; });
  let unavailable = false;
  const r2 = { read: async () => ({ body: unavailable ? '{invalid' : JSON.stringify(original()) }) };
  globalThis.fetch = async url => {
    if (url.includes('/objects/user/')) return new Response(unavailable ? '{invalid' : JSON.stringify(original()));
    if (url.includes('chart_arrange')) return Response.json([], { headers: { 'content-range': '*/0' } });
    if (url.includes('/rest/v1/users?')) return Response.json([{ iidx_id: '123' }]);
    return Response.json([]);
  };
  const data = await dumpUser('123', { textageMeta: { songs: {} } }, { deferPersona: true, r2 });
  assert.deepEqual(data.persona, { old: 'dp' }); assert.deepEqual(data.spPersona, { old: 'sp' });
  assert.deepEqual(data.spReachNps, { old: 'sp-nps' });
  unavailable = true;
  await assert.rejects(dumpUser('123', { textageMeta: { songs: {} } }, { deferPersona: true, r2 }));
  let puts = 0;
  assert.deepEqual(await updateSinglePersona('123', { client: { read: async () => ({ body: JSON.stringify(original()), etag: '"x"' }),
    put: async () => { puts++; } }, calculate: async () => ({ persona: null, spPersona: null }) }), { unchanged: true });
  assert.equal(puts, 0);
});

test('single mode SP matches direct dump SP engine with identical grid input', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ song_id: i + 1, title: `song${i}`, textage_song_id: `tx${i}`, diff: 3, ex_score: 100, lamp: 5, bp: i }));
  const R = { textageMeta: { songs: Object.fromEntries(rows.map(r => [r.textage_song_id, { notes: { SA: 100 }, levels: { SA: 12 } }])) },
    norm: s => s, spKeymaps: { noteByKey: new Map(), scoresByKey: new Map(), bpmByNorm: new Map(), offByKey: new Map() },
    personaLib: { richReportOf: (profile, lang = 'ko') => ({ head: lang, report: JSON.stringify(profile), persona: { oneLiner: 'summary', prose: 'prose', tags: [], rel: { NOTES: 1 } } }) } };
  for (const r of rows) { R.spKeymaps.noteByKey.set(`${r.title}|ANOTHER`, 100); R.spKeymaps.scoresByKey.set(`${r.title}|ANOTHER`, { SARA_RHYTHM: {}, KEY_RHYTHM: {} }); }
  const expected = engine.spPersonaFor(engine.spChartsFromGridRows(rows, R.textageMeta), R);
  const actual = personaFields({ dp: [], sp: rows.map(({ title, textage_song_id, ...row }) => row) }, R, new Map(rows.map(r => [r.song_id, r])), [], engine).spPersona;
  assert.ok(expected); assert.ok(actual);
  delete expected._v; delete actual._v;
  assert.deepEqual(actual, expected);
});

test('workflow uses per-user cancellation in every mode and keeps 33/34 uploads in that user group', () => {
  const workflow = fs.readFileSync(new URL('../../workflows/dump-user.yml', import.meta.url), 'utf8');
  const concurrency = workflow.match(/^concurrency:\r?\n((?:[ \t]+[^\r\n]*\r?\n)+)/m)?.[1];
  assert.ok(concurrency, 'workflow-level concurrency block exists');
  const groupTemplate = concurrency.match(/^  group: (.+)$/m)?.[1];
  assert.equal(groupTemplate, 'dump-${{ github.event.client_payload.iidx_id }}');
  assert.match(concurrency, /^  cancel-in-progress: true$/m);
  assert.doesNotMatch(concurrency, /SCORE_BUFFER_PREPARE/);
  assert.match(workflow, /^  dump:\r?\n[\s\S]*?^    env:\r?\n(?:[ \t]+[^\r\n]*\r?\n)*?      SCORE_BUFFER_PREPARE: \$\{\{ vars\.SCORE_BUFFER_PREPARE \|\| '0' \}\}$/m);
  for (const mode of ['', '0', '1']) {
    assert.equal(groupTemplate.replace('${{ github.event.client_payload.iidx_id }}', '12345678'), 'dump-12345678', `mode ${mode}`);
    assert.match(concurrency, /^  cancel-in-progress: true$/m, `mode ${mode}`);
  }
  const groupFor = ({ iidx_id }) => groupTemplate.replace('${{ github.event.client_payload.iidx_id }}', iidx_id);
  const a33 = groupFor({ iidx_id: '12345678', played_version: 33 });
  const a34 = groupFor({ iidx_id: '12345678', played_version: 34 });
  const b33 = groupFor({ iidx_id: '87654321', played_version: 33 });
  assert.equal(a33, a34);
  assert.notEqual(a33, b33);
  assert.equal(new Set([a33, a34, b33]).size, 2);
  assert.doesNotMatch(workflow, /played_version[^\n]*(?:reject|deny|dispatch)/i);
});

test('deferred SP NPS failures and RPC failures preserve prior value; successful RPC stays on existing path without DP work', async t => {
  process.env.SUPABASE_URL = 'https://supabase.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
  const { dumpUser } = await import('../dump-user.mjs');
  const saved = globalThis.fetch; t.after(() => { globalThis.fetch = saved; });
  const prior = { old: 'sp-nps' };
  const r2 = { read: async () => ({ body: JSON.stringify({ ...original(), spReachNps: prior }) }) };
  let rpcFails = false, scoreRows = [], calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push(String(url));
    if (String(url).includes('/objects/user/')) return Response.json({ ...original(), spReachNps: prior });
    if (String(url).includes('/rest/v1/users?')) return Response.json([{ iidx_id: '123' }]);
    if (String(url).includes('/rest/v1/rpc/make_grid_data')) {
      const body = JSON.parse(init.body);
      if (body.p_play_style === 1) return Response.json([{ song_id: 11, ex_score: 50, lamp: 5, diff: 3 }]);
      if (rpcFails) return new Response('failed', { status: 500 });
      return Response.json(scoreRows);
    }
    if (String(url).includes('chart_arrange')) return Response.json([], { headers: { 'content-range': '*/0' } });
    return Response.json([]);
  };
  const R = { textageMeta: { songs: {} }, spNpsSchemaVersion: 1, spNpsScores: {},
    reachNpsLib: () => { throw new Error('unexpected engine call'); } };
  rpcFails = true;
  const rpcFailure = await dumpUser('123', R, { deferPersona: true, r2 });
  assert.deepEqual(rpcFailure.spReachNps, prior);
  assert.equal(calls.some(url => url.includes('make_grid_data')), true);

  calls = []; rpcFails = false; scoreRows = [{ song_id: 7, title: 'missing', textage_song_id: 'absent', diff: 3, ex_score: 50, lamp: 5 }];
  const calcFailure = await dumpUser('123', R, { deferPersona: true, r2 });
  assert.deepEqual(calcFailure.spReachNps, prior);
  assert.equal(calls.filter(url => url.includes('make_grid_data')).length, 2);

  calls = []; scoreRows = [];
  const noPlays = await dumpUser('123', R, { deferPersona: true, r2 });
  assert.deepEqual(noPlays.spReachNps, prior);
  assert.equal(calls.filter(url => url.includes('make_grid_data')).length, 2);
});

test('workflow keeps early upload, Node guard and dump-persona-coach order', () => {
  const workflow = fs.readFileSync(new URL('../../workflows/dump-user.yml', import.meta.url), 'utf8');
  const dump = workflow.slice(workflow.indexOf('  dump:'), workflow.indexOf('  persona:'));
  assert.ok(dump.indexOf('Upload to R2') < dump.indexOf('merge-user-into-list.mjs'));
  assert.ok(dump.indexOf('Upload to R2') < dump.indexOf('refresh-missing-songs.mjs'));
  assert.ok(dump.indexOf('Upload to R2') < dump.indexOf('user-slice.mjs'));
  assert.doesNotMatch(dump, /setup-node|git (?:add|commit|push)/);
  assert.match(dump, /node --version[\s\S]*< 20/);
  assert.match(workflow, /persona:\s+needs: dump/);
  assert.match(workflow, /dispatch-coach-user:\s+needs: \[dump, persona\]/);
  assert.match(workflow, /r2-repersona.mjs --single="\$IIDX_ID"/);
});

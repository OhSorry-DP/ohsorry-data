import assert from 'node:assert/strict';
import test from 'node:test';
import { runRefresh } from '../refresh-coach-user.mjs';

const ID = 'USER1';
const V = '2026-10-05T00:00:00.000Z';
const SP = { SP_PHYS_Q_VERSION: 'q-samehand-2s-v1', SP_PHYS_TIME_AXIS_VERSION: 'ta-20261004', SP_PHYS_ASSETS_MANIFEST_KEY: 'phys-sp-manifest.json' };

function fixture({ sp = [{ song_id: 1, diff: 1, lamp: 7 }], race = false, spFail = false } = {}) {
  const dump = { _v: V, user: { iidx_id: ID }, dp: [], sp };
  const state = { source: JSON.stringify(dump), race };
  const calls = [], objects = new Map();
  const io = {
    async read(key) {
      calls.push(['GET', key]);
      if (key === `user/${ID}.json`) {
        if (state.race) { state.race = false; state.source = JSON.stringify({ ...dump, _v: '2026-10-05T00:00:01.000Z' }); }
        return { body: state.source, etag: 'source-etag' };
      }
      return objects.get(key) ?? null;
    },
    async getText(key) {
      calls.push(['GETTEXT', key]);
      if (key === 'dp-manifest.json' || key === SP.SP_PHYS_ASSETS_MANIFEST_KEY) return JSON.stringify({ publishable: true });
      if (key === 'songs.json') return JSON.stringify({ '1': 'song-one' });
      return '{}';
    },
    async put(key, body, etag) {
      calls.push(['PUT', key, body, etag]);
      objects.set(key, { body, etag: 'written' });
    },
  };
  const inputs = [];
  const versions = { PHYS_MODEL_VERSION: 'phys-line-v2', PHYS_Q_VERSION: 'q-samehand-2s-v1', PHYS_TIME_AXIS_VERSION: 'ta-20261004', PHYS_ASSETS_MANIFEST_KEY: 'dp-manifest.json', ...SP };
  const deps = { io, env: versions,
    loadPhysAssets: async () => { if (spFail) throw new Error('SP fixture failure'); return { status: 'ready', model: { content_hash: 'm' }, charts: new Map() }; },
    producePhysUser: async input => {
      inputs.push(input);
      if (input.playStyle === 'SP' && spFail) throw new Error('SP fixture failure');
      const key = input.playStyle === 'SP' ? `phys/user-sp/${ID}.json` : `phys/user/${ID}.json`;
      await input.io.put(key, JSON.stringify({ play_style: input.playStyle }), null);
      return { status: 'ready', changed: true, source_revision: input.playStyle };
    } };
  return { deps, calls, inputs, state };
}

test('sp-phys-refresh/1 — both=각단계/key', async () => {
  const f = fixture();
  const result = await runRefresh({ id: ID, expectedV: V }, f.deps);
  assert.equal(result.phys.status, 'ready');
  assert.equal(result.phys_sp.status, 'ready');
  assert.deepEqual(f.calls.filter(x => x[0] === 'PUT').map(x => x[1]), [`phys/user/${ID}.json`, `phys/user-sp/${ID}.json`]);
  assert.deepEqual(f.inputs.map(x => x.playStyle || 'DP'), ['DP', 'SP']);
  assert.equal(f.inputs[1].versions.model_version, 'phys-line-sp-v1');
});

test('sp-phys-refresh/2 — unset=SPskip', async () => {
  const f = fixture();
  delete f.deps.env.SP_PHYS_Q_VERSION;
  delete f.deps.env.SP_PHYS_TIME_AXIS_VERSION;
  delete f.deps.env.SP_PHYS_ASSETS_MANIFEST_KEY;
  const result = await runRefresh({ id: ID, expectedV: V }, f.deps);
  assert.equal(result.phys_sp.status, 'skipped');
  assert.equal(f.inputs.some(x => x.playStyle === 'SP'), false);
});

test('sp-phys-refresh/3 — failure=DPready/false', async () => {
  const f = fixture({ spFail: true });
  const result = await runRefresh({ id: ID, expectedV: V }, f.deps);
  assert.equal(result.phys.status, 'ready');
  assert.equal(result.phys_sp.status, 'failed');
  assert.equal(result.ok, false);
});

test('sp-phys-refresh/4 — source-race=SPPUT차단', async () => {
  const f = fixture();
  let spStarted = false;
  let raced = false;
  const readSource = f.deps.io.read.bind(f.deps.io);
  f.deps.io.read = async key => {
    if (key === `user/${ID}.json` && spStarted && !raced) {
      f.state.source = JSON.stringify({ _v: '2026-10-05T00:00:01.000Z', user: { iidx_id: ID }, dp: [], sp: [] });
      raced = true;
    }
    return readSource(key);
  };
  const producer = f.deps.producePhysUser;
  f.deps.producePhysUser = async input => {
    if (input.playStyle === 'SP') {
      spStarted = true;
      const put = input.io.put;
      input.io.put = async (...args) => { const result = await put(...args); return result; };
      f.state.source = JSON.stringify({ _v: '2026-10-05T00:00:01.000Z', user: { iidx_id: ID }, dp: [], sp: [] });
    }
    return producer(input);
  };
  const result = await runRefresh({ id: ID, expectedV: V }, f.deps);
  assert.equal(result.ok, false);
  assert.equal(f.calls.some(x => x[0] === 'PUT' && x[1] === `phys/user-sp/${ID}.json`), false);
});

test('sp-phys-refresh/5 — preserved=보존SP계산', async () => {
  const previous = fixture({ sp: [{ song_id: 5, diff: 2, lamp: 6 }] });
  const preserved = JSON.parse(previous.state.source);
  previous.state.source = JSON.stringify({ ...preserved, sp: [{ song_id: 5, diff: 2, lamp: 6 }] });
  const result = await runRefresh({ id: ID, expectedV: V }, previous.deps);
  assert.equal(result.phys_sp.status, 'ready');
  assert.deepEqual(previous.inputs.find(x => x.playStyle === 'SP').dump.sp, [{ song_id: 5, diff: 2, lamp: 6 }]);
});

test('sp-phys-refresh/6 — forbidden=다른ID/phase거부', async () => {
  const f = fixture();
  f.deps.producePhysUser = async ({ playStyle, io }) => {
    await io.put(playStyle === 'DP' ? `phys/user-sp/${ID}.json` : 'phys/user-sp/OTHER.json', '{}', null);
    return { status: 'ready', changed: true };
  };
  const result = await runRefresh({ id: ID, expectedV: V }, f.deps);
  assert.equal(result.phys.status, 'failed');
  assert.equal(result.phys_sp.status, 'failed');
  assert.equal(f.calls.some(x => x[0] === 'PUT'), false);
});

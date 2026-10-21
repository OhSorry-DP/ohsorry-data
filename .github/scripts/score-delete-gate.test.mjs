import test from 'node:test';
import assert from 'node:assert/strict';
import { runScoreDeleteGate } from './score-delete-gate.mjs';
import { sha256Hex } from './score-buffer.mjs';

const histText = '[[1000,3,4,1234,33,"2026-10-22T01:02:03.123456+00:00","2026-10-22",1,null,1500]]';
const histBytes = Buffer.from(histText, 'utf8');
const snapshotKey = 'snapshot/daily/2026-10-22.tar.gz';
const tarSha256 = 'a'.repeat(64);
const candidateBytes = (scoreIds = [101]) => Buffer.from(JSON.stringify({
  score_ids: scoreIds, hist: { key: 'hist/Ab12.json', sha256: sha256Hex(histBytes) },
}), 'utf8');
const base = (overrides = {}) => ({ iidxId: 'Ab12', candidateBytes: candidateBytes(), histBytes,
  snapshotKey, tarSha256, ...overrides });
const lock = (overrides = {}) => ({ iidxId: 'Ab12', snapshotKey, tarSha256,
  scope: 'all-hist-writers', assertHeld: async () => {}, ...overrides });

test('기본 꺼짐은 계획만 반환하고 어댑터와 잠금을 호출하지 않는다', async () => {
  let calls = 0;
  const out = await runScoreDeleteGate(base({ deleteScoreIds: async () => { calls++; } }));
  assert.deepEqual(out, { status: 'prepared', scoreIds: [101], batches: [[101]], deleted: 0, reason: null });
  assert.equal(calls, 0);
});

test('후보 스키마, hist 해시와 snapshot 식별자를 검증한다', async () => {
  for (const args of [
    base({ candidateBytes: Buffer.from(JSON.stringify({ score_ids: [101, 101], hist: { key: 'hist/Ab12.json', sha256: 'a'.repeat(64) } })) }),
    base({ candidateBytes: Buffer.from(JSON.stringify({ score_ids: [101], hist: { key: 'hist/Else.json', sha256: 'a'.repeat(64) } })) }),
    base({ histBytes: Buffer.from('[]') }),
    base({ snapshotKey: 'snapshot/../daily/2026-10-22.tar.gz' }),
    base({ snapshotKey: 'snapshot/daily/not-a-date.tar.gz' }),
    base({ tarSha256: 'bad' }),
  ]) await assert.rejects(runScoreDeleteGate(args));
});

test('실행 시 일치하는 잠금 capability가 없거나 assertHeld가 실패하면 차단한다', async () => {
  let calls = 0;
  const del = async () => { calls++; return { deleted: 1 }; };
  for (const serialization of [null, true, lock({ scope: 'hist-only' }), lock({ snapshotKey: 'snapshot/daily/2026-10-21.tar.gz' }),
    lock({ assertHeld: async () => { throw new Error('lock lost'); } })]) {
    const out = await runScoreDeleteGate(base({ execute: true, serialization, deleteScoreIds: del }));
    assert.equal(out.status, 'blocked');
  }
  assert.equal(calls, 0);
});

test('401개 ID를 200/200/1로 전달하고 정상 삭제 및 0건 재실행을 허용한다', async () => {
  const ids = Array.from({ length: 401 }, (_, i) => i + 1);
  const received = [];
  const out = await runScoreDeleteGate(base({ candidateBytes: candidateBytes(ids), execute: true, serialization: lock(),
    deleteScoreIds: async (id, batch) => { assert.equal(id, 'Ab12'); received.push(batch); return { deleted: batch.length }; } }));
  assert.deepEqual(out.batches.map((batch) => batch.length), [200, 200, 1]);
  assert.deepEqual(received, out.batches);
  assert.deepEqual(received.flat(), ids);
  assert.equal(out.deleted, 401);
  const again = await runScoreDeleteGate(base({ execute: true, serialization: lock(), deleteScoreIds: async () => ({ deleted: 0 }) }));
  assert.equal(again.status, 'deleted');
  assert.equal(again.deleted, 0);
});

test('두 번째 배치 실패 또는 잘못된 deleted 반환은 뒤 배치를 중단하고 부분 결과를 반환한다', async () => {
  const ids = Array.from({ length: 401 }, (_, i) => i + 1);
  let calls = 0;
  const out = await runScoreDeleteGate(base({ candidateBytes: candidateBytes(ids), execute: true, serialization: lock(),
    deleteScoreIds: async (_id, batch) => { calls++; if (calls === 2) throw new Error('adapter outage'); return { deleted: batch.length }; } }));
  assert.equal(calls, 2);
  assert.equal(out.status, 'partial');
  assert.equal(out.deleted, 200);
  assert.match(out.reason, /adapter outage/);
  const invalid = await runScoreDeleteGate(base({ execute: true, serialization: lock(), deleteScoreIds: async () => ({ deleted: 2 }) }));
  assert.equal(invalid.status, 'partial');
  assert.equal(invalid.deleted, 0);
  assert.match(invalid.reason, /invalid deleted count/);
});

test('잠금은 시작, 각 배치 전, 종료에 확인한다', async () => {
  let checks = 0, deletes = 0;
  const out = await runScoreDeleteGate(base({ candidateBytes: candidateBytes([1, 2, 3]), execute: true,
    serialization: lock({ assertHeld: async () => { checks++; } }),
    deleteScoreIds: async (_id, batch) => { deletes++; return { deleted: batch.length }; } }));
  assert.equal(out.status, 'deleted');
  assert.equal(checks, 3);
  assert.equal(deletes, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, selectIds, runCoachOnly } from '../r2-repersona.mjs';

test('coach-only 옵션은 유효 concurrency·dry·web-root 입력을 보존', () => {
  const options = parseArgs(['--coach-only', '--web-root=../web', '--concurrency=4', '--dry']);
  assert.equal(options.coachOnly, true);
  assert.equal(options.concurrency, 4);
  assert.equal(options.dry, true);
  assert.equal(options.webRoot.endsWith('web'), true);
  assert.throws(() => parseArgs(['--concurrency=0']));
});

test('R2 users-list 유효 ID 정렬·중복 제거 후 only와 limit 적용', () => {
  assert.deepEqual(selectIds([{ iidx_id: 'Z9' }, { iidx_id: 'bad-id' }, { iidx_id: 'A1' }, { iidx_id: 'Z9' }],
    { only: new Set(['Z9', 'A1']), limit: 1 }), ['A1']);
});

test('coach-only는 producer main 1회 위임하고 dry 및 결과 집계를 보존', async () => {
  let argsSeen;
  const producerMain = async args => {
    argsSeen = args;
    return [{ id: 'A1', ok: true, engine_sha256: 'fixture-hash', generation: 'g', puts: 0, cells: Array(32), wall_ms: 8, cpu_ms: 3 }];
  };
  const result = await runCoachOnly({ ids: ['A1'], options: parseArgs(['--coach-only', '--web-root=../web', '--dry']), producerMain });
  assert.deepEqual(argsSeen.slice(-1), ['--dry']);
  assert.ok(argsSeen.includes('--only') && argsSeen.includes('A1'));
  assert.deepEqual(result[0].cells, Array(32));
  assert.equal(result[0].puts, 0);
});

test('빈 선택은 producer 호출 없이 성공 종료', async () => {
  assert.deepEqual(await runCoachOnly({ ids: [], options: parseArgs([]), producerMain() { assert.fail('호출 금지'); } }), []);
});

test('실패는 결과에 유지되고 비정상 종료 상태로 집계', async () => {
  const previous = process.exitCode;
  process.exitCode = 0;
  try {
    const results = await runCoachOnly({ ids: ['A1'], options: parseArgs([]), producerMain: async () => {
      return [{ id: 'A1', ok: false, reason: 'engine_mismatch', engine_sha256: 'fixture-hash', puts: 0, cpu_ms: 1 }];
    } });
    assert.equal(results[0].reason, 'engine_mismatch');
    assert.equal(process.exitCode, 1);
  } finally { process.exitCode = previous; }
});

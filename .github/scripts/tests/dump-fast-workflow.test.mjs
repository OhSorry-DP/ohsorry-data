import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(new URL('../../workflows/dump-user.yml', import.meta.url), 'utf8');
const captureAt = workflow.indexOf('- name: Capture fast dump generation');
const dumpAt = workflow.indexOf('- name: Dump user from supabase');
const uploadAt = workflow.indexOf('- name: Upload to R2 (data.iidx.in)');
const markerAt = workflow.indexOf('- name: Publish pending completion marker');
const capture = workflow.slice(captureAt, dumpAt);
const upload = workflow.slice(uploadAt, markerAt);
const markerEnd = workflow.indexOf('\n      - name:', markerAt + 1);
const marker = workflow.slice(markerAt, markerEnd);

test('게이트 OFF는 기존 업로드 분기를 타고 원래 curl 업로드 trace를 유지한다', () => {
  assert.match(workflow, /FAST_DUMP_LIGHT_GUARD: \$\{\{ vars\.FAST_DUMP_LIGHT_GUARD \|\| '0' \}\}/);
  assert.match(upload, /if \[ "\$FAST_DUMP_LIGHT_GUARD" = "1" \]/);
  assert.match(upload, /put "user\/\$IIDX_ID\.json"[\s\S]*?put "hist\/\$IIDX_ID\.json"/);
  assert.match(upload, /--data-binary "@\$1" "\$R2_URL\/\$1"/);
  assert.equal(captureAt < 0, false);
});

test('pending generation/since를 캡처한 뒤 dump-user 점수 입력을 읽는다', () => {
  assert.ok(captureAt >= 0 && captureAt < dumpAt);
  assert.match(capture, /retries: 0/);
  assert.match(capture, /marker\.generation/);
  assert.match(capture, /FAST_DUMP_GENERATION=.*FAST_DUMP_SINCE=/);
});

test('S3 업로드 분기는 origin GET ETag로 CAS하고 L1 Actions merge를 사용한다', () => {
  assert.ok(dumpAt < uploadAt);
  assert.match(upload, /mergeActionsUser\(JSON\.parse\(await originResponse\.text\(\)\), local, process\.env\.FAST_DUMP_GENERATION \|\| null\)/);
  assert.match(upload, /'If-Match': etag/);
  assert.match(upload, /attempt <= 3/);
  assert.match(upload, /s3R2Client\(\{ retries: 0 \}\)/);
  assert.match(upload, /R2_ACCESS_KEY_ID/);
  assert.match(upload, /const key = `user\/\$\{id\}\.json`/);
  assert.doesNotMatch(upload, /FAST_DUMP_USER_KEY/);
  const loopGet = upload.indexOf("r2.request(key, { method: 'GET' })");
  const missing = upload.indexOf('originResponse.status === 404');
  const createPut = upload.indexOf("'If-None-Match': '*'", missing);
  const createConflict = upload.indexOf('response.status === 412', createPut);
  const retryContinue = upload.indexOf('continue;', createConflict);
  const updatePut = upload.indexOf("'If-Match': etag", createConflict);
  assert.ok(loopGet < missing && missing < createPut && createPut < createConflict
    && createConflict < retryContinue && retryContinue < updatePut);
  assert.match(upload.slice(missing, createConflict), /fastGeneration: process\.env\.FAST_DUMP_GENERATION/);
});

test('Edge 선행 또는 Actions 선행의 양 순서에서 captured generation merge가 동일 적용된다', async () => {
  const { mergeActionsUser, mergeEdgeUser } = await import('../dump-fast-publish.mjs');
  const initial = { _v: 'old', dp: [0], sp: [0], dpRecent: [], spRecent: [], persona: 'keep', unknown: 7 };
  const local = { _v: 'new', dp: [2], sp: [2], dpRecent: [2], spRecent: [2] };
  const edgePatch = { dp: [3], sp: [3], dpRecent: [3], spRecent: [3], fastGeneration: '3' };
  const actionsFirst = mergeActionsUser(initial, local, '2');
  const edgeAfter = mergeEdgeUser(actionsFirst, edgePatch, '3');
  assert.equal(edgeAfter.ok, true);
  const edgeFirst = mergeEdgeUser(initial, edgePatch, '3');
  const actionsAfter = mergeActionsUser(edgeFirst.value, local, '2');
  assert.deepEqual(actionsAfter.dp, [3]);
  assert.equal(actionsAfter.fastGeneration, '3');
  assert.equal(actionsAfter.persona, 'keep');
  assert.equal(actionsAfter.unknown, 7);
});

test('캡처 G보다 높은 현재 G는 Actions 완료 표식을 억제한다', () => {
  assert.match(marker, /marker\.generation !== process\.env\.FAST_DUMP_GENERATION/);
  assert.match(marker, /marker\.since !== process\.env\.FAST_DUMP_SINCE/);
  assert.match(marker, /완료 표식 생략/);
  assert.match(marker, /'If-Match': etag/);
});

test('CAS/key 실패는 성공 출력이나 폴백 없이 멈추고 hist 게시 성공만 완료 단계로 간다', () => {
  assert.match(upload, /R2 S3 key 미설정/);
  assert.match(upload, /R2 user CAS HTTP/);
  assert.match(upload, /hist 파일 없음 — 보호 게시 실패/);
  assert.match(upload, /hist=success/);
  assert.match(upload, /hist=published-by-dump/);
  assert.match(marker, /steps\.upload\.outputs\.hist == 'success'.*steps\.upload\.outputs\.hist == 'published-by-dump'/);
  assert.doesNotMatch(upload, /user CAS HTTP[\s\S]{0,100}curl.*user\//);
});

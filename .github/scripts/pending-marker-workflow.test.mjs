import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(new URL('../workflows/dump-user.yml', import.meta.url), 'utf8');
const uploadStart = workflow.indexOf('      - name: Upload to R2');
const markerStart = workflow.indexOf('      - name: Publish pending completion marker');
const markerEnd = workflow.indexOf('\n      - name:', markerStart + 1);
const upload = workflow.slice(uploadStart, markerStart);
const marker = workflow.slice(markerStart, markerEnd);
const markerIf = marker.match(/^\s+if: (.+)$/m)?.[1] ?? '';

function shouldPublish({ token = true, userFile = true, histFile = true, prepare = false, cumulative = false, userPut = true, histPut = true } = {}) {
  const histRequired = !prepare && !cumulative;
  const uploadSucceeds = token && userFile && userPut && (!histRequired || !histFile || histPut);
  return Boolean(token && userFile && uploadSucceeds && (histRequired ? histFile && histPut : true));
}

test('user와 hist 실제 PUT 성공 뒤 user _v 원문으로 D1 완료 함수 호출', () => {
  assert.match(upload, /put "user\/\$IIDX_ID\.json"[\s\S]*?put "hist\/\$IIDX_ID\.json"/);
  assert.match(upload, /\[\[ "\$status" == 2\?\? \]\]/);
  assert.match(markerIf, /steps\.upload\.outputs\.user == 'success'/);
  assert.match(markerIf, /steps\.upload\.outputs\.hist == 'success'.*steps\.upload\.outputs\.hist == 'published-by-dump'/);
  assert.match(marker, /conditionalR2Client\(/);
  assert.match(marker, /mergePendingDone\(process\.env\.IIDX_ID, version\)/);
  assert.match(marker, /const version = user\?\._v/);
  assert.equal(shouldPublish(), true);
});

test('user PUT 실패 시 완료 게시 없음', () => {
  assert.equal(shouldPublish({ userPut: false }), false);
});

test('hist PUT 실패 시 완료 게시 없음', () => {
  assert.equal(shouldPublish({ histPut: false }), false);
});

test('user 파일 누락 시 완료 게시 없음, 비누적 hist 파일 누락은 업로드 성공 후 마커 skip', () => {
  assert.equal(shouldPublish({ userFile: false }), false);
  assert.equal(shouldPublish({ histFile: false }), false);
  assert.equal(shouldPublish({ histFile: false, prepare: true }), true);
  assert.match(upload, /hist 파일 없음 — PUT skip[\s\S]*?hist=skip/);
  assert.doesNotMatch(upload, /hist 파일 없음 — PUT skip[^\n]*rc=1/);
});

test('PREPARE/CUMULATIVE user PUT 성공 후 hist 정본 게시로 마커 조건 참', () => {
  assert.equal(shouldPublish({ prepare: true }), true);
  assert.equal(shouldPublish({ cumulative: true }), true);
  assert.match(upload, /SCORE_BUFFER_CUMULATIVE.*SCORE_BUFFER_PREPARE/);
  assert.match(upload, /hist=published-by-dump/);
});

test('토큰 없음 시 완료 게시 없음', () => {
  assert.equal(shouldPublish({ token: false }), false);
  assert.match(upload, /CLOUDFLARE_API_TOKEN 미설정[\s\S]*?user=skip[\s\S]*?hist=skip/);
});

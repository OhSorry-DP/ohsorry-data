import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync(new URL('../workflows/dump-user.yml', import.meta.url), 'utf8');
const section = (start, end) => {
  const from = workflow.indexOf(start);
  assert.notEqual(from, -1, `missing section: ${start}`);
  const to = end ? workflow.indexOf(end, from + start.length) : workflow.length;
  assert.ok(!end || to !== -1, `missing end section: ${end}`);
  return workflow.slice(from, to === -1 ? undefined : to);
};

test('dump, upload, and official write run in order with successful outcomes required', () => {
  const dump = section('- name: Dump user from supabase', '- name: Upload to R2');
  const upload = section('- name: Upload to R2 (data.iidx.in)', '- name: Write official user to Supabase');
  const official = section('- name: Write official user to Supabase', '- name: 누락 신곡 확인');
  assert.match(dump, /id: dump/);
  assert.match(upload, /id: upload/);
  assert.match(official, /id: official_write/);
  assert.match(official, /steps\.dump\.outcome == 'success' && steps\.upload\.outcome == 'success'/);
});

test('official write is gated by prepare mode and receives secrets and CLI inputs through env', () => {
  const official = section('- name: Write official user to Supabase', '- name: 누락 신곡 확인');
  assert.match(official, /env\.SCORE_BUFFER_PREPARE == '1'/);
  assert.match(official, /SUPABASE_URL: \$\{\{ secrets\.SUPABASE_URL \}\}/);
  assert.match(official, /SUPABASE_SERVICE_ROLE_KEY: \$\{\{ secrets\.SUPABASE_SERVICE_ROLE_KEY \}\}/);
  assert.match(official, /run: node \.github\/scripts\/write-official-user\.mjs "\$IIDX_ID" "\$GITHUB_WORKSPACE\/user\/\$IIDX_ID\.json"/);
});

test('official write failure does not fail or interrupt the dump job; final check owns failure', () => {
  const dump = section('  dump:', '  persona:');
  const official = section('- name: Write official user to Supabase', '- name: 누락 신곡 확인');
  const check = section('  official-write-check:', undefined);
  assert.match(official, /continue-on-error: true/);
  assert.doesNotMatch(dump, /Fail job when official write failed|steps\.official_write\.outcome == 'failure'[\s\S]*?exit 1/);
  assert.match(dump, /outputs:\s+official_write: \$\{\{ steps\.official_write\.outcome \}\}/);
  assert.match(check, /needs: \[dump, persona, dispatch-coach-user\]/);
  assert.match(check, /if: \$\{\{ !cancelled\(\) && needs\.dump\.outputs\.official_write == 'failure' \}\}/);
  assert.match(check, /::error::/);
  assert.match(check, /exit 1/);
});

test('default concurrency, hist mode gate, and list/slice sequence remain intact', () => {
  const concurrency = workflow.match(/^concurrency:\r?\n((?:[ \t]+[^\r\n]*\r?\n)+)/m)?.[1];
  assert.ok(concurrency);
  assert.match(concurrency, /^  group: dump-\$\{\{ github\.event\.client_payload\.iidx_id \}\}$/m);
  assert.match(concurrency, /^  cancel-in-progress: true$/m);
  assert.doesNotMatch(concurrency, /SCORE_BUFFER_PREPARE/);
  const upload = section('- name: Upload to R2 (data.iidx.in)', '- name: Write official user to Supabase');
  assert.match(upload, /if \[ "\$SCORE_BUFFER_CUMULATIVE" != "1" \] && \[ "\$SCORE_BUFFER_PREPARE" != "1" \]; then[\s\S]*put "hist\/\$IIDX_ID\.json"/);
  assert.match(workflow, /^      SCORE_BUFFER_CUMULATIVE: \$\{\{ vars\.SCORE_BUFFER_CUMULATIVE \|\| '0' \}\}$/m);
  const list = workflow.indexOf('- name: users-list 증분 병합');
  const slice = workflow.indexOf('- name: uslice 증분 PUT', list);
  const later = workflow.indexOf('  persona:', slice);
  assert.ok(list !== -1 && slice > list && later > slice);
  assert.match(workflow, /  official-write-check:\s+needs: \[dump, persona, dispatch-coach-user\]/);
});

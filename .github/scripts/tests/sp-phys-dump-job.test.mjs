import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const workflowPath = new URL('../../workflows/dump-user.yml', import.meta.url);
const workflowBytes = await readFile(workflowPath);
const workflow = workflowBytes.toString('utf8');
const lines = workflow.split(/\r?\n/);
const envAt = lines.findIndex(line => line.trim() === 'PHYS_ASSETS_MANIFEST_KEY: ${{ vars.PHYS_ASSETS_MANIFEST_KEY }}');
const envBlock = lines.slice(envAt, envAt + 9).join('\n');

test('sp-phys-dump-job/1 — sp-env=6 variables only, no default (SP 자산 게시 전엔 비어 있어 건너뛴다)', () => {
  assert.ok(envAt >= 0, 'DP asset env exists');
  for (const name of ['MODEL_VERSION', 'LINE_VERSION', 'MEAN_VERSION', 'Q_VERSION', 'TIME_AXIS_VERSION', 'ASSETS_MANIFEST_KEY']) {
    assert.ok(envBlock.includes(`SP_PHYS_${name}: ${'$'}{{ vars.SP_PHYS_${name} }}`), name);
  }
  assert.doesNotMatch(envBlock, /SP_PHYS_[A-Z_]+: .*\|\|/);
});

test('sp-phys-dump-job/2 — dp-env retains existing expressions', () => {
  assert.match(workflow, /PHYS_MODEL_VERSION: \$\{\{ vars\.PHYS_MODEL_VERSION \|\| 'phys-line-v2' \}\}/);
  assert.match(workflow, /PHYS_LINE_VERSION: \$\{\{ vars\.PHYS_LINE_VERSION \|\| 'phys-line-v2' \}\}/);
  assert.match(workflow, /PHYS_MEAN_VERSION: \$\{\{ vars\.PHYS_MEAN_VERSION \|\| 'mean-os-pattern-span-v2' \}\}/);
  assert.match(workflow, /PHYS_Q_VERSION: \$\{\{ vars\.PHYS_Q_VERSION \}\}/);
  assert.match(workflow, /PHYS_TIME_AXIS_VERSION: \$\{\{ vars\.PHYS_TIME_AXIS_VERSION \}\}/);
  assert.match(workflow, /PHYS_ASSETS_MANIFEST_KEY: \$\{\{ vars\.PHYS_ASSETS_MANIFEST_KEY \}\}/);
});

test('sp-phys-dump-job/3 — same job and one refresh invocation', () => {
  assert.equal((workflow.match(/^  dispatch-coach-user:$/gm) || []).length, 1);
  assert.equal((workflow.match(/refresh-coach-user\.mjs/g) || []).length, 1);
  assert.equal((workflow.match(/^      - name: Precompute coach recommendations$/gm) || []).length, 1);
});

test('sp-phys-dump-job/4 — no publish command added and source bytes are UTF-8', () => {
  assert.doesNotMatch(envBlock, /^\s+run:/m);
  assert.doesNotMatch(envBlock, /\b(?:wrangler|aws\s+s3|rclone|publish)\b/i);
  assert.equal(workflowBytes.toString('utf8'), workflow);
  assert.match(createHash('sha256').update(workflowBytes).digest('hex'), /^[a-f0-9]{64}$/);
});

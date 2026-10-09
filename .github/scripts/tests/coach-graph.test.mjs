import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectGraph, digest } from '../uvec-lib.mjs';

async function checkout(t, source = 'export const value = 1;') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coach-graph-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'functions/api/[iidxId]'), { recursive: true });
  await fs.mkdir(path.join(root, 'functions/_shared'), { recursive: true });
  await fs.writeFile(path.join(root, 'functions/api/[iidxId]/[resource].js'), "export { value } from '../../_shared/contract.js';\n");
  await fs.writeFile(path.join(root, 'functions/_shared/contract.js'), source);
  return root;
}

test('기본 entry와 modules 계약은 기존 uvec-slice로 유지', async (t) => {
  const root = await checkout(t);
  await fs.mkdir(path.join(root, 'v3/services'), { recursive: true });
  await fs.writeFile(path.join(root, 'v3/services/uvec-slice.js'), 'export const old = true;');
  const graph = await collectGraph(root, () => { throw new Error('로컬 HTTP 금지'); });
  try {
    assert.equal(Object.keys(graph.modules).length, 1);
    assert.match(graph.entry, /v3\/services\/uvec-slice\.js$/);
    assert.equal('coachSources' in graph, false);
  } finally { await graph.cleanup(); }
});

test('coach entry를 로컬 ESM으로 import하고 루트 상대 LF 해시를 반환', async (t) => {
  const root = await checkout(t, 'export const value = 1;\r\n');
  const graph = await collectGraph(root, () => { throw new Error('로컬 HTTP 금지'); }, { mode: 'coach' });
  try {
    assert.equal((await import(graph.entry)).value, 1);
    assert.deepEqual(graph.coachSources, {
      'functions/_shared/contract.js': digest('export const value = 1;\n'),
      'functions/api/[iidxId]/[resource].js': digest("export { value } from '../../_shared/contract.js';\n"),
    });
    assert.equal(graph.coachFingerprint, digest(JSON.stringify(graph.coachSources)));
  } finally { await graph.cleanup(); }
});

test('checkout 위치와 CRLF/LF는 동일 지문', async (t) => {
  const a = await checkout(t, 'export const value = 2;\n');
  const b = await checkout(t, 'export const value = 2;\r\n');
  const first = await collectGraph(a, fetch, { mode: 'coach' });
  const second = await collectGraph(b, fetch, { mode: 'coach' });
  try { assert.equal(first.coachFingerprint, second.coachFingerprint); }
  finally { await Promise.all([first.cleanup(), second.cleanup()]); }
});

test('의존 모듈 변경은 coach 지문을 변경', async (t) => {
  const root = await checkout(t, 'export const value = 1;');
  const before = await collectGraph(root, fetch, { mode: 'coach' });
  await fs.writeFile(path.join(root, 'functions/_shared/contract.js'), 'export const value = 3;');
  const after = await collectGraph(root, fetch, { mode: 'coach' });
  try { assert.notEqual(before.coachFingerprint, after.coachFingerprint); }
  finally { await Promise.all([before.cleanup(), after.cleanup()]); }
});

test('루트 탈출과 nonliteral dynamic import는 거부', async (t) => {
  const root = await checkout(t, "import(name); export const value = 1;");
  await assert.rejects(collectGraph(root, fetch, { mode: 'coach' }), /지원하지 않는 import 지정자/);
  await fs.writeFile(path.join(root, 'functions/api/[iidxId]/[resource].js'), "export { value } from '../../../../escape.js';\n");
  await assert.rejects(collectGraph(root, fetch, { mode: 'coach' }), /웹 루트 밖/);
});

test('성공 및 실패 모두 임시 ESM 그래프를 정리', async (t) => {
  const root = await checkout(t);
  // 다른 테스트 파일이 병렬로 만드는 uvec- 임시 폴더와 섞이지 않게 이 테스트 전용 임시 루트를 쓴다.
  const ownTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'coach-graph-cleanup-'));
  const savedTmp = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  process.env.TEMP = process.env.TMP = process.env.TMPDIR = ownTmp;
  t.after(async () => {
    for (const [k, v] of Object.entries(savedTmp)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await fs.rm(ownTmp, { recursive: true, force: true });
  });
  const before = new Set((await fs.readdir(os.tmpdir())).filter((name) => name.startsWith('uvec-')));
  const success = await collectGraph(root, fetch, { mode: 'coach' });
  const successDir = path.dirname(new URL(success.entry).pathname);
  await success.cleanup();
  await assert.rejects(fs.access(successDir));
  await fs.writeFile(path.join(root, 'functions/api/[iidxId]/[resource].js'), "import(name);\n");
  await assert.rejects(collectGraph(root, fetch, { mode: 'coach' }));
  const leftovers = (await fs.readdir(os.tmpdir())).filter((name) => name.startsWith('uvec-'));
  assert.deepEqual(leftovers.filter((name) => !before.has(name)), []);
});

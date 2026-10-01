// 로컬 전용 결함 주입 검증. 임시 복사본만 변경하고 매 실행 뒤 원본 내용으로 복구한다.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const sourceUrl = new URL('./dbr-history.mjs', import.meta.url);
const source = readFileSync(sourceUrl, 'utf8');
const root = mkdtempSync(join(tmpdir(), 'dbr-history-mutations-'));
const modulePath = join(root, 'dbr-history.mjs');
const testPath = join(root, 'dbr-history.test.mjs');

function run() {
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', testPath], {
    encoding: 'utf8', timeout: 30000,
  });
  if (result.error) throw result.error;
  assert.equal(result.signal, null, '테스트가 비정상 종료했다');
  return { status: result.status, output: result.stdout + result.stderr };
}

try {
  copyFileSync(new URL('./dbr-history.test.mjs', import.meta.url), testPath);
  copyFileSync(new URL('./dump-user.mjs', import.meta.url), join(root, 'dump-user.mjs'));
  writeFileSync(modulePath, source);
  assert.equal(run().status, 0, '임시 복사본의 정상 테스트 실패');
  const mutations = [
    {
      name: '직전값 < 를 <= 로 변경',
      from: 'if (group[mid].time < time)', to: 'if (group[mid].time <= time)',
      expected: '직전값은 현재 행 자신을 제외',
    },
    {
      name: '같은 날 교체를 추가로 변경',
      from: 'for (const r of incoming.rows) byKey.set(naturalKey(r), r);',
      to: 'for (const r of incoming.rows) byKey.set(`${naturalKey(r)}:append:${byKey.size}`, r);',
      expected: '같은 날 재저장은 낮은 점수',
    },
  ];
  for (const mutation of mutations) {
    assert.equal(source.split(mutation.from).length, 2, '결함 주입 위치는 하나여야 한다');
    try {
      writeFileSync(modulePath, source.replace(mutation.from, mutation.to));
      const result = run();
      assert.equal(result.status, 1, `${mutation.name}: 실패를 검출하지 못했다`);
      const failures = result.output.split('\n').filter((line) => /^not ok /.test(line));
      assert.ok(failures.some((line) => line.includes(mutation.expected)), result.output);
      console.log(`${mutation.name}: 검출됨 (exit=${result.status}, 실패 ${failures.length}개)`);
      for (const line of failures) console.log(line);
    } finally {
      writeFileSync(modulePath, source);
    }
    assert.equal(run().status, 0, '결함 원복 후 테스트 실패');
  }
  assert.equal(readFileSync(sourceUrl, 'utf8'), source, '워크스페이스 원본 변경 감지');
  console.log('두 결함 모두 검출, 각각 원복 후 전체 신규 테스트 통과, 워크스페이스 원본 동일');
} finally {
  // 생성한 임시 디렉터리가 시스템 임시 경로 바로 아래인지 확인한 뒤 정리한다.
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  rmSync(root, { recursive: true, force: true });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { SOURCE_KEYS, PREFIX, songPatternsKey, buildSongPatterns, planSongPatterns } from './song-patterns.mjs';
import { publishSongPatterns } from './dump-song-patterns.mjs';
import { md5, listEntries } from './r2-client.mjs';
import { pacedFetch } from './song-meta.mjs';

const sources = [
  { tx: { t: '제목', c: { DP_ANO: { lv: 12, pt: { x: 0 }, m1: [1, 2], extra: null } } } },
  { tx: { t: '다른 제목', c: { DP_HYP: { lv: 9 } } } },
  { tx: { c: { DP_NOR: { lv: 4 } } }, other: { c: { DP_NOR: { lv: 3 } } } },
];
function mock(entries = [], bands = sources) {
  const reads = []; const writes = []; const waits = [];
  const client = { md5,
    getText: async key => { reads.push(key); return JSON.stringify(bands[SOURCE_KEYS.indexOf(key)]); },
    listEntries: async prefix => { reads.push(prefix); return entries; },
    putText: async (key, body) => { writes.push(['put', key, body]); return { ok: true }; },
    del: async key => { writes.push(['delete', key]); return true; } };
  return { client, reads, writes, waits, sleep: async ms => waits.push(ms) };
}
const listing = bundles => [...bundles].map(([key, body]) => ({ key, etag: md5(body) }));
const stale = count => Array.from({ length: count }, (_, i) => ({ key: songPatternsKey(`stale-${i}`) }));

test('3밴드 곡 합집합은 계약과 원본 행을 그대로 보존하며 원본은 불변', () => {
  const before = JSON.stringify(sources);
  const bundles = buildSongPatterns(sources);
  assert.equal(bundles.size, 2);
  assert.deepEqual(JSON.parse(bundles.get(songPatternsKey('tx'))), { v: 1, id: 'tx', c: {
    DP_ANO: sources[0].tx.c.DP_ANO, DP_HYP: sources[1].tx.c.DP_HYP, DP_NOR: sources[2].tx.c.DP_NOR } });
  assert.equal(JSON.stringify(sources), before);
});

test('같은 곡 chartKey의 모든 밴드 쌍 충돌은 동일 행이어도 쓰기 전에 중단', async () => {
  for (const [a, b] of [[0, 1], [0, 2], [1, 2]]) {
    const bands = structuredClone(sources);
    bands[b].tx.c = { ...bands[b].tx.c, ...bands[a].tx.c };
    const m = mock([], bands);
    await assert.rejects(publishSongPatterns({ ...m, apply: true }), /밴드 간 충돌: tx\/DP_/);
    assert.deepEqual(m.writes, []);
    assert.ok(!m.reads.includes(PREFIX));
  }
});

test('다른 곡의 같은 chartKey는 충돌하지 않고 합친다', () => {
  assert.equal(buildSongPatterns(sources).size, 2);
});

test('hex는 웹 song-features.js의 실제 식과 동일하고 id 정규화를 하지 않는다', () => {
  // 형제 레포가 없는 CI에서도 실행하도록 웹 6행의 확정 식을 오라클로 보존한다.
  const webHex = id => Array.from(new TextEncoder().encode(id), byte => byte.toString(16).padStart(2, '0')).join('');
  for (const id of ['tx', 'AbC /%', '한글曲', '😀', 'é', 'e\u0301', '__proto__']) {
    assert.equal(songPatternsKey(id), `${PREFIX}${webHex(id)}.json`);
  }
  assert.equal(songPatternsKey('한'), `${PREFIX}ed959c.json`);
  assert.notEqual(songPatternsKey('é'), songPatternsKey('e\u0301'));
  assert.notEqual(songPatternsKey('TX'), songPatternsKey('tx'));
  const bands = [{ '曲😀': { c: { DP_ANO: { x: 1 } } } }, sources[1], sources[2]];
  assert.equal(JSON.parse(buildSongPatterns(bands).get(songPatternsKey('曲😀'))).id, '曲😀');
});

test('md5 동일 목록은 약한·인용·대문자 ETag도 증분 skip하고 추가 GET은 없다', async () => {
  const entries = listing(buildSongPatterns(sources)).map(entry => ({ ...entry, etag: `W/"${entry.etag.toUpperCase()}"` }));
  const m = mock(entries);
  const result = await publishSongPatterns({ ...m, apply: true });
  assert.equal(result.puts, 0); assert.equal(result.remaining, 0);
  assert.deepEqual(m.writes, []); assert.deepEqual(m.reads, [...SOURCE_KEYS, PREFIX]);
});

test('행 변경은 해당 곡 하나만 PUT', async () => {
  const entries = listing(buildSongPatterns(sources));
  const bands = structuredClone(sources); bands[0].tx.c.DP_ANO.lv = 11;
  const m = mock(entries, bands); const result = await publishSongPatterns({ ...m, apply: true });
  assert.equal(result.puts, 1); assert.equal(m.writes[0][1], songPatternsKey('tx'));
});

test('기본 dry-run은 쓰기 0이며 모든 원본·목록 요청 사이 250ms', async () => {
  const m = mock(); const result = await publishSongPatterns(m);
  assert.equal(result.objects, 2); assert.equal(result.puts, 2); assert.equal(result.written, 0);
  assert.equal(result.remaining, 2); assert.deepEqual(m.writes, []);
  assert.deepEqual(m.waits, [250, 250, 250]);
  const sizes = [...buildSongPatterns(sources).values()].map(body => Buffer.byteLength(body)).sort((a, b) => a - b);
  assert.equal(result.medianBytes, (sizes[0] + sizes[1]) / 2); assert.equal(result.maxBytes, sizes[1]);
});

test('사라진 곡만 DELETE하며 타 prefix·잘못된 hex 키는 보존', async () => {
  const removed = songPatternsKey('gone');
  const m = mock([{ key: removed }, { key: 'data/song-meta-1.json' }, { key: `${PREFIX}abc.json` },
    { key: `${PREFIX}GG.json` }, { key: `${PREFIX}.json` }]);
  const result = await publishSongPatterns({ ...m, apply: true });
  assert.equal(result.deletes, 1); assert.deepEqual(m.writes[0], ['delete', removed]);
});

test('상한은 DELETE+PUT 합계이고 다음 회차는 나머지만 계속 게시', async () => {
  const m = mock(stale(1)); const first = await publishSongPatterns({ ...m, apply: true, maxWrites: 2 });
  assert.equal(first.written, 2); assert.equal(first.remaining, 1);
  assert.equal(m.writes[0][0], 'delete');
  const [, key, body] = m.writes[1];
  const next = mock([{ key, etag: md5(body) }]);
  const second = await publishSongPatterns({ ...next, apply: true, maxWrites: 2 });
  assert.equal(second.written, 1); assert.equal(second.remaining, 0);
  assert.notEqual(next.writes[0][1], key);
  assert.deepEqual(m.waits, [250, 250, 250, 250, 250]);
});

test('삭제 가드: 최소 20 경계와 기존 대비 5% 경계를 모두 검사한다', async () => {
  const bundles = buildSongPatterns(sources);
  assert.equal(planSongPatterns(bundles, stale(20), { md5 }).deletes, 20);
  for (const apply of [false, true]) {
    const m = mock(stale(21));
    await assert.rejects(publishSongPatterns({ ...m, apply }), /초과/); assert.deepEqual(m.writes, []);
  }
  const many = new Map(Array.from({ length: 475 }, (_, i) => [songPatternsKey(`song-${i}`), '{}']));
  const existing = [...listing(many), ...stale(25)];
  assert.equal(planSongPatterns(many, existing, { md5 }).deletes, 25);
  // 전체 500 중 26 삭제는 5%를 넘는다. 비계약 키로 분모를 부풀리지 못한다.
  many.delete(songPatternsKey('song-0'));
  assert.throws(() => planSongPatterns(many, [...existing, ...Array.from({ length: 1000 }, () => ({ key: 'data/other.json' }))], { md5 }), /초과/);
});

test('원본 조회·누락·파싱·스키마·목록 실패는 apply에서도 쓰기 0', async () => {
  for (const key of SOURCE_KEYS) for (const failure of ['request', 'missing', 'parse', 'schema']) {
    const m = mock(); const original = m.client.getText;
    m.client.getText = async input => input !== key ? original(input) : failure === 'request' ? Promise.reject(new Error('원본 실패'))
      : failure === 'missing' ? null : failure === 'parse' ? '{' : '[]';
    await assert.rejects(publishSongPatterns({ ...m, apply: true })); assert.deepEqual(m.writes, []);
  }
  for (const invalid of [[], [sources[0], sources[1]], [{}, sources[1], sources[2]],
    [{ tx: {} }, sources[1], sources[2]], [{ tx: { c: { DP_ANO: null } } }, sources[1], sources[2]]]) {
    assert.throws(() => buildSongPatterns(invalid));
  }
  const m = mock(); m.client.listEntries = async () => { throw new Error('목록 실패'); };
  await assert.rejects(publishSongPatterns({ ...m, apply: true })); assert.deepEqual(m.writes, []);
});

test('PUT·DELETE 실패는 후속 쓰기 없이 중단하고 상한·간격 무효 입력은 거부', async () => {
  const m = mock(); m.client.putText = async () => ({ ok: false });
  await assert.rejects(publishSongPatterns({ ...m, apply: true }), /put 실패/); assert.deepEqual(m.writes, []);
  const d = mock(stale(1)); d.client.del = async () => false;
  await assert.rejects(publishSongPatterns({ ...d, apply: true }), /delete 실패/); assert.deepEqual(d.writes, []);
  for (const maxWrites of [0, -1, 1.5, NaN, Infinity]) await assert.rejects(publishSongPatterns({ ...mock(), maxWrites }));
  await assert.rejects(publishSongPatterns({ ...mock(), intervalMs: 249 }));
});

test('공용 LIST의 429 Retry-After 대기·페이지 요청도 250ms 간격을 지킨다', async () => {
  let clock = 0; const starts = []; const waits = []; const sleep = async ms => { waits.push(ms); clock += ms; };
  const fetchImpl = pacedFetch(async () => {
    starts.push(clock);
    if (starts.length === 1) return new Response('', { status: 429, headers: { 'retry-after': '2' } });
    return new Response(JSON.stringify({ result: [], ...(starts.length === 2 ? { result_info: { cursor: 'next' } } : {}) }));
  }, { now: () => clock, sleep });
  await listEntries(PREFIX, { token: 'test', fetchImpl, sleep });
  assert.equal(starts.length, 3); assert.ok(waits.includes(2000));
  assert.ok(starts.slice(1).every((time, i) => time - starts[i] >= 250));
});

test('실행기는 공용 감속을 적용하고 잘못된 CLI 인자를 쓰기 전에 거부', () => {
  const file = new URL('./dump-song-patterns.mjs', import.meta.url);
  const code = readFileSync(file, 'utf8'); assert.match(code, /globalThis.fetch = pacedFetch\(originalFetch\)/);
  const result = spawnSync(process.execPath, [file.pathname.replace(/^\/([A-Za-z]:)/, '$1'), '--unknown'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /지원 인자/);
});

test('workflow는 엇갈린 cron apply·수동 dry-run·독립 concurrency·500 상한', () => {
  const workflow = readFileSync(new URL('../workflows/dump-song-patterns.yml', import.meta.url), 'utf8');
  assert.match(workflow, /cron: '10,40 \* \* \* \*'/); assert.match(workflow, /workflow_dispatch: \{\}/);
  assert.match(workflow, /group: dump-song-patterns, cancel-in-progress: false/);
  assert.match(workflow, /permissions: \{ contents: read \}/); assert.match(workflow, /--max-writes=500/);
  assert.match(workflow, /github.event_name == 'schedule' && '--apply' \|\| ''/);
  assert.doesNotMatch(workflow, /inputs\.apply/);
});

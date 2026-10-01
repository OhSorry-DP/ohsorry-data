// 운영 원천은 R2만 사용한다. 기본 dry-run이며 --apply에서만 쓴다.
import { pathToFileURL } from 'node:url';
import * as r2 from './r2-client.mjs';
import { pacedFetch } from './song-meta.mjs';
import { SOURCE_KEYS, PREFIX, buildSongPatterns, planSongPatterns } from './song-patterns.mjs';

export async function publishSongPatterns({ client = r2, apply = false, maxWrites = 500, intervalMs = 250,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!Number.isSafeInteger(maxWrites) || maxWrites < 1 || !Number.isFinite(intervalMs) || intervalMs < 250) throw new Error('상한/요청 간격 오류');
  let started = false;
  const call = async (fn, ...args) => { if (started) await sleep(intervalMs); started = true; return fn(...args); };
  const sources = [];
  for (const key of SOURCE_KEYS) {
    const text = await call(client.getText, key);
    if (text === null) throw new Error(`패턴 원본 없음: ${key}`);
    sources.push(JSON.parse(text));
  }
  const bundles = buildSongPatterns(sources);
  const entries = await call(client.listEntries, PREFIX);
  const plan = planSongPatterns(bundles, entries, { md5: client.md5, maxWrites });
  let written = 0;
  if (apply) for (const change of plan.selected) {
    const result = change.type === 'put' ? await call(client.putText, change.key, change.body) : await call(client.del, change.key);
    if (change.type === 'put' ? !result?.ok : result !== true) throw new Error(`R2 ${change.type} 실패: ${change.key}`);
    written++;
  }
  return { objects: bundles.size, puts: plan.puts, deletes: plan.deletes, selected: plan.selected.length, written,
    remaining: plan.pending - written, medianBytes: plan.medianBytes, maxBytes: plan.maxBytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--apply' && !/^--max-writes=\d+$/.test(arg))) throw new Error('지원 인자: --apply --max-writes=N');
  if (!r2.useRest) throw new Error('R2 REST 자격증명 필요');
  const maxWrites = Number(args.find(arg => arg.startsWith('--max-writes='))?.split('=')[1] || 500);
  // 공용 클라이언트의 목록 페이지와 429 재시도도 실제 요청 시작 간격을 보장한다.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = pacedFetch(originalFetch);
  try { console.log(JSON.stringify(await publishSongPatterns({ apply: args.includes('--apply'), maxWrites }))); }
  finally { globalThis.fetch = originalFetch; }
}

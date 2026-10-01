// 운영 원천은 R2만 사용한다. 기본은 dry-run이며 --apply에서만 쓴다.
import * as client from './r2-client.mjs';
import { publishSongMeta, pacedFetch } from './song-meta.mjs';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--apply' && !/^--max-writes=\d+$/.test(arg))) throw new Error('지원 인자: --apply --max-writes=N');
if (!client.useRest) throw new Error('R2 REST 자격증명 필요');
const maxWrites = Number(args.find(arg => arg.startsWith('--max-writes='))?.split('=')[1] || 500);
// 공용 클라이언트의 목록 페이지와 재시도까지 실제 REST 요청 시작을 직렬 감속한다.
const originalFetch = globalThis.fetch;
globalThis.fetch = pacedFetch(originalFetch);
try { console.log(JSON.stringify(await publishSongMeta({ client, apply: args.includes('--apply'), maxWrites }))); }
finally { globalThis.fetch = originalFetch; }

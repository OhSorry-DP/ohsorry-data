import { normalizeAliasInputs } from "../../../.github/scripts/song-aliases.mjs";
import { replayScoreBuffer, gridFromHistory } from "../../../.github/scripts/score-history.mjs";
import { buildCandidate } from "../../../.github/scripts/score-buffer.mjs";
import { assembleUserDump, recentHistoryFromRows, HIST_COLS } from "../../../.github/scripts/dump-fast-core.mjs";
import { createR2S3Adapter } from "../_shared/r2-s3.ts";

// Generated from the checked-in source bytes; node tests reject stale values.
export const PROVENANCE = {
  revision: "c7f0e53019ffff17c64f8fd29b098926363ad6e2",
  dirty: true,
  hashes: {
    songAliases: "b1b8f38b0e1a00fb992de4ca30d5f2941f8b394fe5e9154a184847eebb55859d",
    scoreHistory: "1ad1e34c9a08b6a0b20b1d231283660766fcf79141c213f2d6d70896198e0079",
    scoreBuffer: "3e03ababebf893b756278814d9cdde54c001e957f0e4b9d5b5e70d38dc3b95ea",
    dumpFastCore: "8363bdb08e08b90d1f113a6d2ac03a7a029fc99f7bc9fa283b6512fec5e6db57",
    r2S3: "cc103c84e6747549284d2c25282f52fb6de9e27643527d38b7942c1dbc707890",
    denoJson: "fc2f55ef8479de38a49d702230d5a9759e1bc43fee68e5a62024c30cf2735d1d",
  },
  npm: { aws4fetch: "1.0.20" },
};

const FIXTURES = new Set(["94309458", "C200074777849"]);
const encoder = new TextEncoder();
const enc = (v: unknown) => encoder.encode(JSON.stringify(v));
async function digest(b: Uint8Array) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function valid(body: any) {
  if (!body || typeof body !== "object" || !FIXTURES.has(body.fixture)) throw new TypeError("invalid fixture");
  if (body.mode === "cpu") {
    if (![1, 100, 1000, "all"].includes(body.r)) throw new TypeError("invalid r");
  } else if (body.mode === "r2") {
    if (!Number.isInteger(body.n) || body.n < 1 || body.n > 10) throw new TypeError("invalid n");
  } else throw new TypeError("invalid mode");
  if (Object.keys(body).some((k) => !["mode", "fixture", "r", "n"].includes(k))) throw new TypeError("unexpected input");
}
const times = () => performance.now();
const measure = async <T>(fn: () => T | Promise<T>) => { const t = times(); const value = await fn(); return { value, elapsedMs: times() - t }; };
const publicUrlsFor = (fixture: string) => ({ hist: `https://data.iidx.in/hist/${fixture}.json`, songs: "https://data.iidx.in/songs.json" });
let isolateFirstRequest = true;
const isolateId = crypto.randomUUID();
const region = Deno.env.get("SB_REGION") ?? Deno.env.get("FLY_REGION") ?? "unknown";

async function cpu(fixture: string, r: number | "all", adapter?: ReturnType<typeof createR2S3Adapter>) {
  const keys = [`bench/hist-${fixture}.json`, "bench/songs.json"];
  const publicUrls = [publicUrlsFor(fixture).hist, publicUrlsFor(fixture).songs];
  const [h, s] = await Promise.all(keys.map(async (key, index) => {
    const t = times();
    let bytes: Uint8Array;
    if (adapter) {
      const response = await adapter.get(key);
      bytes = response.value!;
    } else {
      const response = await fetch(publicUrls[index]);
      if (!response.ok) throw new Error(`public input fetch failed (${response.status})`);
      bytes = new Uint8Array(await response.arrayBuffer());
    }
    const downloadMs = times() - t;
    const parse = await measure(() => JSON.parse(new TextDecoder().decode(bytes)));
    return { key, bytes: bytes.length, downloadMs, parseMs: parse.elapsedMs, value: parse.value as any };
  }));
  const previousHistRows = h.value;
  const songs = s.value;
  const restMeasure = await measure(() => {
    const count = r === "all" ? Math.max(1, previousHistRows.length) : r;
    const regular = previousHistRows.filter((row: any[]) => row[4] !== -10);
    const idSet = new Set<number>();
    return Array.from({ length: count }, (_, i) => {
      const row = regular[i % Math.max(1, regular.length)] ?? [1, 0, null, null, 1, "2020-01-01T00:00:00Z", "2020-01-01", 1, null, null];
      let score_id = i;
      while (idSet.has(score_id)) score_id++;
      idSet.add(score_id);
      return Object.fromEntries(["song_id", "diff", "lamp", "ex_score", "played_version", "date", "date_kst", "play_style", "bp", "note_count"].map((k, j) => [k, row[j]]).concat([["score_id", score_id], ["iidx_id", fixture]]));
    });
  });
  const restRows = restMeasure.value;
  const aliases = { v: 1, rules: [] };
  const aliasesBytes = enc(aliases);
  const spans: Record<string, number> = {};
  const run = async (name: string, fn: () => any) => { const m = await measure(fn); spans[name] = m.elapsedMs; return m.value; };
  const normalized = await run("normalizeAliasInputs", () => normalizeAliasInputs({ histRows: previousHistRows, restRows, aliases, songs }));
  const replayed = await run("replayScoreBuffer", () => replayScoreBuffer(normalized.histRows, normalized.restRows));
  const histBytes = await run("histUtf8", () => enc(replayed));
  const candidateArgs = { iidxId: fixture, restRows, previousHistRows, aliases, aliasesBytes, songs, publishedHistBytes: histBytes, downloadedHistBytes: histBytes };
  const candidate1 = await run("buildCandidate1", () => buildCandidate(candidateArgs));
  const assumedDownloaded = await run("downloadCopy", () => new Uint8Array(histBytes));
  const candidate2 = await run("buildCandidate2", () => buildCandidate({ ...candidateArgs, downloadedHistBytes: assumedDownloaded }));
  const dp = await run("gridDP", () => gridFromHistory(fixture, replayed, songs, 1));
  const sp = await run("gridSP", () => gridFromHistory(fixture, replayed, songs, 0));
  const now = Date.now();
  const dpRecent = await run("recentDP", () => recentHistoryFromRows(replayed, 0, now));
  const spRecent = await run("recentSP", () => recentHistoryFromRows(replayed, 1, now));
  const user = await run("assembleUser", () => assembleUserDump({ timestamp: new Date(now).toISOString(), userRows: [{ iidx_id: fixture }], radars: null, osPattern: null, persona: null, spPersona: null, reachNps: null, dpRows: dp, sp: sp.map((x: any) => ({ song_id: x.song_id, diff: x.diff, lamp: x.lamp, ex_score: x.ex_score })), cumulative: true, dpRecent, spRecent }));
  const serial = await run("serialize", () => ({ hist: enc(replayed), candidate: enc(candidate2), user: enc(user) }));
  const computeTotalMs = Object.values(spans).reduce((a, b) => a + b, 0);
  return { rows: { previous: previousHistRows.length, rest: restRows.length, output: replayed.length, dbrExcluded: previousHistRows.filter((x: any[]) => x[4] === -10).length, targetRestRows: restRows.length }, bytes: { histInput: h.bytes, songs: s.bytes, aliases: aliasesBytes.length, histOutput: serial.hist.length, candidate: serial.candidate.length, user: serial.user.length, assumedDownloaded: assumedDownloaded.length }, hashes: { hist: await digest(serial.hist), candidate: await digest(serial.candidate), user: await digest(serial.user) }, candidateEqual: JSON.stringify(candidate1) === JSON.stringify(candidate2), downloadAssumption: { performedReget: false, byteCopy: true }, recentAt: new Date(now).toISOString(), timings: { histDownloadMs: h.downloadMs, songsDownloadMs: s.downloadMs, histParseMs: h.parseMs, songsParseMs: s.parseMs, restRowsSynthesisMs: restMeasure.elapsedMs, ...spans, computeTotalMs, nonOverlappingStageTotalMs: computeTotalMs } };
}

async function r2(fixture: string, n: number, adapter: ReturnType<typeof createR2S3Adapter>, uuid: string) {
  const source = await adapter.get(`bench/hist-${fixture}.json`);
  const bytes = source.value!;
  const root = `bench/runs/${uuid}`;
  const objectKey = `${root}/sample.json`;
  const samples: any = { put: [], get: [], head: [] }, created = [objectKey];
  const timed = async (op: string, attempt: number, fn: () => Promise<any>) => { const t = times(); try { const result = await fn(); const body = result.value; return { status: result.status, elapsedMs: times() - t, bytes: body instanceof Uint8Array ? body.length : op === "PUT" ? bytes.length : 0, attempt, etag: result.etag }; } catch (e) { return { status: (e as any).status ?? 0, elapsedMs: times() - t, bytes: 0, attempt, error: String(e) }; } };
  const initialization = await timed("PUT", 0, () => adapter.put(objectKey, bytes, { ifNoneMatch: "*" }));
  for (let i = 1; i <= n; i++) {
    samples.put.push(await timed("PUT", i, () => adapter.put(objectKey, bytes)));
    samples.get.push(await timed("GET", i, () => adapter.get(objectKey)));
    samples.head.push(await timed("HEAD", i, () => adapter.head(objectKey)));
  }
  const etag = samples.head.at(-1)?.etag;
  let wrongStatus = 0, preserved = false;
  try { await adapter.put(objectKey, enc({ wrong: true }), { ifMatch: '"wrong-etag"' }); } catch (e) { wrongStatus = (e as any).status ?? 0; }
  const afterWrong = await adapter.get(objectKey); const afterHead = await adapter.head(objectKey);
  preserved = wrongStatus === 412 && !!etag && afterHead.etag === etag && await digest(afterWrong.value!) === await digest(bytes);
  const raceA = `${root}/race-a.json`, raceB = `${root}/race-b.json`; created.push(raceA, raceB);
  const raceBodies = [enc({ winner: "a", id: uuid }), enc({ winner: "b", id: uuid })];
  // Two conditional writes race against the same previously absent UUID key.
  const raceKey = `${root}/race.json`; created.push(raceKey);
  const contenders = await Promise.allSettled(raceBodies.map((b) => adapter.put(raceKey, b, { ifNoneMatch: "*" })));
  const statuses = contenders.map((x) => x.status === "fulfilled" ? x.value.status : (x.reason as any).status ?? 0);
  const final = await adapter.get(raceKey);
  const winner = statuses.indexOf(200) >= 0 ? statuses.indexOf(200) : statuses.indexOf(201);
  const cas = { statuses, successes: statuses.filter((x) => x === 200 || x === 201).length, preconditions: statuses.filter((x) => x === 412).length, finalMatchesWinner: winner >= 0 && await digest(final.value!) === await digest(raceBodies[winner]) };
  const assertions = { wrongEtag412: wrongStatus === 412, existingPreserved: preserved, exactlyOneCasWinner: cas.successes === 1 && cas.preconditions === 1, finalMatchesWinner: cas.finalMatchesWinner };
  return { initialization, samples, assertions, actual: { wrongEtagStatus: wrongStatus, casStatuses: statuses }, createdKeys: created, ok: Object.values(assertions).every(Boolean) && [samples.put, samples.get, samples.head].flat().every((x: any) => x.status >= 200 && x.status < 300) };
}

Deno.serve(async (request) => {
  const requestId = crypto.randomUUID(), runId = crypto.randomUUID(), first = isolateFirstRequest;
  isolateFirstRequest = false;
  const started = times();
  try {
    if (request.method !== "POST") return Response.json({ error: "POST required", requestId }, { status: 405 });
    const body = await request.json(); valid(body);
    const env = ["R2_BENCH_ACCOUNT_ID", "R2_BENCH_ACCESS_KEY_ID", "R2_BENCH_SECRET_ACCESS_KEY", "R2_BENCH_BUCKET"];
    const [accountId, accessKeyId, secretAccessKey, bucket] = env.map((k) => Deno.env.get(k) ?? "");
    const configured = [accountId, accessKeyId, secretAccessKey, bucket].every((value) => value.length > 0);
    if (body.mode === "r2" && !configured) return Response.json({ ok: false, error: "r2 credentials not configured" }, { status: 400 });
    const adapter = configured ? createR2S3Adapter({ accountId, accessKeyId, secretAccessKey, bucket, fetchImpl: fetch }) : undefined;
    const result = body.mode === "cpu" ? await cpu(body.fixture, body.r, adapter) : await r2(body.fixture, body.n, adapter!, runId);
    if (body.mode === "cpu") Object.assign(result, { inputSource: configured ? "r2" : "public", inputUrls: publicUrlsFor(body.fixture) });
    const ok = (result as any).ok !== false;
    return Response.json({ requestId, runId, isolateId, isolateFirstRequest: first, region, revision: PROVENANCE.revision, dirty: PROVENANCE.dirty, moduleSha256: PROVENANCE.hashes, dependencies: PROVENANCE.npm, mode: body.mode, ...result, requestElapsedMs: times() - started, ok }, { status: ok ? 200 : 500 });
  } catch (error) {
    return Response.json({ requestId, runId, isolateId, isolateFirstRequest: first, region, revision: PROVENANCE.revision, dirty: PROVENANCE.dirty, moduleSha256: PROVENANCE.hashes, dependencies: PROVENANCE.npm, ok: false, error: String(error), requestElapsedMs: times() - started }, { status: 400 });
  }
});

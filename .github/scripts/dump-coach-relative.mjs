// 야간 상대 모집단 입력 생산기와 불변 스냅샷 게시기.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { useRest, getText, pool, conditionalR2Client } from './r2-client.mjs';
import { buildRelativeRegistry, adaptRelativeInput, patternRecordSources, radarRecordSources } from './coach-relative-input.mjs';
import { buildPopulation, projectRelative } from './coach-relative.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KERNEL_PATH = path.join(HERE, 'vendor', 'patternScoreKernel.js');
const DP_FEATURE_KEY = Object.freeze({ 1: 'DP_NOR', 2: 'DP_HYP', 3: 'DP_ANO', 4: 'DP_LEG' });
const DP_NOTES_KEY = Object.freeze({ 1: 'DN', 2: 'DH', 3: 'DA', 4: 'DX' });
const FEATURE_ASSET_PATHS = Object.freeze(['data/feature-scores-slim.json', 'data/textage-meta.json']);
const LOCAL_FEATURE_ASSET_PATHS = Object.freeze(['dist/feature-scores-slim.json', 'dist/textage-meta.json']);

export function stableJson(value) {
  const sort = item => Array.isArray(item) ? item.map(sort)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])])) : item;
  return JSON.stringify(sort(value));
}
export function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : stableJson(value), 'utf8');
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

export function selectDpRegistry(registry) { return registry.filter(item => item.key.startsWith('dp/')); }
export function stripDpPrefix(value) {
  if (Array.isArray(value)) return value.map(stripDpPrefix);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.startsWith('dp/') ? key.slice(3) : key,
    key === 'registry' && Array.isArray(item) ? item.filter(axis => axis.key.startsWith('dp/')).map(axis => ({ ...axis, key: axis.key.slice(3) })) : stripDpPrefix(item)]));
}

function listRows(rows) {
  if (!Array.isArray(rows)) throw new Error('users-list는 배열이어야 합니다');
  const grouped = new Map();
  for (const row of rows) {
    if (!row || (typeof row.iidx_id !== 'string' && typeof row.iidx_id !== 'number')) throw new Error('users-list iidx_id가 없습니다');
    const id = String(row.iidx_id);
    if (!id) throw new Error('빈 iidx_id');
    const existing = grouped.get(id);
    if (!existing) { grouped.set(id, row); continue; }
    if (stableJson(existing) === stableJson(row)) continue;
    const oldTime = Date.parse(existing.date || existing._v || '');
    const newTime = Date.parse(row.date || row._v || '');
    if (Number.isFinite(oldTime) && Number.isFinite(newTime) && oldTime !== newTime) {
      if (newTime > oldTime) grouped.set(id, row);
      continue;
    }
    throw new Error(`users-list 중복 행 충돌, 최신 순서 근거 없음: ${id}`);
  }
  return [...grouped.keys()].sort().map(id => ({ id, row: grouped.get(id) }));
}

export function buildEntries(rows, scoresMap, songsMeta) {
  const entries = [];
  for (const row of rows) {
    if (!row || !row.ex_score || row.ex_score <= 0) continue;
    const sid = row.textage_song_id;
    if (!sid) continue;
    const featureKey = DP_FEATURE_KEY[row.diff], notesKey = DP_NOTES_KEY[row.diff];
    if (!featureKey || !notesKey) continue;
    const chartScores = scoresMap[sid]?.[featureKey];
    if (!chartScores) continue;
    const song = songsMeta[sid];
    if (!song?.notes) continue;
    const noteCount = song.notes[notesKey];
    if (!noteCount || noteCount <= 0) continue;
    entries.push({ song_id: row.song_id, diff: row.diff, scoreRate: row.ex_score / (noteCount * 2), chartScores });
  }
  return entries;
}

function loadKernel() {
  const require = createRequire(import.meta.url);
  const kernel = require(KERNEL_PATH);
  if (typeof kernel.countPatternScoreRecords !== 'function') throw new Error('vendor countPatternScoreRecords 없음');
  return kernel;
}

function codeVersion(kernelBytes) {
  return { kernel: sha256(kernelBytes), buildEntries: sha256(buildEntries.toString()),
    mapping: sha256(stableJson({ DP_FEATURE_KEY, DP_NOTES_KEY })) };
}

function validateAssets(featureFile, metaFile) {
  if (!featureFile?.scores || typeof featureFile.scores !== 'object'
    || !metaFile?.songs || typeof metaFile.songs !== 'object') throw new Error('피처 자산 .scores 또는 .songs 누락');
}

function parseAssets(featureBytes, metaBytes) {
  const hashes = { 'data/feature-scores-slim.json': sha256(featureBytes), 'data/textage-meta.json': sha256(metaBytes) };
  const featureFile = JSON.parse(featureBytes.toString('utf8'));
  const metaFile = JSON.parse(metaBytes.toString('utf8'));
  validateAssets(featureFile, metaFile);
  return { featureFile, metaFile, hashes };
}

function loadLocalAssets(directory) {
  const files = LOCAL_FEATURE_ASSET_PATHS.map(relative => path.join(directory, relative));
  for (const file of files) if (!fs.existsSync(file)) throw new Error(`피처 자산 없음: ${file}`);
  return parseAssets(fs.readFileSync(files[0]), fs.readFileSync(files[1]));
}

async function loadRemoteAssets(r2) {
  const bodies = await Promise.all(FEATURE_ASSET_PATHS.map(async key => {
    const body = await r2.getText(key);
    if (body === null) throw new Error(`R2 피처 자산 없음: ${key}`);
    if (typeof body !== 'string') throw new Error(`R2 피처 자산 응답 오류: ${key}`);
    return Buffer.from(body, 'utf8');
  }));
  return parseAssets(bodies[0], bodies[1]);
}

export function calculateUser(dump, registry, versions, assets, kernel) {
  const entries = buildEntries(dump.dp || [], assets.featureFile.scores, assets.metaFile.songs);
  const counts = kernel.countPatternScoreRecords(entries);
  const axisSources = { ...patternRecordSources({ style: 'dp', counts }), ...radarRecordSources({ dump }) };
  const adapted = adaptRelativeInput({ dump, registry, featureVersion: versions.featureVersion,
    sourceRevision: versions.sourceRevision, axisSources });
  return stripDpPrefix(adapted);
}

async function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' });
  fs.renameSync(temp, file);
}
function statePaths(directory) { return { manifest: path.join(directory, 'manifest.json'), checkpoint: path.join(directory, 'inputs.json') }; }
function conditionalR2ClientFromEnv() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID || '607eea1b073bea6747e6e9b76f2d7b41';
  const token = process.env.CLOUDFLARE_R2_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  return conditionalR2Client({ account, token });
}

const jsonBody = value => JSON.stringify(value);
const parseRemote = (item, key) => {
  if (!item) return null;
  try { return JSON.parse(item.body); } catch { throw new Error(`R2 JSON 손상: ${key}`); }
};

export async function publishSnapshot(report, { r2, resumeDir, poolFn = pool, logger = console } = {}) {
  if (!report?.completePopulation || !Array.isArray(report.users) || !r2?.read || !r2?.put) {
    throw new Error('완전 모집단과 조건부 R2 client가 필요합니다');
  }
  const { users, registry, featureVersion, generatedAt } = report;
  const sortedUsers = [...users].sort((a, b) => a.iidxId.localeCompare(b.iidxId));
  if (sortedUsers.length !== report.totalMembers || new Set(sortedUsers.map(user => user.iidxId)).size !== sortedUsers.length) {
    throw new Error('불변 모집단 회원 수 또는 ID가 일치하지 않습니다');
  }
  const versionInput = { membership: sortedUsers.map(user => user.iidxId),
    source_revisions: sortedUsers.map(user => [user.iidxId, user.sourceRevision]), feature_version: featureVersion,
    registry: [...registry].sort((a, b) => a.key.localeCompare(b.key)) };
  const populationVersion = report.populationVersion || sha256(versionInput);
  if (populationVersion !== sha256(versionInput)) throw new Error('모집단 버전 입력 불일치');
  const population = buildPopulation({ users: sortedUsers, registry, featureVersion, populationVersion, generatedAt });
  const populationKey = `coach/relative/population/${populationVersion}.json`;
  const populationRecord = { schema_version: 'coach-relative-population/1', rank_version: population.rank_version,
    feature_version: featureVersion, population_version: populationVersion,
    registry: versionInput.registry, membership_hash: sha256(versionInput.membership), source_hash: sha256(versionInput),
    membership: versionInput.membership, source_revisions: versionInput.source_revisions, calculation: population };
  const immutablePut = async (key, value) => {
    const body = jsonBody(value); const existing = await r2.read(key);
    if (existing) {
      if (sha256(existing.body) !== sha256(body)) throw new Error(`immutable 자산 불일치: ${key}`);
      return { body, hash: sha256(body), skipped: true };
    }
    await r2.put(key, body, null);
    const verified = await r2.read(key);
    if (!verified || sha256(verified.body) !== sha256(body)) throw new Error(`immutable PUT 검증 실패: ${key}`);
    return { body, hash: sha256(body), skipped: false };
  };
  const populationSaved = await immutablePut(populationKey, populationRecord);
  const stateFile = resumeDir ? path.join(resumeDir, `publish-${populationVersion}.json`) : null;
  let state = stateFile && fs.existsSync(stateFile) ? readJson(stateFile) : { populationVersion, staged: {}, users: {} };
  if (state.populationVersion !== populationVersion) throw new Error('resume 게시 버전 불일치');
  const saveState = () => stateFile ? atomicJson(stateFile, state) : Promise.resolve();
  let puts = populationSaved.skipped ? 0 : 1, gets = 3, skips = populationSaved.skipped ? 1 : 0;
  const outputs = new Map();
  for (const user of sortedUsers) {
    const relative = projectRelative({ user, registry, population, sourceRevision: user.sourceRevision, generatedAt });
    const result = { schema_version: 'coach-skill-evidence/1', iidx_id: user.iidxId, play_style: 'DP', relative };
    const body = jsonBody(result); outputs.set(user.iidxId, { result, body, hash: sha256(body) });
  }
  const putImmutableUser = async (id, stageKey) => {
    if (state.staged[id]) return;
    const output = outputs.get(id); const saved = await immutablePut(stageKey, output.result);
    if (saved.skipped) skips++; else puts++;
    const verified = await r2.read(stageKey); gets++;
    if (!verified || sha256(verified.body) !== output.hash) throw new Error(`staging 검증 실패: ${id}`);
    state.staged[id] = output.hash; await saveState();
  };
  const stageFailures = {};
  await poolFn(sortedUsers, 8, async user => {
    try { await putImmutableUser(user.iidxId, `coach/relative/snapshot/${populationVersion}/user/${user.iidxId}.json`); }
    catch (error) { stageFailures[user.iidxId] = String(error?.message || error); }
  });
  if (Object.keys(stageFailures).length) throw Object.assign(new Error('staging 게시 실패'), { publishSummary: { populationVersion, failed: stageFailures, gets, puts, skips } });
  const changed = []; const userFailures = {};
  await poolFn(sortedUsers, 8, async user => {
    const id = user.iidxId; const output = outputs.get(id);
    try {
      if (state.users[id] === output.hash) return;
      const key = `coach/relative/user/${id}.json`; const current = await r2.read(key); gets++;
      if (current && sha256(current.body) === output.hash) { state.users[id] = output.hash; skips++; await saveState(); return; }
      const etag = current?.etag ?? null;
      await r2.put(key, output.body, etag); puts++;
      const verified = await r2.read(key); gets++;
      if (!verified || sha256(verified.body) !== output.hash) throw new Error('계약 키 사후 검증 불일치');
      state.users[id] = output.hash; changed.push(id); await saveState();
    } catch (error) { userFailures[id] = String(error?.message || error); }
  });
  if (Object.keys(userFailures).length) throw Object.assign(new Error('user 계약 키 게시 실패'), { publishSummary: { populationVersion, failed: userFailures, changed: changed.sort(), gets, puts, skips, mismatch_risk: changed.sort() } });
  const userHashes = Object.fromEntries([...outputs].sort(([a], [b]) => a.localeCompare(b)).map(([id, output]) => [id, output.hash]));
  const sourceHash = populationVersion;
  const manifestKey = 'coach/relative/current.json'; const current = await r2.read(manifestKey); gets++;
  const currentManifest = parseRemote(current, manifestKey);
  const manifest = { schema_version: 'coach-relative-manifest/1', rank_version: population.rank_version,
    feature_version: featureVersion, population_version: populationVersion, population_key: populationKey,
    generated_at: generatedAt, users_count: sortedUsers.length, source_hash: sourceHash, user_hashes: userHashes };
  if (currentManifest?.source_hash === sourceHash && currentManifest.population_version === populationVersion) {
    logger.log(`게시 요약: 성공=${sortedUsers.length}, 실패=0, skip=${skips}, GET=${gets}, PUT=${puts}, populationVersion=${populationVersion}, no-op`);
    return { ...report, publication: { status: 'noop', populationVersion, gets, puts, skips } };
  }
  try {
    await r2.put(manifestKey, jsonBody(manifest), current?.etag ?? null); puts++;
  } catch (error) {
    throw Object.assign(new Error(`manifest conditional PUT 실패: ${String(error?.message || error)}`),
      { publishSummary: { populationVersion, failed: { manifest: '경합·412·응답 유실; 이전 manifest 유지' }, changed, gets, puts, skips, mismatch_risk: changed } });
  }
  const verifiedManifest = await r2.read(manifestKey); gets++;
  if (!verifiedManifest || sha256(verifiedManifest.body) !== sha256(jsonBody(manifest))) {
    throw Object.assign(new Error('manifest 사후 검증 실패'), { publishSummary: { populationVersion, changed, gets, puts, skips, mismatch_risk: changed } });
  }
  logger.log(`게시 요약: 성공=${sortedUsers.length}, 실패=0, skip=${skips}, GET=${gets}, PUT=${puts}, populationVersion=${populationVersion}`);
  return { ...report, publication: { status: 'published', populationVersion, gets, puts, skips, changed } };
}

export async function produceInputs({ usersListFile, selectedIds, limit, resumeDir, dryRun, featureAssetsDir,
  r2 = { useRest, getText, read: (...args) => conditionalR2ClientFromEnv().read(...args),
    put: (...args) => conditionalR2ClientFromEnv().put(...args) }, poolFn = pool,
  now = new Date().toISOString(), logger = console }) {
  if (!r2.useRest) throw new Error('R2 REST 토큰이 필요합니다');
  const usersBytes = fs.readFileSync(usersListFile);
  const members = listRows(JSON.parse(usersBytes.toString('utf8')));
  let targets = members;
  if (selectedIds?.length) {
    const wanted = new Set(selectedIds.map(String)); targets = targets.filter(item => wanted.has(item.id));
    const found = new Set(targets.map(item => item.id));
    for (const id of wanted) if (!found.has(id)) throw new Error(`--only ID가 users-list에 없습니다: ${id}`);
  }
  if (limit != null) targets = targets.slice(0, limit);
  const completeTargetSet = targets.length === members.length && targets.every((item, index) => item.id === members[index].id);
  const assetMode = featureAssetsDir ? 'local' : 'r2';
  const assets = featureAssetsDir ? loadLocalAssets(path.resolve(featureAssetsDir)) : await loadRemoteAssets(r2);
  const kernel = loadKernel();
  const kernelBytes = fs.readFileSync(KERNEL_PATH);
  const registryAll = buildRelativeRegistry({ featureMeta: assets.featureFile._meta || {} });
  const registry = selectDpRegistry(registryAll);
  const codeHashes = codeVersion(kernelBytes);
  const featureVersion = sha256({ assets: assets.hashes, registry, codeHashes });
  const optionIdentity = { selectedIds: selectedIds || null, limit: limit ?? null, usersListPath: path.resolve(usersListFile),
    dryRun: !!dryRun, featureAssetsMode: assetMode };
  const initial = { schema: 1, generatedAt: now, listHash: sha256(usersBytes), featureVersion,
    options: optionIdentity, targetIds: targets.map(item => item.id), completed: {}, failures: {} };
  let state = initial;
  if (resumeDir) {
    fs.mkdirSync(resumeDir, { recursive: true });
    const paths = statePaths(resumeDir);
    if (fs.existsSync(paths.manifest)) {
      const previous = readJson(paths.manifest);
      if (previous.listHash !== initial.listHash || previous.featureVersion !== featureVersion
        || stableJson(previous.options) !== stableJson(optionIdentity) || stableJson(previous.targetIds) !== stableJson(initial.targetIds)) {
        throw new Error('resume 상태가 목록·자산·옵션과 일치하지 않습니다');
      }
      state = previous;
    } else await atomicJson(paths.manifest, initial);
  }
  const doneIds = new Set(completeTargetSet ? Object.keys(state.completed) : []);
  const pending = targets.filter(item => !doneIds.has(item.id));
  const failures = {};
  let inputGets = 0;
  await poolFn(pending, 8, async ({ id }) => {
    try {
      inputGets++;
      const body = await r2.getText(`user/${id}.json`);
      if (body === null) throw new Error('R2 404');
      const dump = JSON.parse(body);
      if (String(dump.user?.iidx_id ?? '') !== id) throw new Error('덤프 iidx_id 불일치');
      const sourceRevision = sha256({ dump: sha256(body), assets: assets.hashes, registry, codeHashes });
      const user = calculateUser(dump, registry, { featureVersion, sourceRevision }, assets, kernel);
      state.completed[id] = { dumpHash: sha256(body), user };
      delete state.failures[id];
    } catch (error) { failures[id] = String(error?.message || error); }
  });
  state.failures = { ...state.failures, ...failures };
  if (resumeDir) await atomicJson(statePaths(resumeDir).manifest, state);
  const users = targets.filter(item => state.completed[item.id]).map(item => state.completed[item.id].user);
  if (completeTargetSet && users.length === members.length && !Object.keys(state.failures).length) {
    const allUsers = [...members].map(item => state.completed[item.id].user).sort((a, b) => a.iidxId.localeCompare(b.iidxId));
    // 입력 성공 기준만 확정한다. 모집단 계산은 publishSnapshot에서 한 번 수행한다.
    if (allUsers.length !== members.length) throw new Error('불변 모집단 회원 입력 누락');
  }
  const report = { generatedAt: now, totalMembers: members.length, requested: targets.length, succeeded: users.length,
    failed: failures, completePopulation: completeTargetSet && users.length === members.length && Object.keys(state.failures).length === 0,
    dryRun: !!dryRun, registry, featureVersion, users, population: null, // featureVersion 은 publishSnapshot 의 모집단 버전 재계산에 필요
    populationVersion: completeTargetSet && users.length === members.length && !Object.keys(state.failures).length
      ? sha256({ membership: users.map(user => user.iidxId).sort((a, b) => a.localeCompare(b)), // publishSnapshot 과 같은 정렬 source_revisions: users.map(user => [user.iidxId, user.sourceRevision]).sort(([a], [b]) => a.localeCompare(b)),
        feature_version: featureVersion, registry: [...registry].sort((a, b) => a.key.localeCompare(b.key)) }) : null };
  if (resumeDir) {
    await atomicJson(statePaths(resumeDir).checkpoint, state.completed);
    await atomicJson(path.join(resumeDir, 'result.json'), report);
  }
  logger.log(`피처 자산: ${assetMode === 'r2' ? FEATURE_ASSET_PATHS.join(', ') : LOCAL_FEATURE_ASSET_PATHS.join(', ')} (${assetMode})`);
  logger.log(`입력 ${users.length}/${targets.length}, 실패 ${Object.keys(failures).length}, GET=${inputGets}, PUT=0, populationVersion=${report.populationVersion || '미확정'}, dry-run=${!!dryRun}`);
  return report;
}

function parseArgs(args) {
  const out = { usersListFile: 'users-list.json', selectedIds: null, limit: null, resumeDir: null, dryRun: false, featureAssetsDir: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i], next = () => { if (!args[i + 1]) throw new Error(`${arg} 값이 필요합니다`); return args[++i]; };
    if (arg === '--users-list') out.usersListFile = next();
    else if (arg === '--only') out.selectedIds = next().split(',').filter(Boolean);
    else if (arg === '--limit') { const n = Number(next()); if (!Number.isInteger(n) || n < 1) throw new Error('--limit은 양의 정수여야 합니다'); out.limit = n; }
    else if (arg === '--resume') out.resumeDir = next();
    else if (arg === '--feature-assets') out.featureAssetsDir = next();
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--self-test-standalone') out.selfTestStandalone = true;
    else if (arg === '--self-test-input') out.selfTest = true;
    else if (arg === '--self-test-publish') out.selfTestPublish = true;
    else throw new Error(`알 수 없는 옵션: ${arg}`);
  }
  return out;
}

async function selfTestInput() {
  const assert = await import('node:assert/strict');
  const { mkdtempSync, rmSync, writeFileSync } = fs;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-relative-'));
  try {
    const assets = { featureFile: { scores: { song: { DP_NOR: { NOTES: 100, 'SOF-LAN': 30 } } }, _meta: { feats: ['NOTES', 'KEIMA_L'] } },
      metaFile: { songs: { song: { notes: { DN: 100 } } } }, hashes: { f: 'a', m: 'b' } };
    const localKernel = { countPatternScoreRecords(entries) { const counts = { NOTES: 0, 'SOF-LAN': 0, KEIMA_L: 0 };
      for (const entry of entries) for (const key of Object.keys(counts)) if (entry.chartScores[key] > 0) counts[key]++;
      return counts; } };
    const rows = listRows([{ iidx_id: '001', date: '2026-01-01' }, { iidx_id: '001', date: '2026-01-01' }]);
    assert.equal(rows[0].id, '001');
    assert.throws(() => listRows([{ iidx_id: '1', star: 2 }, { iidx_id: '1', star: 3 }]), /충돌/);
    const registry = selectDpRegistry(buildRelativeRegistry({ featureMeta: assets.featureFile._meta }));
    assert.ok(registry.every(item => item.key.startsWith('dp/')));
    const thirty = Array.from({ length: 30 }, (_, i) => ({ song_id: i, diff: 1, scoreRate: 1, chartScores: { NOTES: 100 } }));
    assert.equal(localKernel.countPatternScoreRecords(thirty).NOTES, 30);
    const d = { user: { iidx_id: '001', star: 4 }, dp: thirty.map(x => ({ song_id: x.song_id, diff: 1, ex_score: 100, textage_song_id: 'song' })),
      osPattern: [{ play_style: 1, notes: 7, soflan: 0 }], radars: [{ play_style: 1, notes: 4 } ] };
    const cv = calculateUser(d, registry, { featureVersion: 'v', sourceRevision: 's' }, assets, localKernel);
    assert.equal(cv.features['osPattern:NOTES'].recordCount, 30);
    assert.equal(cv.features['osPattern:KEIMA_L'].recordCount, 0);
    assert.equal(cv.features['osPattern:SOF-LAN'].value, 0);
    assert.equal(cv.features['radar:notes'].recordCount, 30);
    const noGrid = calculateUser({ ...d, dp: undefined }, registry, { featureVersion: 'v', sourceRevision: 's' }, assets, localKernel);
    assert.equal(noGrid.features['radar:notes'].recordCount, null);
    assert.equal(sha256({ b: 2, a: 1 }), sha256({ a: 1, b: 2 }));
    assert.notEqual(sha256('dump-a'), sha256('dump-b'));

    let peak = 0, active = 0, calls = 0;
    const fakePool = async (items, concurrency, fn) => {
      assert.equal(concurrency, 8); let next = 0;
      await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (next < items.length) { const item = items[next++]; active++; peak = Math.max(peak, active);
          await new Promise(resolve => setTimeout(resolve, 1)); await fn(item); active--; }
      }));
    };
    const listFile = path.join(temp, 'users.json');
    writeFileSync(listFile, JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ iidx_id: String(i).padStart(4, '0'), star: 4 }))));
    const fake = { useRest: true, async getText(key) { calls++; if (key.endsWith('0001.json')) throw new Error('fixture failure'); return JSON.stringify({ user: { iidx_id: key.match(/user\/(.*)\.json/)[1] }, dp: [], osPattern: [], radars: [] }); } };
    const fakeAssetsDir = path.join(temp, 'rating'); fs.mkdirSync(path.join(fakeAssetsDir, 'dist'), { recursive: true });
    writeFileSync(path.join(fakeAssetsDir, 'dist', 'feature-scores-slim.json'), JSON.stringify(assets.featureFile));
    writeFileSync(path.join(fakeAssetsDir, 'dist', 'textage-meta.json'), JSON.stringify(assets.metaFile));
    const fakeRoot = path.join(temp, 'src'); fs.mkdirSync(path.join(fakeRoot, 'modules'), { recursive: true }); fs.mkdirSync(path.join(fakeRoot, 'scripts', 'derive', 'dp'), { recursive: true });
    writeFileSync(path.join(fakeRoot, 'modules', 'patternScoreKernel.js'), "module.exports={countPatternScoreRecords:()=>({NOTES:0})}");
    const fakeResult = await produceInputs({ usersListFile: listFile, limit: 50, dryRun: true, featureAssetsDir: fakeAssetsDir,
      r2: fake, poolFn: fakePool, logger: { log() {} }, now: '2026-01-01T00:00:00.000Z' });
    assert.equal(fakeResult.requested, 50); assert.equal(fakeResult.succeeded, 49); assert.equal(Object.keys(fakeResult.failed).length, 1);
    assert.ok(peak <= 8); assert.equal(calls, 50);
    const dir = path.join(temp, 'resume'); let r2Calls = 0;
    const resumableR2 = { useRest: true, async getText(key) { r2Calls++; if (key.endsWith('0001.json')) throw new Error('retry me'); return fake.getText(key); } };
    await produceInputs({ usersListFile: listFile, limit: 2, dryRun: true, resumeDir: dir, featureAssetsDir: fakeAssetsDir, r2: resumableR2, logger: { log() {} } });
    const firstCalls = r2Calls;
    await produceInputs({ usersListFile: listFile, limit: 2, dryRun: true, resumeDir: dir, featureAssetsDir: fakeAssetsDir, r2: resumableR2, logger: { log() {} } });
    assert.equal(r2Calls, firstCalls + 2);
    await assert.rejects(() => produceInputs({ usersListFile: listFile, limit: 3, dryRun: true, resumeDir: dir, featureAssetsDir: fakeAssetsDir, r2: resumableR2, logger: { log() {} } }), /일치/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
  console.log('self-test-input: OK');
}

async function selfTestStandalone() {
  const assert = await import('node:assert/strict');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-standalone-'));
  const fixtureFeature = { _meta: { feats: ['NOTES', 'CHORD'] }, scores: Object.fromEntries(['s1','s2','s3','s4','s5','s6','s7'].map(id =>
    [id, Object.fromEntries(['DP_NOR','DP_HYP','DP_ANO','DP_LEG'].map(key => [key, { NOTES: 100, CHORD: 50 }]))])) };
  const fixtureMeta = { songs: Object.fromEntries(['s1','s2','s3','s4','s5','s6','s7'].map((id, i) =>
    [id, { notes: { DN: 100 + i, DH: 200 + i, DA: 300 + i, DX: 400 + i } }])) };
  const makeR2 = (feature = JSON.stringify(fixtureFeature), meta = JSON.stringify(fixtureMeta)) => {
    const calls = [], puts = [];
    return { calls, puts, useRest: true, async getText(key) {
      calls.push(key);
      if (key === FEATURE_ASSET_PATHS[0]) return feature;
      if (key === FEATURE_ASSET_PATHS[1]) return meta;
      if (key.startsWith('user/')) return JSON.stringify({ user: { iidx_id: key.slice(5, -5) }, dp: [], osPattern: [], radars: [] });
      throw new Error(`unexpected R2 key: ${key}`);
    }, async read() { throw new Error('unexpected population PUT path'); }, async put(key) { puts.push(key); } };
  };
  const listFile = path.join(temp, 'users.json');
  fs.writeFileSync(listFile, JSON.stringify([{ iidx_id: 'u1' }]));
  const localDir = path.join(temp, 'local');
  fs.mkdirSync(path.join(localDir, 'dist'), { recursive: true });
  const featureBytes = Buffer.from(JSON.stringify(fixtureFeature));
  const metaBytes = Buffer.from(JSON.stringify(fixtureMeta));
  fs.writeFileSync(path.join(localDir, LOCAL_FEATURE_ASSET_PATHS[0]), featureBytes);
  fs.writeFileSync(path.join(localDir, LOCAL_FEATURE_ASSET_PATHS[1]), metaBytes);
  try {
    const localKernelBytes = fs.readFileSync(KERNEL_PATH);
    const localKernel = loadKernel();
    assert.equal(typeof localKernel.countPatternScoreRecords, 'function');
    const ratingKernel = path.resolve(HERE, '..', '..', '..', 'ohSorryRating', 'modules', 'patternScoreKernel.js');
    if (fs.existsSync(ratingKernel)) {
      const expected = fs.readFileSync(ratingKernel);
      const committed = await new Promise((resolve, reject) => {
        const { execFile } = createRequire(import.meta.url)('node:child_process');
        execFile('git', ['-c', 'safe.directory=D:/work/ohSorryRating', '-C', path.resolve(HERE, '..', '..', '..', 'ohSorryRating'),
          'show', '49a5135:modules/patternScoreKernel.js'], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
      });
      assert.deepEqual(expected, committed, 'local Rating kernel is not commit 49a5135 canonical bytes');
      assert.deepEqual(localKernelBytes, expected, 'vendor kernel differs from local Rating canonical bytes');
      console.log('self-test-standalone kernel: local and vendor bytes match 49a5135');
    } else console.log('self-test-standalone kernel: SKIP (local Rating sibling absent)');

    const rows = [
      { song_id: 1, diff: 1, ex_score: 100, textage_song_id: 's1' },
      { song_id: 2, diff: 2, ex_score: 100, textage_song_id: 's2' },
      { song_id: 3, diff: 3, ex_score: 100, textage_song_id: 's3' },
      { song_id: 4, diff: 4, ex_score: 100, textage_song_id: 's4' },
      { song_id: 5, diff: 1, ex_score: 0, textage_song_id: 's5' },
      { song_id: 6, diff: 1, ex_score: -1, textage_song_id: 's6' },
      { song_id: 7, diff: 1, ex_score: 10 },
      { song_id: 8, diff: 5, ex_score: 10, textage_song_id: 's1' },
      { song_id: 9, diff: 1, ex_score: 10, textage_song_id: 'missing' },
      { song_id: 10, diff: 1, ex_score: 10, textage_song_id: 's5' },
      { song_id: 11, diff: 1, ex_score: 10, textage_song_id: 's6' },
    ];
    const scores = { ...fixtureFeature.scores }; delete scores.s5.DP_NOR; scores.s6.DP_NOR.NOTES = 0;
    const songs = { ...fixtureMeta.songs, s5: { notes: {} }, s6: { notes: { DN: 0 } } };
    const entries = buildEntries(rows, scores, songs);
    assert.deepEqual(entries.map(entry => [entry.song_id, entry.diff]), [[1,1],[2,2],[3,3],[4,4]]);
    assert.deepEqual(entries.map(entry => entry.scoreRate), [100/200,100/402,100/604,100/806]);
    assert.equal(localKernel.countPatternScoreRecords(entries).NOTES, 4);

    const rest = makeR2(featureBytes.toString('utf8'), metaBytes.toString('utf8'));
    const base = { usersListFile: listFile, dryRun: true, r2: rest, logger: { log() {} }, now: '2026-10-05T00:00:00Z' };
    const remote = await produceInputs(base);
    assert.deepEqual(rest.calls.slice(0, 2), FEATURE_ASSET_PATHS);
    assert.equal(rest.calls.filter(key => FEATURE_ASSET_PATHS.includes(key)).length, 2);
    assert.equal(remote.succeeded, 1);
    const localR2 = makeR2();
    const local = await produceInputs({ ...base, featureAssetsDir: localDir, r2: localR2 });
    assert.equal(localR2.calls.filter(key => FEATURE_ASSET_PATHS.includes(key)).length, 0);
    assert.equal(remote.users[0].featureVersion, local.users[0].featureVersion);

    const badCases = [
      ['null', null, JSON.stringify(fixtureMeta)], ['http', new Error('HTTP 500'), JSON.stringify(fixtureMeta)],
      ['json', '{', JSON.stringify(fixtureMeta)], ['structure', JSON.stringify({}), JSON.stringify(fixtureMeta)],
      ['meta-structure', JSON.stringify(fixtureFeature), JSON.stringify({})],
    ];
    for (const [name, feature, meta] of badCases) {
      const fake = makeR2(feature, meta); let userGets = 0;
      const original = fake.getText.bind(fake);
      fake.getText = async key => { if (key.startsWith('user/')) userGets++; if (feature instanceof Error && key === FEATURE_ASSET_PATHS[0]) throw feature; return original(key); };
      await assert.rejects(() => produceInputs({ ...base, r2: fake }), undefined, name);
      assert.equal(userGets, 0, `${name}: users read before asset validation`);
      assert.deepEqual(fake.puts, []);
    }

    const changed = makeR2(JSON.stringify({ ...fixtureFeature, _meta: { feats: ['NOTES'] } }));
    const changedResult = await produceInputs({ ...base, r2: changed });
    assert.notEqual(remote.users[0].featureVersion, changedResult.users[0].featureVersion);
    const baselineVersion = sha256({ assets: parseAssets(featureBytes, metaBytes).hashes,
      registry: selectDpRegistry(buildRelativeRegistry({ featureMeta: fixtureFeature._meta })), codeHashes: codeVersion(localKernelBytes) });
    assert.equal(baselineVersion, sha256({ assets: parseAssets(featureBytes, metaBytes).hashes,
      registry: selectDpRegistry(buildRelativeRegistry({ featureMeta: fixtureFeature._meta })), codeHashes: codeVersion(localKernelBytes) }));
    const versionWith = overrides => sha256({ assets: parseAssets(featureBytes, metaBytes).hashes,
      registry: selectDpRegistry(buildRelativeRegistry({ featureMeta: fixtureFeature._meta })),
      codeHashes: { ...codeVersion(localKernelBytes), ...overrides } });
    assert.notEqual(baselineVersion, versionWith({ kernel: sha256(Buffer.concat([localKernelBytes, Buffer.from(' ')])) }));
    assert.notEqual(baselineVersion, versionWith({ buildEntries: sha256(`${buildEntries.toString()} `) }));
    assert.notEqual(baselineVersion, versionWith({ mapping: sha256('changed mapping') }));
    const resume = path.join(temp, 'resume');
    await produceInputs({ ...base, resumeDir: resume });
    await assert.rejects(() => produceInputs({ ...base, resumeDir: resume, r2: changed }), /일치/);
    console.log('self-test-standalone: OK');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

async function selfTestPublish() {
  const assert = await import('node:assert/strict');
  const registry = [{ key: 'osPattern:NOTES', valueUnit: 'feature_score', higherIsBetter: true }];
  const users = Array.from({ length: 30 }, (_, index) => ({ iidxId: String(index).padStart(2, '0'), star: 4,
    featureVersion: 'fv', sourceRevision: `sr-${index}`, features: { 'osPattern:NOTES': { value: index < 2 ? 50 : index, recordCount: 30 } } }));
  const makeReport = generatedAt => ({ completePopulation: true, totalMembers: 30, users, registry, featureVersion: 'fv', generatedAt });
  const makeR2 = initial => {
    const objects = new Map(initial || []); const calls = []; let active = 0, peak = 0;
    return { objects, calls, get peak() { return peak; }, async read(key) { calls.push(['GET', key]); const found = objects.get(key); return found ? { body: found.body, etag: found.etag } : null; },
      async put(key, body, etag) { active++; peak = Math.max(peak, active); calls.push(['PUT', key]);
        try { await new Promise(resolve => setTimeout(resolve, 1)); const old = objects.get(key);
          if (old && (etag === null || old.etag !== etag)) throw new Error('HTTP 412');
          if (!old && etag !== null) throw new Error('HTTP 412');
          const newEtag = `"${sha256(body).slice(0, 32)}"`; objects.set(key, { body, etag: newEtag });
        } finally { active--; } }, };
  };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-publish-'));
  try {
    const r2 = makeR2(); const first = await publishSnapshot(makeReport('2026-10-05T00:00:00.000Z'), { r2, resumeDir: path.join(temp, 'resume'), logger: { log() {} } });
    assert.equal(first.publication.status, 'published');
    const manifest = JSON.parse(r2.objects.get('coach/relative/current.json').body);
    assert.equal(manifest.schema_version, 'coach-relative-manifest/1'); assert.equal(Object.keys(manifest.user_hashes).length, 30);
    assert.ok(r2.calls.findIndex(call => call[1].includes('/population/')) < r2.calls.findIndex(call => call[1].includes('/snapshot/')));
    assert.ok(r2.calls.findIndex(call => call[1].includes('/snapshot/')) < r2.calls.findIndex(call => call[1] === 'coach/relative/current.json' && call[0] === 'PUT'));
    assert.ok(r2.peak <= 8);
    const putCount = r2.calls.filter(call => call[0] === 'PUT').length;
    const second = await publishSnapshot(makeReport('2026-10-05T00:00:00.000Z'), { r2, resumeDir: path.join(temp, 'resume'), logger: { log() {} } });
    assert.equal(second.publication.status, 'noop'); assert.equal(r2.calls.filter(call => call[0] === 'PUT').length, putCount);
    const broken = makeR2(); let userPuts = 0; const basePut = broken.put.bind(broken);
    broken.put = async (key, body, etag) => { if (key.startsWith('coach/relative/user/') && ++userPuts === 4) throw new Error('fixture fail'); return basePut(key, body, etag); };
    const resume = path.join(temp, 'resume-fail');
    await assert.rejects(() => publishSnapshot(makeReport('2026-10-05T00:00:00.000Z'), { r2: broken, resumeDir: resume, logger: { log() {} } }), /user 계약 키 게시 실패/);
    assert.equal(broken.objects.has('coach/relative/current.json'), false);
    const beforeRetry = broken.calls.filter(call => call[0] === 'PUT' && call[1].startsWith('coach/relative/snapshot/')).length;
    const retried = await publishSnapshot(makeReport('2026-10-05T00:00:00.000Z'), { r2: broken, resumeDir: resume, logger: { log() {} } });
    assert.equal(retried.publication.status, 'published');
    assert.equal(broken.calls.filter(call => call[0] === 'PUT' && call[1].startsWith('coach/relative/snapshot/')).length, beforeRetry);
    const conflict = makeR2(); await publishSnapshot(makeReport('2026-10-05T00:00:00.000Z'), { r2: conflict, logger: { log() {} } });
    assert.equal(JSON.parse(conflict.objects.get('coach/relative/user/00.json').body).relative.features['osPattern:NOTES'].overall.percentile, 96.67);
    console.log('self-test-publish: OK');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.selfTestStandalone) return selfTestStandalone();
  if (options.selfTest) return selfTestInput();
  if (options.selfTestPublish) return selfTestPublish();
  const result = await produceInputs(options);
  if (!options.dryRun && result.completePopulation) return publishSnapshot(result, { r2: conditionalR2ClientFromEnv(), resumeDir: options.resumeDir });
  if (!options.dryRun) throw new Error('부분 모집단은 게시할 수 없습니다');
  return result;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}

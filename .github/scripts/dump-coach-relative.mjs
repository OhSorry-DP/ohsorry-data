// 야간 상대 모집단 입력 생산기. R03b 게시 단계는 publishSnapshot 경계에 연결한다.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { useRest, getText, pool } from './r2-client.mjs';
import { buildRelativeRegistry, adaptRelativeInput, patternRecordSources, radarRecordSources } from './coach-relative-input.mjs';
import { buildPopulation } from './coach-relative.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RATING_ROOT = path.resolve(HERE, '..', '..', '..', 'ohSorryRating');
const DP_FEATURE_KEY = Object.freeze({ 1: 'DP_NOR', 2: 'DP_HYP', 3: 'DP_ANO', 4: 'DP_LEG' });
const DP_NOTES_KEY = Object.freeze({ 1: 'DN', 2: 'DH', 3: 'DA', 4: 'DX' });
const FEATURE_ASSET_PATHS = Object.freeze(['dist/feature-scores-slim.json', 'dist/textage-meta.json']);
const DERIVATION_FILES = Object.freeze([
  'modules/patternScoreKernel.js', 'scripts/derive/dp/backfill-pattern-score.js',
]);

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
const hashFile = file => sha256(fs.readFileSync(file));

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
    // INF 분기는 실제 adapter와 동일하게 textage_song_id가 가리키는 채보 노트를 이용한다.
    const noteCount = song.notes[notesKey];
    if (!noteCount || noteCount <= 0) continue;
    entries.push({ song_id: row.song_id, diff: row.diff, scoreRate: row.ex_score / (noteCount * 2), chartScores });
  }
  return entries;
}

function loadAssets(directory) {
  const files = FEATURE_ASSET_PATHS.map(relative => path.join(directory, relative));
  for (const file of files) if (!fs.existsSync(file)) throw new Error(`피처 자산 없음: ${file}`);
  const featureFile = readJson(files[0]), metaFile = readJson(files[1]);
  if (!featureFile.scores || !metaFile.songs) throw new Error('피처 자산 .scores 또는 .songs 누락');
  return { featureFile, metaFile, files, hashes: Object.fromEntries(files.map(file => [path.relative(directory, file).replaceAll('\\', '/'), hashFile(file)])) };
}

function loadKernel(ratingRoot) {
  const kernelPath = path.join(ratingRoot, 'modules', 'patternScoreKernel.js');
  const require = createRequire(import.meta.url);
  const kernel = require(kernelPath);
  if (typeof kernel.countPatternScoreRecords !== 'function') throw new Error('canonical countPatternScoreRecords 없음');
  return { kernel, kernelPath };
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

export async function publishSnapshot() {
  throw new Error('R03b 게시 단계가 연결되지 않았습니다');
}

export async function produceInputs({ usersListFile, selectedIds, limit, resumeDir, dryRun, featureAssetsDir,
  ratingRoot = process.env.COACH_RATING_ROOT || DEFAULT_RATING_ROOT, r2 = { useRest, getText }, poolFn = pool,
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
  const assetDir = path.resolve(featureAssetsDir || ratingRoot);
  const assets = loadAssets(assetDir);
  const { kernel, kernelPath } = loadKernel(ratingRoot);
  const registryAll = buildRelativeRegistry({ featureMeta: assets.featureFile._meta || {} });
  const registry = selectDpRegistry(registryAll);
  const codeHashes = Object.fromEntries([...DERIVATION_FILES, 'modules/fullUserFeatures.js'].map(relative => {
    const file = path.join(ratingRoot, relative);
    return [relative, fs.existsSync(file) ? hashFile(file) : sha256(`missing:${relative}`)];
  }));
  const featureVersion = sha256({ assets: assets.hashes, registry, codeHashes, kernel: hashFile(kernelPath) });
  const optionIdentity = { selectedIds: selectedIds || null, limit: limit ?? null, usersListPath: path.resolve(usersListFile),
    dryRun: !!dryRun, featureAssetsDir: assetDir, ratingRoot: path.resolve(ratingRoot) };
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
  const doneIds = new Set(Object.keys(state.completed));
  const pending = targets.filter(item => !doneIds.has(item.id));
  const failures = {};
  const currentMembers = new Map(members.map(item => [item.id, item.row]));
  await poolFn(pending, 8, async ({ id }) => {
    try {
      const body = await r2.getText(`user/${id}.json`);
      if (body === null) throw new Error('R2 404');
      const dump = JSON.parse(body);
      if (String(dump.user?.iidx_id ?? '') !== id) throw new Error('덤프 iidx_id 불일치');
      const sourceRevision = sha256({ dump: sha256(body), assets: assets.hashes, registry, codeHashes, kernel: hashFile(kernelPath) });
      const user = calculateUser(dump, registry, { featureVersion, sourceRevision }, assets, kernel);
      state.completed[id] = { dumpHash: sha256(body), user };
      delete state.failures[id];
    } catch (error) { failures[id] = String(error?.message || error); }
  });
  state.failures = { ...state.failures, ...failures };
  if (resumeDir) await atomicJson(statePaths(resumeDir).manifest, state);
  const users = targets.filter(item => state.completed[item.id]).map(item => state.completed[item.id].user);
  const population = buildPopulation({ users, registry, featureVersion, populationVersion: sha256(users.map(user => user.sourceRevision).sort()), generatedAt: state.generatedAt });
  const report = { generatedAt: now, totalMembers: members.length, requested: targets.length, succeeded: users.length,
    failed: failures, completePopulation: completeTargetSet && users.length === members.length && Object.keys(state.failures).length === 0,
    dryRun: !!dryRun, registry, users, population };
  if (resumeDir) {
    await atomicJson(statePaths(resumeDir).checkpoint, state.completed);
    await atomicJson(path.join(resumeDir, 'result.json'), report);
  }
  logger.log(`피처 자산: ${FEATURE_ASSET_PATHS.join(', ')} (${assetDir})`);
  logger.log('매칭/skip 원문: scripts/derive/dp/backfill-pattern-score.js computePatternScoreVec()');
  logger.log(`입력 ${users.length}/${targets.length}, 실패 ${Object.keys(failures).length}, dry-run=${!!dryRun}`);
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
    else if (arg === '--self-test-input') out.selfTest = true;
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
    const fakeResult = await produceInputs({ usersListFile: listFile, limit: 50, dryRun: true, ratingRoot: fakeRoot, featureAssetsDir: fakeAssetsDir,
      r2: fake, poolFn: fakePool, logger: { log() {} }, now: '2026-01-01T00:00:00.000Z' });
    assert.equal(fakeResult.requested, 50); assert.equal(fakeResult.succeeded, 49); assert.equal(Object.keys(fakeResult.failed).length, 1);
    assert.ok(peak <= 8); assert.equal(calls, 50);
    const dir = path.join(temp, 'resume'); let r2Calls = 0;
    const resumableR2 = { useRest: true, async getText(key) { r2Calls++; if (key.endsWith('0001.json')) throw new Error('retry me'); return fake.getText(key); } };
    await produceInputs({ usersListFile: listFile, limit: 2, dryRun: true, resumeDir: dir, ratingRoot: fakeRoot, featureAssetsDir: fakeAssetsDir, r2: resumableR2, logger: { log() {} } });
    const firstCalls = r2Calls;
    await produceInputs({ usersListFile: listFile, limit: 2, dryRun: true, resumeDir: dir, ratingRoot: fakeRoot, featureAssetsDir: fakeAssetsDir, r2: resumableR2, logger: { log() {} } });
    assert.equal(r2Calls, firstCalls + 1);
    await assert.rejects(() => produceInputs({ usersListFile: listFile, limit: 3, dryRun: true, resumeDir: dir, ratingRoot: fakeRoot, featureAssetsDir: fakeAssetsDir, r2: resumableR2, logger: { log() {} } }), /일치/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
  console.log('self-test-input: OK');
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.selfTest) return selfTestInput();
  const result = await produceInputs(options);
  if (!options.dryRun && result.completePopulation) return publishSnapshot(result);
  if (!options.dryRun) throw new Error('부분 모집단은 게시할 수 없습니다');
  return result;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}

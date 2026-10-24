import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
globalThis.fetch = () => { throw Error('network forbidden'); };
let serves = 0, imports = 0;
globalThis.Deno = { serve() { serves++; }, env: { get() { throw Error('global env'); } } };
registerHooks({ resolve(s, c, next) { if (s === 'aws4fetch') { imports++; return { url: 'test:aws', shortCircuit: true }; } return next(s, c); }, load(u, c, next) { return u === 'test:aws' ? { format: 'module', shortCircuit: true, source: 'export class AwsClient { async sign(u,i) { return new Request(u,i); } }' } : next(u,c); } });
const url = new URL('../../supabase/functions/dump-fast/index.ts', import.meta.url);
const { createDumpFastHandler, createReadAdapters, getOnlyFetch, loadDefaultReads } = await import(url.href);
assert.equal(serves, 0); assert.equal(imports, 0);
const { prepareFastDump, HIST_COLS } = await import('./dump-fast-core.mjs');
const secret = 's'.repeat(32), enc = x => new TextEncoder().encode(JSON.stringify(x));
const row = n => ({ score_id:n, iidx_id:'u1', song_id:1, diff:3, lamp:4, ex_score:100, played_version:32, date:'2026-10-23T00:00:00Z', date_kst:'2026-10-23', play_style:1, bp:2, note_count:100 });
const req = (x = { iidxId:'u1' }, init = {}) => new Request('https://local.invalid', { method:'POST', headers:{'content-type':'application/json','x-fast-dump-shadow-secret':secret}, body:JSON.stringify(x), ...init });
function fixture({ rows = [], real = false, published = [], compute, select, r2 } = {}) {
  const env = { FAST_DUMP_MODE:'shadow', FAST_DUMP_SHADOW_SECRET:secret };
  const user = { _v:'2026-10-24T03:00:00.000Z', dp:[], sp:[], dpRecent:[], spRecent:[] };
  const hist = enc(published), aliases = { v:1, rules:[] }, songs = [];
  const input = { iidxId:'u1', previousHistRows:published, restRows:[], aliases, aliasesBytes:enc(aliases), songs, previousUser:user, generation:1, nowMs:Date.parse(user._v) };
  if (real) Object.assign(user, prepareFastDump(input).fastPatch);
  const objects = new Map([['hist/u1.json',hist],['user/u1.json',enc(user)],['meta/song-aliases.json',enc(aliases)],['songs.json',enc(songs)]]);
  const calls = { select:0, r2:0, compute:0 }, offsets = [], inputs = [];
  const handler = createDumpFastHandler({ getEnv:k=>env[k], selectBuffer:async(id,o)=>{ calls.select++; offsets.push(o); return select ? select(id,o,calls.select) : {rows:rows.slice(o,o+1000),total:rows.length}; }, getR2:async k=>{ calls.r2++; return r2 ? r2(k,calls.r2,objects) : objects.get(k); }, prepareFastDump:i=>{ calls.compute++; inputs.push(i); return compute ? compute(i,calls.compute,{hist,user}) : real ? prepareFastDump(i) : {histBytes:hist,fastPatch:user}; } });
  return {handler,env,user,objects,calls,offsets,inputs};
}
async function check(f,status,reason,request=req()) { const r=await f.handler(request), b=await r.json(); assert.equal(r.status,status,JSON.stringify(b)); assert.equal(r.headers.get('cache-control'),'no-store'); if(reason) assert.equal(b.reason??b.status,reason); assert.doesNotMatch(JSON.stringify(b),/stack|Bearer|private-error|service-secret/); return b; }

test('mode and authentication fail before body, credentials or capability loading',async()=>{
  for(const [mode,s,auth,status] of [[undefined,secret,secret,503],['off',secret,secret,503],['publish',secret,secret,503],['unknown',secret,secret,503],['shadow',undefined,secret,503],['shadow','short',secret,503],['shadow',secret,'wrong',401]]) {
    let loaded=0, consumed=0;
    const handler=createDumpFastHandler({getEnv:k=>({FAST_DUMP_MODE:mode,FAST_DUMP_SHADOW_SECRET:s})[k],loadReads:async()=>{loaded++;throw Error();}});
    const request=req({}, {headers:{'x-fast-dump-shadow-secret':auth}}); Object.defineProperty(request,'body',{get(){consumed++;throw Error();}});
    await check({handler},status,null,request); assert.equal(loaded,0); assert.equal(consumed,0);
  }
});
test('request contract rejects methods, media, bytes, JSON, identifiers and extra inputs',async()=>{
  const f=fixture();
  for(const [request,status] of [[req({}, {method:'GET',body:undefined}),405],...['text/plain','application/jsonp'].map(t=>[req({}, {headers:{'content-type':t,'x-fast-dump-shadow-secret':secret}}),415]),[req({}, {body:' '.repeat(4097),headers:{'content-type':'application/json','content-length':'1','x-fast-dump-shadow-secret':secret}}),413],[req({}, {body:'"'+'한'.repeat(1400)+'"'}),413],[req({}, {body:'{'}),400],...[null,[],{}, {iidxId:1},{iidxId:'../x'},{iidxId:''},...['hist','buffer','expectedHash','nowMs','unknown'].map(k=>({iidxId:'u1',[k]:'private'}))].map(x=>[req(x),400])]) await check(f,status,null,request);
  assert.deepEqual(f.calls,{select:0,r2:0,compute:0});
});
test('real empty and reflected buffers replay at published ISO time',async()=>{
  for(const rows of [[],[row(1)]]) { const f=fixture({real:true,rows,published:rows.map(r=>HIST_COLS.map(k=>r[k]))}); assert.equal((await check(f,200,'matched')).matched,true); assert.equal(f.calls.compute,2); assert.ok(f.inputs.every(i=>i.nowMs===Date.parse(f.user._v)&&i.generation===1)); assert.deepEqual(f.inputs[0].restRows,[]); assert.deepEqual(f.inputs[1].aliasesBytes,f.objects.get('meta/song-aliases.json')); }
});
test('stable fast mismatch is 409 and new buffered history is inconclusive',async()=>{
  const f=fixture({compute:(i,n,{hist,user})=>({histBytes:hist,fastPatch:{...user,dp:[{song_id:1}]}})}); assert.equal((await check(f,409,'user_fast_fields_differ')).matched,false);
  assert.equal((await check(fixture({rows:[row(1)],real:true}),200,'buffer_not_reflected_or_reference_drift')).matched,null);
});
test('paging boundaries, incomplete reads, changed inputs, missing references and external failures',async()=>{
  for(const size of [1001,2000,50000]) {const f=fixture({rows:Array.from({length:size},(_,i)=>row(i+1))}); await check(f,200,'matched'); const offsets=Array.from({length:Math.floor(size/1000)+1},(_,i)=>i*1000); assert.deepEqual(f.offsets,[...offsets,...offsets]);}
  for(const after of [false,true]) for(const kind of ['over','missingTotal','changingTotal','shortMiddle','shortLast','duplicate','reverse','notArray','external']) {
    const all=Array.from({length:2001},(_,i)=>row(i+1));
    const f=fixture({select:(id,o,n)=>{let rows=all.slice(o,o+1000),total=all.length;if(!after||n>3){if(kind==='over')total=50001;if(kind==='missingTotal')total=undefined;if(kind==='changingTotal'&&o)total++;if(kind==='shortMiddle'&&o===1000)rows.pop();if(kind==='shortLast'&&o===2000)rows=[];if(kind==='duplicate'&&o===1000)rows[0]=row(1000);if(kind==='reverse'&&o===1000)rows[0]=row(999);if(kind==='notArray')rows={};if(kind==='external'&&o===1000)throw Error('private-error');}return {rows,total};}});
    await check(f,kind==='external'?502:200,kind==='external'?'upstream_read_failed':after?'inputs_changed':'buffer_incomplete'); if(!after)assert.equal(f.calls.compute,0);
  }
  await check(fixture({select:(id,o,n)=>({rows:Array.from({length:o?1:1000},(_,i)=>({...row(o+i+1),bp:n===4?99:2})),total:1001})}),200,'inputs_changed');
  for(const key of ['hist/u1.json','user/u1.json','meta/song-aliases.json','songs.json']) {
    await check(fixture({r2:(k,n,m)=>n>4&&k===key?enc({changed:true}):m.get(k)}),200,'inputs_changed');
    for(const after of [false,true])for(const status of [404,403,500]) {const a=createReadAdapters({getEnv:()=>'',fetchImpl:globalThis.fetch,r2Get:async()=>{throw Object.assign(Error('private-error'),{status});}}); await check(fixture({r2:(k,n,m)=>k===key&&(!after||n>4)?a.getR2(k):m.get(k)}),status===404?200:502,status===404?'reference_missing':'upstream_read_failed');}
  }
  for(const change of [u=>delete u.dp,u=>delete u._v,u=>{u._v='2026-02-30T00:00:00.000Z';}]) {const f=fixture();change(f.user);f.objects.set('user/u1.json',enc(f.user));await check(f,200,'reference_incompatible');}
  await check(fixture({compute:()=>({histBytes:enc([1])})}),200,'reference_incompatible');
  await check(fixture({compute:()=>{throw Error('private-error');}}),500,'calculation_failed');
});
test('lazy import and Buffer order; read adapters expose only GET and constrained keys and SELECT pages',async()=>{
  assert.equal(serves,0);assert.equal(imports,0);
  const source=readFileSync(url,'utf8');assert.ok(source.indexOf('(globalThis as any).Buffer = Buffer')<source.indexOf("await import('../../../.github/scripts/dump-fast-core.mjs')"));
  const saved=globalThis.Buffer;delete globalThis.Buffer;
  const env=k=>({SUPABASE_URL:'https://db.invalid',SUPABASE_SERVICE_ROLE_KEY:'service-secret',R2_ACCOUNT_ID:'acct',R2_ACCESS_KEY_ID:'key',R2_SECRET_ACCESS_KEY:'secret',R2_BUCKET:'bucket'})[k];
  const defaultRequests=[];
  const loaded=await loadDefaultReads(env,async(input,init)=>{defaultRequests.push(input instanceof Request?input.method:init.method);return new Response('[]',{headers:{'content-range':'*/0'}});});assert.equal(globalThis.Buffer,saved);assert.deepEqual(Object.keys(loaded).sort(),['getR2','prepareFastDump','selectBuffer']);
  await loaded.getR2('songs.json');await loaded.selectBuffer('u1',0);assert.deepEqual(defaultRequests,['GET','GET']);
  let sends=0;const boundary=getOnlyFetch(async(u,i)=>{sends++;assert.equal(i.method,'GET');return new Response('');});
  for(const method of ['PUT','DELETE','POST','PATCH','HEAD']){assert.throws(()=>boundary('https://x',{method}),/GET only/);assert.throws(()=>boundary(new Request('https://x',{method})),/GET only/);}assert.equal(sends,0);await boundary(new Request('https://x'));assert.equal(sends,1);
  const offsets=[];let gets=0;
  const a=createReadAdapters({getEnv:env,fetchImpl:getOnlyFetch(async(u,i)=>{const q=new URL(u).searchParams,o=Number(q.get('offset'));offsets.push(o);assert.equal(q.get('iidx_id'),'eq.u1');assert.equal(q.get('played_version'),'neq.-10');assert.equal(q.get('select'),['score_id','iidx_id',...HIST_COLS].join(','));assert.equal(q.get('order'),'score_id.asc');assert.equal(q.get('limit'),'1000');assert.equal(new Headers(i.headers).get('Prefer'),'count=exact');const rows=Array.from({length:o?1:1000},(_,i)=>row(o+i+1));return new Response(JSON.stringify(rows),{headers:{'content-range':`${o}-${o+rows.length-1}/1001`}});}),r2Get:async()=>{gets++;return enc([]);}});
  for(const key of ['pending/u1.json','../songs.json','hist/../u1.json','hist/u-1.json','user/u1.json?x','candidate/u1.json'])await assert.rejects(a.getR2(key),/invalid R2 key/);assert.equal(gets,0);
  for(const key of ['hist/u1.json','user/u1.json','songs.json','meta/song-aliases.json'])await a.getR2(key);assert.equal(gets,4);assert.deepEqual(Object.keys(a).sort(),['getR2','selectBuffer']);
  const f=fixture();const handler=createDumpFastHandler({getEnv:k=>f.env[k],selectBuffer:a.selectBuffer,getR2:async k=>f.objects.get(k),prepareFastDump:()=>({histBytes:enc([]),fastPatch:f.user})});await check({handler},200,'matched');assert.deepEqual(offsets,[0,1000,0,1000]);
  let encoded;const encodedAdapter=createReadAdapters({getEnv:env,fetchImpl:async u=>{encoded=u;return new Response('[]',{headers:{'content-range':'*/0'}});},r2Get:async()=>enc([])});await encodedAdapter.selectBuffer('a+b',0);assert.match(encoded,/iidx_id=eq.a%2Bb/);
  for(const [range,body] of [['0-0/0',[]],['1-1/1',[row(1)]],['0-2/1',[row(1)]],['*/1',{}],['0-0/*',[row(1)]],['',[]]]){const a=createReadAdapters({getEnv:env,fetchImpl:async()=>new Response(JSON.stringify(body),{headers:{'content-range':range}}),r2Get:async()=>enc([])});await assert.rejects(a.selectBuffer('u1',0));}
  await check({handler:createDumpFastHandler({getEnv:k=>f.env[k],loadReads:()=>loadDefaultReads(()=>undefined)})},503,'configuration_unavailable');
});

test('publish validates its independent secret and exact generation request before loading adapters',async()=>{
  const publishSecret='p'.repeat(32), env={FAST_DUMP_MODE:'publish',FAST_DUMP_LIGHT_SECRET:publishSecret};
  for(const [headers,status] of [[{'x-fast-dump-light-secret':'wrong'},401],[{'x-fast-dump-light-secret':publishSecret},400]]) {
    let loaded=0;
    const handler=createDumpFastHandler({getEnv:k=>env[k],loadReads:async()=>{loaded++;throw Error('should not load');}});
    const input=status===401?{iidxId:'u1',generation:'1',since:'2026-10-24T00:00:00.000Z'}:{iidxId:'u1',generation:'1',since:'2026-10-24T00:00:00.000Z',extra:true};
    const r=await handler(new Request('https://local.invalid',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(input)}));
    const b=await r.json();assert.equal(r.status,status);assert.equal(b.mode,'publish');assert.equal(loaded,0);assert.doesNotMatch(JSON.stringify(b),/secret|Bearer|Authorization/i);
  }
  assert.match(readFileSync(url,'utf8'),/FAST_DUMP_LIGHT_SECRET/);assert.match(readFileSync(url,'utf8'),/x-fast-dump-light-secret/);
});

test('publish injects the shared worker and constrains S3 writes to user and pending with ETag CAS',async()=>{
  const publishSecret='p'.repeat(32), env={FAST_DUMP_MODE:'publish',FAST_DUMP_LIGHT_SECRET:publishSecret,R2_ACCOUNT_ID:'acct',R2_ACCESS_KEY_ID:'key',R2_SECRET_ACCESS_KEY:'secret',R2_BUCKET:'bucket'};
  const user={_v:'2026-10-24T03:00:00.000Z',dp:[],sp:[],dpRecent:[],spRecent:[]};
  const pending={generation:'2',since:'2026-10-24T02:00:00.000Z'};
  const store=new Map([['pending/u1.json',{body:JSON.stringify(pending),etag:'"p1"'}],['user/u1.json',{body:JSON.stringify(user),etag:'"u1"'}],['hist/u1.json',{body:'[]',etag:'"h1"'}],['meta/song-aliases.json',{body:'{"v":1,"rules":[]}',etag:'"a1"'}],['songs.json',{body:'[]',etag:'"s1"'}]]);
  const writes=[], reads=[];
  const handler=createDumpFastHandler({getEnv:k=>env[k],loadReads:async()=>({selectBuffer:async()=>({rows:[],total:0}),getR2:async()=>new Uint8Array(),prepareFastDump:()=>({histBytes:enc([]),fastPatch:{dp:[1],sp:[],dpRecent:[],spRecent:[]}})})});
  const realFetch=globalThis.fetch;
  globalThis.fetch=async(input,init)=>{
    const req=input instanceof Request?input:new Request(input,init), path=new URL(req.url).pathname;
    const key=decodeURIComponent(path.slice(path.indexOf('/bucket/')+8)); reads.push([req.method,key,req.headers.get('if-match')]);
    if(req.method==='GET') {const item=store.get(key);if(!item)return new Response('',{status:404});return new Response(item.body,{headers:{etag:item.etag}});}
    writes.push([req.method,key,req.headers.get('if-match')]);
    const item=store.get(key);if(!item||req.headers.get('if-match')!==item.etag)return new Response('',{status:412});
    store.set(key,{body:await req.text(),etag:'"next"'});return new Response('',{status:200});
  };
  try {
    const request=new Request('https://local.invalid',{method:'POST',headers:{'content-type':'application/json','x-fast-dump-light-secret':publishSecret},body:JSON.stringify({iidxId:'u1',generation:'2',since:pending.since})});
    const r=await handler(request), b=await r.json();assert.equal(r.status,200,JSON.stringify(b));assert.equal(b.done,true);assert.deepEqual(writes.map(x=>x.slice(0,2)),[['PUT','user/u1.json'],['PUT','pending/u1.json']]);assert.deepEqual(writes.map(x=>x[2]),['"u1"','"p1"']);assert.ok(reads.some(x=>x[0]==='GET'&&x[1]==='user/u1.json'));
  } finally {globalThis.fetch=realFetch;}
  const source=readFileSync(url,'utf8');assert.match(source,/dump-fast-worker\.ts/);assert.match(source,/r2\.put\(key, new TextEncoder\(\)\.encode\(value\), \{ ifMatch: etag \}\)/);
});

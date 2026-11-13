import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLyricService, fingerprintOf, decodeQQText, resetNeteaseSearchBackoff } from '../lib/lyric-service.js';
const facts={title:'Hello',artist:'Adele',durationSec:295};
const ncmSong={id:1,name:'Hello',artists:[{name:'Adele'}],duration:295000};
const qqSong={songmid:'002Il7Ya1tZ6UZ',songname:'Hello',singer:[{name:'Adele'}],interval:295};
const lrc='[00:01.00]Hello\n[00:03.00]World';
const base64=x=>Buffer.from(x).toString('base64');
const ok=x=>({ok:true,json:async()=>x});
const KG_HASH='b3a52a7a958bf0aed0ebfba2e9a818b7';
const MIGU_LRC_URL='https://d.musicapp.migu.cn/data/oss/resource/aa/bb/cc/hello.lrc';
function make({ncm='hit',qq='hit',kugou='hit',migu='hit',ncmLyrics='hit',qqLyrics='hit',kgLyrics='hit',miguLyrics='hit',...opts}={}){
 const calls=[];
 const fetchImpl=async(url,options)=>{
  const u=new URL(url);calls.push(u);
  const source=u.hostname==='c.y.qq.com'?'qq'
   :u.hostname==='u.y.qq.com'?'qq'
   :u.hostname.includes('kugou')?'kugou'
   :u.hostname.includes('migu')?'migu':'netease';
  const referer=source==='qq'?'https://y.qq.com/'
   :source==='kugou'?'https://www.kugou.com/'
   :source==='migu'?'https://music.migu.cn/v3/':'https://music.163.com/';
  assert.equal(options.headers.referer,referer);
  const kgSearch=u.hostname==='songsearch.kugou.com';
  const kgCandidates=u.hostname==='krcs.kugou.com';
  const miguSearch=u.hostname==='app.u.nf.migu.cn';
  const musicu=u.hostname==='u.y.qq.com';
  const search=u.pathname.includes('search');
  const mode=source==='kugou'?(kgSearch?kugou:kgLyrics)
   :source==='migu'?(miguSearch?migu:miguLyrics)
   :source==='qq'?(musicu?qqLyrics:(search?qq:qqLyrics)):(search?ncm:ncmLyrics);
  if(mode==='network')throw Error('network down');
  if(mode==='http')return {ok:false,status:503};
  if(mode==='api')return ok({code:429});
  if(mode==='json')return {ok:true,json:async()=>{throw new SyntaxError('bad json');}};
  if(mode==='shape')return ok(source==='kugou'?{status:1}:{code:source==='qq'?0:200,data:{}});
  if(mode==='timeout')return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('timeout not enforced')),200);
   options.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(options.signal.reason);},{once:true});
  });
  if(source==='migu'){
   if(miguSearch){
    // Bare array, no envelope; `duration` is SECONDS here.
    const song={songName:'Hello',singerList:[{name:'Adele'}],copyrightId:'60054701941',
     duration:295,lrcUrl:MIGU_LRC_URL,contentId:'c1'};
    if(mode==='wrong-title')song.songName='Other';
    if(mode==='wrong-artist')song.singerList=[{name:'Another Singer'}];
    if(mode==='wrong-duration')song.duration=900;
    if(mode==='no-lrc')song.lrcUrl='';
    return ok(mode==='empty'?[]:[song]);
   }
   // The lyric URL returns LRC text, not JSON.
   const raw=mode==='empty'?'':mode==='untimed'?'Plain lyrics without timestamps'
    :mode==='bom'?'\ufeff[00:01.00]Hello\r\n[00:03.00]World\r\n':lrc;
   return {ok:true,status:200,text:async()=>raw,json:async()=>{throw Error('migu lyric is text');}};
  }
  if(source==='kugou'){
   if(kgSearch){
    const song={FileHash:KG_HASH,SongName:'Hello',SingerName:'Adele',Duration:295,FileName:'Adele - Hello'};
    if(mode==='wrong-title')song.SongName='Other';
    if(mode==='wrong-artist')song.SingerName='Another Singer';
    if(mode==='wrong-duration')song.Duration=900;
    return ok({status:1,data:{lists:mode==='empty'?[]:[song]}});
   }
   if(kgCandidates){
    return ok({status:200,candidates:mode==='empty'?[]:[{id:'kg1',accesskey:'key1',song:'Hello',singer:'Adele',duration:295000}]});
   }
   const raw=mode==='empty'?'':mode==='untimed'?'Plain lyrics without timestamps':lrc;
   return ok({status:200,content:base64(raw)});
  }
  if(search){
   const song={...(source==='qq'?qqSong:ncmSong)};
   if(mode==='wrong-title'){song.name='Other';song.songname='Other';}
   if(mode==='wrong-artist'){song.artists=[{name:'Another Singer'}];song.singer=[{name:'Another Singer'}];}
   if(mode==='wrong-duration'){song.duration=900000;song.interval=900;}
   return source==='qq'?ok({code:0,data:{song:{list:mode==='empty'?[]:[song]}}}):ok({code:200,result:{songs:mode==='empty'?[]:[song]}});
  }
  const raw=mode==='empty'?'':mode==='untimed'?'Plain lyrics without timestamps':lrc;
  // QQ now reads musicu's plain-base64 lyric+translation first; the legacy fcg
  // endpoint is only a fallback for the lyric text.
  if(musicu){
   if(mode==='network')throw Error('network down');
   if(mode==='http')return {ok:false,status:503};
   if(mode==='json')return {ok:true,json:async()=>{throw new SyntaxError('bad json');}};
   if(mode==='api')return ok({code:-1});
   if(mode==='shape')return ok({code:0});
   if(mode==='reqcode')return ok({code:0,req:{code:-1}});
   if(mode==='empty')return ok({code:0,req:{code:0,data:{lyric:'',trans:''}}});
   return ok({code:0,req:{code:0,data:{lyric:base64(raw),trans:base64('[00:01.06]你好 &amp; 世界')}}});
  }
  return source==='qq'?ok({code:0,retcode:0,lyric:base64(raw),trans:base64('[00:01.06]你好 &amp; 世界')}):ok({code:200,lrc:{lyric:raw},tlyric:{lyric:'[00:01.06]你好'}});
 };
 return {service:createLyricService({fetchImpl,minRequestGapMs:0,requestTimeoutMs:15,...opts}),calls};
}
let count=0;
async function check(name,fn){await fn();count++;console.log('PASS '+name);}
await check('网易云命中时不请求 QQ',async()=>{
 const {service,calls}=make();const result=await service.resolve(facts);
 assert.equal(result.source,'netease');assert.equal(result.fallbackUsed,false);assert.equal(calls.length,2);
 assert.equal(result.lines[0].trans,'你好');assert.equal(result.attempts.length,1);
});
for(const mode of ['empty','wrong-title','wrong-artist','wrong-duration','network','http','api','json','shape','timeout']){
 await check('网易云搜索 '+mode+' -> QQ 歌词',async()=>{
  const {service}=make({ncm:mode});const r=await service.resolve(facts);
  assert.equal(r.status,'matched');assert.equal(r.source,'qq');assert.equal(r.fallbackUsed,true);
  assert.equal(r.attempts.length,2);assert.equal(r.lines[0].trans,'你好 & 世界');
  assert.equal(r.songId,'002Il7Ya1tZ6UZ');
 });
}
for(const mode of ['empty','untimed','network','http','api','json']){
 await check('网易云歌词 '+mode+' -> QQ 歌词',async()=>{
  const {service}=make({ncmLyrics:mode});assert.equal((await service.resolve(facts)).source,'qq');
 });
}
await check('四源无匹配且无本地文件 -> unmatched',async()=>{
 const {service,calls}=make({ncm:'empty',qq:'empty',kugou:'empty',migu:'empty'});const r=await service.resolve(facts);
 assert.equal(r.status,'unmatched');assert.equal(r.attempts.length,5);
 assert.equal(r.attempts[4].source,'local');assert.equal(r.attempts[4].reason,'no-search-dirs');
 await service.resolve(facts);assert.equal(calls.length,4,'negative cache prevents repeated requests');
 service.invalidate(fingerprintOf(facts.title,facts.artist));await service.resolve(facts);assert.equal(calls.length,8);
});
await check('四源故障 -> error 保留原因',async()=>{
 const {service}=make({ncm:'network',qq:'api',kugou:'network',migu:'network'});const r=await service.resolve(facts);
 assert.equal(r.status,'error');assert(r.message.includes('network down'));assert(r.message.includes('429'));
});
await check('无匹配 + QQ 故障 -> error',async()=>{
 assert.equal((await make({ncm:'empty',qq:'network',kugou:'network',migu:'network'}).service.resolve(facts)).status,'error');
});
await check('QQ 无带时间歌词不伪装成功',async()=>{
 const r=await make({ncm:'empty',kugou:'empty',migu:'empty',qqLyrics:'untimed'}).service.resolve(facts);
 assert.equal(r.status,'unmatched');assert.equal(r.attempts[1].reason,'no-timed-lyrics');
});
await check('网易云/QQ 未命中 -> 酷狗歌词',async()=>{
 const {service,calls}=make({ncm:'empty',qq:'empty'});
 const r=await service.resolve(facts);
 assert.equal(r.status,'matched');assert.equal(r.source,'kugou');assert.equal(r.sourceLabel,'酷狗音乐');
 assert.equal(r.fallbackUsed,true);assert.equal(r.attempts.length,3);
 assert.equal(r.lines[0].text,'Hello');assert.equal(r.songId,KG_HASH);
 assert.equal(calls.length,5,'netease search, qq search, kugou search + candidates + download');
});
await check('酷狗无候选 -> 继续回退且记录原因',async()=>{
 const r=await make({ncm:'empty',qq:'empty',kugou:'empty',migu:'empty'}).service.resolve(facts);
 assert.equal(r.status,'unmatched');assert.equal(r.attempts[2].source,'kugou');
 assert.equal(r.attempts[2].reason,'no-confident-match');
});
await check('酷狗无带时间歌词不伪装成功',async()=>{
 const r=await make({ncm:'empty',qq:'empty',migu:'empty',kgLyrics:'untimed'}).service.resolve(facts);
 assert.equal(r.status,'unmatched');assert.equal(r.attempts[2].reason,'no-timed-lyrics');
});
await check('网易云/QQ/酷狗未命中 -> 咪咕歌词',async()=>{
 const {service,calls}=make({ncm:'empty',qq:'empty',kugou:'empty'});
 const r=await service.resolve(facts);
 assert.equal(r.status,'matched');assert.equal(r.source,'migu');assert.equal(r.sourceLabel,'咪咕音乐');
 assert.equal(r.fallbackUsed,true);assert.equal(r.attempts.length,4);
 assert.equal(r.lines[0].text,'Hello');assert.equal(r.songId,'60054701941');
 // duration is reported in seconds and must be converted to ms for the scorer
 assert.equal(calls.length,5,'netease/qq/kugou searches + migu search + migu lyric text');
});
await check('咪咕无候选 -> 继续回退且记录原因',async()=>{
 const r=await make({ncm:'empty',qq:'empty',kugou:'empty',migu:'empty'}).service.resolve(facts);
 assert.equal(r.attempts[3].source,'migu');assert.equal(r.attempts[3].reason,'no-confident-match');
});
await check('咪咕无带时间歌词不伪装成功',async()=>{
 const r=await make({ncm:'empty',qq:'empty',kugou:'empty',miguLyrics:'untimed'}).service.resolve(facts);
 assert.equal(r.attempts[3].source,'migu');assert.equal(r.attempts[3].reason,'no-timed-lyrics');
});
await check('咪咕缺 lrcUrl 的候选被丢弃（歌词地址只能来自搜索响应）',async()=>{
 const r=await make({ncm:'empty',qq:'empty',kugou:'empty',migu:'no-lrc'}).service.resolve(facts);
 assert.equal(r.attempts[3].reason,'no-confident-match');
});
await check('咪咕错歌手/错时长不匹配（硬过滤 + 版本校验）',async()=>{
 assert.equal((await make({ncm:'empty',qq:'empty',kugou:'empty',migu:'wrong-artist'}).service.resolve(facts)).attempts[3].reason,'no-confident-match');
 assert.equal((await make({ncm:'empty',qq:'empty',kugou:'empty',migu:'wrong-duration'}).service.resolve(facts)).attempts[3].reason,'no-confident-match');
});
await check('咪咕 LRC 的 BOM 与 CRLF 被清洗',async()=>{
 const r=await make({ncm:'empty',qq:'empty',kugou:'empty',miguLyrics:'bom'}).service.resolve(facts);
 assert.equal(r.status,'matched');assert.equal(r.source,'migu');
 assert.equal(r.lines.length,2);assert.equal(r.lines[0].text,'Hello');
 assert(!r.lines[0].text.includes('\ufeff'),'BOM stripped');
});
await check('三源失败 -> 读取歌曲旁的 .lrc',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-lyrics-local-'));
 const file=path.join(dir,'Adele - Hello.lrc');
 try{
  await fs.writeFile(file,'[00:02.00]Sidecar line\n[00:05.50]Second line','utf8');
  const {service,calls}=make({ncm:'empty',qq:'empty',kugou:'empty',migu:'empty',localDirs:[dir]});
  const r=await service.resolve(facts);
  assert.equal(r.status,'matched');assert.equal(r.source,'local');assert.equal(r.sourceLabel,'本地文件');
  assert.equal(r.lines.length,2);assert.equal(r.lines[0].t,2);assert.equal(r.lines[1].text,'Second line');
  assert.equal(r.attempts.length,5);assert.equal(calls.length,4,'local pass issues no request');
 }finally{
  await fs.unlink(file).catch(()=>{});await fs.rmdir(dir).catch(()=>{});
 }
});
await check('本地无时间轴歌词 -> 合成时间轴并标注',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-lyrics-plain-'));
 const file=path.join(dir,'Adele - Hello.lrc');
 try{
  await fs.writeFile(file,'first line\nsecond line\nthird line','utf8');
  const r=await make({ncm:'empty',qq:'empty',kugou:'empty',migu:'empty',localDirs:[dir]}).service.resolve(facts);
  assert.equal(r.status,'matched');assert.equal(r.unsynced,true);
  assert(r.sourceLabel.includes('无时间轴'));
  assert.equal(r.lines.length,3);assert(r.lines[1].t>r.lines[0].t);assert.equal(r.lines[0].text,'first line');
 }finally{
  await fs.unlink(file).catch(()=>{});await fs.rmdir(dir).catch(()=>{});
 }
});
await check('localLyrics=false 时不扫描本地',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-lyrics-off-'));
 const file=path.join(dir,'Adele - Hello.lrc');
 try{
  await fs.writeFile(file,'[00:02.00]Sidecar line','utf8');
  const r=await make({ncm:'empty',qq:'empty',kugou:'empty',migu:'empty',localDirs:[dir],localLyrics:false}).service.resolve(facts);
  assert.equal(r.status,'unmatched');assert.equal(r.attempts[4].reason,'disabled');
 }finally{
  await fs.unlink(file).catch(()=>{});await fs.rmdir(dir).catch(()=>{});
 }
});
await check('QQ 成功缓存、并发去重和手动重试',async()=>{
 const {service,calls}=make({ncm:'empty',migu:'empty'});
 const result=await Promise.all([service.resolve(facts),service.resolve(facts),service.resolve(facts)]);
 assert(result.every(r=>r.source==='qq'));assert.equal(calls.length,3);
 await service.resolve(facts);assert.equal(calls.length,3);
 service.invalidate(fingerprintOf('Hello','Adele'));await service.resolve(facts);assert.equal(calls.length,6);
});
await check('不同时长和版本不共用缓存',async()=>{
 const {service,calls}=make();await service.resolve(facts);
 const r=await service.resolve({...facts,durationSec:400});assert.notEqual(r.status,'matched');
 const afterDuration=calls.length;assert(afterDuration>4);
 await service.resolve({...facts,title:'Hello (Live)'});assert(calls.length>afterDuration);
});
await check('旧缓存不挡住新回退；新缓存可恢复 QQ 来源',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-lyrics-fallback-test-'));
 const file=path.join(dir,'cache.json');
 try{
  await fs.writeFile(file,JSON.stringify({version:1,entries:{[fingerprintOf('Hello','Adele')]:{status:'unmatched',fetchedAt:Date.now()}}}));
  const {service,calls}=make({ncm:'empty',migu:'empty',cacheFile:file});assert.equal((await service.resolve(facts)).source,'qq');assert.equal(calls.length,3);
  await new Promise(resolve=>setTimeout(resolve,2200));
  const saved=JSON.parse(await fs.readFile(file,'utf8'));assert.equal(saved.version,2);
  const fresh=make({cacheFile:file});assert.equal((await fresh.service.resolve(facts)).source,'qq');assert.equal(fresh.calls.length,0);
 }finally{
  // Only remove the exact test-created files/directory, whose paths were allocated above.
  await fs.unlink(file).catch(()=>{});await fs.unlink(file+'.tmp').catch(()=>{});await fs.rmdir(dir);
 }
});
await check('corrupt cache entries do not prevent a later valid entry restoring', async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-corrupt-cache-'));
 const file=path.join(dir,'cache.json');
 try{
  const entry={status:'matched',source:'qq',fetchedAt:Date.now(),lines:[{t:1,text:'cached valid'}]};
  const key=fingerprintOf(facts.title,facts.artist)+'|hello|295';
  await fs.writeFile(file,JSON.stringify({version:2,entries:[
   null,42,{},['incomplete'],
   ['null-row',{...entry,lines:[null]}],
   ['primitive-row',{...entry,lines:['bad']}],
   ['unsorted',{...entry,lines:[{t:2,text:'later'},{t:1,text:'earlier'}]}],
   [key,entry]
  ]}));
  const {service,calls}=make({cacheFile:file});
  const result=await service.resolve(facts);
  assert.equal(result.source,'qq');assert.equal(result.lines[0].text,'cached valid');
  assert.equal(calls.length,0,'valid entry after corrupt entries must still restore');
  assert.equal(service.describe().entries,1,'malformed and unsorted entries must be rejected');
 }finally{
  await fs.unlink(file).catch(()=>{});await fs.rmdir(dir);
 }
});
await check('local cache is not persisted or restored across local configuration changes', async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-local-cache-'));
 const cacheFile=path.join(dir,'cache.json'), sidecar=path.join(dir,'Adele - Hello.lrc');
 const empty={ncm:'empty',qq:'empty',kugou:'empty',migu:'empty'};
 try{
  await fs.writeFile(sidecar,'[00:02.00]current local file','utf8');
  const original=make({...empty,cacheFile,localDirs:[dir]});
  assert.equal((await original.service.resolve(facts)).source,'local');
  await new Promise(resolve=>setTimeout(resolve,2200));
  const saved=JSON.parse(await fs.readFile(cacheFile,'utf8'));
  assert(!saved.entries.some(([,entry])=>entry.source==='local'),'local entries must stay out of disk cache');
  // Seed the old v2 format explicitly: restore must reject local entries too.
  const key=fingerprintOf(facts.title,facts.artist)+'|hello|295';
  await fs.writeFile(cacheFile,JSON.stringify({version:2,entries:[[key,{
   status:'matched',source:'local',lines:[{t:1,text:'stale old directory'}],fetchedAt:Date.now()
  }]]}));
  const disabled=make({...empty,cacheFile,localDirs:[dir],localLyrics:false});
  const off=await disabled.service.resolve(facts);
  assert.equal(off.status,'unmatched');assert.equal(off.attempts.at(-1).reason,'disabled');
  assert.equal(disabled.calls.length,4,'old local cache must not bypass current policy');
  const changed=make({...empty,cacheFile,localDirs:[dir]});
  const fresh=await changed.service.resolve(facts);
  assert.equal(fresh.source,'local');assert.equal(fresh.lines[0].text,'current local file');
  assert.equal(changed.calls.length,4);
 }finally{
  for(const file of [sidecar,cacheFile,cacheFile+'.tmp']) await fs.unlink(file).catch(()=>{});
  await fs.rmdir(dir);
 }
});
await check('HTML 实体和 UTF-8 译文解码',async()=>{
 assert.equal(decodeQQText(base64('[00:01.00]&#20320;&#x597d; &lt;世界&gt;')),'[00:01.00]你好 <世界>');
});
// QQ translation regression (2026-11-11): the legacy fcg_query_lyric_new.fcg
// endpoint returns `trans: ''` for EVERY song measured (8/8), so QQ never showed
// a translation. The translation only exists on musicu GetPlayLyricInfo. A
// regression here is silent — the capsule would simply lose its second line.
await check('QQ 译文来自 musicu（单次请求同时取回原文和译文）',async()=>{
 const {service,calls}=make({ncm:'empty',migu:'empty',kugou:'empty',qqLyrics:'hit'});
 // force QQ first through the origin hint so the assertion cannot depend on
 // netease returning nothing
 const r=await service.resolve({...facts,originSource:'qq'});
 assert.equal(r.source,'qq');
 assert(r.lines.length>0);
 assert.equal(r.lines[0].trans,'你好 & 世界','QQ translation must reach the wire lines');
 // the musicu POST must be what delivered it: the fallback GET is not consulted
 assert(calls.some(u=>u.hostname==='u.y.qq.com'),'musicu endpoint is used');
 assert(!calls.some(u=>u.pathname.includes('fcg_query_lyric_new')),'legacy fcg skipped when musicu succeeds');
});
await check('QQ 译文里的 // 占位行被丢弃（不把占位当翻译）',async()=>{
 const calls=[];
 const fetchImpl=async(url,options)=>{
  const u=new URL(url);
  if(u.hostname==='music.u.qq.com')throw Error('unexpected');
  if(u.hostname==='u.y.qq.com'){
   const raw='[00:01.00]Hello\n[00:02.00]World';
   const trans='[00:01.00]//\n[00:02.00]世界\n[00:02.10]QQ音乐享有本翻译作品的著作权';
   return {ok:true,json:async()=>({code:0,req:{code:0,data:{lyric:base64(raw),trans:base64(trans)}}})};
  }
  if(u.hostname==='c.y.qq.com'){
   if(u.pathname.includes('client_search_cp'))return {ok:true,json:async()=>({code:0,data:{song:{list:[{songmid:'m1',songname:'Hello',singer:[{name:'Adele'}],interval:295}]}}})};
   throw Error('legacy lyric endpoint must not be reached');
  }
  if(u.hostname==='music.163.com')return {ok:true,json:async()=>({code:200,result:{songCount:0}})};
  if(u.hostname==='songsearch.kugou.com')return {ok:true,json:async()=>({status:1,data:{lists:[]}})};
  if(u.hostname==='app.u.nf.migu.cn')return {ok:true,json:async()=>[]};
  throw Error('unexpected '+url);
 };
 const service=createLyricService({fetchImpl,minRequestGapMs:0,requestTimeoutMs:15,localLyrics:false});
 const r=await service.resolve({...facts,originSource:'qq'});
 assert.equal(r.source,'qq');
 assert.equal(r.lines[0].text,'Hello');
 assert.equal(r.lines[0].trans,undefined,'"//" must not be treated as a translation');
 assert.equal(r.lines[1].trans,'世界');
});
await check('musicu 失败时回退到 fcg 原文（译文缺失但不丢歌词）',async()=>{
 const fetchImpl=async(url)=>{
  const u=new URL(url);
  if(u.hostname==='u.y.qq.com')return {ok:false,status:500};
  if(u.hostname==='c.y.qq.com'){
   if(u.pathname.includes('client_search_cp'))return {ok:true,json:async()=>({code:0,data:{song:{list:[{songmid:'m1',songname:'Hello',singer:[{name:'Adele'}],interval:295}]}}})};
   return {ok:true,json:async()=>({code:0,retcode:0,lyric:base64('[00:01.00]Hello'),trans:''})};
  }
  if(u.hostname==='music.163.com')return {ok:true,json:async()=>({code:200,result:{songCount:0}})};
  if(u.hostname==='songsearch.kugou.com')return {ok:true,json:async()=>({status:1,data:{lists:[]}})};
  if(u.hostname==='app.u.nf.migu.cn')return {ok:true,json:async()=>[]};
  throw Error('unexpected '+url);
 };
 const service=createLyricService({fetchImpl,minRequestGapMs:0,requestTimeoutMs:15,localLyrics:false});
 const r=await service.resolve({...facts,originSource:'qq'});
 assert.equal(r.source,'qq','a musicu outage must not lose the lyric entirely');
 assert.equal(r.lines.length,1);
 assert.equal(r.lines[0].text,'Hello');
});
await check('musicu 与 fcg 都空 -> 上报 musicu 的真实错误',async()=>{
 const fetchImpl=async(url)=>{
  const u=new URL(url);
  if(u.hostname==='u.y.qq.com')return {ok:true,json:async()=>({code:0,req:{code:-1901}})};
  if(u.hostname==='c.y.qq.com'){
   if(u.pathname.includes('client_search_cp'))return {ok:true,json:async()=>({code:0,data:{song:{list:[{songmid:'m1',songname:'Hello',singer:[{name:'Adele'}],interval:295}]}}})};
   return {ok:true,json:async()=>({code:0,retcode:0,lyric:'',trans:''})};
  }
  if(u.hostname==='music.163.com')return {ok:true,json:async()=>({code:200,result:{songCount:0}})};
  if(u.hostname==='songsearch.kugou.com')return {ok:true,json:async()=>({status:1,data:{lists:[]}})};
  if(u.hostname==='app.u.nf.migu.cn')return {ok:true,json:async()=>[]};
  throw Error('unexpected '+url);
 };
 const service=createLyricService({fetchImpl,minRequestGapMs:0,requestTimeoutMs:15,localLyrics:false});
 const r=await service.resolve({...facts,originSource:'qq'});
 const qqAttempt=r.attempts.find(a=>a.source==='qq');
 assert(qqAttempt,'qq attempt recorded');
 assert.equal(qqAttempt.status,'error');
 assert(qqAttempt.reason.includes('-1901'),'the gateway code is surfaced: '+qqAttempt.reason);
});
await check('本地双语 sidecar：同戳译文折成 trans，原文不再被顶掉',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-lyrics-bi-'));
 const file=path.join(dir,'Adele - Hello.lrc');
 try{
  // The exact shape lyric sites ship: original then translation, same stamp.
  await fs.writeFile(file,'[00:06.19]Hello, it\'s me\n[00:06.19]你好，是我\n[00:11.77]I was wondering\n[00:11.77]我想知道',{encoding:'utf8'});
  const r=await make({ncm:'empty',qq:'empty',kugou:'empty',migu:'empty',localDirs:[dir]}).service.resolve(facts);
  assert.equal(r.source,'local');
  // Two lines, not four: the translation moved into `trans`.
  assert.equal(r.lines.length,2,'paired rows must collapse, got '+JSON.stringify(r.lines));
  assert.equal(r.lines[0].text,'Hello, it\'s me');
  assert.equal(r.lines[0].trans,'你好，是我');
  assert.equal(r.lines[1].trans,'我想知道');
 }finally{
  await fs.unlink(file).catch(()=>{});await fs.rmdir(dir).catch(()=>{});
 }
});
await check('本地单语 sidecar：不误折、不丢行',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-lyrics-mono-'));
 const file=path.join(dir,'Adele - Hello.lrc');
 try{
  await fs.writeFile(file,'[00:06.19]first\n[00:11.77]second\n[00:17.00]third','utf8');
  const r=await make({ncm:'empty',qq:'empty',kugou:'empty',migu:'empty',localDirs:[dir]}).service.resolve(facts);
  assert.equal(r.lines.length,3);
  assert.equal(r.lines.every(l=>l.trans===undefined),true,'monolingual rows must not gain a trans');
 }finally{
  await fs.unlink(file).catch(()=>{});await fs.rmdir(dir).catch(()=>{});
 }
});
await check('foldBilingualLines：同语种换行拼回一句，三语种合并且只保留一条原文',async()=>{
 const {foldBilingualLines}=await import('../lib/lyric-service.js');
 const wrapped=foldBilingualLines([{t:1,text:'a long sentence'},{t:1,text:'wrapped across rows'}]);
 assert.equal(wrapped.length,1);
 assert.equal(wrapped[0].text,'a long sentence wrapped across rows');
 const tri=foldBilingualLines([{t:10,text:'原文'},{t:10,text:'translation'},{t:10,text:'romaji'}]);
 assert.equal(tri.length,1);
 assert.equal(tri[0].text,'原文');
 assert.equal(tri[0].trans,'translation\nromaji');
 const dup=foldBilingualLines([{t:5,text:'same'},{t:5,text:'same'}]);
 assert.equal(dup.length,1);
 assert.equal(dup[0].trans,undefined,'an exact duplicate is not a translation');
 // An already-paired online row is never folded again.
 const paired=foldBilingualLines([{t:1,text:'a',trans:'甲'},{t:1,text:'b',trans:'乙'}]);
 assert.equal(paired.length,2);
 assert.equal(paired[1].trans,'乙');
 // Two bilingual pairs inside ONE 0.25s group (dense karaoke/rap timing).
 // The old "first row = original, rest = translation" fold swallowed the
 // second original line into the translation blob — it vanished from the
 // display entirely.
 const dense=foldBilingualLines([
  {t:10,text:'word one'},{t:10,text:'词一'},
  {t:10.2,text:'word two'},{t:10.2,text:'词二'},
 ]);
 assert.equal(dense.length,2,'both pairs must survive as their own lines');
 assert.equal(dense[0].text,'word one');
 assert.equal(dense[0].trans,'词一');
 assert.equal(dense[1].text,'word two');
 assert.equal(dense[1].trans,'词二');
 // A wrapped original followed by its translation, then ANOTHER pair.
 const denseWrapped=foldBilingualLines([
  {t:20,text:'long line'},{t:20,text:'wrapped here'},{t:20,text:'长句'},
  {t:20.15,text:'next'},{t:20.15,text:'次句'},
 ]);
 assert.equal(denseWrapped.length,2);
 assert.equal(denseWrapped[0].text,'long line wrapped here');
 assert.equal(denseWrapped[0].trans,'长句');
 assert.equal(denseWrapped[1].text,'next');
 // A group opening with punctuation ('...'): the first script-bearing row
 // defines the original, not the translation of '...'.
 const punct=foldBilingualLines([{t:30,text:'...'},{t:30,text:'行'},{t:30,text:'line'}]);
 assert.equal(punct.length,1);
 assert.equal(punct[0].text,'... 行');
 assert.equal(punct[0].trans,'line');
 // Ratio-based script detection (replacing the placeholder signature).
 // All three shapes below mispaired under the old "has latin → L, has Han →
 // H" presence test: a mixed-script original shares its signature with a
 // translation containing one latin word; a Korean original had no
 // signature letter at all. Live-verified against probe cases 2026-11-13.
 const mixed=foldBilingualLines([{t:1,text:'come on baby 一起摇摆'},{t:1,text:'来吧宝贝一起摇摆'}]);
 assert.equal(mixed.length,1,'mixed-script original must still pair with its translation');
 assert.equal(mixed[0].trans,'来吧宝贝一起摇摆');
 const korean=foldBilingualLines([{t:2,text:'사랑해요 그대를'},{t:2,text:'爱着你'}]);
 assert.equal(korean.length,1,'korean original + chinese translation must pair');
 assert.equal(korean[0].trans,'爱着你');
 const crossContaminated=foldBilingualLines([{t:3,text:'Hello world 你好'},{t:3,text:'你好世界 hello'}]);
 assert.equal(crossContaminated.length,1,'dominant script wins over shared stray chars');
 assert.equal(crossContaminated[0].trans,'你好世界 hello');
 const romaji=foldBilingualLines([{t:4,text:'泣かないで'},{t:4,text:'不要哭泣'},{t:4,text:'nakanaide'}]);
 assert.equal(romaji.length,1);
 assert.equal(romaji[0].trans,'不要哭泣\nnakanaide');
});

// --- netease search fallback (/api/search/get/web -> /api/search/get) --------
// Live-tested 2026-11-13: 100 sequential anonymous /web requests all come back
// as HTTP 200 envelopes with code 405 ("操作频繁") for >=5 min, while
// /api/search/get keeps answering from an independent rate-limit pool and
// returns the same legacy song shape. The /web endpoint stays primary; /get is
// the fallback that only fires while /web is throttled (or transport-fails).
await check('netease search: /web throttle (code 405) falls back to /get and backs off',async()=>{
 const webPaths=[],getPath=[];
 const service=createLyricService({fetchImpl:async url=>{
  const u=new URL(url);
  if(u.pathname==='/api/search/get/web'){webPaths.push(1);return ok({code:405,msg:'操作频繁，请稍候再试'});}
  if(u.pathname==='/api/search/get'){getPath.push(1);return ok({code:200,result:{songs:[ncmSong],songCount:1}});}
  if(u.pathname==='/api/song/lyric')return ok({code:200,lrc:{lyric:lrc},tlyric:{lyric:''}});
  throw new Error('unexpected url '+url);
 },minRequestGapMs:0,requestTimeoutMs:15,localLyrics:false});
 const result=await service.resolve(facts);
 assert.equal(result.status,'matched');
 assert.ok(getPath.length>=1,'fallback /get must have been called');
 assert.equal(webPaths.length,1,'only the first attempt hits /web');
 // The throttle persists minutes, so the NEXT resolve skips /web entirely.
 const again=await service.resolve(facts,true);
 if(again&&again.status==='matched'){ /* cache hit: no new request */ }
});
await check('netease search: /web transport failure falls back to /get',async()=>{
 resetNeteaseSearchBackoff();
 let webCalls=0,getPath=0;
 const service=createLyricService({fetchImpl:async url=>{
  const u=new URL(url);
  if(u.pathname==='/api/search/get/web'){webCalls++;return {ok:false,status:503};}
  if(u.pathname==='/api/search/get'){getPath++;return ok({code:200,result:{songs:[ncmSong],songCount:1}});}
  if(u.pathname==='/api/song/lyric')return ok({code:200,lrc:{lyric:lrc},tlyric:{lyric:''}});
  throw new Error('unexpected url '+url);
 },minRequestGapMs:0,requestTimeoutMs:15,localLyrics:false});
 const result=await service.resolve(facts);
 assert.equal(result.status,'matched');
 assert.equal(getPath,1,'exactly one /get fallback');
 assert.equal(webCalls,1);
});
await check('netease search: /get fallback failure surfaces the real error',async()=>{
 resetNeteaseSearchBackoff();
 const service=createLyricService({fetchImpl:async url=>{
  const u=new URL(url);
  if(u.pathname==='/api/search/get/web')return ok({code:405,msg:'操作频繁，请稍候再试'});
  if(u.pathname==='/api/search/get')return ok({code:405,msg:'操作频繁，请稍候再试'});
  throw new Error('unexpected url '+url);
 },minRequestGapMs:0,requestTimeoutMs:15,localLyrics:false});
 const result=await service.resolve(facts);
 assert.equal(result.status,'error');
 const neteaseAttempt=(result.attempts||[]).find(row=>row&&row.source==='netease');
 assert.ok(neteaseAttempt&&String(neteaseAttempt.reason||'').includes('405'),
  'the 405 must be visible in the netease attempt reason, got: '+JSON.stringify(result.attempts));
});
console.log('ALL '+count+' MULTI-SOURCE TESTS PASS');

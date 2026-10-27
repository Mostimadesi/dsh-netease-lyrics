import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLyricService, fingerprintOf, decodeQQText } from '../lib/lyric-service.js';
const facts={title:'Hello',artist:'Adele',durationSec:295};
const ncmSong={id:1,name:'Hello',artists:[{name:'Adele'}],duration:295000};
const qqSong={songmid:'002Il7Ya1tZ6UZ',songname:'Hello',singer:[{name:'Adele'}],interval:295};
const lrc='[00:01.00]Hello\n[00:03.00]World';
const base64=x=>Buffer.from(x).toString('base64');
const ok=x=>({ok:true,json:async()=>x});
const KG_HASH='b3a52a7a958bf0aed0ebfba2e9a818b7';
function make({ncm='hit',qq='hit',kugou='hit',ncmLyrics='hit',qqLyrics='hit',kgLyrics='hit',...opts}={}){
 const calls=[];
 const fetchImpl=async(url,options)=>{
  const u=new URL(url);calls.push(u);
  const source=u.hostname==='c.y.qq.com'?'qq':u.hostname.includes('kugou')?'kugou':'netease';
  const referer=source==='qq'?'https://y.qq.com/':source==='kugou'?'https://www.kugou.com/':'https://music.163.com/';
  assert.equal(options.headers.referer,referer);
  const kgSearch=u.hostname==='songsearch.kugou.com';
  const kgCandidates=u.hostname==='krcs.kugou.com';
  const search=u.pathname.includes('search');
  const mode=source==='kugou'?(kgSearch?kugou:kgLyrics):source==='qq'?(search?qq:qqLyrics):(search?ncm:ncmLyrics);
  if(mode==='network')throw Error('network down');
  if(mode==='http')return {ok:false,status:503};
  if(mode==='api')return ok({code:429});
  if(mode==='json')return {ok:true,json:async()=>{throw new SyntaxError('bad json');}};
  if(mode==='shape')return ok(source==='kugou'?{status:1}:{code:source==='qq'?0:200,data:{}});
  if(mode==='timeout')return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('timeout not enforced')),200);
   options.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(options.signal.reason);},{once:true});
  });
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
await check('三源无匹配且无本地文件 -> unmatched',async()=>{
 const {service,calls}=make({ncm:'empty',qq:'empty',kugou:'empty'});const r=await service.resolve(facts);
 assert.equal(r.status,'unmatched');assert.equal(r.attempts.length,4);
 assert.equal(r.attempts[3].source,'local');assert.equal(r.attempts[3].reason,'no-search-dirs');
 await service.resolve(facts);assert.equal(calls.length,3,'negative cache prevents repeated requests');
 service.invalidate(fingerprintOf(facts.title,facts.artist));await service.resolve(facts);assert.equal(calls.length,6);
});
await check('三源故障 -> error 保留原因',async()=>{
 const {service}=make({ncm:'network',qq:'api',kugou:'network'});const r=await service.resolve(facts);
 assert.equal(r.status,'error');assert(r.message.includes('network down'));assert(r.message.includes('429'));
});
await check('无匹配 + QQ 故障 -> error',async()=>{
 assert.equal((await make({ncm:'empty',qq:'network',kugou:'network'}).service.resolve(facts)).status,'error');
});
await check('QQ 无带时间歌词不伪装成功',async()=>{
 const r=await make({ncm:'empty',kugou:'empty',qqLyrics:'untimed'}).service.resolve(facts);
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
 const r=await make({ncm:'empty',qq:'empty',kugou:'empty'}).service.resolve(facts);
 assert.equal(r.status,'unmatched');assert.equal(r.attempts[2].source,'kugou');
 assert.equal(r.attempts[2].reason,'no-confident-match');
});
await check('酷狗无带时间歌词不伪装成功',async()=>{
 const r=await make({ncm:'empty',qq:'empty',kgLyrics:'untimed'}).service.resolve(facts);
 assert.equal(r.status,'unmatched');assert.equal(r.attempts[2].reason,'no-timed-lyrics');
});
await check('三源失败 -> 读取歌曲旁的 .lrc',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-lyrics-local-'));
 const file=path.join(dir,'Adele - Hello.lrc');
 try{
  await fs.writeFile(file,'[00:02.00]Sidecar line\n[00:05.50]Second line','utf8');
  const {service,calls}=make({ncm:'empty',qq:'empty',kugou:'empty',localDirs:[dir]});
  const r=await service.resolve(facts);
  assert.equal(r.status,'matched');assert.equal(r.source,'local');assert.equal(r.sourceLabel,'本地文件');
  assert.equal(r.lines.length,2);assert.equal(r.lines[0].t,2);assert.equal(r.lines[1].text,'Second line');
  assert.equal(r.attempts.length,4);assert.equal(calls.length,3,'local pass issues no request');
 }finally{
  await fs.unlink(file).catch(()=>{});await fs.rmdir(dir).catch(()=>{});
 }
});
await check('本地无时间轴歌词 -> 合成时间轴并标注',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-lyrics-plain-'));
 const file=path.join(dir,'Adele - Hello.lrc');
 try{
  await fs.writeFile(file,'first line\nsecond line\nthird line','utf8');
  const r=await make({ncm:'empty',qq:'empty',kugou:'empty',localDirs:[dir]}).service.resolve(facts);
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
  const r=await make({ncm:'empty',qq:'empty',kugou:'empty',localDirs:[dir],localLyrics:false}).service.resolve(facts);
  assert.equal(r.status,'unmatched');assert.equal(r.attempts[3].reason,'disabled');
 }finally{
  await fs.unlink(file).catch(()=>{});await fs.rmdir(dir).catch(()=>{});
 }
});
await check('QQ 成功缓存、并发去重和手动重试',async()=>{
 const {service,calls}=make({ncm:'empty'});
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
  const {service,calls}=make({ncm:'empty',cacheFile:file});assert.equal((await service.resolve(facts)).source,'qq');assert.equal(calls.length,3);
  await new Promise(resolve=>setTimeout(resolve,2200));
  const saved=JSON.parse(await fs.readFile(file,'utf8'));assert.equal(saved.version,2);
  const fresh=make({cacheFile:file});assert.equal((await fresh.service.resolve(facts)).source,'qq');assert.equal(fresh.calls.length,0);
 }finally{
  // Only remove the exact test-created files/directory, whose paths were allocated above.
  await fs.unlink(file).catch(()=>{});await fs.unlink(file+'.tmp').catch(()=>{});await fs.rmdir(dir);
 }
});
await check('HTML 实体和 UTF-8 译文解码',async()=>{
 assert.equal(decodeQQText(base64('[00:01.00]&#20320;&#x597d; &lt;世界&gt;')),'[00:01.00]你好 <世界>');
});
console.log('ALL '+count+' MULTI-SOURCE TESTS PASS');

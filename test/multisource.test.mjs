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
function make({ncm='hit',qq='hit',ncmLyrics='hit',qqLyrics='hit',...opts}={}){
 const calls=[];
 const fetchImpl=async(url,options)=>{
  const u=new URL(url);calls.push(u);
  const source=u.hostname==='c.y.qq.com'?'qq':'netease';
  const search=u.pathname.includes('search');
  const mode=source==='qq'?(search?qq:qqLyrics):(search?ncm:ncmLyrics);
  assert.equal(options.headers.referer,source==='qq'?'https://y.qq.com/':'https://music.163.com/');
  if(mode==='network')throw Error('network down');
  if(mode==='http')return {ok:false,status:503};
  if(mode==='api')return ok({code:429});
  if(mode==='json')return {ok:true,json:async()=>{throw new SyntaxError('bad json');}};
  if(mode==='shape')return ok({code:source==='qq'?0:200,data:{}});
  if(mode==='timeout')return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('timeout not enforced')),200);
   options.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(options.signal.reason);},{once:true});
  });
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
await check('双源无匹配 -> unmatched',async()=>{
 const {service,calls}=make({ncm:'empty',qq:'empty'});const r=await service.resolve(facts);
 assert.equal(r.status,'unmatched');assert.equal(r.attempts.length,2);
 await service.resolve(facts);assert.equal(calls.length,2,'negative cache prevents repeated requests');
 service.invalidate(fingerprintOf(facts.title,facts.artist));await service.resolve(facts);assert.equal(calls.length,4);
});
await check('双源故障 -> error 保留原因',async()=>{
 const {service}=make({ncm:'network',qq:'api'});const r=await service.resolve(facts);
 assert.equal(r.status,'error');assert(r.message.includes('network down'));assert(r.message.includes('429'));
});
await check('无匹配 + QQ 故障 -> error',async()=>{
 assert.equal((await make({ncm:'empty',qq:'network'}).service.resolve(facts)).status,'error');
});
await check('QQ 无带时间歌词不伪装成功',async()=>{
 const r=await make({ncm:'empty',qqLyrics:'untimed'}).service.resolve(facts);
 assert.equal(r.status,'unmatched');assert.equal(r.attempts[1].reason,'no-timed-lyrics');
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
 assert.equal(calls.length,4);
 await service.resolve({...facts,title:'Hello (Live)'});assert(calls.length>4);
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

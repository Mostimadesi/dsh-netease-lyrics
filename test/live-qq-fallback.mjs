import { createLyricService } from '../lib/lyric-service.js';
const facts={title:'Hello',artist:'Adele',durationSec:295};
const service=createLyricService({cacheFile:'',fetchImpl:(url,opts)=>{
 if(new URL(url).hostname==='music.163.com')throw Error('TEST: simulated primary outage');
 return fetch(url,opts);
}});
const result=await service.resolve(facts);
console.log(JSON.stringify({test:'simulated NetEase outage + REAL QQ requests',status:result.status,source:result.source,
 songId:result.songId,songName:result.songName,artists:result.artistNames,lines:result.lines?.length,
 translatedLines:result.lines?.filter(row=>row.trans).length,attempts:result.attempts},null,2));
if(result.status!=='matched'||result.source!=='qq')process.exitCode=1;

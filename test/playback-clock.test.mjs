import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
let api;
const source=fs.readFileSync(new URL('../lib/client.js',import.meta.url),'utf8')
 .replace('exports.apply = apply;', 'exports.test = { createPlaybackClock, clampPlacement, fontStack }; exports.apply = apply;');
vm.runInNewContext(source,{window:{__ModuleLoader__:{load:({factory})=>{api=factory(()=>({default:{createElement(){}}})).test;}}}});
const sample=(position,at,extra={})=>({app:'cloudmusic.exe',title:'Track',artist:'Artist',active:true,playing:true,positionSec:position,atMs:at,durationSec:300,...extra});
const clock=api.createPlaybackClock();
clock.update(sample(9.8,1000),1000);
assert(clock.read(1250)>10);
let prior=clock.read(1250);
for(let i=0;i<6;i++){
 const now=1500+i*500;
 clock.update(sample(9.8+i*.25,now),now);
 const value=clock.read(now);
 assert(value>=prior,'normal corrections must not pull position back across lyric boundary');prior=value;
}
console.log('PASS: repeated/lagging samples cannot oscillate across a lyric boundary');
const held=api.createPlaybackClock();
held.update(sample(9.8,1000),1000);
held.update(sample(9.8,1500),1500);
assert.equal(held.read(1500),10.3,'duplicate position must not reset interpolation');
held.update(sample(1,1400),1600);
assert.equal(held.read(1600),10.4,'out-of-order timestamp ignored');
assert(held.read(6000)<=11.8,'stale playback stops advancing after 2 seconds');
console.log('PASS: duplicate samples, out-of-order updates, stale playback');
clock.update(sample(2,5000),5000);assert.equal(clock.read(5000),2,'backward seek resets clock');
clock.update(sample(100,5500),5500);assert.equal(clock.read(5500),100,'forward seek resets clock');
clock.update(sample(100.2,6000,{playing:false}),6000);assert.equal(clock.read(9000),100.2,'pause stays frozen');
clock.update(sample(0,9500,{title:'Other track'}),9500);assert.equal(clock.read(9500),0,'track change resets');
console.log('PASS: seeks, pause, track change remain supported');
for(const [x,y,w,h,vw,vh] of [[-100,-20,200,100,1000,600],[2000,2000,640,240,800,400]]){
 const p=api.clampPlacement(x,y,w,h,vw,vh);
 assert(p.x-w/2>=8&&p.x+w/2<=vw-8);assert(p.y>=8&&p.y+h<=vh-8);
}
assert.equal(api.fontStack('Microsoft YaHei，Noto Sans'),'"Microsoft YaHei", "Noto Sans"');
assert.equal(api.fontStack(''),'inherit');
console.log('PASS: position clamping and font stack validation');

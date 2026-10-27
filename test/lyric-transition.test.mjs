import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
let Component;
const hooks=[]; let cursor=0; let effect, cleanup, dependencies; let timers=new Map(), serial=0;
const React={createElement:(type,props,...children)=>({type,props:props||{},children}),
 useState(initial){const i=cursor++;if(!(i in hooks))hooks[i]=typeof initial==='function'?initial():initial;return[hooks[i],fn=>hooks[i]=typeof fn==='function'?fn(hooks[i]):fn];},
 useEffect(fn,deps){if(!dependencies||deps[0]!==dependencies[0]){effect=fn;dependencies=deps;}}};
const source=fs.readFileSync(new URL('../lib/client.js',import.meta.url),'utf8').replace('exports.apply = apply;','exports.transition = LyricTransition; exports.apply = apply;');
vm.runInNewContext(source,{window:{__ModuleLoader__:{load:({factory})=>{Component=factory(()=>({default:React})).transition;}}},setTimeout:fn=>{timers.set(++serial,fn);return serial;},clearTimeout:id=>timers.delete(id)});
function render(identity){cursor=0;return Component({identity,children:identity});}
function commit(){if(effect){cleanup?.();cleanup=effect();effect=null;}}
let tree=render('line A');commit();assert.equal(tree.children[0],null);
render('line B');commit();tree=render('line B');
assert.equal(tree.children[0].props['aria-hidden'],true);
assert.equal(tree.children[0].children[0],'line A');
assert.equal(tree.children[1].children[0],'line B');
const count=timers.size;
render('line B');commit();assert.equal(timers.size,count,'poll ticks must not restart transition');
render('line C');commit();tree=render('line C');
assert.equal(timers.size,1,'rapid changes must cancel previous timer');
assert.equal(tree.children[0].children[0],'line B');
for(const fn of [...timers.values()])fn();timers.clear();
tree=render('line C');assert.equal(tree.children[0],null);
cleanup();assert.equal(timers.size,0);
assert(source.includes('@media(prefers-reduced-motion:reduce)'));
console.log('PASS: outgoing/current lyric layers, stable identity, rapid seek cleanup, 240ms removal, reduced-motion CSS.');

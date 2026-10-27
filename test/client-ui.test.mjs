import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const store = new Map();
const entries = new Map();
let hookIndex = 0;
let snapshot = null;
let plugin;
const React = {
 createElement: (type, props, ...children) => ({type, props: props || {}, children: children.flat()}),
 useState: (initial) => { const i = hookIndex++; return [i === 1 && snapshot ? snapshot : typeof initial === 'function' ? initial() : initial, () => {}]; },
 useEffect() {}, useRef: () => ({current:null}),
};
const context = {window:{__ModuleLoader__:{load: ({factory}) => {plugin = factory(() => ({default:React}));}}, dispatchEvent(){}},
 localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v)}, Event:class{}, console};
vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js',import.meta.url),'utf8'), context);
plugin.apply({slots:{inject:(_,cb)=>cb(),register:(opts,component)=>{entries.set(opts.name,component);return ()=>{};}}});
assert(entries.has('shell.overlay'));
assert(entries.has('plugins.bundle.config'));
function nodes(root) {return root && typeof root === 'object' ? [root,...(root.children||[]).flatMap(nodes)] : [];}
function renderIsland(trans) {
 hookIndex=0; snapshot={active:true,title:'Foreign song',lyric:{status:'matched',lines:[{t:0,text:'Original',...(trans?{trans}: {})}]}};
 return entries.get('shell.overlay')();
}
let tree=renderIsland('中文译文');
assert(nodes(tree).some(n=>n.props.className==='dnl-now-trans'&&n.children.includes('中文译文')));
assert(!nodes(renderIsland('')).some(n=>n.props.className==='dnl-now-trans'));
hookIndex=0; snapshot=null;
const settings=entries.get('plugins.bundle.config')({view:'page'});
const inputs=nodes(settings).filter(n=>n.type==='input'&&n.props.type==='color');
assert.equal(inputs.length,3);
inputs[0].props.onChange({target:{value:'#123456'}});
assert.equal(JSON.parse([...store.values()][0]).original,'#123456');
assert.equal(renderIsland('译文').props.style['--dnl-original'],'#123456');
inputs[1].props.onChange({target:{value:'#abcdef'}});
assert.equal(renderIsland('译文').props.style['--dnl-translation'],'#abcdef');
hookIndex=0;snapshot=null;
const updated=entries.get('plugins.bundle.config')({view:'page'});
nodes(updated).find(n=>n.type==='button'&&n.children.includes('恢复全部主题默认')).props.onClick();
assert.equal(Object.keys(renderIsland('译文').props.style).filter(key => key.startsWith('--dnl-')).length,0);
hookIndex=0; snapshot=null;
const appearance=entries.get('plugins.bundle.config')({view:'page'});
const fontInput=nodes(appearance).find(n=>n.type==='input'&&n.props['aria-label']==='歌词字体');
assert(fontInput);
fontInput.props.onChange({target:{value:'Microsoft YaHei, Noto Sans CJK SC'}});
assert.equal(renderIsland('译文').props.style['--dnl-font'],'"Microsoft YaHei", "Noto Sans CJK SC"');
assert(nodes(renderIsland('译文')).some(n=>n.props['aria-label']==='拖动歌词浮层'));
assert.equal(renderIsland('译文').props.style.left,'70vw');
hookIndex=0;snapshot=null;
const savedAppearance=entries.get('plugins.bundle.config')({view:'page'});
nodes(savedAppearance).find(n=>n.type==='button'&&n.children.includes('恢复默认字体')).props.onClick();
assert.equal(renderIsland('译文').props.style['--dnl-font'],undefined);
console.log('PASS: real client registers both slots; collapsed translation visible; absent translation omitted; 3 color controls; persistence and CSS variables; restore defaults.');

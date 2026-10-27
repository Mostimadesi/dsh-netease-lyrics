import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const storage=new Map();
const source=fs.readFileSync(new URL('../lib/client.js',import.meta.url),'utf8');
function mount(){
 const hooks=[];let i=0;const entries=new Map();let plugin;
 const React={createElement:(type,props,...children)=>({type,props:props||{},children:children.flat()}),
  useState(initial){const k=i++;if(!(k in hooks))hooks[k]=k===1?{active:true,title:'Track',lyric:{status:'matched',lines:[{t:0,text:'line'}]}}:typeof initial==='function'?initial():initial;
   return [hooks[k],v=>hooks[k]=typeof v==='function'?v(hooks[k]):v];},
  useRef(initial){const k=i++;return hooks[k]??(hooks[k]={current:initial});},useEffect(){}};
 const win={innerWidth:1200,innerHeight:800,dispatchEvent(){},__ModuleLoader__:{load:({factory})=>plugin=factory(()=>({default:React}))}};
 vm.runInNewContext(source,{window:win,Event:class{},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)}});
 plugin.apply({slots:{inject:(_,cb)=>cb(),register:(opts,c)=>{entries.set(opts.name,c);return ()=>{};}}});
 return {render(){i=0;return entries.get('shell.overlay')();}};
}
function nodes(n){return n&&typeof n==='object'?[n,...(n.children||[]).flatMap(nodes)]:[];}
const mounted=mount();const tree=mounted.render();
tree.props.ref.current={getBoundingClientRect:()=>({left:600,top:12,width:300,height:80})};
const handle=nodes(tree).find(n=>n.props['aria-label']==='拖动歌词浮层');
const target={setPointerCapture(){},hasPointerCapture:()=>true,releasePointerCapture(){}};
const event=(x,y)=>({button:0,pointerId:1,clientX:x,clientY:y,currentTarget:target,stopPropagation(){},preventDefault(){}});
handle.props.onPointerDown(event(700,30));
handle.props.onPointerMove(event(800,80));
handle.props.onPointerUp(event(800,80));
const saved=JSON.parse(storage.get('dsh.netease-lyrics.display.v1'));
assert.equal(saved.x,850/1200);assert.equal(saved.y,62/800);
const restored=mount().render();
assert(Math.abs(parseFloat(restored.props.style.left)-saved.x*100)<0.001);
assert(Math.abs(parseFloat(restored.props.style.top)-saved.y*100)<0.001);
console.log('PASS: actual pointer handlers capture, move, save normalized position, restore across remount.');

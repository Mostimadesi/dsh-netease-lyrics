// Halo-wave preview (v0.4.34): renders the three ambient wave styles
// (dots / stardust / wave) collapsed, plus a scope=both expanded cell for the
// waveform style. All frozen mid-animation (paused + negative delays) so the
// rings are visible in a static screenshot.
// Usage: node _gen-halo-wave-preview.mjs <out.html>
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';

let plugin;
vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
	window: {
		__ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => ({ default: React })); } },
		addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
		matchMedia: () => ({ matches: false }), innerWidth: 1200, innerHeight: 800,
	},
	document: undefined, console, AbortController, AbortSignal,
	fetch: () => new Promise(() => {}),
	Event: class {}, localStorage: { getItem: () => null, setItem() {} },
	setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
});
const CSS = plugin.__test.CSS;

const main = '「また会えるよね」って、声にならない声';
const sub = '「我们还能相见吧」此声终未能传达出口';
const collapsedBody = `
	<div class="dnl-now"><div class="dnl-now-inner">
		<div class="dnl-line dnl-line-main">${main}</div>
		<div class="dnl-line dnl-line-sub">${sub}</div>
	</div></div>`;
const expandedBody = `
	<div class="dnl-now-wrap"><div class="dnl-now"><div class="dnl-now-inner">
		<div class="dnl-line dnl-line-main">${main}</div>
		<div class="dnl-line dnl-line-sub">${sub}</div>
	</div></div></div>
	<div class="dnl-grow"><div class="dnl-grow-inner">
		<div class="dnl-line dnl-line-main">きみを呪う言葉がずっと喉の奥につかえてる</div>
		<div class="dnl-line dnl-line-main dnl-line-active">${main}</div>
		<div class="dnl-line dnl-line-sub dnl-line-active">${sub}</div>
	</div></div>`;

const ringSvg = '<svg viewBox="0 0 100 100" preserveAspectRatio="none"><rect class="r1" x="2" y="2" width="96" height="96" rx="48" pathLength="100"></rect><rect class="r2" x="2" y="2" width="96" height="96" rx="48" pathLength="100"></rect></svg>';
const waveSpans = () => `<span class="w1">${ringSvg}</span><span class="w2">${ringSvg}</span>`;
const cell = (label, style, scope, expanded, vivid) => `<div class="dnl-col"><h3>${label}</h3>
	<div class="dnl-host dnl-host-preview"><div class="dnl-shell${expanded ? ' dnl-shell-expanded' : ''}">
		<span class="dnl-halo dnl-halo-wave dnl-wave-${style}${scope === 'both' ? ' dnl-wave-both' : ''}${vivid ? ' dnl-wave-vivid' : ''}" style="--dnl-glow-dur:5.6s;--dnl-glow-amp:1" aria-hidden="true">
			<span class="h1"></span><span class="h2"></span><span class="h3"></span><span class="h4"></span>${waveSpans()}</span>
		<div class="dnl-island${expanded ? ' dnl-expanded' : ''}">
			<button class="dnl-drag">⠿</button>
			${expanded ? expandedBody : collapsedBody}
		</div>
	</div></div></div>`;

const page = `<!doctype html><meta charset="utf-8">
<style>
html,body{margin:0;background:#0e1016;font-family:"Segoe UI",system-ui,sans-serif}
.dnl-grid{display:grid;grid-template-columns:1fr 1fr;gap:44px 64px;padding:44px;width:max-content}
.dnl-col h3{color:#888;font:400 12px/1.3 "Segoe UI",sans-serif;margin:0 0 10px}
.dnl-host-preview{position:static !important;transform:none !important}
.dnl-host{--dnl-panel-alpha:.45;--dsw-alias-bg-overlay:#171a22;--dsw-alias-bg-layer-1:#1d212b;--dsw-alias-border-l1:rgba(255,255,255,.09);--dsw-alias-brand-primary:#7c8cff;--dsw-alias-text-primary:#e8eaf2;--dsw-alias-text-secondary:#9aa0b4;--dsw-alias-label-primary:#e8eaf2;--dsw-alias-label-secondary:#9aa0b4;--dnl-halo:#7c8cff}
/* freeze mid-animation: dash orbit part-walked, twinkle near its bright phase */
.dnl-halo-wave rect,.dnl-halo-wave>.w1,.dnl-halo-wave>.w2{animation-play-state:paused !important}
.dnl-halo-wave rect{animation-delay:-1.6s !important}
.dnl-halo-wave>.w1{animation-delay:-1.4s !important}
.dnl-halo-wave>.w2{animation-delay:-4.2s !important}
</style>
<style>${CSS}</style>
<div class="dnl-grid">
	${cell('点阵环 dots · 收起 · 含蓄', 'dots', 'collapsed', false, false)}
	${cell('点阵环 dots · 收起 · 鲜明', 'dots', 'collapsed', false, true)}
	${cell('星尘环 stardust · 收起 · 含蓄', 'stardust', 'collapsed', false, false)}
	${cell('星尘环 stardust · 收起 · 鲜明', 'stardust', 'collapsed', false, true)}
	${cell('波形描边 wave · 收起 · 鲜明', 'wave', 'collapsed', false, true)}
	${cell('波形描边 wave · 展开（范围=收起+展开）· 含蓄', 'wave', 'both', true, false)}
</div>
<script>
window.addEventListener('load',()=>{setTimeout(()=>{
	const rows=[...document.querySelectorAll('.dnl-halo span')].map(el=>{const r=el.getBoundingClientRect();return (el.className||'?')+' @'+Math.round(r.x)+','+Math.round(r.y)+' '+Math.round(r.width)+'x'+Math.round(r.height)});
	const pre=document.createElement('pre');
	pre.style.cssText='position:fixed;left:0;bottom:0;margin:0;padding:6px;background:#000;color:#0f0;font:10px/1.4 monospace;z-index:9999;max-width:1060px;white-space:pre-wrap';
	pre.textContent=rows.join('\n');
	document.body.appendChild(pre);
},300)});
</script>`;
fs.writeFileSync(process.argv[2], page, 'utf8');
console.log('written', process.argv[2], page.length, 'bytes');

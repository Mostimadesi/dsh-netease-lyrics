// Halo-burst preview (v0.4.33): renders both burst shapes (rim / wide),
// collapsed + expanded, frozen at the pulse peak.
// Usage: node _gen-halo-preview.mjs <out.html>
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
		<div class="dnl-line dnl-line-sub">诅咒你的话语一直哽于喉间</div>
		<div class="dnl-line dnl-line-main dnl-line-active">${main}</div>
		<div class="dnl-line dnl-line-sub dnl-line-active">${sub}</div>
		<div class="dnl-line dnl-line-main">昼下がり、じめつく風の季節は</div>
	</div></div>`;

const haloSpans = `<span class="h1"></span><span class="h2"></span><span class="h3"></span><span class="h4"></span>`;
const cell = (label, wide, expanded) => `<div class="dnl-col"><h3>${label}</h3>
	<div class="dnl-host" style="position:static;transform:none"><div class="dnl-shell${expanded ? ' dnl-shell-expanded' : ''}">
		<span class="dnl-halo dnl-halo-burst${wide ? ' dnl-halo-wide' : ''}" style="--dnl-glow-dur:1.15s;--dnl-glow-amp:1" aria-hidden="true">${haloSpans}</span>
		<div class="dnl-island dnl-notice${expanded ? ' dnl-expanded' : ''}">
			<button class="dnl-drag">⠿</button>
			<div class="dnl-decor dnl-decor-none" aria-hidden="true"></div>
			${expanded ? expandedBody : collapsedBody}
		</div>
	</div></div></div>`;

const page = `<!doctype html><meta charset="utf-8">
<style>
html,body{margin:0;background:#0e1016;font-family:"Segoe UI",system-ui,sans-serif}
.dnl-grid{display:grid;grid-template-columns:1fr 1fr;gap:34px 56px;padding:30px;width:max-content}
.dnl-col h3{color:#888;font:400 12px/1.3 "Segoe UI",sans-serif;margin:0 0 8px}
.dnl-host{--dnl-panel-alpha:.45;--dsw-alias-bg-overlay:#171a22;--dsw-alias-bg-layer-1:#1d212b;--dsw-alias-border-l1:rgba(255,255,255,.09);--dsw-alias-brand-primary:#7c8cff;--dsw-alias-text-primary:#e8eaf2;--dsw-alias-text-secondary:#9aa0b4;--dsw-alias-label-primary:#e8eaf2;--dsw-alias-label-secondary:#9aa0b4}
/* freeze the burst at each layer's peak frame (paused + negative delay) */
.dnl-halo-burst>span{animation-play-state:paused !important}
.dnl-halo-burst>.h1{animation-delay:-0.30s !important}
.dnl-halo-burst>.h2{animation-delay:-0.345s !important}
.dnl-halo-burst.dnl-halo-wide>.h3{animation-delay:-0.437s !important}
.dnl-halo-burst.dnl-halo-wide>.h4{animation-delay:-0.368s !important}
</style>
<style>${CSS}</style>
<div class="dnl-grid">
	${cell('rim 贴边描边 · 收起（默认）', false, false)}
	${cell('halo 收敛光晕 · 收起', true, false)}
	${cell('rim 贴边描边 · 展开', false, true)}
	${cell('halo 收敛光晕 · 展开', true, true)}
</div>`;
fs.writeFileSync(process.argv[2], page, 'utf8');
console.log('written', process.argv[2], page.length, 'bytes');

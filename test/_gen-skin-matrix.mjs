// Repro (m03170): default vs arknights, collapsed vs expanded — same track,
// same DOM, REAL island CSS. Screenshot tells the truth about what differs.
// Usage: node _gen-skin-matrix.mjs <out.html>
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
const island = (skinCls, extra, body) => `<div class="dnl-island ${skinCls} ${extra}">
	<button class="dnl-drag">⠿</button>
	<div class="dnl-decor dnl-decor-none" aria-hidden="true"></div>
	${body}
</div>`;
const cell = (label, skinCls, extra, body) => `<div class="dnl-col"><h3>${label}</h3>
	<div class="dnl-host" style="position:static;transform:none">${island(skinCls, extra, body)}</div></div>`;

const page = `<!doctype html><meta charset="utf-8">
<style>
html,body{margin:0;background:#0e1016;font-family:"Segoe UI",system-ui,sans-serif}
.dnl-grid{display:grid;grid-template-columns:1fr 1fr;gap:28px 56px;padding:28px;width:max-content}
.dnl-col h3{color:#888;font:400 12px/1.3 "Segoe UI",sans-serif;margin:0 0 8px}
.dnl-host{--dnl-panel-alpha:.45;--dsw-alias-bg-overlay:#171a22;--dsw-alias-bg-layer-1:#1d212b;--dsw-alias-border-l1:rgba(255,255,255,.09);--dsw-alias-brand-primary:#7c8cff;--dsw-alias-text-primary:#e8eaf2;--dsw-alias-text-secondary:#9aa0b4}
</style>
<style>${CSS}</style>
<div class="dnl-grid">
	${cell('default · 收起', 'dnl-style-default', '', collapsedBody)}
	${cell('arknights · 收起', 'dnl-style-arknights', '', collapsedBody)}
	${cell('default · 展开', 'dnl-style-default', 'dnl-expanded', expandedBody)}
	${cell('arknights · 展开', 'dnl-style-arknights', 'dnl-expanded', expandedBody)}
</div>`;
fs.writeFileSync(process.argv[2], page, 'utf8');
console.log('written', process.argv[2], page.length, 'bytes');

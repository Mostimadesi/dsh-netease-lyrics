// Repro (m03170): default / arknights skin collapsed vs expanded visual diff.
// Renders the REAL island CSS + a realistic DOM skeleton in both states,
// side by side, so the screenshot tells the truth.
// Usage: node _gen-skin-repro.mjs <out.html> [skin]   skin: default (default) | arknights
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
const skin = process.argv[3] || 'default';

const linesCollapsed = `
	<div class="dnl-now"><div class="dnl-now-inner">
		<div class="dnl-line dnl-line-main">「また会えるよね」って、声にならない声</div>
		<div class="dnl-line dnl-line-sub">「我们还能相见吧」此声终未能传达出口</div>
	</div></div>`;
const linesExpanded = `
	<div class="dnl-now-wrap"><div class="dnl-now"><div class="dnl-now-inner">
		<div class="dnl-line dnl-line-main">「また会えるよね」って、声にならない声</div>
		<div class="dnl-line dnl-line-sub">「我们还能相见吧」此声终未能传达出口</div>
	</div></div></div>
	<div class="dnl-grow"><div class="dnl-grow-inner">
		<div class="dnl-line dnl-line-main">きみを呪う言葉がずっと喉の奥につかえてる</div>
		<div class="dnl-line dnl-line-sub">诅咒你的话语一直哽于喉间</div>
		<div class="dnl-line dnl-line-main dnl-line-active">「また会えるよね」って、声にならない声</div>
		<div class="dnl-line dnl-line-sub dnl-line-active">「我们还能相见吧」此声终未能传达出口</div>
		<div class="dnl-line dnl-line-main">昼下がり、じめつく風の季節は</div>
	</div></div>`;

const island = (extra, body) => `<div class="dnl-island dnl-style-${skin} ${extra}">
	<button class="dnl-drag">⠿</button>
	<div class="dnl-decor dnl-decor-none" aria-hidden="true"></div>
	${body}
</div>`;

const page = `<!doctype html><meta charset="utf-8">
<style>
html,body{margin:0;background:#0e1016;font-family:"Segoe UI",system-ui,sans-serif}
.dnl-stage{display:flex;gap:48px;align-items:flex-start;padding:36px}
.dnl-col h3{color:#777;font:400 13px/1.4 "Segoe UI",sans-serif;margin:0 0 10px}
.dnl-host{--dsw-alias-bg-overlay:#171a22;--dsw-alias-bg-layer-1:#1d212b;--dsw-alias-border-l1:rgba(255,255,255,.09);--dsw-alias-brand-primary:#7c8cff;--dsw-alias-text-primary:#e8eaf2;--dsw-alias-text-secondary:#9aa0b4}
</style>
<style>${CSS}</style>
<div class="dnl-stage">
	<div class="dnl-col"><h3>收起态（skin: ${skin}）</h3>
		<div class="dnl-host" style="position:static;transform:none">${island('', linesCollapsed)}</div>
	</div>
	<div class="dnl-col"><h3>展开态（skin: ${skin}）</h3>
		<div class="dnl-host" style="position:static;transform:none">${island('dnl-expanded', linesExpanded)}</div>
	</div>
</div>`;
fs.writeFileSync(process.argv[2], page, 'utf8');
console.log('written', process.argv[2], page.length, 'bytes');

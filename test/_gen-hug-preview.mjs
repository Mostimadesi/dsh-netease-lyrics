// v0.4.46 preview: real plugin CSS + real island markup, dust frozen mid-cycle.
// Usage: node test/_gen-hug-preview.mjs <out.html> [--slight] [--beat] [--spread=0..100]
//   Flags, not positional args: PowerShell 5.1 silently swallows an empty ""
//   argument, which once shifted --spread into the beat slot.
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
const DUST = plugin.__test.dustGrains;
if (typeof DUST !== 'function') { console.error('dustGrains is not exported via __test'); process.exit(2); }

/* Flags instead of positional args: PowerShell 5.1 drops a bare "" argument,
 * which silently shifted the spread value into the beat slot (real bug this
 * round — three pages all rendered spread=0.45 default). */
const argv = process.argv.slice(3);
const hasFlag = (f) => argv.includes(f);
const flagValue = (f, fallback) => {
	const hit = argv.find((a) => a.startsWith(f + '='));
	if (!hit) return fallback;
	const v = Number(hit.slice(f.length + 1));
	return Number.isFinite(v) ? v : fallback;
};
const mode = hasFlag('--slight') ? 'slight' : 'wrap';
const beat = hasFlag('--beat') ? 0.85 : 0;
/* v0.4.46: the band thickness is a real pref — the preview must render through
 * the same DUST_SPREAD helper the plugin uses, or it would show a band the
 * plugin can never produce. */
const spreadArg = flagValue('--spread', NaN);
const spread = Number.isFinite(spreadArg) ? Math.min(100, Math.max(0, spreadArg)) / 100 : plugin.__test.DUST_SPREAD({});
// Serialise the REAL grain nodes (no duplicated math): dustGrains() returns
// plain React elements, so a tiny serialiser keeps the preview honest.
const toHtml = (el) => {
	if (el === null || el === undefined || el === false) return '';
	if (typeof el === 'string' || typeof el === 'number') return String(el);
	if (Array.isArray(el)) return el.map(toHtml).join('');
	const { className, style, children } = el.props || {};
	const attrs = [
		className ? 'class="' + className + '"' : '',
		style ? 'style="' + Object.entries(style).map(([k, v]) => k + ':' + v).join(';') + '"' : '',
	].filter(Boolean).join(' ');
	return '<' + el.type + (attrs ? ' ' + attrs : '') + '>' + toHtml(children) + '</' + el.type + '>';
};
const grains = toHtml(DUST(150, 'medium', spread));

const block = (hug, label) => `
<div class="frame">
  <span class="dnl-wave dnl-wave-stardust dnl-wave-both${hug === 'slight' ? ' dnl-hug-slight' : ''}"
        style="--dnl-beat:${beat};--dnl-beat-gain:1;--dnl-dust-glow:1">
    <span class="w1">${grains}</span>
    <span class="dnl-dustpulse"></span>
  </span>
  <div class="dnl-island"><span class="dnl-line">这是测试歌词的一行</span></div>
  <div class="edge"></div>
  <div class="lbl">${label}</div>
</div>`;

const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:#0d1017;font:13px/1.5 system-ui,sans-serif;color:#c9d3e8}
:root{--dsw-alias-brand-primary:#6a8dff;--dnl-halo:#7fa0ff;--dsw-alias-label-primary:#eef2ff;
--dsw-alias-bg-overlay:#171b26;--dsw-alias-border-l1:rgba(255,255,255,.16)}
${CSS}
body{padding:26px;display:flex;flex-direction:column;gap:34px}
/* freeze the lifecycle at a representative mid-flight phase: keep only the
   per-grain delay, then shift every grain the same 3.4s into its cycle */
.dnl-wave .dnl-dust{animation-play-state:paused!important;animation-delay:calc(var(--del,0s) - 3.4s)!important}
.dnl-wave.dnl-wave-stardust>.w1{animation-play-state:paused!important}
.dnl-island{width:440px;height:38px;border-radius:999px;padding:0 20px;display:flex;align-items:center;font-size:14px}
.frame{position:relative;width:520px;height:120px;display:flex;align-items:center;justify-content:center}
.dnl-wave{position:absolute;left:40px;top:41px;width:440px;height:38px}
/* exactly the island edge, so "hug vs float" is eyeballable */
.edge{position:absolute;left:40px;top:41px;width:440px;height:38px;border-radius:999px;
  border:1px dashed rgba(255,69,200,.65);pointer-events:none}
.lbl{position:absolute;bottom:2px;left:40px;color:#7f90b4}
</style>
<h3>星尘环 · ${mode === 'slight' ? '整体略微外扩（回退档）' : '中间外扩 · 两端环绕（默认）'} · 环带 ${Math.round(spread * 100)}% · beat ${beat}</h3>
${block(mode, mode === 'slight' ? 'inset 统一 9px' : '中间 +4px、两端贴齐')}
${beat ? block(mode, '同上，节拍强度 0.85') : ''}`;

const out = process.argv[2];
if (!out) { console.error('usage: node test/_gen-hug-preview.mjs <out.html> [--slight] [--beat] [--spread=0..100]'); process.exit(2); }
fs.writeFileSync(out, html, 'utf8');
console.log('wrote ' + out + ' (150 grains, hug=' + mode + ', spread=' + spread + ', beat=' + beat + ')');

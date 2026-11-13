// Frozen-frame preview for the v0.4.42 宇宙尘埃 lifecycle field.
// Usage: node test/_gen-dust-preview.mjs <out.html> [dense]
// v0.4.42 grains run a pure-CSS lifecycle (dnl-dust-life with per-grain
// --dur/--del/--dx/--dy/--peak), so the frame only freezes a deterministic
// global phase by shifting every grain's animation-delay by a constant.
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

const COUNT = process.argv[3] === 'dense' ? 300 : 150;
// same grain math as dustGrains in lib/client.js (keep in sync!)
const AN = (() => { const out = []; for (let i = 0; i < COUNT; i++) out.push(Math.round((i * 137.508 - 90) % 360)); return out; })();
const grains = [];
for (let i = 0; i < COUNT; i++) {
	const ang = AN[i] * Math.PI / 180;
	const jitter = ((i * 31) % 7 - 3) * 1.2;
	const r = 46 - (i % 3) * 1.4 + jitter;
	const size = +(0.6 + ((i * 13) % 6) / 10).toFixed(2);
	const drift = 9 + ((i * 17) % 5);
	const dur = 7 + ((i * 11) % 7);
	const del = -((((i * 23) % 100) / 100) * dur);
	const peak = +(0.55 + ((i * 29) % 4) * 0.1).toFixed(2);
	grains.push(`<circle class="dp" cx="${(50 + r * Math.cos(ang)).toFixed(1)}" cy="${(50 + r * Math.sin(ang)).toFixed(1)}" r="${size}"`
		+ ` style="--dx:${(Math.cos(ang) * drift).toFixed(2)};--dy:${(Math.sin(ang) * drift).toFixed(2)};--dur:${dur}s;--del:${del.toFixed(2)}s;--peak:${peak}"/>`);
}

const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#141824;display:grid;place-items:center;font:16px/1.4 sans-serif}
:root{--dsw-alias-brand-primary:#6a8dff;--dsw-alias-label-primary:#f5f7ff}
${CSS}
/* freeze a deterministic mid-flight frame: every grain 3.4s into its own cycle,
   twinkle at its bright peak, whole-ring beat pulse held high */
.dnl-wave-stardust>.w1 circle.dp{animation-play-state:paused!important;animation-delay:calc(var(--del,0s) - 3.4s)!important}
.dnl-wave-stardust>.w1{animation-play-state:paused!important;animation-delay:calc(var(--dnl-glow-dur,5.6s) * -0.25)!important}
.dnl-wave svg{transform:scale(calc(1 + 1 * .6 * .05))!important;filter:drop-shadow(0 0 3px color-mix(in srgb,var(--dnl-halo,var(--dsw-alias-brand-primary)) 38%,transparent)) brightness(calc(1 + 1 * .6 * .55))!important}
.stage{position:relative;width:560px;height:260px}
.island{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:440px;height:38px;border-radius:999px;border:.5px solid rgba(255,255,255,.14);background:rgb(18,22,34);display:grid;place-items:center;color:#e8edff;font-size:14px}
</style>
<div class="stage">
<div class="island">
<span class="dnl-halobox" style="--dnl-glow-dur:5.6s;--dnl-glow-amp:1;--dnl-beat-gain:1">
<span class="dnl-halo"><span class="h1"></span><span class="h2"></span><span class="h3"></span><span class="h4"></span></span>
<span class="dnl-wave dnl-wave-stardust"><span class="w1"><svg viewBox="0 0 100 100" preserveAspectRatio="none">${grains.join('')}</svg></span></span>
</span>
星尘环 v0.4.42（宇宙尘埃 · 外漂-渐隐-重生生命周期）· ${COUNT} 颗
</div>
</div>`;

const out = process.argv[2];
if (!out) { console.error('usage: node test/_gen-dust-preview.mjs <out.html> [dense]'); process.exit(2); }
fs.writeFileSync(out, html, 'utf8');
console.log('wrote ' + out + ' (' + COUNT + ' grains, v0.4.42 lifecycle, frozen mid-flight frame)');

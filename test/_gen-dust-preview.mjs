// Frozen-frame preview for the v0.4.41 宇宙尘埃 random-walk field.
// Usage: node test/_gen-dust-preview.mjs <out.html> [dense]
// The JS random walk cannot run headless here, so the frame pre-bakes a slow
// deterministic walk (every grain wanders from its anchor) + band-keyed
// opacity — a static approximation of the live field.
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
// same grain math as dustGrains in lib/client.js
const AN = (() => { const out = []; for (let i = 0; i < COUNT; i++) out.push((i * 137.508 - 90) % 360); return out; })();
// a mid-stomp band profile: kick loud, highs tapering off
const bands = [0.35, 0.9, 0.75, 0.5, 0.32, 0.2, 0.12, 0.06, 0.02, 0.0];
const grains = [];
for (let i = 0; i < COUNT; i++) {
	const ang = AN[i] * Math.PI / 180;
	const jitter = ((i * 31) % 7 - 3) * 1.2;
	const r = 46 - (i % 3) * 1.4 + jitter;
	const big = i % 5 === 4;
	const size = big ? 1.5 + ((i * 3) % 10) / 10 : 0.5 + ((i * 7) % 7) / 10;
	// pre-baked slow walk: deterministic wander (seeds, no Math.random for reproducibility)
	const wx = (((i * 7) % 11) - 5) * 0.5, wy = (((i * 13) % 11) - 5) * 0.5;
	// band pair like DUST_BAND_MIX(count)
	const pos = (i * 10) / COUNT, a = Math.floor(pos), fa = 1 - (pos - a), fb = pos - a;
	const band = bands[a] * fa + bands[(a + 1) % 10] * fb;
	grains.push(`<circle class="dp" cx="${(50 + r * Math.cos(ang)).toFixed(1)}" cy="${(50 + r * Math.sin(ang)).toFixed(1)}" r="${size.toFixed(2)}" transform="translate(${wx.toFixed(1)} ${wy.toFixed(1)})" opacity="${(0.3 + band * 0.6).toFixed(2)}"/>`);
}
const bandVars = bands.map((v, i) => `--dnl-b${i}:${v};`).join('');

const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#141824;display:grid;place-items:center;font:16px/1.4 sans-serif}
:root{--dsw-alias-brand-primary:#6a8dff;--dsw-alias-label-primary:#f5f7ff}
${CSS}
/* freeze the breathing so the frame is static */
.dnl-wave-stardust>.w1{animation-delay:calc(var(--dnl-glow-dur,5.6s) * -0.35)!important}
.stage{position:relative;width:560px;height:260px}
.pill{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:440px;height:38px;border-radius:20px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,rgb(12,16,26));box-shadow:inset 0 0 0 1px rgba(255,255,255,.08);display:grid;place-items:center;color:#e8edff;font-size:14px}
</style>
<div class="stage">
<span class="dnl-halo dnl-halo-wave dnl-wave-stardust" style="--dnl-glow-dur:5.6s;--dnl-glow-amp:1;--dnl-beat-gain:1;${bandVars}">
<span class="h1"></span><span class="h2"></span><span class="h3"></span><span class="h4"></span>
<span class="w1"><svg viewBox="0 0 100 100" preserveAspectRatio="none"><g class="dg">${grains.join('')}</g></svg></span>
</span>
<div class="pill">星尘环 v3（宇宙尘埃 · 随机游走预烘）· ${COUNT} 颗 · kick 频段高、高频渐弱</div>
</div>`;

const out = process.argv[2];
fs.writeFileSync(out, html, 'utf8');
console.log('wrote ' + out + ' (' + COUNT + ' grains)');

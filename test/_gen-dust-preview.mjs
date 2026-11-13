// Frozen-frame preview for the v0.4.40 宇宙尘埃 dust field (stardust face).
// Usage: node test/_gen-dust-preview.mjs <out.html>
// Renders the real plugin CSS with the w1/w2 grain groups fed a synthetic kick
// profile (b1/b2 loud, highs decaying) — grains near the loud band angles
// should glow bigger, which is the fftrandom partial-beat look.
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';

const here = new URL('.', import.meta.url);
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

// same grain math as DUST_BAND_MIX / dustGrains in lib/client.js
const mix = (count) => {
	const out = [];
	for (let i = 0; i < count; i++) {
		const pos = (i * 10) / count, a = Math.floor(pos);
		out.push({ a, b: (a + 1) % 10, fa: (1 - (pos - a)).toFixed(2), fb: (pos - a).toFixed(2) });
	}
	return out;
};
const grains = (count, sizeBase, sizeStep, radiusBase, radiusStep, opBase, opGain, phase) =>
	mix(count).map((s, i) => {
		const angle = i * 137.508 - 90 + phase;
		const rad = (angle * Math.PI) / 180;
		const jitter = ((i * 31) % 7 - 3) * 1.2;
		const r = radiusBase - (i % 3) * radiusStep + jitter;
		const size = (sizeBase + (((i + phase) % 4 + 4) % 4) * sizeStep).toFixed(2);
		const expr = `(var(--dnl-b${s.a},0) * ${s.fa} + var(--dnl-b${s.b},0) * ${s.fb})`;
		return `<circle class="dp" cx="${(50 + r * Math.cos(rad)).toFixed(1)}" cy="${(50 + r * Math.sin(rad)).toFixed(1)}" r="${size}" style="transform:scale(calc(0.65 + ${expr} * 1.6));opacity:calc(${opBase} + ${expr} * ${opGain})"/>`;
	}).join('');

// a mid-stomp profile: kick bands loud, highs tapering off
const bands = [0.35, 0.9, 0.75, 0.5, 0.32, 0.2, 0.12, 0.06, 0.02, 0.0];
const bandVars = bands.map((v, i) => `--dnl-b${i}:${v};`).join('');

const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#141824;display:grid;place-items:center;font:16px/1.4 sans-serif}
:root{--dsw-alias-brand-primary:#6a8dff;--dsw-alias-label-primary:#f5f7ff}
${CSS}
/* freeze the breathing/orbit so the frame is static but phases differ */
.dnl-wave-stardust>.w1{animation-delay:calc(var(--dnl-glow-dur,5.6s) * -0.3)!important}
.dnl-wave-stardust>.w1 .dg{animation-delay:calc(var(--dnl-glow-dur,5.6s) * -1.7)!important}
.dnl-wave-stardust>.w2 .dg{animation-delay:calc(var(--dnl-glow-dur,5.6s) * -3.1)!important}
.stage{position:relative;width:560px;height:260px}
.pill{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:440px;height:38px;border-radius:20px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,rgb(12,16,26));box-shadow:inset 0 0 0 1px rgba(255,255,255,.08);display:grid;place-items:center;color:#e8edff;font-size:14px}
</style>
<div class="stage">
<span class="dnl-halo dnl-halo-wave dnl-wave-stardust" style="--dnl-glow-dur:5.6s;--dnl-glow-amp:1;--dnl-beat-gain:1;${bandVars}">
<span class="h1"></span><span class="h2"></span><span class="h3"></span><span class="h4"></span>
<span class="w1"><svg viewBox="0 0 100 100" preserveAspectRatio="none"><g class="dg">${grains(16, 1.3, 0.3, 46, 1, '.3', '.55', 0)}</g></svg></span>
<span class="w2"><svg viewBox="0 0 100 100" preserveAspectRatio="none"><g class="dg dg2">${grains(12, 0.95, 0.24, 47.5, 2, '.26', '.5', 2)}</g></svg></span>
</span>
<div class="pill">星尘环 v2（宇宙尘埃）· 冻结帧（kick 频段高、高频渐弱）</div>
</div>`;

const out = process.argv[2];
fs.writeFileSync(out, html, 'utf8');
console.log('wrote ' + out);

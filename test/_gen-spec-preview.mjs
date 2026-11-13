// Frozen-frame preview for the v0.4.39 spec ring (NCM 音波 partial-beat).
// Usage: node test/_gen-spec-preview.mjs <out.html>
// Renders the real plugin CSS with a w3 bar tier fed a synthetic kick profile
// (b1/b2 loud, highs decaying) — the bars should extend on a slice of the
// circle only, which is the whole point of the face.
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

// same segment math as SPEC_SEGMENTS in lib/client.js
const SEGS = (() => {
	const out = [];
	for (let i = 0; i < 24; i++) {
		const pos = (i * 10) / 24;
		const a = Math.floor(pos);
		out.push({ angle: i * 15 - 90, a, b: (a + 1) % 10, fa: (1 - (pos - a)).toFixed(2), fb: (pos - a).toFixed(2) });
	}
	return out;
})();
const bars = SEGS.map((s, i) =>
	`<g transform="rotate(${s.angle})"><rect class="sb" x="-1.15" y="-47" width="2.3" height="10" rx="1.15" style="transform:scaleY(calc(0.08 + (var(--dnl-b${s.a},0) * ${s.fa} + var(--dnl-b${s.b},0) * ${s.fb}) * 0.92))"/></g>`).join('');

// a mid-stomp profile: kick bands loud, highs tapering off
const bands = [0.35, 0.9, 0.75, 0.5, 0.32, 0.2, 0.12, 0.06, 0.02, 0.0];
const bandVars = bands.map((v, i) => `--dnl-b${i}:${v};`).join('');

const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#141824;display:grid;place-items:center;font:16px/1.4 sans-serif}
:root{--dsw-alias-brand-primary:#6a8dff;--dsw-alias-label-primary:#f5f7ff}
${CSS}
.stage{position:relative;width:560px;height:200px}
.pill{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:440px;height:38px;border-radius:20px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,rgb(12,16,26));box-shadow:inset 0 0 0 1px rgba(255,255,255,.08);display:grid;place-items:center;color:#e8edff;font-size:14px}
</style>
<div class="stage">
<span class="dnl-halo dnl-halo-wave dnl-wave-spec" style="--dnl-glow-dur:5.6s;--dnl-glow-amp:1;--dnl-beat-gain:1;${bandVars}">
<span class="h1"></span><span class="h2"></span><span class="h3"></span><span class="h4"></span>
<span class="w3"><svg viewBox="-50 -50 100 100" preserveAspectRatio="none">${bars}</svg></span>
</span>
<div class="pill">频谱环 · 冻结帧（kick 频段高、高频渐弱）</div>
</div>`;

const out = process.argv[2];
fs.writeFileSync(out, html, 'utf8');
console.log('wrote ' + out);

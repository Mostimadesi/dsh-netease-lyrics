// Frozen-frame preview for the v0.4.43 宇宙尘埃 offset-path dust field.
// Usage: node test/_gen-dust-preview.mjs <out.html> [count] [fine|medium]
// The grains are DOM elements placed on the capsule outline by
// `offset-path: rect(0 100% 100% 0 round 999px)` — the basic shape clamps
// `round` to half the box height, so the path hugs the pill at any width.
// Everything here mirrors dustGrains() in lib/client.js; keep the math in sync.
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

const COUNT = Math.min(300, Math.max(60, Number(process.argv[3]) || 150));
const TIER = process.argv[4] === 'fine' ? 'fine' : 'medium';
const PX = TIER === 'fine' ? [1.5, 3] : [2.5, 4.5];

const grains = [];
for (let i = 0; i < COUNT; i++) {
	// arc-length parameterised, with a sub-percent wobble so the ring reads as
	// dust rather than a comb (still evenly distributed)
	const at = (i / COUNT) * 100 + ((i * 31) % 7 - 3) * 0.012;
	const size = PX[0] + ((i * 13) % 7) / 6 * (PX[1] - PX[0]);
	const ang = (i * 137.508) * Math.PI / 180;        // outward direction
	const drift = 9 + ((i * 17) % 5);                 // 9-13px outward
	const dur = 7 + ((i * 11) % 7);                   // 7-13s cycle
	const del = -((((i * 23) % 100) / 100) * dur);
	const peak = +(0.55 + ((i * 29) % 4) * 0.1).toFixed(2);
	grains.push(`<i class="dnl-dust" style="--at:${at.toFixed(3)}%;--dx:${(Math.cos(ang) * drift).toFixed(1)}px;--dy:${(Math.sin(ang) * drift).toFixed(1)}px;--dur:${dur}s;--del:${del.toFixed(2)}s;--peak:${peak};--sz:${size.toFixed(2)}px"></i>`);
}

const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#141824;display:grid;place-items:center;font:16px/1.4 system-ui,sans-serif}
:root{--dsw-alias-brand-primary:#6a8dff;--dsw-alias-label-primary:#f5f7ff;--dnl-halo:#6a8dff}
${CSS}
/* Freeze a deterministic mid-flight frame: every grain 3.4s into its own
   cycle (no live JS needed), twinkle held at its bright peak. */
.dnl-dust{animation-play-state:paused!important;animation-delay:calc(var(--del,0s) - 3.4s)!important}
.dnl-wave.dnl-wave-stardust>.w1{animation-play-state:paused!important;animation-delay:calc(var(--dnl-glow-dur,5.6s) * -.25)!important}
.dnl-wave svg{transform:none}
.stage{position:relative;width:620px;height:300px}
.island{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:440px;height:38px;border-radius:999px;border:.5px solid rgba(255,255,255,.14);background:rgb(18,22,34);display:grid;place-items:center;color:#e8edff;font-size:13px}
.cap{position:absolute;left:0;right:0;bottom:8px;text-align:center;color:#8b93a7;font-size:12px}
</style>
<div class="stage">
<div class="island">
<span class="dnl-halobox" style="--dnl-glow-dur:5.6s;--dnl-glow-amp:1;--dnl-beat-gain:1">
<span class="dnl-halo"><span class="h1"></span><span class="h2"></span><span class="h3"></span><span class="h4"></span></span>
<span class="dnl-wave dnl-wave-stardust" style="--dnl-dust-glow:1"><span class="w1">${grains.join('')}</span></span>
</span>
星尘环 v0.4.43 · ${COUNT} 颗 · ${TIER === 'fine' ? '细碎' : '适中'}
</div>
<div class="cap">offset-path 真胶囊轮廓（不再横向拉伸）· 径向羽化 + plus-lighter 加法混合 · 外漂-渐隐-重生</div>
</div>`;

const out = process.argv[2];
if (!out) { console.error('usage: node test/_gen-dust-preview.mjs <out.html> [count] [fine|medium]'); process.exit(2); }
fs.writeFileSync(out, html, 'utf8');
console.log('wrote ' + out + ' (' + COUNT + ' offset-path grains, ' + TIER + ', frozen mid-flight)');

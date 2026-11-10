// Reproduce the "decor only covers the collapsed strip" report: render the REAL
// island CSS + real DOM skeleton in the EXPANDED state, rainv2 on, animations
// phase-frozen, on a dark desktop-ish backdrop. Screenshot tells the truth.
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

const spans = [
	...['s1', 's2', 's3'].map((k) => `<span class="dnl-decor-streak ${k}"></span>`),
	// default density 7 → the first seven slots of RV2_BEAD_ORDER
	...['b2', 'b5', 'b4', 'b7', 'b3', 'b1', 'b9'].map((k) => `<span class="dnl-decor-drop ${k}"></span>`),
	...['sl1', 'sl2', 'sl3', 'sl4'].map((k) => `<span class="dnl-decor-drop ${k}"></span>`),
	...['ra1', 'ra2', 'rb1', 'rb2', 'rc1', 'rc2', 'rd1', 'rd2'].map((k) => `<span class="dnl-decor-remnant ${k}"></span>`),
].join('');

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{margin:0;background:linear-gradient(140deg,#1a2438 0%,#0b1120 55%,#131c30 100%);min-height:100vh;padding:30px 0 0;font-family:system-ui}
/* host-theme aliases (dark values, mirroring the desktop profile) */
.dnl-stage{--dsw-alias-bg-overlay:rgba(16,24,42,.78);--dsw-alias-border-l1:rgba(120,150,220,.28);
--dsw-alias-label-primary:#e8eefc;--dsw-alias-label-secondary:#aebdd8;--dsw-alias-label-tertiary:#7f92b5;
--dsw-alias-brand-primary:#4f8cff;padding:40px;display:flex;justify-content:center}
${CSS}
/* phase freeze (v0.4.19 top-based profile): beads mid-hang; sl1 at 70% (top 50%,
 * ra1 shed, long remnant); sl3 at 84% (top 85%, both rc remnants visible);
 * streaks mid-fall */
.b1{animation-delay:-4.4s !important;animation-play-state:paused !important}
.b2{animation-delay:-6s !important;animation-play-state:paused !important}
.b3{animation-delay:-12.9s !important;animation-play-state:paused !important}
.b4{animation-delay:-5.6s !important;animation-play-state:paused !important}
.b5{animation-delay:-11.55s !important;animation-play-state:paused !important}
.b7{animation-delay:-5s !important;animation-play-state:paused !important}
.b9{animation-delay:-13.36s !important;animation-play-state:paused !important}
.sl1,.sl1::after,.ra1,.ra2{animation-delay:-9.8s !important;animation-play-state:paused !important}
.sl2,.sl2::after,.rb1,.rb2{animation-delay:-2s !important;animation-play-state:paused !important}
.sl3,.sl3::after,.rc1,.rc2{animation-delay:-12.6s !important;animation-play-state:paused !important}
.sl4,.sl4::after,.rd1,.rd2{animation-delay:-1s !important;animation-play-state:paused !important}
.s1{animation-delay:-.9s !important;animation-play-state:paused !important}
.s2{animation-delay:-1.7s !important;animation-play-state:paused !important}
.s3{animation-delay:-1.2s !important;animation-play-state:paused !important}
/* STRUCTURAL CHECK ONLY (not shipped): brighten every water element and outline
 * the layer so placement/coverage can be verified in a still. Aesthetic judgment
 * uses the un-brightened shot. */
${process.argv[3] === 'bright' ? '.dnl-decor{outline:2px dashed magenta}.dnl-decor-drop,.dnl-decor-remnant{filter:brightness(3)}.dnl-decor-streak{opacity:.6 !important}' : ''}
${process.argv[3] === 'zoom' ? '.dnl-stage{zoom:2.4}' : ''}
</style></head><body><div class="dnl-stage"><div class="dnl-host" style="position:static;transform:none">
<div class="dnl-island dnl-expanded" style="border-radius:24px">
	<button class="dnl-drag" style="position:absolute">⠿</button>
	<div class="dnl-decor dnl-decor-rainv2" aria-hidden="true">${spans}</div>
	<div class="dnl-grow" aria-hidden="undefined"><div class="dnl-grow-inner"><div class="dnl-panel">
		<div class="dnl-lines">
			<div class="dnl-line"><span>夜空中最亮的星 是否聆听</span></div>
			<div class="dnl-line"><span>那仰望的人 心底的孤独和叹息</span></div>
			<div class="dnl-line"><span>给我再去相信的勇气</span></div>
			<div class="dnl-line"><span>越过谎言去拥抱你</span></div>
		</div>
	</div></div></div>
	<div class="dnl-now"><span class="dnl-now-text">夜空中最亮的星 — 逃跑计划</span></div>
</div>
</div></div></body></html>`;

fs.writeFileSync(process.argv[2], html, 'utf8');
console.log('written', process.argv[2], html.length, 'bytes');

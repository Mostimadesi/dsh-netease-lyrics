// Reproduce the "decor only covers the collapsed strip" report: render the REAL
// island CSS + real DOM skeleton in the EXPANDED state, rainv2/petalsv2 on,
// animations phase-frozen, on a dark desktop-ish backdrop. Screenshot tells the truth.
// Usage: node _gen-rainv2-expanded.mjs <out.html> <mode> [preset] [variant]
//   mode: (empty) | bright | zoom    preset: rainv2 (default) | petalsv2 | motesv2
//   variant: rainv2 → slide|evaporate · petalsv2 → v2|classic · motesv2 → dust|star|gentle|stargentle
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
const preset = process.argv[4] || 'rainv2';

const spans = preset === 'petalsv2'
	? ['p6', 'p12', 'p3', 'p10', 'p8', 'p2', 'p11', 'p5'].map((k) =>
		`<span class="dnl-decor-petal ${k} ${{ p6: 'sh-a', p12: 'sh-b', p3: 'sh-c', p10: 'sh-a', p8: 'sh-b', p2: 'sh-c', p11: 'sh-a', p5: 'sh-b' }[k]}${['p12', 'p8', 'p5', 'p4'].includes(k) ? ' acc' : ''}"></span>`).join('')
	: preset === 'motesv2'
	? ['o7', 'o3', 'o12', 'o10', 'o1', 'o9', 'o4'].map((k) =>
		`<span class="dnl-decor-mote2 ${k} ${{ o3: 'd-near', o7: 'd-near', o12: 'd-near', o11: 'd-near', o2: 'd-far', o5: 'd-far', o8: 'd-far' }[k] || 'd-mid'}"></span>`).join('')
	: [
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
/* phase freeze (v0.4.25 anchor-slide profile): beads hang until 54% then slide
 * to the rim — freeze a mix of hanging and mid-slide phases; sl1 at 70%,
 * sl2 at 50%, sl3 at 84%, sl4 at 35%; streaks mid-fall. Native delays are
 * negative, so these just re-pick exact phases. */
.b1{animation-delay:-3.3s !important;animation-play-state:paused !important}
.b2{animation-delay:-5.2s !important;animation-play-state:paused !important}
.b3{animation-delay:-8.4s !important;animation-play-state:paused !important}
.b4{animation-delay:-2.8s !important;animation-play-state:paused !important}
.b5{animation-delay:-8.9s !important;animation-play-state:paused !important}
.b7{animation-delay:-6.75s !important;animation-play-state:paused !important}
.b9{animation-delay:-9.6s !important;animation-play-state:paused !important}
.sl1,.sl1::after,.ra1,.ra2{animation-delay:-9.8s !important;animation-play-state:paused !important}
.sl2,.sl2::after,.rb1,.rb2{animation-delay:-8s !important;animation-play-state:paused !important}
.sl3,.sl3::after,.rc1,.rc2{animation-delay:-12.6s !important;animation-play-state:paused !important}
.sl4,.sl4::after,.rd1,.rd2{animation-delay:-6s !important;animation-play-state:paused !important}
.s1{animation-delay:-.9s !important;animation-play-state:paused !important}
.s2{animation-delay:-1.7s !important;animation-play-state:paused !important}
.s3{animation-delay:-1.2s !important;animation-play-state:paused !important}
/* petalsv2 phase freeze: p6 at 30% (mid-fall, sway left), p12 at 55% (lower, sway right),
 * p3 at 70% (near bottom), p10 at 15% (early), p8 at 40%, p2 at 60%, p11 at 25%, p5 at 50% */
.p6{animation-delay:calc(-9.2s * 0.3 / 1),calc(-3.6s * 0.5 / 1) !important;animation-play-state:paused !important}
.p12{animation-delay:calc(-10.6s * 0.55 / 1),calc(-4.3s * 0.3 / 1) !important;animation-play-state:paused !important}
.p3{animation-delay:calc(-8.8s * 0.7 / 1),calc(-4.4s * 0.2 / 1) !important;animation-play-state:paused !important}
.p10{animation-delay:calc(-10.2s * 0.15 / 1),calc(-3.7s * 0.6 / 1) !important;animation-play-state:paused !important}
.p8{animation-delay:calc(-9.8s * 0.4 / 1),calc(-3.4s * 0.8 / 1) !important;animation-play-state:paused !important}
.p2{animation-delay:calc(-9.6s * 0.6 / 1),calc(-3.9s * 0.4 / 1) !important;animation-play-state:paused !important}
.p11{animation-delay:calc(-9s * 0.25 / 1),calc(-3.5s * 0.7 / 1) !important;animation-play-state:paused !important}
.p5{animation-delay:calc(-9.4s * 0.5 / 1),calc(-4.1s * 0.1 / 1) !important;animation-play-state:paused !important}
/* STRUCTURAL CHECK ONLY (not shipped): brighten every water element and outline
 * the layer so placement/coverage can be verified in a still. Aesthetic judgment
 * uses the un-brightened shot. */
${process.argv[3] === 'bright' ? '.dnl-decor{outline:2px dashed magenta}.dnl-decor-drop,.dnl-decor-remnant,.dnl-decor-petal,.dnl-decor-mote2{filter:brightness(3)}.dnl-decor-streak{opacity:.6 !important}' : ''}
${process.argv[3] === 'zoom' ? '.dnl-stage{zoom:2.4}' : ''}
</style></head><body><div class="dnl-stage"><div class="dnl-host" style="position:static;transform:none">
<div class="dnl-island dnl-expanded" style="border-radius:24px">
	<button class="dnl-drag" style="position:absolute">⠿</button>
	<div class="dnl-decor dnl-decor-${preset}${preset === 'rainv2' && process.argv[5] === 'evaporate' ? ' rv2-end-evaporate' : preset === 'rainv2' ? ' rv2-end-slide' : preset === 'petalsv2' ? ' ' + (process.argv[5] === 'classic' ? 'pv2-mat-classic' : 'pv2-mat-v2') : preset === 'motesv2' ? ' mv2-mood-' + (/^star/.test(process.argv[5] || '') ? 'star' : 'dust') + ' mv2-motion-' + (/gentle$/.test(process.argv[5] || '') ? 'gentle' : 'wander') : ''}" aria-hidden="true">${spans}</div>
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

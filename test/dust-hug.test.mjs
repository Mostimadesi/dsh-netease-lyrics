// v0.4.47 hug contract: does the dust ring actually sit on the capsule, and
// does the band-thickness knob actually thicken it?
//
// The v0.4.43 bug is invisible to every CSS-text assertion we already have —
// the stylesheet looked perfect, but each grain element was a 3-4px dot, and
// the capsule path had no room to exist. All 60 grains landed on one point,
// 42px outside the pill. This file therefore asserts the things that make the
// ring real:
//
//   1. the grain element FILLS its band (inset:0) and carries the path, while
//      the visible dot is a centred ::after — a dot-sized element can never hug;
//   2. the outward band offset lives INSIDE the path expression. v0.4.46 tried
//      to grow the grain box instead (inset:calc(-1 * var(--off))) and the band
//      stayed byte-identical, because inset() resolves against the CONTAINING
//      BLOCK, not the element's own border box. Probe 11 measured the working
//      form: inset(calc(-1 * var(--off,0px)) 4px round 999px) moves the grains
//      to y -12/+12 (off 12px) and y -24/+24 (off 24px).
//
// And it proves the fallback hug mode the user asked for (m08390: 先做略微外扩
// 作为一种设置选项供用户回退) is wired end to end: sanitizer → class → CSS.
import assert from 'node:assert/strict';
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
const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

// ---- 1. the grain element is a full-bleed path carrier -----------------------
const grainRule = CSS.match(/\.dnl-wave \.dnl-dust\{([^}]*)\}/);
assert.ok(grainRule, 'the grain rule exists');
const grain = grainRule[1];
assert.match(grain, /position:absolute;inset:0;/,
	'the grain element fills the band; a dot-sized element makes the path collapse onto one point (v0.4.43 bug)');
assert.doesNotMatch(grain, /inset:calc\(-1 \* var\(--off/,
	'the band offset must NOT be applied by growing the grain box — inset() resolves against the '
	+ 'containing block, so the path stayed identical and the thickness slider did nothing (v0.4.46 bug, user m11872 #1)');
assert.doesNotMatch(grain, /width:var\(--sz/,
	'the grain element must NOT be sized by the dot diameter — that is what broke the ring');
assert.doesNotMatch(grain, /height:var\(--sz/,
	'the grain element must not be dot-sized vertically either');
assert.match(grain, /offset-path:inset\(calc\(-1 \* var\(--off,0px\)\) 4px round 999px\);/,
	'each grain carries its own outward offset inside the path expression, so raising the count '
	+ 'thickens the band instead of piling every grain on one line');
assert.match(grain, /offset-distance:var\(--at,0%\);/,
	'grains are placed by arc-length distance around the capsule');
assert.match(grain, /offset-anchor:center;/,
	'the anchor is the element centre, which is where the ::after dot is pinned');
assert.match(grain, /offset-rotate:0deg;/,
	'the dot never rotates with the path tangent');

// ---- 2. the visible dot is the ::after, pinned to the anchor -----------------
const dotRule = CSS.match(/\.dnl-wave \.dnl-dust::after\{([^}]*)\}/);
assert.ok(dotRule, 'the dot pseudo-element exists');
const dot = dotRule[1];
assert.match(dot, /position:absolute;left:50%;top:50%;/,
	'the dot is centred on the path anchor');
assert.match(dot, /translate:-50% -50%;/,
	'the dot is offset by half its own size so it is truly centred');
assert.match(dot, /width:var\(--sz,3px\);height:var\(--sz,3px\);/,
	'each grain keeps its own baked diameter');
assert.match(dot, /border-radius:50%;/,
	'the dot is round — never a stretched bar');
assert.match(dot, /mix-blend-mode:plus-lighter;/,
	'overlaps accumulate light like the official additive particle field');

// ---- 3. ring-vs-band geometry: the ring lands outside the pill rim ----------
const bandOut = Number(CSS.match(/\.dnl-wave\.dnl-wave-stardust>\.w1\{inset:(-?\d+)px/)?.[1]);
assert.equal(bandOut, -4, 'the band extends 4px past the pill on every side');
const pathInset = Number(CSS.match(/offset-path:inset\(calc\(-1 \* var\(--off,0px\)\) (\d+)px round 999px\)/)?.[1]);
assert.equal(pathInset, 4, 'the path is inset 4px inside the band, on top of each grain\'s own --off');
// band = pill + 4px each side; path inset 4px inside the band => the ring is
// exactly pill-width horizontally and 8px taller vertically: straight runs sit
// 4px out, and the caps wrap back to touch the pill at its widest points.
assert.equal(bandOut + pathInset, 0, 'horizontally the ring is flush with the capsule width');

// ---- 4. fallback hug mode is wired end to end -------------------------------
assert.match(CSS, /\.dnl-wave\.dnl-hug-slight>\.w1\{inset:-9px\}/,
	'fallback mode is a visibly wider uniform 9px outset (v0.4.46: 3px read identical to wrap, user m11591 #4)');
assert.match(CSS, /\.dnl-wave\.dnl-hug-slight \.dnl-dust\{offset-path:inset\(calc\(-1 \* var\(--off,0px\)\) round 999px\)\}/,
	'fallback mode keeps the per-grain --off inside a uniform 9px band edge');
assert.match(src, /if \(raw\?\.glowDustHug === "wrap" \|\| raw\?\.glowDustHug === "slight"\) out\.glowDustHug = raw\.glowDustHug;/,
	'the hug choice round-trips through the sanitizer whitelist');
assert.match(src, /prefs\.glowWaveStyle === "stardust" && prefs\.glowDustHug === "slight" \? " dnl-hug-slight" : ""/,
	'the hug choice reaches the wave span as a class');
assert.match(src, /\[\["wrap", "中间外扩 · 两端环绕（默认）"\], \["slight", "整体略微外扩"\]\]/,
	'both hug modes are offered in settings');
assert.match(src, /glowDustHug: undefined, glowDustSpread: undefined \}\) \}, "恢复尘埃默认参数"\)/,
	'the reset button restores the default hug mode and band thickness too');

// ---- 5. beat drives the ring, not just a blink ------------------------------
assert.doesNotMatch(CSS, /\.dnl-wave\.dnl-wave-stardust>\.w1\{[^}]*filter:brightness/,
	'the grain group carries no beat-driven filter (v0.4.45: it re-rasters the whole chain)');
assert.match(CSS, /\.dnl-dustpulse\{[^}]*opacity:calc\(\.22 \+ min\(var\(--dnl-beat-gain,0\),1\.2\) \* var\(--dnl-beat-slow,0\) \* \.32\)/,
	'the bloom rides the SLOW lane and its gain is capped at 1.2 (v0.4.46: the 60 Hz lane made the halo tremble, 200% buried the pill — user m11591 #1/#3)');
assert.match(CSS, /100%\{translate:calc\(var\(--dx,6px\) \* \(1 \+ var\(--dnl-beat-slow,0\) \* var\(--dnl-beat-gain,0\)\)\)/,
	'the outward drift distance swells with the SLOW beat lane (m08390 #2b, v0.4.45 detune)');
assert.match(CSS, /@keyframes dnl-wave-twinkle\{0%,100%\{opacity:calc\(\.74 /,
	'twinkle was pushed back to weak background noise (m08390 #4: 保留但压弱)');

// ---- 6. the grain factory stays the single source of geometry --------------
assert.equal(typeof plugin.__test.dustGrains, 'function',
	'dustGrains is exported, so previews and probes render the REAL nodes instead of a copy that can drift');
assert.equal(typeof plugin.__test.DUST_COUNT, 'function', 'DUST_COUNT is exported');
assert.equal(typeof plugin.__test.DUST_SPREAD, 'function', 'DUST_SPREAD is exported');
const grains = plugin.__test.dustGrains(8, 'medium', 0.45);
assert.equal(grains.length, 8, 'one element per grain');
const ats = grains.map((g) => g.props.style['--at']);
assert.equal(ats[0], '0.000%', 'the ring starts at the path origin');
assert.equal(new Set(ats).size, 8, 'every grain gets a distinct arc-length position');
// ---- 7. the band has thickness (v0.4.46, user m11591 #1) -------------------
const offs = grains.map((g) => parseFloat(g.props.style['--off']));
assert.ok(offs.every((v) => v >= 0 && v <= plugin.__test.DUST_BAND_PX),
	'every grain carries its own outward --off, so raising the count thickens the band instead of packing one line');
assert.ok(new Set(offs).size >= 4, 'the offsets are scattered, not quantised to one ring');
/* ---- 7b. the band is VISIBLE, and stays even at high counts (v0.4.47) ------
 * Probe F rendered the same factory at cap 7 and cap 20: at 7px, spread 0% and
 * spread 100% painted an identical 49px band (measured), i.e. the slider did
 * nothing. 14px is the floor where the two extremes differ on screen. */
assert.ok(plugin.__test.DUST_BAND_PX >= 14,
	'the band cap must be thick enough to see: 7px next to a 38px pill rendered '
	+ 'spread 0% and 100% as the same line (user m11872 #1)');
const denseGrains = plugin.__test.dustGrains(220, 'medium', 1);
const denseOffs = denseGrains.map((g) => parseFloat(g.props.style['--off']));
assert.equal(new Set(denseOffs).size, 220,
	'offsets are low-discrepancy, so 220 grains still get 220 distinct rings — '
	+ 'the old ((i*37)%100)/100 repeated every 100 and striped the band');
assert.match(CSS, /\.dnl-wave\.dnl-dust-dense \.dnl-dust::after\{mix-blend-mode:normal\}/,
	'dense tiers drop the per-grain blend surface (user m11591 #2: 200 grains stuttered)');
assert.match(CSS, /\.dnl-wave\.dnl-dust-dense>\.w1\{mix-blend-mode:plus-lighter\}/,
	'...and re-add the SAME additive look once on the group, so the material does not change');

console.log('ok — dust ring hugs the capsule (v0.4.47 contract)');

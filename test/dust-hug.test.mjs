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
assert.match(grain, /position:absolute;left:0;top:0;width:var\(--sz,3px\);height:var\(--sz,3px\);/,
	'the grain box IS the dot (v0.4.48): pixel probe 16 rendered dot-sized and full-bleed carriers and the '
	+ 'rings were identical, so the band-sized box was pure cost');
assert.match(grain, /contain:layout style paint;/,
	'each grain is layout/paint contained, so no grain can dirty the whole band');
assert.doesNotMatch(grain, /inset:calc\(-1 \* var\(--off/,
	'the band offset must NOT be applied by growing the grain box — inset() resolves against the '
	+ 'containing block, so the path stayed identical and the thickness slider did nothing (v0.4.46 bug, user m11872 #1)');
assert.doesNotMatch(grain, /inset:0;contain/,
	'a full-bleed carrier is no longer needed: the ring shape comes from inset() resolving against the '
	+ 'containing block, not from the grain box (v0.4.48)');
assert.match(grain, /offset-path:inset\(calc\(4px - var\(--off,0px\)\) round 999px\);/,
	'each grain carries its own outward offset inside the path expression, so raising the count '
	+ 'thickens the band instead of piling every grain on one line');
assert.doesNotMatch(grain, /offset-path:inset\(calc\(-1 \* var\(--off,0px\)\) 4px/,
	'the path insets must stay SYMMETRIC: growing only the vertical inset made the stadium radius '
	+ 'capH/2+off while the half-width stayed capW/2, so the ring met the capsule only at the two '
	+ 'equators and floated above/below it (v0.4.54; measured 1px band at W/SW vs 12-14px at N/S '
	+ 'on the user 132x78 capsule, m13602 "只是变得更扁了")');
assert.match(grain, /offset-distance:var\(--at,0%\);/,
	'grains are placed by arc-length distance around the capsule');
assert.match(grain, /offset-anchor:center;/,
	'the anchor is the element centre, which is where the ::after dot is pinned');
assert.match(grain, /offset-rotate:0deg;/,
	'the dot never rotates with the path tangent');

// ---- 2. the dot IS the element; light piles up once, on the group -----------
assert.doesNotMatch(CSS, /\.dnl-wave \.dnl-dust::after/,
	'there is no ::after: the gradient paints on the element itself, which halves the painted nodes');
assert.match(grain, /border-radius:50%;/,
	'the dot is round — never a stretched bar');
assert.match(grain, /background-image:radial-gradient\(circle,/,
	'the material is a feathered radial core, not a hard-edged disc');
assert.match(CSS, /\.dnl-wave>\.w1\{mix-blend-mode:plus-lighter\}/,
	'overlaps accumulate light like the official additive particle field — applied ONCE on the group, '
	+ 'because probe v5 measured per-grain and group blending as indistinguishable in cost and look');

// ---- 3. ring-vs-band geometry: a CONSTANT band all the way round ------------
const bandOut = Number(CSS.match(/\.dnl-wave\.dnl-wave-stardust>\.w1\{inset:(-?\d+)px/)?.[1]);
assert.equal(bandOut, -4, 'the band extends 4px past the pill on every side');
const pathIn = CSS.match(/offset-path:inset\(calc\((\d+)px - var\(--off,0px\)\) round 999px\)/);
assert.ok(pathIn, 'the path inset must be written as calc(<n>px - var(--off,0px)) so both axes '
	+ 'grow together — a single round length is scaled proportionally, so symmetric insets give a '
	+ 'stadium of radius capH/2 + n + off, i.e. the outline pushed out by exactly n + off px');
assert.equal(Number(pathIn[1]), 4, 'the path sits 4px inside the band, which lands it on the pill rim');
// band = pill + 4px each side, path inset 4px inside the band => radius and
// half-width are both pill/2 + 4 + off: the band width is CONSTANT. Before
// v0.4.54 the horizontal inset was pinned at 4px while the vertical grew, so
// the ring only touched the pill at the equators (1px there, 12-14px at N/S).
assert.equal(bandOut + Number(pathIn[1]), 0,
	'path box == pill box at off=0: the ring hugs the rim with zero standoff');

// ---- 4. fallback hug mode is wired end to end -------------------------------
assert.match(CSS, /\.dnl-wave\.dnl-hug-slight>\.w1\{inset:-9px\}/,
	'fallback mode is a visibly wider uniform 9px outset (v0.4.46: 3px read identical to wrap, user m11591 #4)');
assert.match(CSS, /\.dnl-wave\.dnl-hug-slight \.dnl-dust\{offset-path:inset\(calc\(0px - var\(--off,0px\)\) round 999px\)\}/,
	'fallback mode keeps the per-grain --off inside its uniform 9px band edge, and its path may '
	+ 'not widen on its own (that would break the constant band width the same way v0.4.52 did)');
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
assert.match(CSS, /100%\{translate:calc\(var\(--dx,6px\) \* min\(1\.7, 1 \+ var\(--dnl-beat-slow,0\) \* var\(--dnl-beat-gain,0\)\)\)/,
	'the outward drift still swells with the SLOW beat lane, but capped at 1.7x (m08390 #2b; v0.4.52: at 200% strength the uncapped 3x turned a 9px leg into a 27px thread hanging off an 84px-tall capsule — user m13378)');
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
assert.match(CSS, /\.dnl-wave>\.w1\{mix-blend-mode:plus-lighter\}/,
	'the additive surface is a single group layer for every tier (user m11591 #2: 200 grains stuttered)');
assert.doesNotMatch(CSS, /\.dnl-wave \.dnl-dust\{[^}]*mix-blend-mode:/,
	'no per-grain blend surface is left behind — that was the cost that scaled with the grain count');

/* ---- 8. the animation budget decouples frames from the count (v0.4.50) -----
 * Probe v9 measured the law: frames track the number of elements that OWN a CSS
 * animation (600=17.9ms, 1200=32.8ms, 2400=75.4ms), while the identical field
 * with the animations stripped stays at 16.7ms even at 2400 grains. Probe v10
 * then capped the animated subset at 128/256 and got 16.7ms at both 1200 and
 * 2400. So the budget, not the drawing, is what buys headroom for slower
 * machines — user m12681 #2. */
assert.ok(plugin.__test.DUST_ANIM_CAP > 0 && plugin.__test.DUST_ANIM_CAP <= 300,
	'DUST_ANIM_CAP is a real budget inside the shipped count range');
assert.equal(typeof plugin.__test.dustAnimSet, 'function', 'dustAnimSet is exported so probes can reuse it');
const big = plugin.__test.dustGrains(300, 'medium', 0.45);
const live = big.filter((g) => String(g.props.className).includes('dnl-dust-live'));
assert.equal(live.length, plugin.__test.DUST_ANIM_CAP,
	'at the max count exactly DUST_ANIM_CAP grains animate — the rest hold a static brightness, '
	+ 'so the frame cost no longer grows with the slider');
const small = plugin.__test.dustGrains(60, 'medium', 0.45);
assert.equal(small.filter((g) => String(g.props.className).includes('dnl-dust-live')).length, 60,
	'below the budget every grain still animates — the cap must never thin a small field');
const liveIdx = [];
big.forEach((g, i) => { if (String(g.props.className).includes('dnl-dust-live')) liveIdx.push(i); });
const gaps = liveIdx.slice(1).map((v, i) => v - liveIdx[i]);
assert.ok(Math.max(...gaps) <= 4,
	'the animated grains are spread around the ring (golden-ratio stride), not clumped into one arc');
const fades = big.filter((g) => !String(g.props.className).includes('dnl-dust-live'))
	.map((g) => parseFloat(g.props.style['--fade']));
assert.ok(fades.every((v) => v > 0.3 && v < 1),
	'parked grains carry a plausible --fade instead of going fully transparent');
assert.ok(new Set(fades).size >= 3, 'the static brightness varies, so the field still reads as dust');

/* ---- 9. constant ink: the band must not saturate as the count rises (v0.4.51)
 * A 440x38 capsule has a 923px perimeter, so spacing falls from 6.2px at 150
 * grains to 3.1px at 300 while the dots stayed 2.5-4.5px wide. From ~200 on they
 * overlap, and because the grain group carries plus-lighter every overlap ADDS
 * light: the band turned into a solid line with clumps at the caps — the artefact
 * the user photographed above 200 grains (m13125). Shrinking the dot with
 * sqrt(150/count) keeps the painted area flat, so density reads as finer dust
 * instead of a brighter wall. */
assert.equal(typeof plugin.__test.DUST_INK_SCALE, 'function',
	'DUST_INK_SCALE is exported so probes can render the shipped geometry');
assert.equal(typeof plugin.__test.DUST_MAX_COUNT, 'number',
	'DUST_MAX_COUNT is exported instead of hiding a magic 300 in two places');
const dot = (n) => parseFloat(plugin.__test.dustGrains(n, 'medium', 0.45)[0].props.style['--sz']);
assert.equal(dot(150), dot(100), 'below the reference density the dots are untouched');
assert.ok(dot(300) < dot(200) && dot(200) < dot(150),
	'the dot shrinks monotonically with the count, so total painted area stays roughly constant');
const ratio = dot(300) / dot(150);
assert.ok(ratio > 0.6 && ratio < 0.8,
	'at the 300-grain max the dot is ~0.71x (sqrt(150/300)) rather than the 1.0x that saturated the band');
assert.ok(plugin.__test.DUST_INK_SCALE(300) >= 0.66,
	'the scale is floored so the dust never shrinks below visibility');

/* Parked grains carry a static translate. Without it they inherit no keyframe
 * motion and sit exactly on the path at a fixed opacity: offset-distance is
 * arc-length parameterised, so they weld into a regular bead chain on the
 * outline — invisible at 150 grains (all animate) but a dotted frame from 181
 * up, compressing into a bright streak at the caps. A static translate costs no
 * animation budget (probe v9: only CSS animations are expensive). */
const parked = plugin.__test.dustGrains(300, 'medium', 0.45)
	.filter((g) => !String(g.props.className).includes('dnl-dust-live'));
assert.equal(parked.length, 300 - plugin.__test.DUST_ANIM_CAP, 'sanity: the parked set is the complement of the budget');
assert.ok(parked.every((g) => /^calc\(var\(--dx\) \* \.55\) /.test(String(g.props.style.translate))),
	'every parked grain is offset off the path, so it scatters into the band like its animated neighbours');
const moving = plugin.__test.dustGrains(300, 'medium', 0.45)
	.filter((g) => String(g.props.className).includes('dnl-dust-live'));
assert.ok(moving.every((g) => g.props.style.translate === undefined),
	'animated grains must NOT take the static translate — it would fight the keyframe');

/* ---- 10. the outward leg has to fit inside the capsule (v0.4.52) ----------
 * Every probe before this painted a 440x38 capsule — 11.6:1 — while the real
 * one is about 150x84. On that squat shape a grain thrown 5-9px along a
 * golden-angle bearing is a fifth of the height and frequently points straight
 * down, which is exactly the hanging thread the user photographed twice
 * (m13125, m13378). The leg is now 2-4.2px and the beat can only stretch it to
 * 1.7x, so the worst case stays near 7px — under a tenth of the capsule. */
const legs = plugin.__test.dustGrains(300, 'medium', 0.45).map((g) => {
	const dx = parseFloat(g.props.style['--dx']);
	const dy = parseFloat(g.props.style['--dy']);
	return Math.hypot(dx, dy);
});
assert.ok(Math.max(...legs) <= 4.5,
	'the base leg never exceeds ~4px, so a grain cannot hang a thread off the band');
assert.ok(Math.min(...legs) >= 1.5,
	'the leg never collapses to zero, so the field still drifts instead of freezing');
assert.ok(new Set(legs.map((v) => v.toFixed(1))).size >= 3,
	'leg lengths vary, so the drift does not read as a mechanical pulse');

console.log('ok — dust ring hugs the capsule (v0.4.54 contract)');

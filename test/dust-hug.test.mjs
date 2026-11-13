// v0.4.44 hug contract: does the dust ring actually sit on the capsule?
//
// The v0.4.43 bug is invisible to every CSS-text assertion we already have —
// the stylesheet looked perfect, but `offset-path`'s basic shape resolves
// against the ELEMENT'S OWN border box, and each grain was a 3-4px dot, so the
// "capsule path" was a 3px box. All 60 grains landed on one point, 42px outside
// the pill. This file therefore asserts the two things that make the ring real:
//
//   1. the grain element FILLS its band (inset:0) and carries the path, while
//      the visible dot is a centred ::after — a dot-sized element can never hug;
//   2. the path inset is smaller than the band outset, so the ring lands
//      outside the pill rim instead of inside it.
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
	'the grain element fills the band; a dot-sized element makes offset-path resolve '
	+ 'against a dot-sized box, which collapses every grain onto one point (v0.4.43 bug)');
assert.doesNotMatch(grain, /width:var\(--sz/,
	'the grain element must NOT be sized by the dot diameter — that is what broke the ring');
assert.doesNotMatch(grain, /height:var\(--sz/,
	'the grain element must not be dot-sized vertically either');
assert.match(grain, /offset-path:inset\(0 4px round 999px\);/,
	'the path is a capsule inset 4px inside the band');
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
const pathInset = Number(CSS.match(/offset-path:inset\(0 (\d+)px round 999px\)/)?.[1]);
assert.equal(pathInset, 4, 'the path is inset 4px inside the band');
// band = pill + 4px each side; path inset 4px inside the band => the ring is
// exactly pill-width horizontally and 8px taller vertically: straight runs sit
// 4px out, and the caps wrap back to touch the pill at its widest points.
assert.equal(bandOut + pathInset, 0, 'horizontally the ring is flush with the capsule width');

// ---- 4. fallback hug mode is wired end to end -------------------------------
assert.match(CSS, /\.dnl-wave\.dnl-hug-slight>\.w1\{inset:-3px\}/,
	'fallback mode pulls the band in to a plain 3px outset');
assert.match(CSS, /\.dnl-wave\.dnl-hug-slight \.dnl-dust\{offset-path:inset\(0 round 999px\)\}/,
	'fallback mode rides the band edge with no extra inset');
assert.match(src, /if \(raw\?\.glowDustHug === "wrap" \|\| raw\?\.glowDustHug === "slight"\) out\.glowDustHug = raw\.glowDustHug;/,
	'the hug choice round-trips through the sanitizer whitelist');
assert.match(src, /prefs\.glowWaveStyle === "stardust" && prefs\.glowDustHug === "slight" \? " dnl-hug-slight" : ""/,
	'the hug choice reaches the wave span as a class');
assert.match(src, /\[\["wrap", "中间外扩 · 两端环绕（默认）"\], \["slight", "整体略微外扩"\]\]/,
	'both hug modes are offered in settings');
assert.match(src, /glowDustHug: undefined \}\) \}, "恢复尘埃默认参数"\)/,
	'the reset button restores the default hug mode too');

// ---- 5. beat drives the ring, not just a blink ------------------------------
assert.match(CSS, /\.dnl-wave\.dnl-wave-stardust>\.w1\{[^}]*filter:brightness\(calc\(1 \+ var\(--dnl-beat-gain,0\) \* var\(--dnl-beat,0\) \* \.6\)\)/,
	'the whole ring brightness rides the beat (m08390 #2a)');
assert.match(CSS, /100%\{translate:calc\(var\(--dx,6px\) \* \(1 \+ var\(--dnl-beat,0\) \* var\(--dnl-beat-gain,0\)\)\)/,
	'the outward drift distance also swells with the beat (m08390 #2b)');
assert.match(CSS, /@keyframes dnl-wave-twinkle\{0%,100%\{opacity:calc\(\.74 /,
	'twinkle was pushed back to weak background noise (m08390 #4: 保留但压弱)');

// ---- 6. the grain factory stays the single source of geometry --------------
assert.equal(typeof plugin.__test.dustGrains, 'function',
	'dustGrains is exported, so previews and probes render the REAL nodes instead of a copy that can drift');
assert.equal(typeof plugin.__test.DUST_COUNT, 'function', 'DUST_COUNT is exported');
const grains = plugin.__test.dustGrains(8, 'medium');
assert.equal(grains.length, 8, 'one element per grain');
const ats = grains.map((g) => g.props.style['--at']);
assert.equal(ats[0], '0.000%', 'the ring starts at the path origin');
assert.equal(new Set(ats).size, 8, 'every grain gets a distinct arc-length position');

console.log('ok — dust ring hugs the capsule (v0.4.44 contract)');

// Style contracts for the v0.4.14 polish round (user feedback 2026-11-10):
//   1. rain droplets must SLIDE down the pane with a trail, not blink out;
//   2. the HUD corner brackets breathe;
//   3. the gear must not turn into a black blob on hover (dark skins).
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

// ---- 1. droplets travel ------------------------------------------------
const dropRule = CSS.match(/\.dnl-decor-rain \.dnl-decor-drop\{([^}]*)\}/);
assert.ok(dropRule, 'the droplet rule exists');
assert.match(dropRule[1], /animation:dnl-drop-slide/, 'droplets run the slide animation');
// The regression itself: the old animation only faded opacity/scale in place.
assert.doesNotMatch(src, /animation:dnl-drop-hold/, 'the in-place fade animation is gone');
// The keyframe body contains inner declarations whose braces end the rule early
// with a naive [^}]* match, so slice from the animation name to the NEXT
// keyframes/rule instead and parse every stop in that slice.
const slideStart = CSS.indexOf('@keyframes dnl-drop-slide{');
assert.ok(slideStart >= 0, 'dnl-drop-slide is defined');
const afterSlide = CSS.slice(slideStart + '@keyframes dnl-drop-slide{'.length);
const slideBody = afterSlide.slice(0, afterSlide.indexOf('}@') >= 0 ? afterSlide.indexOf('}@') : afterSlide.length);
const keyframes = [];
for (const [, selectors, body] of slideBody.matchAll(/((?:-?[\d.]+%)(?:,-?[\d.]+%)*)\{([^{}]*)\}/g)) {
	for (const at of selectors.split(',')) {
		keyframes.push({ at: Number(at.replace('%', '')), body });
	}
}
assert.ok(keyframes.length >= 5, 'the slide has real intermediate poses: ' + JSON.stringify(slideBody.slice(0, 120)));
// every travel pose between bead-up and end must actually move down
const travel = keyframes.filter((k) => /translate3d\([^)]*,[\d.]+%/.test(k.body) && k.at >= 22 && k.at <= 100);
assert.ok(travel.length >= 3, 'format: three or more downward poses');
const ys = travel.map((k) => Number(k.body.match(/translate3d\([^,]+,\s*([\d.]+)%/)[1]));
assert.ok(ys.every((y, i) => i === 0 || y >= ys[i - 1]), 'the droplet only ever moves DOWN: ' + ys.join(','));
assert.ok(ys[ys.length - 1] > 40, 'it travels a real distance, not a nudge: ' + ys[ys.length - 1] + '%');
// the bead gathers before it departs (it must grow, not appear at full size)
const first = keyframes[0].body;
assert.match(first, /scale\(\.\d+\)/, 'the bead starts small and gathers');
// and it keeps a wet trail behind it
assert.match(CSS, /\.dnl-decor-rain \.dnl-decor-drop::after\{[^}]*background:linear-gradient\(180deg,transparent/, 'the droplet carries a trail');
assert.match(CSS, /@keyframes dnl-drop-trail\{/, 'the trail is animated');
const trailDelays = (CSS.match(/\.dnl-decor-rain \.d\d::after\{animation-delay/g) || []).length;
const dropDelays = (CSS.match(/\.dnl-decor-rain \.d\d\{left:/g) || []).length;
assert.equal(trailDelays, dropDelays, 'every droplet has a matching trail delay (' + dropDelays + ' droplets)');
assert.ok(dropDelays >= 4, 'four droplets for an uneven cadence');
// streaks cross the whole capsule and thin out instead of being cut at 150px
const rainStart = CSS.indexOf('@keyframes dnl-rain-fall{');
assert.ok(rainStart >= 0, 'the streak keyframes exist');
const rainBody = CSS.slice(rainStart, rainStart + 300);
assert.match(rainBody, /translate3d\([^)]*120%/, 'rain streaks travel the full height');
assert.match(rainBody, /100%\{[^}]*opacity:0/, 'streaks fade out rather than being clipped');
assert.match(rainBody, /scaleY/, 'streaks stretch as they accelerate');

// ---- 2. corner brackets breathe ---------------------------------------
assert.match(CSS, /@keyframes dnl-ak-bracket-breathe\{/, 'the bracket breathing keyframes exist');
assert.match(CSS, /\.dnl-style-arknights::before\{[^}]*animation:dnl-ak-bracket-breathe/, 'the brackets consume it');
const breatheAt = CSS.indexOf('@keyframes dnl-ak-bracket-breathe{');
assert.ok(breatheAt >= 0, 'the bracket breathing keyframes exist');
const breathe = CSS.slice(breatheAt, breatheAt + 400);
assert.match(breathe, /0%,100%\{opacity:\.\d+/, 'the loop returns to its start (seamless)');
assert.match(breathe, /50%\{opacity:1/, 'it swells to full opacity');
assert.match(breathe, /drop-shadow/, 'and picks up a soft glow');
// the accent it glows with is the skin accent, so rainbow mode animates with it
assert.match(breathe, /var\(--dnl-ak-accent/, 'the glow follows the skin accent');
// reduced motion keeps the brackets visible but static (there are several
// reduced-motion blocks; the bracket one is identified by its subject).
const reducedBlocks = [...CSS.matchAll(/@media\(prefers-reduced-motion:reduce\)\{/g)]
	.map((m) => CSS.slice(m.index, m.index + 800));
const bracketReduced = reducedBlocks.find((block) => block.includes('dnl-style-arknights::before'));
assert.ok(bracketReduced, 'the arknights brackets appear in a reduced-motion block');
assert.match(bracketReduced, /\.dnl-style-arknights::before\{animation:none/, 'reduced motion disables the breathing');
assert.match(bracketReduced, /\.dnl-style-arknights::before\{[^}]*opacity:\.\d+/, 'the brackets stay visible when frozen');

// ---- 3. the gear must not go black on hover ---------------------------
const gearHover = CSS.match(/\.dnl-gear:hover\{([^}]*)\}/);
assert.ok(gearHover, 'the hover rule exists');
assert.doesNotMatch(gearHover[1], /--dsw-alias-label-primary/,
	'the gear must not hover into label-primary (near-black on the dark skins)');
assert.match(gearHover[1], /var\(--dnl-original/, 'it prefers the user lyric colour (guaranteed legible)');
assert.match(gearHover[1], /--dnl-ak-accent/, 'and falls back to the skin accent');
// the hover is still visible: the disc behind the icon carries the affordance
const gearDisc = CSS.match(/\.dnl-gear:hover::before\{([^}]*)\}/);
assert.ok(gearDisc, 'the hover disc rule exists');
assert.match(gearDisc[1], /background:color-mix/, 'the disc is tinted, not flat');
assert.match(gearDisc[1], /border-color:color-mix/, 'and bordered');
// both skins' readable colours are really defined by the theme tokens used above
assert.match(CSS, /--dnl-original/, 'the lyric colour variable exists');

console.log('PASS: style polish — droplets slide with a trail (never fade in place), HUD brackets breathe on the skin accent, the gear hovers into a readable accent instead of black.');

// Contracts for the v0.4.30 月相引路 (persona) rework (user report m03758):
//   1. the moon must be CONTAINED — the old 74px ball at right:-14px/top:-34px
//      was clipped by the capsule into an overflowing "rounded square";
//   2. the skin must read as Persona 3 Reload — deep-night navy, a hairline
//      orbit ring, a cyan horizon line, and a crescent that tracks the REAL
//      moon phase (moonPhaseShadow → --dnl-persona-moon);
//   3. text colours stay on the user knobs (the rework touches chrome only).
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
const { moonPhaseShadow } = plugin.__test;
assert.equal(typeof moonPhaseShadow, 'function', 'moonPhaseShadow is exported for tests');

// ---- 1. the moon is contained AND gradient-painted -----------------------
// (m03914: the real host squashed border-radius/box-shadow on the pseudo into
// a rounded square — the disc must be drawn by radial-gradients + a mask.)
const moon = CSS.match(/\.dnl-style-persona::before\{([^}]*)\}/);
assert.ok(moon, 'the persona ::before (moon) rule exists');
assert.doesNotMatch(moon[1], /(^|;)right:-|(^|;)top:-|(^|;)left:-/, 'no negative offsets — nothing overflows the capsule');
assert.doesNotMatch(moon[1], /74px/, 'the old oversized 74px ball is gone');
const moonSize = Number(moon[1].match(/width:(\d+)px/)[1]);
assert.ok(moonSize <= 24, 'the moon is small enough for the collapsed pill: ' + moonSize + 'px');
assert.doesNotMatch(moon[1], /border-radius/, 'no border-radius — shape must not depend on it (host squashes it)');
assert.doesNotMatch(moon[1], /box-shadow/, 'no box-shadow — the lit disc is a gradient, not a shadow');
assert.match(moon[1], /background:radial-gradient\(circle at 50% 50%,#f8faff 0 6\.5px/,
	'the lit disc is a hard-stop gradient circle (survives border-radius squashing)');
assert.match(moon[1], /mask-image:radial-gradient\(circle at calc\(10px \+ var\(--dnl-persona-moon,6px\)\) 50%,transparent 8\.6px,#000 9\.4px\)/,
	'the dark side is cut by a phase-shifted mask cover-circle with a waxing fallback');
assert.match(moon[1], /-webkit-mask-image:/, 'webkit-prefixed mask rides along for older Electron');
// the unmasked faint outline lives on the island base so a new moon still reads
const base = CSS.match(/\.dnl-style-persona,\.dnl-style-persona\.dnl-expanded\{([^}]*)\}/);
assert.ok(base, 'the persona base rule exists');
assert.match(base[1], /radial-gradient\(circle at calc\(100% - 21px\) 50%,transparent 9px,rgba\(238,244,255,\.18\) 9\.6px/,
	'a faint full-disc outline circles the moon even at new moon');

// ---- 2. P3 Reload chrome ------------------------------------------------
assert.match(base[1], /#081128/, 'deep-night navy base (not the old light-blue wash)');
assert.doesNotMatch(base[1], /#9db8ff 55%/, 'the old light-blue gradient is gone');
assert.match(base[1], /--dnl-panel-alpha/, 'the background still honours panel opacity');
assert.match(base[1], /radial-gradient\(circle at calc\(100% - 21px\) 50%,transparent 15px/,
	'a hairline orbit ring circles the moon (P3R moon motif)');
assert.match(base[1], /linear-gradient\(180deg,transparent calc\(100% - 1px\),color-mix\(in srgb,#59c3ff/,
	'the 1px cyan horizon line runs along the bottom edge');
assert.match(base[1], /border:1px solid color-mix\(in srgb,#7fb8ff/, 'cyan hairline border');
// star motes kept but dimmed; drift still reduced-motion safe
assert.match(CSS, /\.dnl-style-persona::after\{[^}]*animation:dnl-persona-drift/, 'the drifting motes survive');
assert.match(CSS, /@media\(prefers-reduced-motion:reduce\)\{\.dnl-style-persona::after\{animation:none\}\}/,
	'reduced motion stills the drift');
// the label follows the rework
assert.match(src, /\["persona", "月相引路（P3 月夜）"\]/, 'the select label names the P3 night-moon design');

// ---- 3. the phase engine ------------------------------------------------
assert.match(src, /style\["--dnl-persona-moon"\] = moonPhaseShadow\(new Date\(\)\)/,
	'the host injects the current phase shift while the skin is persona');
const xOf = (length) => Number(length.match(/^(-?[\d.]+)px$/)[1]);
// 2000-01-06 18:14 UTC is the epoch new moon: the cover-circle sits dead centre.
const newMoon = xOf(moonPhaseShadow(new Date(Date.UTC(2000, 0, 6, 18, 14))));
assert.ok(Math.abs(newMoon) < 0.5, 'new moon: cover sits centred, x ~ 0, got ' + newMoon);
// 2000-01-21 04:40 UTC full moon: the cover is pushed fully out (|x| = 20).
const fullMoon = xOf(moonPhaseShadow(new Date(Date.UTC(2000, 0, 21, 4, 40))));
assert.ok(Math.abs(fullMoon) >= 19, 'full moon: the whole disc is lit, |x| ~ 20, got ' + fullMoon);
// 2000-01-14 first quarter: waxing → lit on the RIGHT → cover shifts left (x < 0).
const firstQuarter = xOf(moonPhaseShadow(new Date(Date.UTC(2000, 0, 14, 13, 34))));
assert.ok(firstQuarter < -8 && firstQuarter > -13, 'first quarter: half disc, right-lit, x ~ -10, got ' + firstQuarter);
// 2000-01-28 last quarter: waning → lit on the LEFT → x > 0.
const lastQuarter = xOf(moonPhaseShadow(new Date(Date.UTC(2000, 0, 28, 7, 57))));
assert.ok(lastQuarter > 8 && lastQuarter < 13, 'last quarter: half disc, left-lit, x ~ +10, got ' + lastQuarter);

console.log('PASS: 月相引路 rework — gradient-painted phase-true crescent (no border-radius/box-shadow reliance), orbit ring + horizon line, deep-navy P3 chrome, real moon phase math verified against the 2000-01 lunation.');

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

// ---- 1. the moon is contained ------------------------------------------
const moon = CSS.match(/\.dnl-style-persona::before\{([^}]*)\}/);
assert.ok(moon, 'the persona ::before (moon) rule exists');
assert.doesNotMatch(moon[1], /(^|;)right:-|(^|;)top:-|(^|;)left:-/, 'no negative offsets — nothing overflows the capsule');
assert.doesNotMatch(moon[1], /74px/, 'the old oversized 74px ball is gone');
const moonSize = Number(moon[1].match(/width:(\d+)px/)[1]);
assert.ok(moonSize <= 24, 'the moon is small enough for the collapsed pill: ' + moonSize + 'px');
assert.match(moon[1], /border-radius:50%/, 'still a disc (the crescent comes from the shadow, not the shape)');
assert.match(moon[1], /box-shadow:var\(--dnl-persona-moon,/, 'the lit sliver is phase-driven with a CSS fallback');
assert.match(moon[1], /inset -?\d+px -?\d+px 0 0 #eef4ff/, 'the fallback itself is a waxing crescent');

// ---- 2. P3 Reload chrome ------------------------------------------------
const base = CSS.match(/\.dnl-style-persona,\.dnl-style-persona\.dnl-expanded\{([^}]*)\}/);
assert.ok(base, 'the persona base rule exists');
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
	'the host injects the current phase shadow while the skin is persona');
const dxOf = (shadow) => Number(shadow.match(/^inset (-?[\d.]+)px/)[1]);
// 2000-01-06 18:14 UTC is the epoch new moon: the disc is fully covered.
const newMoon = dxOf(moonPhaseShadow(new Date(Date.UTC(2000, 0, 6, 18, 14))));
assert.ok(Math.abs(newMoon) < 0.5, 'new moon: shadow covers the disc, dx ~ 0, got ' + newMoon);
// 2000-01-21 04:40 UTC full moon: the shadow is pushed fully out (|dx| = 2R).
const fullMoon = dxOf(moonPhaseShadow(new Date(Date.UTC(2000, 0, 21, 4, 40))));
assert.ok(Math.abs(fullMoon) >= 19, 'full moon: the whole disc is lit, |dx| ~ 20, got ' + fullMoon);
// 2000-01-14 first quarter: waxing → lit on the RIGHT → shadow shifts left (dx < 0).
const firstQuarter = dxOf(moonPhaseShadow(new Date(Date.UTC(2000, 0, 14, 13, 34))));
assert.ok(firstQuarter < -8 && firstQuarter > -13, 'first quarter: half disc, right-lit, dx ~ -10, got ' + firstQuarter);
// 2000-01-28 last quarter: waning → lit on the LEFT → dx > 0.
const lastQuarter = dxOf(moonPhaseShadow(new Date(Date.UTC(2000, 0, 28, 7, 57))));
assert.ok(lastQuarter > 8 && lastQuarter < 13, 'last quarter: half disc, left-lit, dx ~ +10, got ' + lastQuarter);
// the shadow string always carries the faint outline + glow so a new moon still reads
assert.match(moonPhaseShadow(new Date()), /0 0 0 1px rgba\(238,244,255,\.14\)/, 'faint disc outline rides along');
assert.match(moonPhaseShadow(new Date()), /0 0 8px rgba\(207,224,255,\.45\)/, 'soft glow rides along');

console.log('PASS: 月相引路 rework — contained 20px phase-true crescent, orbit ring + horizon line, deep-navy P3 chrome, real moon phase math verified against the 2000-01 lunation.');

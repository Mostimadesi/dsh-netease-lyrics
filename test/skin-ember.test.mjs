// Contracts for the v0.4.31 暗夜余烬 (ember) full rework (user report m04021):
//   1. the old look must be GONE — v2 was a milk-coffee tan gradient + SVG
//      grain, neither 暗夜 nor 余烬;
//   2. the new skin is a CHARCOAL BED: near-black base with a whisper of
//      dark red, a 1px heat line at the bottom edge, and a warm hairline;
//   3. 余烬 reads through motion: coal glows that slowly BREATHE (::before)
//      and sparks that RISE, flicker and die mid-way (::after) — flicker/fade
//      modelled on the WE fireworks oscillatealpha+alphachange reference;
//   4. calm on purpose (user picked 静谧): slow cycles, two sparks max;
//   5. pseudos must paint ABOVE the near-opaque charcoal background-color,
//      so z-index:-1 is forbidden on them (it would hide the whole effect);
//   6. reduced motion stills both pseudos; text colours stay on user knobs.
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

// ---- 1. the milk-coffee tan v2 is gone -----------------------------------
const base = CSS.match(/\.dnl-style-ember,\.dnl-style-ember\.dnl-expanded\{([^}]*)\}/);
assert.ok(base, 'the ember base rule exists');
assert.doesNotMatch(base[1], /#e8955c|#3a2214|#14100c/, 'the tan/coffee gradient colours are gone');
assert.doesNotMatch(CSS, /\.dnl-style-ember::before\{[^}]*feTurbulence/, 'the SVG grain layer is gone');

// ---- 2. charcoal bed ------------------------------------------------------
assert.match(base[1], /#0d0705/, 'near-black charcoal base');
assert.match(base[1], /#2a0f08/, 'a whisper of dark red in the bed gradient');
assert.match(base[1], /--dnl-panel-alpha/, 'the background still honours panel opacity');
assert.match(base[1], /border:1px solid color-mix\(in srgb,#ff8c42/, 'warm ember hairline border');
assert.match(base[1], /linear-gradient\(180deg,transparent calc\(100% - 1px\),color-mix\(in srgb,#ff7a45/,
	'the 1px heat line runs along the bottom edge');
assert.match(base[1], /inset 0 -14px 30px -18px rgba\(255,110,50/, 'residual heat glows from below (inset shadow)');
assert.match(base[1], /rgba\(0,0,0,\.5/, 'a proper dark drop shadow for the night object');
// no dark-text override survives — text colours stay on the user knobs
assert.doesNotMatch(CSS, /\.dnl-style-ember \.dnl-now\{color:#2d1a0c\}/, 'the old unreadable dark-text override is gone');
assert.match(CSS, /\.dnl-style-ember\.dnl-expanded\{border-radius:12px\}/, 'expanded keeps the 12px squarer corners');

// ---- 3. breathing coals (::before) ----------------------------------------
const coals = CSS.match(/\.dnl-style-ember::before\{([^}]*)\}/);
assert.ok(coals, 'the ember ::before (coals) rule exists');
const coalSpots = coals[1].match(/radial-gradient\(circle at /g) || [];
assert.ok(coalSpots.length >= 3 && coalSpots.length <= 5, 'three-to-five dim coal glows, got ' + coalSpots.length);
const breathe = coals[1].match(/animation:dnl-ember-breathe ([\d.]+)s ease-in-out infinite alternate/);
assert.ok(breathe, 'the coals breathe (ease-in-out alternate)');
assert.ok(Number(breathe[1]) >= 5, 'the breath is slow (>=5s), got ' + breathe[1]);
assert.match(CSS, /@keyframes dnl-ember-breathe\{from\{opacity:\.34\}to\{opacity:1\}\}/,
	'the breath swings dim -> lit, never fully dark, never blinking');

// ---- 4. rising sparks (::after) -------------------------------------------
// (anchor on background-image so the shared placement rule's `::after{` tail
// — which precedes this rule — cannot win the first-match race)
const sparks = CSS.match(/\.dnl-style-ember::after\{(background-image[^}]*)\}/);
assert.ok(sparks, 'the ember ::after (sparks) rule exists');
const sparkDots = sparks[1].match(/radial-gradient\(circle at /g) || [];
assert.ok(sparkDots.length >= 1 && sparkDots.length <= 3, 'sparks stay sparse (<=3, 静谧), got ' + sparkDots.length);
const rise = sparks[1].match(/animation:dnl-ember-rise ([\d.]+)s linear infinite/);
assert.ok(rise, 'the sparks ride their own slow cycle');
assert.ok(Number(rise[1]) >= 6, 'the rise cycle is unhurried (>=6s), got ' + rise[1]);
const riseKf = CSS.match(/@keyframes dnl-ember-rise\{([^@]*)\}/);
assert.ok(riseKf, 'the rise keyframes exist');
assert.match(riseKf[1], /0%\{transform:translateY\(8px\);opacity:0\}/, 'sparks fade in near the coals');
assert.match(riseKf[1], /100%\{transform:translateY\(-34px\);opacity:0\}/, 'sparks rise and die mid-air');
// flicker: mid-flight opacity must change direction at least 3 times
const mid = [...riseKf[1].matchAll(/\d+%\{opacity:\.(\d+)\}/g)].map((m) => Number('0.' + m[1]));
assert.ok(mid.length >= 5, 'enough opacity stops to flicker, got ' + mid.length);
let turns = 0;
for (let i = 2; i < mid.length; i++) {
	const d1 = mid[i - 1] - mid[i - 2], d2 = mid[i] - mid[i - 1];
	if (d1 !== 0 && d2 !== 0 && Math.sign(d1) !== Math.sign(d2)) turns++;
}
assert.ok(turns >= 3, 'sparks flicker (>=3 opacity direction changes), got ' + turns);

// ---- 5. pseudos above the charcoal bed ------------------------------------
const pseudos = CSS.match(/\.dnl-style-ember::before,\.dnl-style-ember::after\{([^}]*)\}/);
assert.ok(pseudos, 'the shared pseudo placement rule exists');
assert.doesNotMatch(pseudos[1], /z-index:-1/, 'pseudos must not hide behind the near-opaque charcoal background');
assert.match(pseudos[1], /pointer-events:none/, 'pseudos never eat clicks');

// ---- 6. reduced motion + label --------------------------------------------
assert.match(CSS, /@media\(prefers-reduced-motion:reduce\)\{\.dnl-style-ember::before,\.dnl-style-ember::after\{animation:none\}/,
	'reduced motion stills both pseudos');
assert.match(src, /\["ember", "暗夜余烬（炭火余温）"\]/, 'the select label names the charcoal-ember design');

console.log('PASS: 暗夜余烬 v3 — charcoal bed + bottom heat line, breathing coal glows (6.5s alternate), two rising flickering sparks (7.5s, die mid-air), calm by design, reduced-motion safe.');

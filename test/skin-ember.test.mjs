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
const sandbox = {
	window: {
		__ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => ({ default: React })); } },
		addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
		matchMedia: () => ({ matches: false }), innerWidth: 1200, innerHeight: 800,
	},
	document: undefined, console, AbortController, AbortSignal,
	fetch: () => new Promise(() => {}),
	Event: class {}, localStorage: { getItem: () => null, setItem() {} },
	setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
};
vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), sandbox);

const CSS = plugin.__test.CSS;
const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

// ---- 1. the milk-coffee tan v2 is gone -----------------------------------
const base = CSS.match(/\.dnl-style-ember,\.dnl-style-ember\.dnl-expanded\{([^}]*)\}/);
assert.ok(base, 'the ember base rule exists');
assert.doesNotMatch(base[1], /#e8955c|#3a2214|#14100c/, 'the tan/coffee gradient colours are gone');
assert.doesNotMatch(CSS, /\.dnl-style-ember::before\{[^}]*feTurbulence/, 'the SVG grain layer is gone');

// ---- 2. charcoal bed + the filled upper half (v3.1, user m04266) ----------
assert.match(base[1], /#0d0705/, 'near-black charcoal base');
assert.match(base[1], /#2a0f08/, 'a whisper of dark red in the bed gradient');
assert.match(base[1], /--dnl-panel-alpha/, 'the background still honours panel opacity');
assert.match(base[1], /border:1px solid color-mix\(in srgb,#ff8c42/, 'warm ember hairline border');
assert.match(base[1], /linear-gradient\(180deg,transparent calc\(100% - 1px\),color-mix\(in srgb,#ff7a45/,
	'the 1px heat line runs along the bottom edge');
assert.match(base[1], /inset 0 -14px 30px -18px rgba\(255,110,50/, 'residual heat glows from below (inset shadow)');
assert.match(base[1], /rgba\(0,0,0,\.5/, 'a proper dark drop shadow for the night object');
// v3.1: the upper half carries its own life — drifting heat motes, a soft
// top halo, and a fire-glow rising from below (all base background layers)
const upperDots = [...base[1].matchAll(/radial-gradient\(circle at (\d+)% (\d+)%/g)]
	.map((m) => ({ x: Number(m[1]), y: Number(m[2]) }))
	.filter((p) => p.y <= 40);
assert.ok(upperDots.length >= 2 && upperDots.length <= 4,
	'two-to-four heat motes live in the upper half (y<=40%), got ' + upperDots.length);
assert.match(base[1], /radial-gradient\(ellipse 64% 46% at 50% 0%,color-mix\(in srgb,#ff783c calc\(var\(--dnl-ember-halo,1\) \* 12%\)/,
	'a soft halo bleeds in from the top edge, scaled by the halo knob');
assert.match(base[1], /radial-gradient\(ellipse 78% 54% at 50% 112%,rgba\(255,96,36,\.10\)/,
	'a fire-glow rises from below the bottom edge');
const motesKf = CSS.match(/@keyframes dnl-ember-motes\{([^@]*)\}/);
assert.ok(motesKf, 'the heat motes drift keyframes exist');
assert.match(motesKf[1], /background-position/, 'the motes drift via background-position');
assert.match(base[1], /animation:dnl-ember-motes calc\(18s \/ var\(--dnl-ember-pace,1\)\) ease-in-out infinite alternate/,
	'the drift is slow (18s), alternating, tempo-scaled');
// no dark-text override survives — text colours stay on the user knobs
assert.doesNotMatch(CSS, /\.dnl-style-ember \.dnl-now\{color:#2d1a0c\}/, 'the old unreadable dark-text override is gone');
assert.match(CSS, /\.dnl-style-ember\.dnl-expanded\{border-radius:12px\}/, 'expanded keeps the 12px squarer corners');

// ---- 3. breathing coals (::before) ----------------------------------------
const coals = CSS.match(/\.dnl-style-ember::before\{([^}]*)\}/);
assert.ok(coals, 'the ember ::before (coals) rule exists');
const coalSpots = coals[1].match(/radial-gradient\(circle at /g) || [];
assert.ok(coalSpots.length >= 3 && coalSpots.length <= 5, 'three-to-five dim coal glows, got ' + coalSpots.length);
const breathe = coals[1].match(/animation:dnl-ember-breathe calc\(([\d.]+)s \/ var\(--dnl-ember-pace,1\)\) ease-in-out infinite alternate/);
assert.ok(breathe, 'the coals breathe (ease-in-out alternate, tempo-scaled)');
assert.ok(Number(breathe[1]) >= 5, 'the breath is slow (>=5s), got ' + breathe[1]);
assert.match(CSS, /@keyframes dnl-ember-breathe\{from\{opacity:calc\(\.34 \* var\(--dnl-ember-glow,1\)\);transform:scale\(\.985\)\}to\{opacity:var\(--dnl-ember-glow,1\);transform:scale\(1\.02\)\}\}/,
	'the breath swings dim -> lit with a subtle scale pulse, glow-knob scaled, never blinking');

// ---- 4. rising sparks (::after) -------------------------------------------
// (anchor on background-image so the shared placement rule's `::after{` tail
// — which precedes this rule — cannot win the first-match race)
const sparks = CSS.match(/\.dnl-style-ember::after\{(background-image[^}]*)\}/);
assert.ok(sparks, 'the ember ::after (sparks) rule exists');
const sparkDots = sparks[1].match(/radial-gradient\(circle at /g) || [];
assert.ok(sparkDots.length >= 1 && sparkDots.length <= 3, 'sparks stay sparse (<=3, 静谧), got ' + sparkDots.length);
const rise = sparks[1].match(/animation:dnl-ember-rise calc\(([\d.]+)s \/ var\(--dnl-ember-pace,1\)\) linear infinite/);
assert.ok(rise, 'the sparks ride their own slow cycle (tempo-scaled)');
assert.ok(Number(rise[1]) >= 6, 'the rise cycle is unhurried (>=6s), got ' + rise[1]);
const riseKf = CSS.match(/@keyframes dnl-ember-rise\{([^@]*)\}/);
assert.ok(riseKf, 'the rise keyframes exist');
assert.match(riseKf[1], /0%\{transform:translateY\(8px\);opacity:0\}/, 'sparks fade in near the coals');
const riseEnd = riseKf[1].match(/100%\{transform:translateY\(-(\d+)px\);opacity:0\}/);
assert.ok(riseEnd && Number(riseEnd[1]) >= 56,
	'sparks climb far enough to reach the upper half (>=56px, v3.1), got ' + (riseEnd && riseEnd[1]));
// flicker: mid-flight opacity must change direction at least 3 times
// (v3.1 scales each stop by the spark knob via calc(x * var(--dnl-ember-spark,1)))
const mid = [...riseKf[1].matchAll(/\d+%\{opacity:calc\(\.(\d+) \* var\(--dnl-ember-spark,1\)\)\}/g)]
	.map((m) => Number('0.' + m[1]));
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
assert.match(CSS, /@media\(prefers-reduced-motion:reduce\)\{\.dnl-style-ember\{animation:none\}\.dnl-style-ember::before,\.dnl-style-ember::after\{animation:none\}/,
	'reduced motion stills the mote drift AND both pseudos');
assert.match(src, /\["ember", "暗夜余烬（炭火余温）"\]/, 'the select label names the charcoal-ember design');

// ---- 7. settings knobs (user m04266: usable params belong in settings) ----
// prefs: four knobs with sanitizer clamps
assert.match(src, /emberGlow: 100, emberSpark: 100, emberHalo: 100, emberPace: 100/,
	'the prefs fallback carries the four ember knobs at 100');
for (const knob of ['emberGlow', 'emberSpark', 'emberHalo', 'emberPace']) {
	const re = new RegExp('const ' + knob + ' = Number\\(raw\\.' + knob + '\\)');
	assert.match(src, re, 'the sanitizer reads raw.' + knob);
}
assert.match(src, /out\.emberPace = Math\.min\(200, Math\.max\(50/, 'the tempo clamps to 50-200%');
assert.match(src, /out\.emberGlow = Math\.min\(200, Math\.max\(0/, 'the coal glow clamps to 0-200%');
// island injection: the knobs become CSS vars only while the skin is active
const inject = src.match(/if \(prefs\.capsuleStyle === "ember"\) \{([\s\S]{0,420}?)\}/);
assert.ok(inject, 'the island style injection for ember exists');
assert.match(inject[1], /style\["--dnl-ember-glow"\]/, 'glow rides --dnl-ember-glow');
assert.match(inject[1], /style\["--dnl-ember-spark"\]/, 'spark rides --dnl-ember-spark');
assert.match(inject[1], /style\["--dnl-ember-halo"\]/, 'halo rides --dnl-ember-halo');
assert.match(inject[1], /style\["--dnl-ember-pace"\]/, 'pace rides --dnl-ember-pace');
// settings UI: four sliders + a reset, gated on the ember skin
assert.match(src, /prefs\.capsuleStyle === "ember" \? \[/, 'the settings block only shows for ember');
assert.match(src, /aria-label": "暗夜余烬炭光强度/, 'the coal-glow slider exists');
assert.match(src, /aria-label": "暗夜余烬火星亮度/, 'the spark-brightness slider exists');
assert.match(src, /aria-label": "暗夜余烬顶部光晕/, 'the top-halo slider exists');
assert.match(src, /aria-label": "暗夜余烬节奏/, 'the tempo slider exists');
assert.match(src, /恢复暗夜余烬默认参数/, 'the reset button restores the ember defaults');
// functional: readNoticePrefs clamps like the other knob families
const readNoticePrefs = plugin.__test.readNoticePrefs;
assert.equal(typeof readNoticePrefs, 'function', 'readNoticePrefs is exported for tests');
const store = {};
sandbox.localStorage = {
	getItem: () => JSON.stringify(store),
	setItem() {},
};
store.emberGlow = 999; store.emberSpark = -5; store.emberHalo = 150; store.emberPace = 10;
const clamped = readNoticePrefs();
assert.equal(clamped.emberGlow, 200, 'glow clamps at 200');
assert.equal(clamped.emberSpark, 0, 'spark clamps at 0');
assert.equal(clamped.emberHalo, 150, 'halo keeps an in-range value');
assert.equal(clamped.emberPace, 50, 'pace clamps at 50');
assert.equal(readNoticePrefs().emberGlow, 200, 'the clamp is stable across reads');
delete globalThis.localStorage;

console.log('PASS: 暗夜余烬 v3.1 — charcoal bed + upper-half heat motes/halo, breathing coals, 3 sparks climbing -64px, four settings knobs (glow/spark/halo/pace), reduced-motion safe.');

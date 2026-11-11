// Style + render contracts for the 雨后玻璃 (rainv2) preset.
// The preset is a SELF-CONTAINED block: the v0.4.17 .dnl-decor-rain rules must
// stay byte-identical so flipping the select back restores the old look exactly.
// Visual model (raindrops.js + RaindropFX + the WE scene presets in the user's
// library): droplets on dark glass are dark refracted bodies with a narrow
// specular arc; most beads HANG (condensation) while a few big ones depart late
// and slide the WHOLE pane — exiting through the bottom rim, not fading
// mid-pane — paying water into a stepped remnant plus two daughter beads (the
// engines' 0.2–0.5 trailScale). Rain silk is a short falling segment.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';

const localStore = { raw: null };
let plugin;
vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
	window: {
		__ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => ({ default: React })); } },
		addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
		matchMedia: () => ({ matches: false }), innerWidth: 1200, innerHeight: 800,
	},
	document: undefined, console, AbortController, AbortSignal,
	fetch: () => new Promise(() => {}),
	Event: class {}, localStorage: { getItem: () => localStore.raw, setItem() {} },
	setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
});

const CSS = plugin.__test.CSS;
const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

// The v2 block: everything between the preset banner and the petalsv2 section.
const v2Start = CSS.indexOf('.dnl-decor-rainv2{--dnl-rv2-pace');
assert.ok(v2Start >= 0, 'the rainv2 preset block exists');
const petalsAt = CSS.indexOf('.dnl-decor-petalsv2{');
assert.ok(petalsAt > v2Start, 'petalsv2 section follows the v2 block');
const v2 = CSS.slice(v2Start, petalsAt);

// ---- 1. isolation: v2 must never touch the original rain rules ------------
assert.doesNotMatch(v2, /\.dnl-decor-rain\s/, 'v2 selectors stay out of the .dnl-decor-rain scope');
assert.doesNotMatch(v2, /dnl-drop-slide|dnl-drop-trail/, 'v2 defines its own keyframes, no v1 reuse');
assert.match(CSS, /\.dnl-decor-rain \.dnl-decor-drop\{[^}]*animation:dnl-drop-slide/, 'v1 drop rule is intact');

// ---- 2. the preset is selectable and structurally rendered -----------------
assert.match(src, /\["rainv2", "雨后玻璃（可调参数）"\]/, 'rainv2 is a decor option');
assert.match(src, /decor === "rainv2" \? rainv2DecorChildren\(noticePrefs, expanded\)/, 'the render branch delegates to the rainv2 builder with the pane state');
assert.match(src, /function rainv2DecorChildren\(np, expanded\)/, 'the rainv2 children builder takes the pane state');
// m02306/m02406: collapsed pill fades (never unmounts) non-survivors via the
// decorCollapse knob (0-100% of the density, default 25)
assert.match(src, /function collapseCount\(np, density\)/, 'the collapse-count helper exists');
assert.match(src, /decorCollapse: 25/, 'decorCollapse defaults to 25');
assert.match(src, /pct <= 0\) return 0/, 'collapse 0 hides the decor entirely');
assert.match(src, /dnl-decor-hide/, 'non-survivors get the hide class');
assert.match(CSS, /\.dnl-decor \.dnl-decor-hide\{opacity:0 !important\}/, 'the hide rule beats running animations');
assert.match(CSS, /transition:opacity \.22s ease/, 'the hide fade is a transition');
assert.match(src, /function rainv2StyleVars\(np\)/, 'the rainv2 style-vars builder exists');
// knobs ride the decor element (its own rule's defaults beat host inheritance)
assert.match(src, /decor === "rainv2" \? \{ style: rainv2StyleVars\(noticePrefs\) \}/, 'knob variables are set on the decor element itself');

// ---- 3. droplet lifecycle contracts ---------------------------------------
// hanging beads: the EXIT is a settings variant (v0.4.26, m02613).
// - slide (default): condense, hang at the anchor until ~54%, then DETACH and
//   slide down the pane, exiting THROUGH the bottom rim — never in-place fade.
// - evaporate: hang at the anchor, then SHRINK dry in place (the engines'
//   autoShrink) — never slides, never bare-fades while still full-size.
assert.match(src, /\["slide", "滑落到边缘消失（默认）"\]/, 'RV2_ENDS offers the slide exit');
assert.match(src, /\["evaporate", "原地蒸发（悬挂后缩小干涸）"\]/, 'RV2_ENDS offers the evaporate exit');
assert.match(src, /function rainv2EndClass\(np\)/, 'the rainv2 end-class helper exists');
assert.match(src, /rv2End: "slide"/, 'the bead exit defaults to slide');
assert.match(src, /decor === "rainv2" \? " " \+ rainv2EndClass\(noticePrefs\)/, 'the render branch tags the decor element with the exit variant');
// the variant class must own the keyframes name — the slot rules carry only
// geometry + timing, or switching the select could never swap the animation
// (same lesson as the petalsv2 gust scope).
const slotRules = [...v2.matchAll(/\.dnl-decor-rainv2 \.(b\d+)\{([^}]*)\}/g)];
assert.strictEqual(slotRules.length, 12, 'twelve bead slots');
assert.match(v2, /\.dnl-decor-rainv2\.rv2-end-slide \.dnl-decor-drop\{animation-name:dnl-rv2-bead\}/,
	'the slide variant assigns the slide keyframes to every droplet');
assert.match(v2, /\.rv2-end-evaporate \.b1[^{]*\.b12\{animation-name:dnl-rv2-bead-evap\}/,
	'the evaporate variant assigns the shrink keyframes to the bead slots');
assert.doesNotMatch(v2, /animation:dnl-rv2-bead /,
	'no bead slot hard-pins the keyframes name (it must come from the variant)');
const beadStart = v2.indexOf('@keyframes dnl-rv2-bead{');
assert.ok(beadStart >= 0, 'bead keyframes exist');
const beadLast = v2.indexOf('100%{top:112%;opacity:0', beadStart);
assert.ok(beadLast > beadStart, 'beads exit THROUGH the bottom rim');
const beadBody = v2.slice(beadStart, v2.indexOf('}', beadLast) + 1);
assert.match(beadBody, /0%\{top:var\(--dnl-rv2-anchor\);opacity:0/, 'beads condense at their anchor');
assert.match(beadBody, /54%\{top:var\(--dnl-rv2-anchor\)/, 'beads hang until 54%');
assert.match(beadBody, /112% - var\(--dnl-rv2-anchor\)/, 'beads descend as fractions of the remaining way');
const beadOps = [...beadBody.matchAll(/(\d+)%\{top:[^;]+;opacity:([\d.]+)/g)].map((m) => ({ at: Number(m[1]), op: Number(m[2]) }));
const inPaneBeads = beadOps.filter((f) => f.at >= 8 && f.at <= 97);
assert.ok(inPaneBeads.every((f) => f.op >= 0.85), 'beads stay ≥.85 opacity inside the pane: ' + JSON.stringify(inPaneBeads.map((f) => f.op)));
// evaporate variant: top NEVER leaves the anchor; the bead shrinks to ~.12
// and only then goes transparent — a dry-out, not a fade-out.
const evapStart = v2.indexOf('@keyframes dnl-rv2-bead-evap{');
assert.ok(evapStart >= 0, 'the evaporate keyframes exist');
const evapLast = v2.indexOf('100%{top:var(--dnl-rv2-anchor);opacity:0', evapStart);
assert.ok(evapLast > evapStart, 'the evaporate exit ends transparent at the anchor');
const evapBody = v2.slice(evapStart, v2.indexOf('}', evapLast) + 1);
const evapTops = [...evapBody.matchAll(/(\d+)%\{top:([^;]+);/g)];
assert.ok(evapTops.length >= 8 && evapTops.every((m) => m[2].includes('--dnl-rv2-anchor') && !m[2].includes('112%')),
	'evaporating beads never leave their anchor (no slide): ' + JSON.stringify(evapTops.map((m) => m[2])));
const evapScales = [...evapBody.matchAll(/scale\(([\d.]+)(?:,([\d.]+))?\)/g)].map((m) => Number(m[1]));
assert.ok(Math.min(...evapScales) <= 0.2, 'the evaporate exit physically shrinks the bead to ≤20% before vanishing');
// every slot pins its anchor and carries a NEGATIVE delay (phase-staggered, so
// a collapse/expand remount shows the bead mid-cycle instead of a dead wait)
for (const [, slot, rule] of slotRules) {
	assert.match(rule, /--dnl-rv2-anchor:\d+%/, slot + ' pins --dnl-rv2-anchor');
	assert.match(rule, /animation-delay:calc\(-[\d.]+s/, slot + ' uses a negative animation-delay');
	assert.match(rule, /animation-duration:calc\([\d.]+s/, slot + ' carries its own duration (name comes from the variant)');
}
// sliders/remnants went negative-delay too (same remount-flash fix)
const slDelays = [...v2.matchAll(/\.dnl-decor-rainv2 \.(sl\d|r[abcd]\d)(::after)?\{[^}]*animation-delay:calc\((-?[\d.]+)s/g)];
assert.ok(slDelays.length >= 16 && slDelays.every((m) => Number(m[3]) < 0), 'sliders/trails/remnants all use negative delays');

// sliders: hang first, then run the FULL pane and exit THROUGH the bottom rim
// (m00882: "slide to the pane edge, then vanish" — no mid-pane fade). Travel is
// `top` (pane-relative %): translateY % resolves against the bead's own ~9px
// height and barely moves — that was the v0.4.19 "sliders never slide" bug.
for (const name of ['dnl-rv2-slide', 'dnl-rv2-slide2', 'dnl-rv2-slide3', 'dnl-rv2-slide4']) {
	const kStart = v2.indexOf('@keyframes ' + name + '{');
	assert.ok(kStart >= 0, name + ' exists');
	const body = v2.slice(kStart, v2.indexOf('}@', kStart) >= 0 ? v2.indexOf('}@', kStart) : v2.length);
	const frames = [...body.matchAll(/(-?[\d.]+)%\{top:(-?[\d.]+)%;opacity:([\d.]+)[^}]*?scale\((-?[\d.]+)/g)]
		.map((m) => ({ at: Number(m[1]), top: Number(m[2]), op: Number(m[3]), scale: Number(m[4]) }));
	assert.ok(frames.length >= 6, name + ' is keyframed via top (pane-relative), not element-relative translateY %');
	const startTop = frames[0].top;
	const hang = frames.filter((f) => f.top === startTop);
	assert.ok(hang.length >= 3, name + ' hangs in place first: ' + JSON.stringify(hang.map((f) => f.at)));
	const travel = frames.filter((f) => f.top > startTop + 2);
	assert.ok(travel.length >= 3, name + ' has intermediate slide poses');
	assert.ok(travel[0].at > hang[hang.length - 1].at, name + ' departs only after the hang phase');
	const maxTop = Math.max(...travel.map((f) => f.top));
	assert.ok(maxTop >= 108, name + ' exits THROUGH the bottom rim (top ' + maxTop + '%), not a mid-pane stop');
	assert.ok(travel.every((f, i) => i === 0 || f.top >= travel[i - 1].top), name + ' only moves DOWN');
	// no mid-pane fade: every in-pane travel pose stays ≥ .8 opacity; the fade is
	// reserved for the last stretch across the rim (overflow clips the rest)
	const inPane = travel.filter((f) => f.top <= 100);
	assert.ok(inPane.every((f) => f.op >= 0.8),
		name + ' stays ≥.8 opacity inside the pane: ' + JSON.stringify(inPane.map((f) => f.op)));
	assert.ok(frames[frames.length - 1].op === 0 && frames[frames.length - 1].top > 100,
		name + ' is fully transparent only past the rim');
	// the mother shrinks as she pays water for the remnant (no scale wobble)
	assert.ok(frames[frames.length - 1].scale < Math.max(...frames.map((f) => f.scale)),
		name + ' shrinks by the end (evaporation)');
}

// rain silk: a SHORT falling segment, not a full-height static column (m00882)
assert.match(v2, /\.dnl-decor-rainv2 \.dnl-decor-streak\{[^}]*height:52px/,
	'streaks are short segments (px height)');
assert.doesNotMatch(v2, /\.dnl-decor-rainv2 \.dnl-decor-streak\{[^}]*height:100%/,
	'streak height is never 100% (that read as a static wire across the pane)');
const fallStart = v2.indexOf('@keyframes dnl-rainv2-fall{');
assert.ok(fallStart >= 0, 'streak fall keyframes exist');
const fallBody = v2.slice(fallStart, fallStart + 400);
assert.match(fallBody, /0%\{top:-[\d.]+%/, 'streak enters from above the pane');
assert.match(fallBody, /100%\{top:1\d\d%/, 'streak exits below the pane');

// ---- 4. stepped remnant trail + pane-positioned daughter beads -------------
assert.match(v2, /@keyframes dnl-rv2-trail\{[\s\S]*?38%\{height:6px[\s\S]*?50%\{height:6px/,
	'the trail holds then extends (stepped = broken beads, not a line)');
assert.match(v2, /@keyframes dnl-rv2-trail\{[\s\S]*?80%\{height:26px[\s\S]*?90%\{height:26px/,
	'the trail has a second hold near full length');
// daughters are SIBLINGS in pane coordinates — a child of the sliding mother
// would ride along instead of being left behind.
assert.match(v2, /\.dnl-decor-rainv2 \.ra1\{left:[\d.]+%;top:[\d.]+%/, 'daughter beads are pane-positioned sibling rules');
assert.doesNotMatch(v2, /\.sl\d \.[a-z]/, 'no remnant rule is nested under a slider (it would ride along)');
assert.match(v2, /@keyframes dnl-rv2-remnant-a\{/, 'mid-run remnant keyframes exist');
assert.match(v2, /@keyframes dnl-rv2-remnant-b\{/, 'late-shed remnant keyframes exist');
// each remnant inherits its slider's exact (negative, phase-staggered) delay
for (const [cls, delay] of [['ra1', '-11.4s'], ['rb1', '-6.9s'], ['rc1', '-9.2s'], ['rd1', '-4.4s']]) {
	assert.match(v2, new RegExp('\\.' + cls + '\\{[^}]*animation-delay:calc\\(' + delay.replace('-', '\\-') + ' / var\\(--dnl-rv2-pace\\)\\)'),
		cls + ' shares its slider cycle delay ' + delay);
}
// daughters sit on their mother's real path (mid-pane), retimed to the top-based
// slide profile — never beyond the pane, never in the top hang band
const daughterTops = [...v2.matchAll(/\.r[abcd][12]\{left:[\d.]+%;top:([\d.]+)%/g)].map((m) => Number(m[1]));
assert.ok(daughterTops.length === 8 && daughterTops.every((t) => t >= 20 && t <= 70),
	'daughter beads sit mid-pane on the mothers’ paths: ' + daughterTops.join(','));

// ---- 5. twelve bead slots spread over the whole pane ------------------------
const beadSlots = [...v2.matchAll(/\.dnl-decor-rainv2 \.b(\d+)\{left:([\d.]+)%;top:([\d.]+)%/g)]
	.map((m) => ({ slot: Number(m[1]), top: Number(m[3]) }));
assert.equal(beadSlots.length, 12, 'twelve bead slots exist (density 4–12 slices into them)');
const tops = beadSlots.map((b) => b.top);
assert.ok(Math.min(...tops) <= 16 && Math.max(...tops) >= 84,
	'bead slots span the whole pane: ' + tops.join(','));
// render order is spread-first so density 4 still covers top AND bottom
assert.match(src, /RV2_BEAD_ORDER = \["b2", "b5", "b4", "b7"/, 'density slices the spread-first bead order');

// ---- 6. tuning variables ----------------------------------------------------
assert.match(v2, /--dnl-rv2-pace:1;--dnl-rv2-hi:\.7;--dnl-rv2-trail:\.34/, 'the three tuning vars exist with the v0.4.19 defaults');

// ---- 7. knob sanitisation in readNoticePrefs --------------------------------
const readNoticePrefs = plugin.__test.readNoticePrefs;
assert.ok(readNoticePrefs, 'readNoticePrefs is exported for tests');
const defaults = readNoticePrefs();
assert.deepEqual(
	{ d: defaults.rv2Density, p: defaults.rv2Pace, t: defaults.rv2Trail, h: defaults.rv2Hi, e: defaults.rv2End },
	{ d: 7, p: 100, t: 100, h: 70, e: 'slide' }, 'knob defaults are 7 beads / 100% pace / 100% trail / 70% highlight / slide exit');
localStore.raw = JSON.stringify({ rv2Density: 99, rv2Pace: 10, rv2Trail: 500, rv2Hi: -5, rv2End: 'evaporate' });
const clamped = readNoticePrefs();
assert.deepEqual(
	{ d: clamped.rv2Density, p: clamped.rv2Pace, t: clamped.rv2Trail, h: clamped.rv2Hi, e: clamped.rv2End },
	{ d: 12, p: 50, t: 200, h: 0, e: 'evaporate' }, 'knobs clamp to density 4–12, pace 50–200, trail 0–200, hi 0–100; the exit accepts a whitelisted variant');
localStore.raw = JSON.stringify({ rv2Density: 6.6, rv2Pace: 'fast', rv2Trail: null, rv2Hi: 40.4, rv2End: 'explode' });
const mixed = readNoticePrefs();
assert.deepEqual(
	{ d: mixed.rv2Density, p: mixed.rv2Pace, t: mixed.rv2Trail, h: mixed.rv2Hi, e: mixed.rv2End },
	{ d: 7, p: 100, t: 0, h: 40, e: 'slide' }, 'non-numeric knobs fall back, numeric ones round (null is 0); an unknown exit falls back to slide');

// ---- 8. reduced motion covers the preset -----------------------------------
// the decor media query (the first prefers-reduced-motion hit is arknights')
const rmStart = CSS.indexOf('@media(prefers-reduced-motion:reduce){.dnl-decor span{animation:none}');
assert.ok(rmStart >= 0, 'the decor reduced-motion block exists');
// the block nests braces, so scan a bounded window instead of to the first }
const rmBlock = CSS.slice(rmStart, rmStart + 800);
assert.ok(rmBlock.includes('.dnl-decor-rainv2 .dnl-decor-streak'), 'rainv2 streaks hidden by reduced motion');
assert.ok(rmBlock.includes('.dnl-decor-rainv2 .dnl-decor-drop'), 'rainv2 drops dimmed by reduced motion');
assert.ok(rmBlock.includes('opacity:.5'), 'the dimming rule is present');
// .dnl-decor span{animation:none} covers the remnants too; their base style is
// opacity:0, so with no animation they simply stay invisible — nothing extra.
assert.match(CSS, /\.dnl-decor-rainv2 \.dnl-decor-drop::after\{display:none\}/,
	'rainv2 trails are hidden by reduced motion');
assert.match(v2, /\.dnl-decor-remnant\{[^}]*opacity:0\}/, 'remnant base style is invisible (reduced-motion safe)');

console.log('PASS: rainv2 (雨后玻璃) — isolation, whole-pane lifecycle, stepped trail, daughter remnants, knobs');

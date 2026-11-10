// Style + render contracts for the v0.4.18 雨后玻璃 (rainv2) preset.
// The preset is a SELF-CONTAINED block: the v0.4.17 .dnl-decor-rain rules must
// stay byte-identical so flipping the select back restores the old look exactly.
// Visual model (learned from the raindrops.js reference in the user's Wallpaper
// Engine library): droplets on dark glass are dark refracted bodies with a
// narrow specular arc — not white glow blobs; most beads HANG and only a couple
// slide a short way, leaving segmented remnant trails.
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

// The v2 block: everything between the preset banner and the petals section.
const v2Start = CSS.indexOf('.dnl-decor-rainv2{--dnl-rv2-pace');
assert.ok(v2Start >= 0, 'the rainv2 preset block exists');
const petalsAt = CSS.indexOf('.dnl-decor-petals .dnl-decor-petal{');
assert.ok(petalsAt > v2Start, 'petals section follows the v2 block');
const v2 = CSS.slice(v2Start, petalsAt);

// ---- 1. isolation: v2 must never touch the original rain rules ------------
assert.doesNotMatch(v2, /\.dnl-decor-rain\s/, 'v2 selectors stay out of the .dnl-decor-rain scope');
assert.doesNotMatch(v2, /dnl-drop-slide|dnl-drop-trail/, 'v2 defines its own keyframes, no v1 reuse');
assert.match(CSS, /\.dnl-decor-rain \.dnl-decor-drop\{[^}]*animation:dnl-drop-slide/, 'v1 drop rule is intact');

// ---- 2. the preset is selectable ------------------------------------------
assert.match(src, /\["rainv2", "雨后玻璃（新预设）"\]/, 'rainv2 is a decor option');
assert.match(src, /decor === "rainv2" \? \[/, 'the render branch handles rainv2');

// ---- 3. droplet lifecycle contracts ---------------------------------------
// stationary beads: never travel more than 2px (condensation, not a run)
const beadStart = v2.indexOf('@keyframes dnl-rv2-bead{');
assert.ok(beadStart >= 0, 'bead keyframes exist');
const beadBody = v2.slice(beadStart, v2.indexOf('}', v2.indexOf('100%{', beadStart)));
const beadTravels = [...beadBody.matchAll(/translate3d\([^)]*?(-?[\d.]+)px/g)].map((m) => Math.abs(Number(m[1])));
assert.ok(beadTravels.every((y) => y <= 2), 'beads hang in place (max 2px wobble): ' + beadTravels.join(','));

// sliders: hang through ~44%, then a SHORT slide (well under half the pane)
for (const name of ['dnl-rv2-slide', 'dnl-rv2-slide2']) {
	const kStart = v2.indexOf('@keyframes ' + name + '{');
	assert.ok(kStart >= 0, name + ' exists');
	const body = v2.slice(kStart, v2.indexOf('}@', kStart) >= 0 ? v2.indexOf('}@', kStart) : v2.length);
	const poses = [...body.matchAll(/(-?[\d.]+)%\{[^}]*?translate3d\([^,]+,\s*(-?[\d.]+)(%|px)/g)]
		.map((m) => ({ at: Number(m[1]), y: Number(m[2]), unit: m[3] }));
	const hang = poses.filter((p) => p.at <= 48);
	assert.ok(hang.length >= 2 && hang.every((p) => p.y <= 2 && p.unit === 'px'),
		name + ' hangs before departing: ' + JSON.stringify(hang));
	const travel = poses.filter((p) => p.at > 48 && p.at <= 90);
	assert.ok(travel.length >= 2, name + ' has intermediate slide poses');
	const lastY = travel[travel.length - 1].y;
	assert.ok(lastY <= 30, name + ' slides only a short way (' + lastY + '%), not the full pane');
	const ys = travel.map((p) => p.y);
	assert.ok(ys.every((y, i) => i === 0 || y >= ys[i - 1]), name + ' only moves DOWN');
}

// ---- 4. remnant trail is segmented ----------------------------------------
assert.match(v2, /@keyframes dnl-rv2-trail\{[\s\S]*?48%\{height:5px[\s\S]*?\}56%\{height:5px/,
	'the trail holds then extends (stepped = broken beads, not a line)');

// ---- 5. tuning variables ---------------------------------------------------
assert.match(v2, /--dnl-rv2-pace:1;--dnl-rv2-hi:\.85;--dnl-rv2-trail:\.34/, 'the three tuning vars exist');

// ---- 6. reduced motion covers the preset ----------------------------------
// the decor media query (the first prefers-reduced-motion hit is arknights')
const rmStart = CSS.indexOf('@media(prefers-reduced-motion:reduce){.dnl-decor span{animation:none}');
assert.ok(rmStart >= 0, 'the decor reduced-motion block exists');
// the block nests braces, so scan a bounded window instead of to the first }
const rmBlock = CSS.slice(rmStart, rmStart + 800);
assert.ok(rmBlock.includes('.dnl-decor-rainv2 .dnl-decor-streak'), 'rainv2 streaks hidden by reduced motion');
assert.ok(rmBlock.includes('.dnl-decor-rainv2 .dnl-decor-drop'), 'rainv2 drops dimmed by reduced motion');
assert.ok(rmBlock.includes('opacity:.5'), 'the dimming rule is present');
assert.match(CSS, /\.dnl-decor-rainv2 \.dnl-decor-drop::after\{display:none\}/,
	'rainv2 trails are hidden by reduced motion');

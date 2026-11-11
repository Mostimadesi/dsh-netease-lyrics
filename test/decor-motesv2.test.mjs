// Style + render contracts for the 光点浮尘 v2 (motesv2) preset (v0.4.28).
// Separate preset: the original 光点浮尘 (.dnl-decor-motes) block stays
// byte-identical until the user retires it. Reference models (user asked
// for night/star wallpaper grounding, m02945): WE fireflies.json
// (1919422512) — oscillatealpha breathing, turbulence wander, low-frequency
// sway; WE snowperspective.json (1382380756) — depth = size × brightness
// (far dots dimmer). Mood (dust/star) and motion (wander/gentle) are
// settings variants (m02941); density/pace/glow are sliders.
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
const readNoticePrefs = plugin.__test.readNoticePrefs;

// The v2 block: from the motesv2 variable defaults to the reduced-motion row.
const mv2Start = CSS.indexOf('.dnl-decor-motesv2{--dnl-mv2-pace');
assert.ok(mv2Start >= 0, 'the motesv2 preset block exists');
const rmRowAt = CSS.indexOf('@media(prefers-reduced-motion:reduce){.dnl-decor span');
assert.ok(rmRowAt > mv2Start, 'the motesv2 block precedes the decor reduced-motion row');
const mv2 = CSS.slice(mv2Start, rmRowAt);
const oldAt = CSS.indexOf('.dnl-decor-motes .dnl-decor-mote{');
assert.ok(oldAt >= 0 && oldAt < mv2Start, 'the original motes block precedes motesv2');

// ---- 1. isolation: v2 must never touch the original motes rules ------------
assert.doesNotMatch(mv2, /\.dnl-decor-motes\s/, 'v2 selectors stay out of the .dnl-decor-motes scope');
assert.doesNotMatch(mv2, /dnl-mote-drift/, 'v2 defines its own keyframes, no v1 reuse');
assert.match(CSS, /@keyframes dnl-mote-drift\{from\{transform:translate3d\(0,0,0\)/, 'v1 mote keyframes are intact');
assert.match(CSS, /\.dnl-decor-motes \.m6\{left:44%;top:78%/, 'v1 slot rules are intact');

// ---- 2. the preset is selectable and structurally rendered -----------------
assert.match(src, /\["motesv2", "光点浮尘（可调参数）"\]/, 'motesv2 is a decor option');
assert.match(src, /decor === "motesv2" \? motesv2DecorChildren\(noticePrefs, expanded\)/, 'the render branch delegates to the motesv2 builder with the pane state');
assert.match(src, /function motesv2DecorChildren\(np, expanded\)/, 'the motesv2 children builder takes the pane state');
// collapsed pill keeps the full set mounted; non-survivors fade (m02306/m02406)
assert.match(src, /const MV2_COLLAPSED_ORDER = \["o6", "o3", "o10"/, 'collapsed survivor order is top-first');
assert.match(src, /dnl-decor-hide/, 'collapsed non-survivors fade out instead of unmounting');
assert.match(src, /function motesv2StyleVars\(np\)/, 'the style-vars builder exists');
// knobs ride the decor element (its own rule's defaults beat host inheritance)
assert.match(src, /decor === "motesv2" \? \{ style: motesv2StyleVars\(noticePrefs\) \}/, 'knob variables are set on the decor element itself');
assert.match(src, /decor === "motesv2" \? " " \+ motesv2MoodClass\(noticePrefs\) \+ " " \+ motesv2MotionClass\(noticePrefs\)/, 'render branch applies mood + motion classes');
assert.match(src, /const MV2_MOODS = \[\s*\["dust"/, 'mood variants exist (dust + star, m02941)');
assert.match(src, /const MV2_MOTIONS = \[\s*\["wander"/, 'motion variants exist (wander + gentle, m02941)');
assert.match(src, /const MV2_ORDER = \["o7", "o3", "o12", "o10"/, 'spread-first slot order');
assert.match(src, /MV2_DEPTHS = new Map\(\[/, 'depth layers are pinned per slot');

// ---- 3. wander: multi-waypoint closed loops, three variants -----------------
for (const name of ['a', 'b', 'c']) {
	const at = mv2.indexOf('@keyframes dnl-mv2-wander-' + name + '{');
	assert.ok(at >= 0, 'wander-' + name + ' keyframes exist');
	const body = mv2.slice(at, mv2.indexOf('}}', at));
	const waypoints = body.match(/translate3d\(/g) || [];
	assert.ok(waypoints.length >= 7, name + ': at least 5 intermediate waypoints (turbulence model): ' + waypoints.length);
	assert.match(body, /0%\{transform:translate3d\(0,0,0\)\}/, name + ': the loop starts at the origin');
	assert.match(body, /100%\{transform:translate3d\(0,0,0\)/, name + ': the loop closes at the origin');
}
// variant assignment collapses under motion-gentle, which alternates
assert.match(mv2, /\.mv2-motion-gentle \.dnl-decor-mote2\{animation-name:dnl-mv2-gentle,dnl-mv2-twinkle;animation-direction:alternate,normal\}/, 'gentle motion swaps in the alternating sway');
assert.match(mv2, /@keyframes dnl-mv2-gentle\{from\{transform:translate3d\(0,0,0\)\}to\{transform:translate3d\(6px,-9px,0\)\}\}/, 'gentle keeps the polished v1 sway');
const wanderAssign = mv2.match(/\.o\d+,\.dnl-decor-motesv2 \.o\d+,[^}]*animation-name:dnl-mv2-wander-[bc]/g) || [];
assert.equal(wanderAssign.length, 2, 'slots split across wander-b and wander-c (a is the base default)');

// ---- 4. twinkle: breathing driven by the glow knob ---------------------------
const twAt = mv2.indexOf('@keyframes dnl-mv2-twinkle{');
assert.ok(twAt >= 0, 'twinkle keyframes exist');
const twBody = mv2.slice(twAt, mv2.indexOf('}}', twAt));
assert.match(twBody, /opacity:calc\(var\(--dnl-mv2-glow\) \* \.95\)/, 'twinkle peak scales with the glow knob');
assert.match(twBody, /opacity:calc\(var\(--dnl-mv2-glow\) \* var\(--dnl-mv2-dim\)\)/, 'twinkle valley scales with glow × dim');
assert.match(mv2, /\.dnl-decor-motesv2\{--dnl-mv2-pace:1;--dnl-mv2-glow:\.7;--dnl-mv2-dim:\.25\}/, 'CSS variable defaults (dust dim .25)');
assert.match(mv2, /\.dnl-decor-motesv2\.mv2-mood-star\{--dnl-mv2-dim:\.12\}/, 'star mood dims the valley deeper');

// ---- 5. depth = size × brightness (snowperspective model) --------------------
assert.match(mv2, /\.d-near\{width:5px;height:5px/, 'near dots are bigger');
assert.match(mv2, /\.d-near\{[^}]*brand-primary\) 55%,#ffffff 45%/, 'near dots are brighter (whiter core)');
assert.match(mv2, /\.d-far\{width:2\.5px;height:2\.5px/, 'far dots are smaller');
assert.match(mv2, /\.d-far\{[^}]*brand-primary\) 75%,#ffffff 20%/, 'far dots are dimmer');
assert.match(mv2, /\.mv2-mood-star \.dnl-decor-mote2\{width:2px;height:2px/, 'star mood shrinks the base dot');
assert.match(mv2, /\.mv2-mood-star \.d-far\{width:1\.5px;height:1\.5px\}/, 'star far dots are tiny glints');

// ---- 6. twelve slots span the pane at any density -----------------------------
const slotPos = {};
for (const m of mv2.matchAll(/\.o(\d+)\{left:([\d.]+)%;top:([\d.]+)%/g)) slotPos['o' + m[1]] = [Number(m[2]), Number(m[3])];
assert.equal(Object.keys(slotPos).length, 12, 'twelve slots: ' + Object.keys(slotPos).join(','));
const order = ['o7', 'o3', 'o12', 'o10', 'o1', 'o9', 'o4', 'o6', 'o2', 'o11', 'o5', 'o8'];
for (const d of [3, 7, 12]) {
	const xs = order.slice(0, d).map((s) => slotPos[s][0]);
	assert.ok(Math.max(...xs) - Math.min(...xs) >= 50, 'density ' + d + ' still spans the width: ' + xs.join(','));
	const ys = order.slice(0, d).map((s) => slotPos[s][1]);
	assert.ok(Math.max(...ys) - Math.min(...ys) >= 30, 'density ' + d + ' still spans the height: ' + ys.join(','));
}
// every slot carries two staggered negative delays (pane is alive at load)
const delayLines = mv2.match(/animation-delay:-[\d.]+s,-[\d.]+s/g) || [];
assert.equal(delayLines.length, 12, 'twelve staggered negative delay pairs');
// every slot has dual durations (wander + twinkle) scaled by pace
const durLines = mv2.match(/animation-duration:calc\([\d.]+s \/ var\(--dnl-mv2-pace\)\),calc\([\d.]+s \/ var\(--dnl-mv2-pace\)\)/g) || [];
assert.equal(durLines.length, 12, 'twelve dual-duration rules scaled by the pace knob');

// ---- 7. knobs: prefs clamps + whitelists -------------------------------------
localStore.raw = JSON.stringify({ mv2Density: 99, mv2Pace: 999, mv2Glow: -5 });
const clamped = readNoticePrefs();
assert.equal(clamped.mv2Density, 12, 'density clamps to 12');
assert.equal(clamped.mv2Pace, 200, 'pace clamps to 200');
assert.equal(clamped.mv2Glow, 0, 'glow clamps to 0');
localStore.raw = JSON.stringify({ mv2Density: 0 });
assert.equal(readNoticePrefs().mv2Density, 3, 'density clamps to 3');
localStore.raw = '{}';
const dflt = readNoticePrefs();
assert.deepEqual(
	[dflt.mv2Density, dflt.mv2Pace, dflt.mv2Glow, dflt.mv2Mood, dflt.mv2Motion],
	[7, 100, 70, 'dust', 'wander'],
	'defaults: 7 dots, 100% pace, 70% glow, dust mood, wander motion');
localStore.raw = JSON.stringify({ mv2Mood: 'star', mv2Motion: 'gentle' });
const variants = readNoticePrefs();
assert.equal(variants.mv2Mood, 'star', 'mood whitelist accepts star');
assert.equal(variants.mv2Motion, 'gentle', 'motion whitelist accepts gentle');
localStore.raw = JSON.stringify({ mv2Mood: 'bogus', mv2Motion: 'bogus' });
const bogus = readNoticePrefs();
assert.equal(bogus.mv2Mood, 'dust', 'unknown mood falls back to dust');
assert.equal(bogus.mv2Motion, 'wander', 'unknown motion falls back to wander');
localStore.raw = JSON.stringify({ decor: 'motesv2' });
assert.equal(readNoticePrefs().decor, 'motesv2', 'the decor whitelist accepts motesv2');
localStore.raw = JSON.stringify({ decor: 'motes' });
assert.equal(readNoticePrefs().decor, 'motes', 'the old preset stays selectable until retired');
localStore.raw = null;

// ---- 8. settings UI ------------------------------------------------------------
for (const label of ['光点浮尘密度', '光点浮尘漂移速度', '光点浮尘亮度', '光点浮尘氛围', '光点浮尘运动方式']) {
	assert.ok(src.includes('"' + label + '"'), 'settings control: ' + label);
}
assert.match(src, /MV2_MOODS\.map\(\(\[id, label\]\) => h\("option"/, 'mood select lists the variants');
assert.match(src, /MV2_MOTIONS\.map\(\(\[id, label\]\) => h\("option"/, 'motion select lists the variants');
assert.match(src, /mv2Density: 7, mv2Pace: 100, mv2Glow: 70, mv2Mood: "dust", mv2Motion: "wander" \}\) \}, "恢复光点浮尘默认参数"/, 'reset button restores all defaults');
assert.match(src, /notice\.decor === "petalsv2" \|\| notice\.decor === "motesv2"\)\s*\n\s*\? h\("label", \{ className: "dnl-set-row" \}, "收起态显示比例"/, 'the collapse-ratio slider also covers motesv2');

// ---- 9. reduced motion ------------------------------------------------------------
assert.ok(CSS.indexOf('.dnl-decor-motesv2 .dnl-decor-mote2{display:none}', rmRowAt) > rmRowAt, 'motesv2 hides under reduced-motion');

console.log('PASS: motesv2 preset — isolation, wander/twinkle/gentle contracts, depth layers, 12 spread-first slots, knob clamps, settings UI, reduced-motion');

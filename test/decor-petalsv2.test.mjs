// Style + render contracts for the 樱吹雪 (petalsv2) preset (v0.4.21).
// Separate preset: the original 花瓣飘落 (.dnl-decor-petals) block stays
// byte-identical until the user retires it. Motion model from WE scene
// 2518584539 leaves5.json: constant fall speed (no gravity), sinusoidal
// sway, tumbling, fade in early / fade out only while crossing the rim.
// Fall is animated via TOP (pane-relative %); sway/rotate/scaleX use
// transform px/deg scaled by --dnl-pv2-sway (the translate-% trap of
// v0.4.19 must never come back).
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

// The v2 block: everything between the preset banner and the motes section.
const pv2Start = CSS.indexOf('.dnl-decor-petalsv2{--dnl-pv2-pace');
assert.ok(pv2Start >= 0, 'the petalsv2 preset block exists');
const motesAt = CSS.indexOf('.dnl-decor-motes .dnl-decor-mote{');
assert.ok(motesAt > pv2Start, 'motes section follows the petalsv2 block');
const pv2 = CSS.slice(pv2Start, motesAt);
const oldAt = CSS.indexOf('.dnl-decor-petals .dnl-decor-petal{');
assert.ok(oldAt >= 0 && oldAt < pv2Start, 'the original petals block precedes petalsv2');

// ---- 1. isolation: v2 must never touch the original petals rules ----------
assert.doesNotMatch(pv2, /\.dnl-decor-petals\s/, 'v2 selectors stay out of the .dnl-decor-petals scope');
assert.doesNotMatch(pv2, /dnl-petal-fall/, 'v2 defines its own keyframes, no v1 reuse');
assert.match(CSS, /border-radius:80% 10% 80% 10%/, 'v1 petal shape rule is intact');
assert.match(CSS, /@keyframes dnl-petal-fall\{0%\{transform:translate3d\(0,-10px,0\) rotate\(0deg\)/, 'v1 petal keyframes are intact');

// ---- 2. the preset is selectable and structurally rendered -----------------
assert.match(src, /\["petalsv2", "樱吹雪（可调参数）"\]/, 'petalsv2 is a decor option');
assert.match(src, /decor === "petalsv2" \? petalsv2DecorChildren\(noticePrefs, expanded\)/, 'the render branch delegates to the petalsv2 builder with the pane state');
assert.match(src, /function petalsv2DecorChildren\(np, expanded\)/, 'the petalsv2 children builder takes the pane state');
// m02406: collapsed survivors = collapseCount(density) via the decorCollapse knob
assert.match(src, /collapseCount\(np, density\)/, 'collapsed count comes from the decorCollapse knob');
assert.match(src, /dnl-decor-hide/, 'collapsed non-survivors fade out instead of unmounting');
assert.match(src, /function petalsv2StyleVars\(np\)/, 'the petalsv2 style-vars builder exists');
// knobs ride the decor element (its own rule's defaults beat host inheritance)
assert.match(src, /decor === "petalsv2" \? \{ style: petalsv2StyleVars\(noticePrefs\) \}/, 'knob variables are set on the decor element itself');
assert.match(src, /const PV2_ORDER = \["p6", "p12", "p3", "p10"/, 'spread-first slot order');
assert.match(src, /const PV2_ACCENTS = new Set\(\["p12", "p8", "p5", "p4"\]\)/, 'accent slots are pinned');
// v0.4.23: trajectory + wind are selectable variants (m02233)
assert.match(src, /const PV2_TRAJS = \[\s*\["varied"/, 'trajectory options exist');
assert.match(src, /const PV2_WINDS = \[\s*\["gust"/, 'wind options exist');
assert.match(src, /function petalsv2TrajClass\(np\)/, 'trajectory class builder exists');
assert.match(src, /function petalsv2WindClass\(np\)/, 'wind class builder exists');
assert.match(src, /decor === "petalsv2" \? " " \+ petalsv2TrajClass\(noticePrefs\) \+ " " \+ petalsv2WindClass\(noticePrefs\) : ""\)/, 'render branch applies the variant classes');

// ---- 3. fall contract: full pane, exit THROUGH the bottom rim --------------
const fallAt = pv2.indexOf('@keyframes dnl-pv2-fall{');
assert.ok(fallAt >= 0, 'fall keyframes exist');
const fallBody = pv2.slice(fallAt, pv2.indexOf('}}', fallAt));
const tops = [...fallBody.matchAll(/top:(-?[\d.]+)%/g)].map((m) => Number(m[1]));
assert.ok(tops[0] < 0, 'petals start above the pane: ' + tops[0]);
assert.ok(tops.some((t) => t >= 98 && t <= 105), 'a frame reaches the bottom rim: ' + tops.join(','));
assert.ok(tops[tops.length - 1] > 105, 'petals exit through the rim: ' + tops[tops.length - 1]);
const opacities = [...fallBody.matchAll(/opacity:([\d.]+)/g)].map((m) => Number(m[1]));
assert.ok(Math.max(...opacities) >= 0.8, 'in-pane opacity is full');
assert.equal(opacities[opacities.length - 1], 0, 'fades only while crossing the rim');
assert.doesNotMatch(fallBody, /translate/, 'fall never moves via transform (translate-% trap)');

// ---- 4. sway + tumble: a sinusoidal alternating animation ------------------
for (const name of ['a', 'b', 'c']) {
	const at = pv2.indexOf('@keyframes dnl-pv2-sway-' + name + '{');
	assert.ok(at >= 0, 'sway-' + name + ' keyframes exist');
	const body = pv2.slice(at, pv2.indexOf('}}', at));
	assert.match(body, new RegExp('translateX\\(calc\\(-?[\\d.]+px \\* var\\(--dnl-pv2-sway\\)\\)\\)'), name + ': sway amplitude scales with the knob');
	assert.match(body, new RegExp('rotate\\(calc\\(-?[\\d.]+deg \\* var\\(--dnl-pv2-sway\\)\\)\\)'), name + ': rocking scales with the knob');
	assert.match(body, /scaleX\(([\d.]+)\)/, name + ': tumble flip present');
}
assert.match(pv2, /ease-in-out infinite alternate/, 'the sway alternates (sinusoidal swing)');
const flips = [...pv2.matchAll(/scaleX\(([\d.]+)\)/g)].map((m) => Number(m[1]));
assert.ok(Math.min(...flips) < 1, 'petals flip edge-on mid-swing (tumble illusion)');

// ---- 5. twelve slots span the full width at any density --------------------
const slotLefts = {};
for (const m of pv2.matchAll(/\.p(\d+)\{left:([\d.]+)%/g)) slotLefts['p' + m[1]] = Number(m[2]);
assert.equal(Object.keys(slotLefts).length, 12, 'twelve slots: ' + Object.keys(slotLefts).join(','));
const order = ['p6', 'p12', 'p3', 'p10', 'p8', 'p2', 'p11', 'p5', 'p9', 'p1', 'p7', 'p4'];
for (const d of [2, 4, 8]) {
	const xs = order.slice(0, d).map((s) => slotLefts[s]);
	assert.ok(Math.max(...xs) - Math.min(...xs) >= 40, 'density ' + d + ' still spans the pane: ' + xs.join(','));
}
// every slot has staggered negative delays (pane is populated at load)
const delays = pv2.match(/animation-delay:calc\(-[\d.]+s \/ var\(--dnl-pv2-pace\)\),calc\(-[\d.]+s/g) || [];
assert.equal(delays.length, 12, 'twelve staggered negative delays');

// ---- 6. knobs: CSS defaults + prefs clamps ---------------------------------
assert.match(pv2, /\.dnl-decor-petalsv2\{--dnl-pv2-pace:1;--dnl-pv2-sway:1;--dnl-pv2-tint:35%\}/, 'CSS variable defaults');
localStore.raw = JSON.stringify({ pv2Density: 99, pv2Pace: 999, pv2Sway: -5, pv2Tint: 500 });
const clamped = readNoticePrefs();
assert.equal(clamped.pv2Density, 12, 'density clamps to 12');
assert.equal(clamped.pv2Pace, 200, 'pace clamps to 200');
assert.equal(clamped.pv2Sway, 0, 'sway clamps to 0');
assert.equal(clamped.pv2Tint, 100, 'tint clamps to 100');
localStore.raw = JSON.stringify({ pv2Density: 0 });
assert.equal(readNoticePrefs().pv2Density, 2, 'density clamps to 2');
localStore.raw = '{}';
const dflt = readNoticePrefs();
assert.deepEqual(
	[dflt.pv2Density, dflt.pv2Pace, dflt.pv2Sway, dflt.pv2Tint],
	[8, 100, 100, 35],
	'defaults: 8 petals, 100% pace/sway, 35% tint');
localStore.raw = JSON.stringify({ decor: 'petalsv2' });
assert.equal(readNoticePrefs().decor, 'petalsv2', 'the whitelist accepts petalsv2');
localStore.raw = JSON.stringify({ decor: 'petals' });
assert.equal(readNoticePrefs().decor, 'petals', 'the old preset stays selectable until retired');
// v0.4.23: trajectory + wind are whitelisted like every other select knob
localStore.raw = JSON.stringify({ pv2Traj: 'uniform', pv2Wind: 'terminal' });
const variant = readNoticePrefs();
assert.equal(variant.pv2Traj, 'uniform', 'traj whitelist accepts uniform');
assert.equal(variant.pv2Wind, 'terminal', 'wind whitelist accepts terminal');
localStore.raw = JSON.stringify({ pv2Traj: 'bogus', pv2Wind: 'bogus' });
const variantDflt = readNoticePrefs();
assert.equal(variantDflt.pv2Traj, 'varied', 'unknown traj falls back to varied');
assert.equal(variantDflt.pv2Wind, 'gust', 'unknown wind falls back to gust');
localStore.raw = null;

// ---- 7. settings UI --------------------------------------------------------
for (const label of ['樱吹雪花瓣密度', '樱吹雪飘落速度', '樱吹雪摇摆幅度', '樱吹雪主色点缀', '樱吹雪飘落轨迹', '樱吹雪风场模拟']) {
	assert.ok(src.includes('"' + label + '"'), 'settings control: ' + label);
}
assert.match(src, /PV2_TRAJS\.map\(\(\[id, label\]\) => h\("option"/, 'traj select lists the variants');
assert.match(src, /PV2_WINDS\.map\(\(\[id, label\]\) => h\("option"/, 'wind select lists the variants');
assert.match(src, /pv2Density: 8, pv2Pace: 100, pv2Sway: 100, pv2Tint: 35, pv2Traj: "varied", pv2Wind: "gust" \}\) \}, "恢复樱吹雪默认参数"/, 'reset button restores all defaults');

// ---- 8. shape variants + two-tone colour -------------------------------------
assert.match(pv2, /\.sh-a\{clip-path:polygon\(52% 10%/, 'notched sakura silhouette (offset notch, no heart read)');
assert.match(pv2, /\.sh-b\{clip-path:ellipse/, 'round plum-petal variant');
assert.match(pv2, /\.sh-c\{clip-path:polygon\(50% 0/, 'slim willow-leaf variant');
assert.match(pv2, /#fff3f8,var\(--dsw-alias-brand-primary\) calc\(var\(--dnl-pv2-tint\) \* \.35\)/, 'light side mixes 0.35x tint');
assert.match(pv2, /#ffd9e8,var\(--dsw-alias-brand-primary\) var\(--dnl-pv2-tint\)/, 'shadow side mixes full tint');
assert.match(pv2, /\.acc\{background:linear-gradient\(115deg/, 'accent petals mix harder');
assert.doesNotMatch(pv2, /box-shadow|filter:/, 'no glow/brightness — decor stays subordinate (m01510)');

// ---- 8b. trajectory + wind variants (v0.4.22 CSS / v0.4.23 selectable, m02233) -
for (const path of ['dnl-pv2-fall-a', 'dnl-pv2-fall-b', 'dnl-pv2-fall-c', 'dnl-pv2-fall-d']) {
	assert.ok(pv2.includes('@keyframes ' + path), 'trajectory keyframes: ' + path);
}
const trajAssign = pv2.match(/\.p\d+\{left:\d+%;width:[^}]*animation:dnl-pv2-fall-[abcd]/g) || [];
assert.equal(trajAssign.length, 12, 'every slot takes one of the four trajectories (varied default)');
assert.match(pv2, /\.pv2-traj-uniform \.p1,.+\.p5,.+\.p9\{animation-name:dnl-pv2-fall,/, 'uniform collapses slots onto the shared fall');
assert.match(pv2, /@keyframes dnl-pv2-gust\{/, 'wind gust keyframes');
assert.match(pv2, /\.dnl-decor-petalsv2\.pv2-wind-gust\{animation:dnl-pv2-gust/, 'gust runs only under the gust variant');
assert.match(pv2, /translateX\(calc\(9px \* var\(--dnl-pv2-sway\)\)\) rotate\(\.8deg\)/, 'gust peak nudge + tilt');
const terminalSpeeds = pv2.match(/\.pv2-wind-terminal \.p\d+\{animation-duration:calc\([\d.]+s/g) || [];
assert.ok(terminalSpeeds.length >= 5, 'terminal variant retunes fall speeds by size: ' + terminalSpeeds.length);
assert.doesNotMatch(pv2, /\.pv2-wind-turb\{animation/, 'turb keeps the layer still (per-petal sway only)');

// ---- 9. reduced motion -------------------------------------------------------
const rmAt = CSS.indexOf('@media(prefers-reduced-motion:reduce){.dnl-decor span{animation:none}');
assert.ok(rmAt >= 0, 'decor reduced-motion block exists');
assert.ok(CSS.indexOf('.dnl-decor-petalsv2 .dnl-decor-petal{display:none}', rmAt) > rmAt, 'petalsv2 hides under reduced-motion');

console.log('PASS: petalsv2 preset — isolation, whole-pane fall through the rim, sinusoidal sway + tumble, 12 spread-first slots, knob clamps, settings UI, reduced-motion');

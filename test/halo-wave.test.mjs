// Style + render contracts for the ambient wave ornaments (v0.4.34, restyled
// in v0.4.36, stardust rebuilt as the 宇宙尘埃 dust field in v0.4.40). User
// reference: NetEase Cloud Music 「音波」/「宇宙尘埃」 player effects.
//
// Rendering model (hardened after the "下垂大U环" bug): the ring element itself
// must NEVER rotate — a capsule-shaped ring turned 40° swings its long axis
// ~150px off the pill. w1/w2 are plain boxes hugging the pill. dots/wave keep
// TWO <rect> rings (r1/r2, pathLength=100) whose dashes ride the path via an
// animated stroke-dashoffset. stardust renders the 宇宙尘埃 model instead: a
// group of discrete grains (.dg circle.dp) that ROTATES around the viewBox
// centre (orbit) while each grain pulses with its own FFT band pair
// (fftrandom — baked --dnl-bN interpolation in inline style).
//
// v0.4.40 driver contract (shared data layer, kept from the v0.4.39 spec
// attempt): the helper emits 10 dB-normalised log bands; the driver shapes
// them with fftpow 1.5, eases each band independently, and publishes
// --dnl-b0..9 on the halo span. lyric lane drives all bands uniformly (cur).
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

// ---- 1. the wave layer base + brightness knob ----------------------------------
assert.match(CSS, /\.dnl-halo-wave\{overflow:visible;--dnl-wave-hi:1;--dnl-beat:0\}/,
	'the halo span lets the rings spill outside; default brightness factor 1; the beat scalar rests at 0');
assert.match(CSS, /\.dnl-halo-wave\.dnl-wave-vivid\{--dnl-wave-hi:1\.45\}/,
	'vivid raises the brightness factor');
assert.match(CSS, /\.dnl-halo-wave>\.w1,\.dnl-halo-wave>\.w2\{position:absolute;pointer-events:none;border:none\}/,
	'w1/w2 ring boxes are border-less and positioned inside the halo');
assert.match(CSS, /\.dnl-halo-wave svg\{[^}]*overflow:visible[^}]*filter:drop-shadow\(/,
	'the ring svg paints outside its own box and carries a soft glow');
assert.match(CSS, /\.dnl-halo-wave rect\{fill:none;stroke:color-mix\(in srgb,var\(--dnl-halo,var\(--dsw-alias-brand-primary\)\) 55%,#ffffff\);vector-effect:non-scaling-stroke;stroke-linecap:round\}/,
	'dots/wave strokes brighten toward white (official ffffff88 reference) and keep width under stretching');
assert.match(CSS, /\.dnl-halo-wave \.r2\{stroke:color-mix\(in srgb,var\(--dnl-halo,var\(--dsw-alias-brand-primary\)\) 38%,#ffffff\)\}/,
	'the second rect is dimmer so the mixed-size dots read as dust, not as a fence');

// ---- 2. dots style --------------------------------------------------------------
assert.match(CSS, /\.dnl-wave-dots>\.w1\{inset:-13px;opacity:calc\(\.72 \* var\(--dnl-wave-hi\)\)\}/,
	'dots w1: ring box just outside the pill rim, brightness-scaled');
assert.match(CSS, /\.dnl-wave-dots>\.w1 \.r1\{stroke-width:2\.6;stroke-dasharray:\.1 3\.15;animation:dnl-wave-orbit calc\(var\(--dnl-glow-dur,5\.6s\) \* 4\) linear infinite\}/,
	'dots w1 r1: primary dots orbit on 4 cycles per breath');
assert.match(CSS, /\.dnl-wave-dots>\.w1 \.r2\{stroke-width:1\.4;stroke-dasharray:\.1 6\.35;opacity:\.6;animation:dnl-wave-orbit calc\(var\(--dnl-glow-dur,5\.6s\) \* 5\) linear infinite\}/,
	'dots w1 r2: smaller sparser dots ride a different period (mixed sizes)');
assert.match(CSS, /\.dnl-wave-dots>\.w2\{inset:-21px;opacity:calc\(\.42 \* var\(--dnl-wave-hi\)\)\}/,
	'dots w2: a second, fainter outer ring');
assert.match(CSS, /\.dnl-wave-dots>\.w2 \.r1\{[^}]*linear infinite reverse\}/,
	'dots w2: primary dots counter-orbit');

// ---- 3. stardust style (v0.4.40 宇宙尘埃 dust field) -------------------------------
assert.match(CSS, /\.dnl-wave-stardust>\.w1\{inset:-13px;opacity:calc\(\.88 \* var\(--dnl-wave-hi\)\);animation:dnl-wave-twinkle var\(--dnl-glow-dur,5\.6s\)/,
	'w1 keeps the twinkle breathing box on the inner orbit');
assert.match(CSS, /\.dnl-wave-stardust>\.w1 \.dg\{animation:dnl-wave-orbit-g calc\(var\(--dnl-glow-dur,5\.6s\) \* 5\) linear infinite\}/,
	'w1 grain group orbits 5 cycles per breath');
assert.match(CSS, /\.dnl-wave-stardust>\.w2\{inset:-22px;opacity:calc\(\.55 \* var\(--dnl-wave-hi\)\)[^}]*animation-delay:calc\(var\(--dnl-glow-dur,5\.6s\) \* -\.5\)\}/,
	'w2 is the fainter outer orbit, half a breath out of phase');
assert.match(CSS, /\.dnl-wave-stardust>\.w2 \.dg\{animation:dnl-wave-orbit-g calc\(var\(--dnl-glow-dur,5\.6s\) \* 8\) linear infinite reverse\}/,
	'outer orbit counter-rotates slower');
assert.match(CSS, /\.dnl-halo-wave\.dnl-wave-stardust circle\.dp\{fill:color-mix\(in srgb,var\(--dnl-halo,var\(--dsw-alias-brand-primary\)\) 35%,#ffffff\);stroke:none;transform-box:fill-box;transform-origin:center\}/,
	'grains fill white-forward (official 宇宙尘埃 alpha-white), scale around their own centre');
assert.match(CSS, /\.dnl-halo-wave\.dnl-wave-stardust svg\{transform:none;/,
	'stardust svg opts out of the generic whole-ring beat-scale (official shakebeat:0 — no 全部跳动)');
assert.match(CSS, /\.dnl-halo-wave \.dg\{transform-box:view-box;transform-origin:50% 50%\}/,
	'the grain group rotates around the viewBox centre (orbit, not capsule rotation)');
assert.match(CSS, /@keyframes dnl-wave-orbit-g\{to\{transform:rotate\(360deg\)\}\}/,
	'orbit rotates the grain group; the capsule boxes never rotate');
assert.match(CSS, /@keyframes dnl-wave-twinkle\{0%,100%\{opacity:\.32;transform:scale\(\.97\)\}50%\{opacity:calc\(\.62 \* var\(--dnl-wave-hi\)\);transform:scale\(1\.03\)\}\}/,
	'the twinkle cycle breathes opacity and scale, vivid raises the peak');

// ---- 4. wave (dashed outline) style ----------------------------------------------
assert.match(CSS, /\.dnl-wave-wave>\.w1 \.r1\{stroke-width:1\.8;stroke-dasharray:7 2\.2;animation:dnl-wave-orbit calc\(var\(--dnl-glow-dur,5\.6s\) \* 3\) linear infinite\}/,
	'wave style draws a long-dash ring that flows on 3 cycles per breath');
assert.match(CSS, /\.dnl-wave-wave>\.w1 \.r2\{stroke-width:1;stroke-dasharray:2\.2 5\.6;opacity:\.6;animation:dnl-wave-orbit[^}]*reverse\}/,
	'wave w1 r2: short interleaved dashes counter-flow (ripple moiré)');
assert.match(CSS, /@keyframes dnl-wave-orbit\{to\{stroke-dashoffset:-100\}\}/,
	'the orbit keyframes walk the dashes along the path (never rotate the element)');

// ---- 5. hold / burst / scope / reduced-motion -------------------------------------
// Specificity must beat the per-style shorthand animations
// (.dnl-wave-dots>.w1 .r1 = 0,3,0; the shorthand resets play-state):
assert.match(CSS, /\.dnl-halo\.dnl-halo-hold\.dnl-halo-wave>\.w1,\.dnl-halo\.dnl-halo-hold\.dnl-halo-wave>\.w2,\.dnl-halo\.dnl-halo-hold\.dnl-halo-wave rect\{animation-play-state:paused\}/,
	'paused playback stills the rings AND their dash orbit (hold rule out-specifies the shorthand)');
assert.match(CSS, /\.dnl-halo-hold\.dnl-halo-wave \.dg\{animation-play-state:paused\}/,
	'paused playback also stills the dust orbit group');
assert.match(CSS, /\.dnl-halo\.dnl-halo-hold>span\{animation:none\}/,
	'the legacy hold rule also out-specifies the h1-h4 shorthand animations (.dnl-halo>.hN = 0,2,0)');
assert.match(CSS, /\.dnl-halo-burst>\.w1,\.dnl-halo-burst>\.w2\{display:none\}/,
	'the notice burst hides the ambient rings (spec tier is gone)');
assert.match(CSS, /\.dnl-shell-expanded \.dnl-halo-wave:not\(\.dnl-wave-both\)>\.w1[^}]*display:none/,
	'rings hide in the expanded card unless scope=both');
assert.match(CSS, /\.dnl-halo>\.w1,\.dnl-halo>\.w2\{display:none\}/,
	'reduced-motion removes the rings outright');
assert.doesNotMatch(src, /className: "w3"/, 'the v0.4.39 spec bar tier is removed');
assert.doesNotMatch(CSS, /dnl-wave-spec/, 'no spec CSS survives');

// ---- 5a. dust render wiring (stardust = 宇宙尘埃 field) -----------------------------
assert.match(src, /const DUST_BAND_MIX = \(count\) =>/, 'band-pair interpolation helper exists');
assert.match(src, /i \* 137\.508 - 90/, 'golden-angle (sunflower) spread keeps the field organic');
assert.match(src, /const dustGrains = \(count, sizeBase, sizeStep, radiusBase, radiusStep, opBase, opGain, phase\) =>/, 'grain factory takes size/opacity/phase knobs');
assert.match(src, /prefs\.glowWaveStyle === "stardust"/, 'the stardust branch exists');
assert.match(src, /dustGrains\(16, 1\.3, 0\.3, 46, 1, "\.3", "\.55", 0\)/,
	'w1: 16 mixed-size grains on the inner orbit');
assert.match(src, /dustGrains\(12, 0\.95, 0\.24, 47\.5, 2, "\.26", "\.5", 2\)/,
	'w2: 12 finer grains on the outer orbit, phase-staggered, dimmer');
assert.match(src, /transform: "scale\(calc\(0\.65 \+ " \+ bandExpr \+ " \* 1\.6\)\)"/,
	'each grain scales linearly with its band pair (0.65 + band × 1.6: quiet visible, hot pops ×2 — stackoverflow linear recipe)');
assert.match(src, /opacity: "calc\(" \+ opBase \+ " \+ " \+ bandExpr \+ " \* " \+ opGain \+ "\)"/,
	'each grain brightens with its own band pair on top of its resting alpha');
assert.doesNotMatch(src, /SPEC_SEGMENT_COUNT/, 'the SPEC constants are gone');

// ---- 5b. band driver (shared --dnl-b0..9 data layer, kept from v0.4.39) -------------
assert.match(src, /Math\.pow\(bandRaw\[i\], 1\.5\)/,
	'bands read fftpow-1.5 shaped targets (vision.json fftpow:1.5)');
assert.match(src, /setProperty\("--dnl-b" \+ i, bands\[i\] < 0\.004 \? "0" : bands\[i\]\.toFixed\(3\)\)/,
	'the driver publishes one --dnl-bN variable per band, with the same kill-threshold as --dnl-beat');
assert.match(src, /const bandAudio = beatSource === "audio" && playing && miss < 3 && audioLive && lastTickAt > 0 && now - lastTickAt < 2000;/,
	'the audio lane only drives bands on fresh ticks (stale helper → quiet field, never frozen grains)');
assert.match(src, /for \(let i = 0; i < 10; i\+\+\) haloRef\.current\.style\.setProperty\("--dnl-b" \+ i, "0"\);/,
	'lane off/empty zeroes every band variable (no stale grains after a source switch)');
assert.match(src, /const bandTarget = beatSource === "audio" \? \(bandAudio \? Math\.pow\(bandRaw\[i\], 1\.5\) : 0\) : cur;/,
	'lyric lane drives all ten bands uniformly from the grid (cur) like NCM dust on a vocal line');

// ---- 6. render wiring --------------------------------------------------------------
assert.match(src, /glowMode !== "notice" && prefs\.glowWaveStyle \? " dnl-halo-wave dnl-wave-" \+ prefs\.glowWaveStyle : ""/,
	'the wave class applies only outside notice mode when a style is picked');
assert.match(src, /prefs\.glowWaveStyle && prefs\.glowWaveScope === "both" \? " dnl-wave-both" : ""/,
	'the both-scope class applies only when both is picked');
assert.match(src, /prefs\.glowWaveStyle && prefs\.glowWaveBright === "vivid" \? " dnl-wave-vivid" : ""/,
	'the vivid class applies only when vivid is picked');
assert.match(src, /h\("rect", \{ key: "r1", className: "r1", x: 2, y: 2, width: 96, height: 96, rx: 48, pathLength: 100 \}\)/,
	'dots/wave ring svgs still render the r1 rect (pathLength=100)');
assert.match(src, /h\("rect", \{ key: "r2", className: "r2", x: 2, y: 2, width: 96, height: 96, rx: 48, pathLength: 100 \}\)/,
	'dots/wave ring svgs still render the r2 rect (mixed dot sizes)');
assert.doesNotMatch(src, /className: "wt"/,
	'the rotated .wt span is gone (rotating a capsule ring was the U-shape bug)');

// ---- 7. settings UI ------------------------------------------------------------------
assert.match(src, /"aria-label": "音波环样式"/, 'the style select exists');
assert.match(src, /\["dots", "点阵环"\]/, 'dots offered');
assert.match(src, /\["stardust", "星尘环（音频律动）"\]/, 'stardust offered as the audio-reactive default face');
assert.match(src, /\["wave", "波形描边"\]/, 'wave offered');
assert.doesNotMatch(src, /\["spec", /, 'the spec bar option is removed');
assert.match(src, /"aria-label": "音波环范围"/, 'the scope select exists');
assert.match(src, /\["both", "收起 \+ 展开"\]/, 'the both scope offered');
assert.match(src, /"aria-label": "音波环亮度"/, 'the brightness select exists');
assert.match(src, /\["subtle", "含蓄（默认）"\]/, 'subtle offered as default');
assert.match(src, /\["vivid", "鲜明"\]/, 'vivid offered');

// ---- 8. sanitizer whitelist -----------------------------------------------------------
assert.match(src, /raw\?\.glowWaveStyle === "dots" \|\| raw\?\.glowWaveStyle === "stardust" \|\| raw\?\.glowWaveStyle === "wave"\) out\.glowWaveStyle = raw\.glowWaveStyle;/,
	'glowWaveStyle is whitelisted to dots/stardust/wave');
assert.match(src, /raw\?\.glowWaveScope === "both"\) out\.glowWaveScope = raw\.glowWaveScope;/,
	'glowWaveScope is whitelisted to both');
assert.match(src, /raw\?\.glowWaveBright === "vivid"\) out\.glowWaveBright = raw\.glowWaveBright;/,
	'glowWaveBright is whitelisted to vivid (subtle is the unpersisted default)');

// ---- 9. functional round-trip through readDisplay --------------------------------------
localStore.raw = JSON.stringify({ glowWaveStyle: 'stardust', glowWaveScope: 'both', glowWaveBright: 'vivid' });
let disp = plugin.__test.readDisplay();
assert.equal(disp.glowWaveStyle, 'stardust', 'stardust round-trips');
assert.equal(disp.glowWaveScope, 'both', 'both scope round-trips');
assert.equal(disp.glowWaveBright, 'vivid', 'vivid brightness round-trips');
localStore.raw = JSON.stringify({ glowWaveStyle: 'spec', glowWaveScope: 'wide', glowWaveBright: 'blinding' });
disp = plugin.__test.readDisplay();
assert.equal(disp.glowWaveStyle, undefined, 'the retired spec value is dropped');
assert.equal(disp.glowWaveScope, undefined, 'unknown scope values are dropped');
assert.equal(disp.glowWaveBright, undefined, 'unknown brightness values are dropped');
localStore.raw = null;
disp = plugin.__test.readDisplay();
assert.equal(disp.glowWaveBright, undefined, 'absent brightness falls through to subtle');

console.log('halo-wave contract: PASS (dots/wave rect rings, v0.4.40 stardust 宇宙尘埃 dust field: fftrandom per-grain FFT bands + orbit-g rotation + twinkle, spec bars removed, band driver --dnl-b0..9 shared, scope/burst/hold/reduced-motion, settings + sanitizer)');

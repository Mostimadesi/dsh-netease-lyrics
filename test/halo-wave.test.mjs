// Style + render contracts for the ambient wave ornaments (v0.4.34, restyled
// in v0.4.36). User reference: NetEase Cloud Music 「音波」 rings (user
// screenshots 2026-11-13). Three selectable styles ride on the halo span; the
// four blur layers are untouched.
//
// Rendering model (hardened after the "下垂大U环" bug): the ring element itself
// must NEVER rotate — a capsule-shaped ring turned 40° swings its long axis
// ~150px off the pill. Instead w1/w2 are plain boxes hugging the pill, each
// carrying an SVG with TWO <rect> rings (r1/r2, pathLength=100). The dashes
// ride the path via an animated stroke-dashoffset;
// vector-effect:non-scaling-stroke keeps the stroke width constant under
// preserveAspectRatio="none".
//
// v0.4.36 restyle follows the official effect-package parameters unpacked from
// the local NetEase cache (wasm/resource/5306503 宇宙尘埃 + 5306506 水晶音波):
// strokes brighten toward WHITE (official colour: ffffff88), a soft drop-shadow
// glow, two rects per ring so dot sizes mix, and a subtle/vivid brightness knob
// (--dnl-wave-hi / dnl-wave-vivid).
// Contracts:
//   - styles dots/stardust/wave render two ring boxes (w1, w2), each with an
//     svg carrying r1+r2 rect rings;
//   - rings follow --dnl-halo and --dnl-glow-dur (pace档位);
//   - collapsed-only by default, .dnl-wave-both keeps them in the expanded card;
//   - paused playback stills them, notice burst hides them, reduced-motion
//     removes them outright;
//   - sanitizer whitelists style/scope/brightness; settings UI exposes all three.
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
	'strokes brighten toward white (official ffffff88 reference) and keep width under stretching');
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

// ---- 3. stardust style -----------------------------------------------------------
assert.match(CSS, /\.dnl-wave-stardust>\.w1\{[^}]*dnl-wave-twinkle var\(--dnl-glow-dur,5\.6s\)/,
	'stardust w1 twinkles on the breathing cadence');
assert.match(CSS, /\.dnl-wave-stardust>\.w1 \.r1\{stroke-width:3;stroke-dasharray:\.1 4\.9/,
	'stardust w1 r1: bright grains');
assert.match(CSS, /\.dnl-wave-stardust>\.w1 \.r2\{stroke-width:1\.6;stroke-dasharray:\.1 7\.4;opacity:\.5/,
	'stardust w1 r2: finer grains counter-orbit');
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
assert.match(CSS, /\.dnl-halo\.dnl-halo-hold>span\{animation:none\}/,
	'the legacy hold rule also out-specifies the h1-h4 shorthand animations (.dnl-halo>.hN = 0,2,0)');
assert.match(CSS, /\.dnl-halo-burst>\.w1,\.dnl-halo-burst>\.w2,\.dnl-halo-burst>\.w3\{display:none\}/,
	'the notice burst hides the ambient rings (and the spec bar tier)');
assert.match(CSS, /\.dnl-shell-expanded \.dnl-halo-wave:not\(\.dnl-wave-both\)>\.w1[^}]*display:none/,
	'rings hide in the expanded card unless scope=both');
assert.match(CSS, /\.dnl-halo>\.w1,\.dnl-halo>\.w2,\.dnl-halo>\.w3\{display:none\}/,
	'reduced-motion removes the rings outright (spec tier included)');

// ---- 5a. spec (segmented spectrum ring, v0.4.39) -------------------------------------
// Behavior model: the NetEase 音波 vision.json rings (5261504/5306504/5306505/
// 5306506/5306507) — the circle is split into angular segments and only the
// segments whose own FFT band has energy extend (shakebeat:0/shaketogether:0
// in every official config: NO whole-ring pulse). Our w3 tier renders 24 radial
// bars; the generic ring rules must be neutralised for this face or the bars
// would ride on a uniform beat-scale = the exact "全部跳动" bug being fixed.
assert.match(CSS, /\.dnl-halo-wave\.dnl-wave-spec>\.w1,\.dnl-halo-wave\.dnl-wave-spec>\.w2\{display:none\}/,
	'spec face hides the dashed rings (they would draw through the bars)');
assert.match(CSS, /\.dnl-halo-wave\.dnl-wave-spec>\.w3 svg\{transform:none;/,
	'spec svg neutralises the generic whole-ring beat-scale (that uniform pulse IS the 全部跳动 bug)');
assert.match(CSS, /\.dnl-halo-wave\.dnl-wave-spec rect\.sb\{fill:color-mix[^}]*stroke:none;transform-box:fill-box;transform-origin:50% 100%\}/,
	'bars fill toward white (official ffffff88), anchored at their base so scaleY extends outward only');
assert.match(CSS, /\.dnl-halo-wave>\.w3\{position:absolute;inset:-15px;pointer-events:none;border:none;opacity:calc\(\.78 \* var\(--dnl-wave-hi,1\)\)\}/,
	'w3 bar tier hugs the pill like the rings did, brightness-scaled, never interactive');
assert.match(CSS, /\.dnl-halo\.dnl-halo-hold\.dnl-wave-spec>\.w3\{opacity:\.45\}/,
	'paused playback stills the bar tier to a quiet ring instead of freezing mid-air');
assert.doesNotMatch(CSS, /\.dnl-wave-spec[^{]*\{[^}]*animation:dnl-wave-orbit/,
	'spec bars never inherit the dash-orbit animation (rotating capsules was the U-shape bug)');

// ---- 5b. spec render + driver wiring ----------------------------------------------------
assert.match(src, /const SPEC_SEGMENT_COUNT = 24;/, 'the segmented ring uses 24 bars');
assert.match(src, /prefs\.glowWaveStyle === "spec"\s*\?\s*h\("span", \{ key: "w3", className: "w3" \}/,
	'spec renders the w3 tier instead of the w1/w2 ring pair');
assert.match(src, /viewBox: "-50 -50 100 100"/, 'the spec svg is centred so bars can reach past the ring edge');
assert.match(src, /transform: "rotate\(" \+ s\.angle \+ "\)"/, 'each bar is rotated into its angle slot');
assert.match(src, /scaleY\(calc\(0\.08 \+ \(var\(--dnl-b" \+ s\.a \+ ",0\) \* " \+ s\.fa \+ " \+ var\(--dnl-b" \+ s\.b \+ ",0\) \* " \+ s\.fb \+ "\) \* 0\.92\)\)/,
	'every bar scales its length from its two neighbouring band variables (linear band interpolation)');
assert.match(src, /Math\.pow\(bandRaw\[i\], 1\.5\)/,
	'bars read fftpow-1.5 shaped band targets (vision.json fftpow:1.5)');
assert.match(src, /setProperty\("--dnl-b" \+ i, bands\[i\] < 0\.004 \? "0" : bands\[i\]\.toFixed\(3\)\)/,
	'the driver publishes one --dnl-bN variable per band, with the same kill-threshold as --dnl-beat');
assert.match(src, /const bandAudio = beatSource === "audio" && playing && miss < 3 && audioLive && lastTickAt > 0 && now - lastTickAt < 2000;/,
	'the audio lane only drives bands on fresh ticks (stale helper → quiet ring, never frozen bars)');
assert.match(src, /for \(let i = 0; i < 10; i\+\+\) haloRef\.current\.style\.setProperty\("--dnl-b" \+ i, "0"\);/,
	'lane off/empty zeroes every band variable (no stale bars after a source switch)');
assert.match(src, /const bandTarget = beatSource === "audio" \? \(bandAudio \? Math\.pow\(bandRaw\[i\], 1\.5\) : 0\) : cur;/,
	'lyric lane drives all ten bands uniformly from the grid (cur) like NCM bars on a vocal line');

// ---- 6. render wiring --------------------------------------------------------------
assert.match(src, /glowMode !== "notice" && prefs\.glowWaveStyle \? " dnl-halo-wave dnl-wave-" \+ prefs\.glowWaveStyle : ""/,
	'the wave class applies only outside notice mode when a style is picked');
assert.match(src, /prefs\.glowWaveStyle && prefs\.glowWaveScope === "both" \? " dnl-wave-both" : ""/,
	'the both-scope class applies only when both is picked');
assert.match(src, /prefs\.glowWaveStyle && prefs\.glowWaveBright === "vivid" \? " dnl-wave-vivid" : ""/,
	'the vivid class applies only when vivid is picked');
assert.match(src, /h\("rect", \{ key: "r1", className: "r1", x: 2, y: 2, width: 96, height: 96, rx: 48, pathLength: 100 \}\)/,
	'each ring svg renders the r1 rect (pathLength=100)');
assert.match(src, /h\("rect", \{ key: "r2", className: "r2", x: 2, y: 2, width: 96, height: 96, rx: 48, pathLength: 100 \}\)/,
	'each ring svg renders the r2 rect (mixed dot sizes)');
assert.doesNotMatch(src, /className: "wt"/,
	'the rotated .wt span is gone (rotating a capsule ring was the U-shape bug)');

// ---- 7. settings UI ------------------------------------------------------------------
assert.match(src, /"aria-label": "音波环样式"/, 'the style select exists');
assert.match(src, /\["dots", "点阵环"\]/, 'dots offered');
assert.match(src, /\["stardust", "星尘环"\]/, 'stardust offered');
assert.match(src, /\["wave", "波形描边"\]/, 'wave offered');
assert.match(src, /\["spec", "频谱环（分段跳动）"\]/, 'spec offered (the NCM 音波 partial-beat)');
assert.match(src, /"aria-label": "音波环范围"/, 'the scope select exists');
assert.match(src, /\["both", "收起 \+ 展开"\]/, 'the both scope offered');
assert.match(src, /"aria-label": "音波环亮度"/, 'the brightness select exists');
assert.match(src, /\["subtle", "含蓄（默认）"\]/, 'subtle offered as default');
assert.match(src, /\["vivid", "鲜明"\]/, 'vivid offered');

// ---- 8. sanitizer whitelist -----------------------------------------------------------
assert.match(src, /raw\?\.glowWaveStyle === "dots" \|\| raw\?\.glowWaveStyle === "stardust" \|\| raw\?\.glowWaveStyle === "wave" \|\| raw\?\.glowWaveStyle === "spec"\) out\.glowWaveStyle = raw\.glowWaveStyle;/,
	'glowWaveStyle is whitelisted to dots/stardust/wave/spec');
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
localStore.raw = JSON.stringify({ glowWaveStyle: 'rings-nonsense', glowWaveScope: 'wide', glowWaveBright: 'blinding' });
disp = plugin.__test.readDisplay();
assert.equal(disp.glowWaveStyle, undefined, 'unknown style values are dropped');
assert.equal(disp.glowWaveScope, undefined, 'unknown scope values are dropped');
assert.equal(disp.glowWaveBright, undefined, 'unknown brightness values are dropped');
localStore.raw = null;
disp = plugin.__test.readDisplay();
assert.equal(disp.glowWaveBright, undefined, 'absent brightness falls through to subtle');

console.log('halo-wave contract: PASS (svg r1/r2 rings, white-forward strokes + glow, mixed dot sizes, subtle/vivid knob, cadence + colour wiring, scope/burst/hold/reduced-motion, v0.4.39 spec segmented spectrum ring * NCM 音波 partial-beat, settings + sanitizer)');

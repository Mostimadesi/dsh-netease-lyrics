// Style + render contracts for the ambient wave ornaments (v0.4.34).
// User reference: NetEase Cloud Music 「音波」 rings (user screenshots
// 2026-11-13). Three selectable styles ride on the halo span; the four blur
// layers are untouched.
//
// Rendering model (hardened after the "下垂大U环" bug): the ring element itself
// must NEVER rotate — a capsule-shaped ring turned 40° swings its long axis
// ~150px off the pill. Instead w1/w2 are plain boxes hugging the pill, each
// carrying an SVG <rect> (pathLength=100). The dashes ride the path via an
// animated stroke-dashoffset; vector-effect:non-scaling-stroke keeps the
// stroke width constant under preserveAspectRatio="none".
// Contracts:
//   - styles dots/stardust/wave render two ring boxes (w1, w2) each with an
//     svg+rect ring;
//   - rings follow --dnl-halo and --dnl-glow-dur (pace档位);
//   - collapsed-only by default, .dnl-wave-both keeps them in the expanded card;
//   - paused playback stills them, notice burst hides them, reduced-motion
//     removes them outright;
//   - sanitizer whitelists the style/scope values; settings UI exposes both.
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

// ---- 1. the wave layer is separate from the blur halo -------------------------
assert.match(CSS, /\.dnl-halo-wave>\.w1,\.dnl-halo-wave>\.w2\{position:absolute;pointer-events:none;border:none\}/,
	'w1/w2 ring boxes are border-less and positioned inside the halo');
assert.match(CSS, /\.dnl-halo-wave\{overflow:visible\}/,
	'the halo span lets the rings spill outside');
assert.match(CSS, /\.dnl-halo-wave svg\{[^}]*overflow:visible[^}]*\}/,
	'the ring svg paints outside its own box');
assert.match(CSS, /\.dnl-halo-wave rect\{[^}]*vector-effect:non-scaling-stroke[^}]*\}/,
	'the rect keeps its stroke width when the capsule stretches the viewBox');

// ---- 2. dots style -------------------------------------------------------------
assert.match(CSS, /\.dnl-wave-dots>\.w1\{inset:-13px;opacity:\.5\}/,
	'dots w1: ring box just outside the pill rim');
assert.match(CSS, /\.dnl-wave-dots>\.w1 rect\{[^}]*stroke-dasharray:\.1 4\.9[^}]*animation:dnl-wave-orbit calc\(var\(--dnl-glow-dur,5\.6s\) \* 4\) linear infinite/,
	'dots w1: round dots orbit on 4 cycles per breath');
assert.match(CSS, /\.dnl-wave-dots>\.w2\{inset:-21px;opacity:\.3\}/,
	'dots w2: a second, fainter outer ring');
assert.match(CSS, /\.dnl-wave-dots>\.w2 rect\{[^}]*stroke-dasharray:\.1 7\.4[^}]*linear infinite reverse/,
	'dots w2: sparser dots counter-orbit');

// ---- 3. stardust style -----------------------------------------------------------
assert.match(CSS, /\.dnl-wave-stardust>\.w1\{[^}]*dnl-wave-twinkle var\(--dnl-glow-dur,5\.6s\)/,
	'stardust w1 twinkles on the breathing cadence');
assert.match(CSS, /\.dnl-wave-stardust>\.w2 rect\{[^}]*stroke-dasharray:\.1 5\.2/,
	'stardust w2: denser dust than dots');
assert.match(CSS, /@keyframes dnl-wave-twinkle\{0%,100%\{opacity:\.28;transform:scale\(\.97\)\}50%\{opacity:\.6;transform:scale\(1\.03\)\}\}/,
	'the twinkle cycle breathes opacity and scale');

// ---- 4. wave (dashed outline) style ----------------------------------------------
assert.match(CSS, /\.dnl-wave-wave>\.w1 rect\{[^}]*stroke-dasharray:6 3[^}]*animation:dnl-wave-orbit calc\(var\(--dnl-glow-dur,5\.6s\) \* 3\) linear infinite/,
	'wave style draws a long-dash ring that flows on 3 cycles per breath');
assert.match(CSS, /\.dnl-wave-wave>\.w2 rect\{[^}]*stroke-dasharray:4 4[^}]*linear infinite reverse/,
	'wave w2 counter-flows with shorter dashes');
assert.match(CSS, /@keyframes dnl-wave-orbit\{to\{stroke-dashoffset:-100\}\}/,
	'the orbit keyframes walk the dashes along the path (never rotate the element)');

// ---- 5. hold / burst / scope / reduced-motion -------------------------------------
// Specificity must beat the per-style shorthand animations
// (.dnl-wave-dots>.w1>svg>rect = 0,2,2; the shorthand resets play-state):
assert.match(CSS, /\.dnl-halo\.dnl-halo-hold\.dnl-halo-wave>\.w1,\.dnl-halo\.dnl-halo-hold\.dnl-halo-wave>\.w2,\.dnl-halo\.dnl-halo-hold\.dnl-halo-wave rect\{animation-play-state:paused\}/,
	'paused playback stills the rings AND their dash orbit (hold rule out-specifies the shorthand)');
assert.match(CSS, /\.dnl-halo\.dnl-halo-hold>span\{animation:none\}/,
	'the legacy hold rule also out-specifies the h1-h4 shorthand animations (.dnl-halo>.hN = 0,2,0)');
assert.match(CSS, /\.dnl-halo-burst>\.w1,\.dnl-halo-burst>\.w2\{display:none\}/,
	'the notice burst hides the ambient rings');
assert.match(CSS, /\.dnl-shell-expanded \.dnl-halo-wave:not\(\.dnl-wave-both\)>\.w1[^}]*display:none/,
	'rings hide in the expanded card unless scope=both');
assert.match(CSS, /\.dnl-halo>\.w1,\.dnl-halo>\.w2\{display:none\}/,
	'reduced-motion removes the rings outright');

// ---- 6. render wiring --------------------------------------------------------------
assert.match(src, /glowMode !== "notice" && prefs\.glowWaveStyle \? " dnl-halo-wave dnl-wave-" \+ prefs\.glowWaveStyle : ""/,
	'the wave class applies only outside notice mode when a style is picked');
assert.match(src, /prefs\.glowWaveStyle && prefs\.glowWaveScope === "both" \? " dnl-wave-both" : ""/,
	'the both-scope class applies only when both is picked');
assert.match(src, /className: "w1" \}, h\("svg", \{ viewBox: "0 0 100 100", preserveAspectRatio: "none" \}, h\("rect", \{ x: 2, y: 2, width: 96, height: 96, rx: 48, pathLength: 100 \}\)\)/,
	'w1 renders an SVG rect ring (pathLength=100)');
assert.doesNotMatch(src, /className: "wt"/,
	'the rotated .wt span is gone (rotating a capsule ring was the U-shape bug)');

// ---- 7. settings UI ------------------------------------------------------------------
assert.match(src, /"aria-label": "音波环样式"/, 'the style select exists');
assert.match(src, /\["dots", "点阵环"\]/, 'dots offered');
assert.match(src, /\["stardust", "星尘环"\]/, 'stardust offered');
assert.match(src, /\["wave", "波形描边"\]/, 'wave offered');
assert.match(src, /"aria-label": "音波环范围"/, 'the scope select exists');
assert.match(src, /\["both", "收起 \+ 展开"\]/, 'the both scope offered');

// ---- 8. sanitizer whitelist -----------------------------------------------------------
assert.match(src, /raw\?\.glowWaveStyle === "dots" \|\| raw\?\.glowWaveStyle === "stardust" \|\| raw\?\.glowWaveStyle === "wave"\) out\.glowWaveStyle = raw\.glowWaveStyle;/,
	'glowWaveStyle is whitelisted to dots/stardust/wave');
assert.match(src, /raw\?\.glowWaveScope === "both"\) out\.glowWaveScope = raw\.glowWaveScope;/,
	'glowWaveScope is whitelisted to both');

// ---- 9. functional round-trip through readDisplay --------------------------------------
localStore.raw = JSON.stringify({ glowWaveStyle: 'stardust', glowWaveScope: 'both' });
let disp = plugin.__test.readDisplay();
assert.equal(disp.glowWaveStyle, 'stardust', 'stardust round-trips');
assert.equal(disp.glowWaveScope, 'both', 'both scope round-trips');
localStore.raw = JSON.stringify({ glowWaveStyle: 'rings-nonsense', glowWaveScope: 'wide' });
disp = plugin.__test.readDisplay();
assert.equal(disp.glowWaveStyle, undefined, 'unknown style values are dropped');
assert.equal(disp.glowWaveScope, undefined, 'unknown scope values are dropped');
localStore.raw = null;
disp = plugin.__test.readDisplay();
assert.equal(disp.glowWaveStyle, undefined, 'absent style falls through to off at read sites');
assert.equal(disp.glowWaveScope, undefined, 'absent scope falls through to collapsed-only');

console.log('halo-wave contract: PASS (svg ring boxes, dash-orbit (no element rotation), cadence + colour wiring, scope/burst/hold/reduced-motion, settings + sanitizer)');

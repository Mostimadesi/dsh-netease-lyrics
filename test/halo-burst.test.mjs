// Style + render contracts for the notice-burst halo shapes (v0.4.33).
// User feedback 2026-11-12: the burst scaled the four halo layers to 1.45
// (1.2 expanded), which lifted the outer ring ~23px off the rim — "一大圈光、
// 和浮窗边缘不紧贴". The magnification is gone. Two selectable shapes:
//   rim  (default): hugging hairline + faint near halo; far layers hidden.
//   halo (dnl-halo-wide): the outward halo stays but is halved and dimmed.
// Both keep the fast 1.15s cadence. Normal breathing modes are untouched.
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

// ---- 1. no more magnification ------------------------------------------------
assert.doesNotMatch(CSS, /\.dnl-halo-burst\{transform:scale/,
	'the burst container no longer scales up');
assert.doesNotMatch(CSS, /\.dnl-shell-expanded \.dnl-halo-burst\{transform:scale/,
	'the expanded burst scale is gone too');
assert.match(CSS, /\.dnl-halo-burst\{opacity:1\}/, 'the burst still lights at full strength');

// ---- 2. rim is the default shape ---------------------------------------------
assert.match(CSS, /\.dnl-halo-burst>\.h3,\.dnl-halo-burst>\.h4\{display:none\}/,
	'rim shape hides the far halo layers (the “not hugging” culprits)');
assert.match(CSS, /\.dnl-halo-burst>\.h2\{[^}]*opacity:\.3\}/,
	'rim shape keeps only a faint near halo on h2');

// ---- 3. the wide variant stays restrained ------------------------------------
assert.match(CSS, /\.dnl-halo-burst\.dnl-halo-wide>\.h3\{display:block;inset:-8px;border-width:7px;filter:blur\(12px\)/,
	'wide shape halves the outer ring geometry (-16px/18px blur → -8px/12px)');
assert.match(CSS, /\.dnl-halo-burst\.dnl-halo-wide>\.h3\{[^}]*opacity:\.35\}/,
	'wide shape dims the outer ring');
assert.match(CSS, /\.dnl-halo-burst\.dnl-halo-wide>\.h4\{display:block;[^}]*opacity:\.2\}/,
	'wide shape keeps a quiet drift layer');

// ---- 4. the fast cadence is preserved -----------------------------------------
assert.match(CSS, /dnl-burst-rim 1\.15s/, 'rim layer keeps the 1.15s pulse');
assert.match(CSS, /dnl-burst-mid 1\.15s/, 'mid layer keeps the 1.15s pulse');
assert.match(CSS, /@keyframes dnl-burst-rim\{0%,100%\{opacity:\.6\}26%\{opacity:1\}\}/, 'burst keyframes intact');
assert.match(src, /"--dnl-glow-dur": glowMode === "notice" \? "1\.15s"/, 'the burst duration override stays');

// ---- 5. normal breathing modes are untouched -----------------------------------
assert.match(CSS, /\.dnl-halo>\.h3\{inset:-16px;border-width:9px;filter:blur\(18px\)/,
	'the ambient halo geometry is unchanged');
assert.match(src, /glowPace === "calm" \? "8\.4s" : glowPace === "lively" \? "3\.9s" : "5\.6s"/,
	'the ambient breathing cadence table remains');

// ---- 6. render wiring ----------------------------------------------------------
assert.match(src, /glowMode === "notice" && prefs\.glowBurstStyle === "halo" \? " dnl-halo-wide" : ""/,
	'the wide variant class applies only in notice mode with the halo shape');

// ---- 7. settings UI -------------------------------------------------------------
assert.match(src, /"aria-label": "通知光晕形态"/, 'the shape select exists');
assert.match(src, /prefs\.glow === "notice" \? h\("label", \{ key: "glow-burst"/,
	'the shape select shows only in notice mode');
assert.match(src, /\["rim", "贴边描边（默认）"\]/, 'rim is offered as the default');
assert.match(src, /\["halo", "收敛光晕"\]/, 'halo is offered for comparison');
assert.match(src, /saveDisplay\(\{ \.\.\.readDisplay\(\), glowBurstStyle: event\.target\.value \}\)/,
	'the shape select persists via display prefs');

// ---- 8. sanitizer whitelist ------------------------------------------------------
assert.match(src, /raw\?\.glowBurstStyle === "rim" \|\| raw\?\.glowBurstStyle === "halo"\) out\.glowBurstStyle = raw\.glowBurstStyle;/,
	'glowBurstStyle is whitelisted to rim/halo');

// ---- 9. functional round-trip through readDisplay --------------------------------
localStore.raw = JSON.stringify({ glowBurstStyle: 'halo', glow: 'notice' });
let disp = plugin.__test.readDisplay();
assert.equal(disp.glowBurstStyle, 'halo', 'halo shape round-trips');
assert.equal(disp.glow, 'notice', 'the notice glow mode round-trips alongside');
localStore.raw = JSON.stringify({ glowBurstStyle: 'wide-nonsense' });
disp = plugin.__test.readDisplay();
assert.equal(disp.glowBurstStyle, undefined, 'unknown shape values are dropped');
localStore.raw = null;
disp = plugin.__test.readDisplay();
assert.equal(disp.glowBurstStyle, undefined, 'absent shape falls through to the rim default at read sites');

console.log('halo-burst contract: PASS (no magnification, rim default, wide variant, cadence kept, settings + sanitizer wired)');

// Regression: a dithering positionSec must not flip the lyric index back and
// forth across a line boundary. Real players (SMTC) report positions that wobble
// ±0.2s; with a plain `t <= pos` test that wobble crosses the boundary every
// poll, so LyricTransition re-rendered the PREVIOUS line in its cross-fade and a
// line change visibly "flashed another line" before settling. Reproduced in a
// real browser: pos 4.8 <-> 5.2 produced B2 -> OUT:B2/IN:A1 -> OUT:A1/IN:B2 -> B2.
//
// The fix is a sticky index with a 0.35s hysteresis band in both directions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';

let plugin;
vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
	window: {
		__ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => ({ default: React })); } },
		addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
		matchMedia: () => ({ matches: true }), innerWidth: 1200, innerHeight: 800,
	},
	document: undefined, console, AbortController, AbortSignal,
	fetch: () => Promise.resolve({ ok: false }), Event: class {},
	localStorage: { getItem: () => null, setItem() {} },
	setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
});

const { currentLineIndex, stickyLineIndex, LINE_HYSTERESIS_SEC } = plugin.__test;

// Lines every 5s: A@0, B@5, C@10, D@15
const lines = [
	{ t: 0, text: 'A' }, { t: 5, text: 'B' }, { t: 10, text: 'C' }, { t: 15, text: 'D' },
];

// --- baseline: the plain lookup still does its job ---
assert.equal(currentLineIndex(lines, -1), -1, 'before the first line is -1');
assert.equal(currentLineIndex(lines, 0), 0, 'exactly on a boundary counts as that line');
assert.equal(currentLineIndex(lines, 4.99), 0, 'just before B is still A');
assert.equal(currentLineIndex(lines, 5), 1, 'exactly at B is B');
assert.equal(currentLineIndex(lines, 100), 3, 'past the end is the last line');

// --- the bug: dither around a boundary with no memory flips the index ---
const jitter = [4.8, 5.2, 4.8, 5.2, 4.9, 5.1];
const naive = jitter.map((p) => currentLineIndex(lines, p));
assert.deepEqual(naive, [0, 1, 0, 1, 0, 1], 'without hysteresis the index flips every poll (the bug)');

// --- the fix: the same dither keeps whatever is already on screen ---
let shown = 0; // we are showing A
const sticky = [];
for (const p of jitter) { shown = stickyLineIndex(lines, p, shown); sticky.push(shown); }
assert.deepEqual(sticky, [0, 0, 0, 0, 0, 0],
	'a dither across the boundary must NOT change the displayed line');

// Starting from B, the same dither also stays on B (symmetric).
shown = 1;
const stickyFromB = jitter.map((p) => { shown = stickyLineIndex(lines, p, shown); return shown; });
assert.deepEqual(stickyFromB, [1, 1, 1, 1, 1, 1], 'dither never pulls the line back once it is shown');

// --- genuine progress is not blocked ---
assert.equal(stickyLineIndex(lines, 5 + LINE_HYSTERESIS_SEC + 0.01, 0), 1,
	'a real advance past the band still changes the line');
assert.equal(stickyLineIndex(lines, 5 + LINE_HYSTERESIS_SEC - 0.01, 0), 0,
	'just inside the band still holds the old line');

// --- a genuine seek (far jump) goes through immediately ---
assert.equal(stickyLineIndex(lines, 15.5, 0), 3, 'a forward seek lands immediately');
assert.equal(stickyLineIndex(lines, 0.5, 3), 0, 'a backward seek lands immediately');

// --- retreat needs to clear the band, so dither cannot pull a line back ---
assert.equal(stickyLineIndex(lines, 4.8, 1), 1, 'dither just below B keeps B');
assert.equal(stickyLineIndex(lines, 5 - LINE_HYSTERESIS_SEC - 0.01, 1), 0,
	'clearly before B retreats to A');

// --- edge cases stay safe ---
assert.equal(stickyLineIndex(lines, 0, -1), 0, 'no previous index behaves like the raw lookup');
assert.equal(stickyLineIndex([], 5, 0), -1, 'empty lines is -1');
assert.equal(stickyLineIndex(lines, 3, 99), 0, 'an out-of-range previous falls back to raw');

// --- the render path must actually use the sticky variant ---
const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
assert.match(src, /const shownIndexRef = useRef\(-1\)/, 'the shown index is remembered across renders');
assert.match(src, /stickyLineIndex\(linesForHooks, clockPos, shownIndexRef\.current\)/,
	'the collapsed/expanded path uses the sticky index');
assert.match(src, /stickyLineIndex\(lines, pos, shownIndexRef\.current\)/,
	'the render path uses the sticky index too');
assert(!/const index = lines\.length > 0 \? currentLineIndex\(lines, pos\) : -1;/.test(src),
	'no render path is left on the non-sticky lookup');

console.log('PASS: lyric index is sticky across a dithering position (no flashing previous line)');

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

const { currentLineIndex, stickyLineIndex, hysteresisFor } = plugin.__test;

// Lines every 5s: A@0, B@5, C@10, D@15
const lines = [
	{ t: 0, text: 'A' }, { t: 5, text: 'B' }, { t: 10, text: 'C' }, { t: 15, text: 'D' },
];

// v0.4.10 (HANDOFF-lyrics-pending-fixes.md §7): the hysteresis band is
// ADAPTIVE — the median forward gap of the current track, clamped to
// 0.08..0.35s. For a 5s-gap track that clamps to the 0.35s ceiling, so the
// historic behaviour on normal songs is preserved exactly.
const HYST = hysteresisFor(lines);
assert.equal(HYST, 0.35, 'a 5s-gap track keeps the full 0.35s band');
// A fast song (0.25s gaps) tightens to 0.08s — the fix for "fast songs lag".
const fastLines = Array.from({ length: 8 }, (_, i) => ({ t: i * 0.25, text: 'F' + i }));
assert.equal(hysteresisFor(fastLines), 0.08, 'a 0.25s-gap track tightens the band to 0.08s');
// A mid song (0.5s gaps) → 0.5*0.25 = 0.125s.
const midLines = Array.from({ length: 8 }, (_, i) => ({ t: i * 0.5, text: 'M' + i }));
assert.equal(hysteresisFor(midLines), 0.125, 'a 0.5s-gap track scales the band proportionally');
// One short line inside a slow song does NOT collapse the band (median, not min).
const mixedLines = [{ t: 0, text: 'a' }, { t: 4, text: 'b' }, { t: 4.2, text: 'c' },
	{ t: 8, text: 'd' }, { t: 12, text: 'e' }];
assert.equal(hysteresisFor(mixedLines), 0.35, 'the median (not the min) protects slow songs');

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
assert.equal(stickyLineIndex(lines, 5 + HYST + 0.01, 0), 1,
	'a real advance past the band still changes the line');
assert.equal(stickyLineIndex(lines, 5 + HYST - 0.01, 0), 0,
	'just inside the band still holds the old line');

// --- a genuine seek (far jump) goes through immediately ---
assert.equal(stickyLineIndex(lines, 15.5, 0), 3, 'a forward seek lands immediately');
assert.equal(stickyLineIndex(lines, 0.5, 3), 0, 'a backward seek lands immediately');

// --- retreat needs to clear the band, so dither cannot pull a line back ---
assert.equal(stickyLineIndex(lines, 4.8, 1), 1, 'dither just below B keeps B');
assert.equal(stickyLineIndex(lines, 5 - HYST - 0.01, 1), 0,
	'clearly before B retreats to A');

// --- edge cases stay safe ---
assert.equal(stickyLineIndex(lines, 0, -1), 0, 'no previous index behaves like the raw lookup');
assert.equal(stickyLineIndex([], 5, 0), -1, 'empty lines is -1');
assert.equal(stickyLineIndex(lines, 3, 99), 0, 'an out-of-range previous falls back to raw');

// --- the render path must use the sticky/settled index ---
const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
assert.match(src, /const lineStateRef = useRef\(null\)/, 'the shown index is remembered across renders');
assert.match(src, /lineStateRef\.current = \{ shown: -1, pending: -1, pendingSince: 0 \}/,
	'the state object is created lazily (useRef initial values are not universal)');
// v0.4.27: the lookup position is now the CALIBRATED one (per-track offset), so
// the assertion pins the argument that reaches settleLineIndex without
// forbidding the calibration wrapper around it.
assert.match(src, /settleLineIndex\(linesForHooks, lookupPos, lineStateRef\.current, Date\.now\(\), backwardSettleMs\(st\?\.pollMs\)\)/,
	'the settled index drives the render, sized by the poll interval');
assert.match(src, /const lookupPos = offsetPosition\(clockPos, offsetMs\)/,
	'the lookup position is derived from the clock through the per-track offset');
assert.match(src, /const index = indexForHooks;/, 'the render reuses the same settled index');
assert(!/stickyLineIndex\(lines, pos, shownIndexRef/.test(src), 'no second, independent index computation is left');

// ---------------------------------------------------------------------------
// settleLineIndex: a single stale BACKWARD reading must not flash a previous
// line. This is the second half of the reported bug ("it flashes another line
// before switching"): one stale poll pulls the raw index back for a cycle and,
// with hysteresis alone, that drop is wide enough to be shown.
// ---------------------------------------------------------------------------
const { settleLineIndex, BACKWARD_SETTLE_MS } = plugin.__test;

// We are showing B (index 1) and one poll reports an older position inside A.
const st = { shown: 1, pending: -1, pendingSince: 0 };
const t0 = 1000;
assert.equal(settleLineIndex(lines, 2.0, st, t0), 1,
	'a backward reading inside the settle window keeps the current line');
assert.equal(st.pending, 0, 'the lower index is remembered as pending');
// The next poll reports the correct position again (still inside B): the stale
// reading is forgotten and B stays on screen the whole time.
assert.equal(settleLineIndex(lines, 6.0, st, t0 + 200), 1,
	'back on the current line after the stale poll: still shows it');
// A genuine backward seek that persists past the window does land.
const st2 = { shown: 2, pending: -1, pendingSince: 0 };
assert.equal(settleLineIndex(lines, 1.0, st2, t0), 2, 'a backward seek is not applied instantly');
assert.equal(settleLineIndex(lines, 1.0, st2, t0 + BACKWARD_SETTLE_MS + 1), 0,
	'a backward seek that persists is applied');

// Forward changes are immediate (hysteresis already vetted them).
const st3 = { shown: 0, pending: -1, pendingSince: 0 };
assert.equal(settleLineIndex(lines, 5 + HYST + 0.01, st3, t0), 1,
	'a clear forward advance is applied at once');

// A transient that returns to the shown line clears the pending state.
const st4 = { shown: 1, pending: -1, pendingSince: 0 };
settleLineIndex(lines, 2.0, st4, t0);
assert.equal(st4.pending, 0, 'pending set by the stale read');
settleLineIndex(lines, 12.0, st4, t0 + 50);
assert.equal(st4.pending, -1, 'returning to the shown line clears the pending state');

// The confirmation window MUST outlast one poll, or a single stale poll (which
// lives exactly one poll cycle) still gets committed. Measured bug: 500ms poll
// with a 450ms window flashed C3 -> A1 -> C3.
const { backwardSettleMs } = plugin.__test;
for (const poll of [250, 500, 1000, 2000]) {
	assert(backwardSettleMs(poll) > poll,
		'confirmation window must exceed the poll interval (' + poll + 'ms)');
}
assert(backwardSettleMs(500) >= 750, 'a 500ms poll gets at least a 750ms window');
assert.equal(backwardSettleMs(undefined) >= 750, true, 'a missing poll interval falls back sanely');

// A one-poll stale reading (500ms) must be swallowed by a 500ms-poll window.
const st5 = { shown: 2, pending: -1, pendingSince: 0 };
const win = backwardSettleMs(500);
assert.equal(st5.shown, 2, 'showing C');
assert.equal(settleLineIndex(lines, 1.0, st5, t0, win), 2, 'stale read does not change the line');
assert.equal(settleLineIndex(lines, 1.0, st5, t0 + 500, win), 2,
	'even after a full stale poll the line is unchanged');

console.log('PASS: lyric index is sticky across a dithering position (no flashing previous line)');

// Regression: the OUTGOING layer of the lyric cross-fade must be established
// synchronously with the identity change (during render), never from a useEffect.
//
// Why this specific test exists: the effect-based version was shipped for many
// versions and looked fine in every headless probe. In the real, GPU-composited
// DSH window it is NOT fine - the first painted frame after a line change shows
// the new line fully opaque with no fade-in, and only then does the effect insert
// the outgoing line at opacity 1 on top of it, so the line that just left flashes
// back before the cross-fade settles. A headless browser run flushes the effect
// within the same frame and therefore paints both versions identically, so this
// cannot be caught by a screenshot/probe - it is guarded here instead.
//
// This was verified in the field: reverting exactly this change made the user's
// "flashes another line" symptom return immediately.
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

const { nextTransitionFrame, CSS } = plugin.__test;
const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

// --- mount: nothing to fade out yet ---
const first = nextTransitionFrame(null, 'a', 'LINE A');
assert.equal(first.identity, 'a', 'mount keeps the identity');
assert.equal(first.content, 'LINE A', 'mount keeps the content');
assert.equal(first.previous, null, 'nothing to fade out on the first line');

// --- a line change must carry `previous` IMMEDIATELY ---
// This is the whole fix: the object returned right after the identity changes
// already knows about the outgoing line, so the very first render of the new
// line can render it. (The effect version returned previous === null here.)
const second = nextTransitionFrame(first, 'b', 'LINE B');
assert.equal(second.identity, 'b', 'the new identity is applied at once');
assert.equal(second.content, 'LINE B', 'the new content is applied at once');
assert.ok(second.previous, 'previous exists synchronously - NOT via an effect');
assert.equal(second.previous.identity, 'a', 'previous remembers the outgoing identity');
assert.equal(second.previous.content, 'LINE A', 'previous carries the outgoing content');
assert.equal(first.previous, null, 'the old frame object is not mutated');

// --- same identity returns the same object (no churn, no extra render) ---
assert.equal(nextTransitionFrame(second, 'b', 'LINE B'), second,
	'an unchanged identity must return the same object so setState is skipped');

// --- a third change keeps only one outgoing layer ---
const third = nextTransitionFrame(second, 'c', 'LINE C');
assert.equal(third.previous.identity, 'b', 'previous always tracks the immediately preceding line');
assert.equal(third.previous.content, 'LINE B');

// --- source contract: the effect must not create `previous` ---
assert.match(src, /function nextTransitionFrame\(frame, identity, children\)/,
	'the transition derivation lives in one place');
assert.match(src, /const derived = nextTransitionFrame\(frame, props\.identity, props\.children\);/,
	'LyricTransition derives the frame during render');
assert.match(src, /if \(derived !== frame\) setFrame\(derived\);/,
	'the render-phase state update is guarded (converges immediately)');
assert.match(src, /const \[frame, setFrame\] = useState\(\(\) => nextTransitionFrame\(null, props\.identity, props\.children\)\)/,
	'the initial frame comes from the same helper');
// v0.4.10 (HANDOFF §8): the clear timeout uses the shared CROSSFADE_CLEAR_MS
// constant (animation duration + 60ms margin) instead of the hard-coded 240.
assert.match(src, /setTimeout\(\(\) => setFrame\(old => \(\{ \.\.\.old, previous: null \}\)\), CROSSFADE_CLEAR_MS\)/,
	'the effect only CLEARS the outgoing layer, after the shared clear constant');
// The clear margin must exceed the animation duration (a dropped frame must
// not truncate the fade-out).
assert.match(src, /CROSSFADE_CLEAR_MS = CROSSFADE_MS \+ 60/,
	'the clear timer carries a 60ms margin over the animation');
// The animation is at least 300ms (a sub-300ms displacement reads as a flash).
assert.match(CSS, /dnl-lyric-out 340ms cubic-bezier\(\.4,0,\.2,1\)/,
	'the fade-out runs 340ms on a both-ends-soft curve');
// The old buggy shape: an effect that assigns `previous`.
assert.ok(!/useEffect\(\(\) => \{\s*setFrame\(old => old\.identity === props\.identity \? old : \{/.test(src),
	'no effect may create the outgoing layer (that paints one frame late)');

console.log('PASS: the outgoing cross-fade layer is created during render, not in an effect');

// Regression: the COLLAPSED pill is content-sized and the host is centred with
// translateX(-50%). When a long lyric line is followed by a short one, the
// width used to change in a single frame (~199px in real Chrome), shifting the
// capsule sideways by ~99px - the "jumping around" on line changes, present
// with the halo ON and OFF alike since v0.3.22 (so it is NOT a halo/kick bug).
//
// Fix: an effect writes the line's measured width as an explicit px value on
// .dnl-now-wrap, and CSS transitions `width`, so the change interpolates
// (measured: 199px one-frame jump -> ~40px first frame, 16-18 intermediate
// widths over ~280ms). The cross-fade animation itself is untouched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

let plugin;
let seq = 0;
const timers = new Map();
const pending = [];

vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
	window: {
		__ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => ({ default: React })); } },
		addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
		matchMedia: () => ({ matches: true }), innerWidth: 1200, innerHeight: 800,
	},
	document: undefined, console, AbortController, AbortSignal,
	fetch: () => new Promise((resolve) => pending.push({ resolve })),
	Event: class {}, localStorage: { getItem: () => null, setItem() {} },
	setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id; },
	clearTimeout: (id) => timers.delete(id),
	setInterval: (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms, repeat: true }); return id; },
	clearInterval: (id) => timers.delete(id),
});

const routes = new Map();
plugin.apply({ slots: {
	inject: (_, cb) => cb(),
	register: (opts, component) => { routes.set(opts.key || opts.id, component); return () => {}; },
} });
const Island = routes.get('dsh-netease-lyrics-island');
const CSS = plugin.__test.CSS;

// 1. The width transition must exist and must NOT be a fixed/constant width.
assert.match(CSS, /\.dnl-now-wrap\{[^}]*transition:[^}]*width\s*\.28s/,
	'the collapsed lyric wrapper transitions its width');
assert(!/\.dnl-now-wrap\{[^}]*width:\s*\d+px\}/.test(CSS),
	'no hard-coded width in CSS (width is measured per line at runtime)');

// 2. With a real React DOM-ish renderer, the effect must write a px width onto
//    .dnl-now-wrap and update it when the line text changes.
const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };
const firePoll = () => {
	for (const [id, t] of [...timers]) {
		if (t.repeat) continue;
		if (t.ms === 500) { timers.delete(id); t.fn(); return true; }
	}
	return false;
};
const wrapNode = (renderer) => renderer.root.findAll((n) => typeof n.type === 'string'
	&& String(n.props.className || '').split(' ').includes('dnl-now-wrap'))[0] || null;
// react-test-renderer host refs are not real DOM nodes; the effect writes via
// `ref.current.style`. Give the wrapper a mutable style object through a fake
// instance by intercepting the ref callback is not possible here, so instead
// assert the source-level contract: an effect keyed on the line text writes
// `wrap.style.width`. This catches a removal of the fix without a real DOM.
const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
assert.match(src, /const nowWrapRef = useRef\(null\)/, 'a ref targets the lyric wrapper');
assert.match(src, /wrap\.style\.width = width \+ "px"/, 'the effect writes an explicit px width');
// Width follows the CURRENT line (the user rejected a fixed width as worse than
// the jump); the CSS transition is what removes the snap.
assert.match(src, /const lineTextForHooks = /, 'the measured text is the current line');
assert.match(src, /\[lineTextForHooks, prefs\.font, st\?\.active\]/,
	'the width effect is keyed on the current line text');
assert.ok(src.indexOf('const nowWrapRef = useRef(null)') < src.indexOf('if (st === null || st.active !== true) return null;'),
	'the width hook is declared before the early return (constant hook order)');

// HEIGHT was the other half of the "text jumps around" bug: a line with a
// translation is ~39px tall vs ~22px without, so switching lines moved the text
// vertically by 17px in one frame. Every line must keep the translation row
// reserved once the track has any translation.
assert.match(src, /const hasAnyTranslation = lines\.some/, 'the track-wide translation check exists');
assert.match(src, /className: "dnl-now-reserve"/, 'a reserve placeholder is rendered on untranslated lines');
assert.match(CSS, /\.dnl-now-reserve\{[^}]*height:16px/, 'the reserve placeholder occupies the translation row');

// 3. The cross-fade transition must still be present (the user reported the
//    line-change transition looked removed; the width jump was what broke it).
assert.match(src, /function LyricTransition\(props\)/, 'line cross-fade still exists');
assert.match(CSS, /\.dnl-fade-in\{animation:dnl-lyric-in/, 'fade-in animation intact');
assert.match(CSS, /\.dnl-fade-out\{[^}]*animation:dnl-lyric-out/, 'fade-out animation intact');

// 3b. Entering through the left gutter must NOT expand the capsule, otherwise
//     the hover expansion resizes the capsule and the drag handle under the
//     pointer mid-gesture (measured: 61x34 -> 362x341, drag produced no move).
assert.match(src, /hostRef\.current\?\.querySelector\?\.\("\.dnl-drag"\)/,
	'the hover handler inspects the drag handle box');
assert.match(src, /event\.clientX >= box\.left && event\.clientX <= box\.right/,
	'a pointer entering the gutter is not expanded');

// 4. Sanity: the component still mounts with real React and a real line change
//    does not throw (the measurement effect must be tolerant of a null ref).
const mk = (pos) => ({ active: true, playing: true, title: 'T', artist: 'A', app: 'test',
	durationSec: 100, pollMs: 500, canToggle: true, positionSec: pos, atMs: Date.now() + 120000,
	lyric: { status: 'matched', songId: 1, lines: [
		{ t: 0, text: '夜' }, { t: 5, text: '我开始想念你 在这个没有星星的夜里' }, { t: 10, text: '风' },
	] } });
let renderer;
try {
	act(() => { renderer = TestRenderer.create(React.createElement(Island)); });
	await act(async () => { pending.at(-1).resolve({ ok: true, json: async () => mk(0) }); await flush(); });
	assert.ok(wrapNode(renderer), 'the wrapper is rendered');
	act(() => { firePoll(); });
	await act(async () => { pending.at(-1).resolve({ ok: true, json: async () => mk(6) }); await flush(); });
	assert.ok(wrapNode(renderer), 'the wrapper survives a line change');
} finally {
	if (renderer) await act(async () => { renderer.unmount(); await flush(); });
}

console.log('PASS: collapsed width is measured per line and transitions smoothly; line cross-fade preserved');

// Contracts for the v0.4.0 workspace-notice surface in lib/client.js:
//
//   - 浮窗未触发 (no SMTC session) + 有提问/轮次结束 → the pill renders the
//     notice headline itself ("xx会话区有提问" / "xx会话区第x轮对话结束"),
//     hover-expand shows the full list.
//   - 浮窗触发 (SMTC active) → ONLY a red dot at the island's bottom-right;
//     clicking it opens the full notice list; the gear ✕ returns to lyrics.
//   - idle + no notice → still completely hidden (the pre-0.4.0 contract).
//
// Real React drives the real component (fake React / serialized HTML do not
// carry production handlers — see procedures/测试-歌词插件静态页面通过但实际交互失败).
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
const { sanitizeNotices, noticeHeadline, noticeClockLabel, noticeList, CSS } = plugin.__test;

// ---- pure helpers ------------------------------------------------------------
// NOTE: values returned from the vm-loaded plugin live in the vm realm, so
// deepEqual's prototype check fails on cross-realm arrays — compare by
// length and elements instead.
assert.equal(sanitizeNotices(null).length, 0);
assert.equal(sanitizeNotices({}).length, 0, 'a payload without items reads as empty');
assert.equal(sanitizeNotices({ items: 'nope' }).length, 0);
// Hostile rows are skipped, not fatal; the workspace falls back to a generic
// label; both a question and a turn ending can ride one item.
const cleaned = sanitizeNotices({ serial: 2, items: [
	null,
	{ workspace: 'alpha', question: null, turnEnd: null },
	{ workspace: 'alpha', question: { kind: 'user-question', preview: '要继续吗？', at: 3000 }, turnEnd: { turn: 3, outcome: 'completed', at: 2000 } },
	{ workspace: '', question: null, turnEnd: { turn: 'x', at: 1 } },
	{ workspace: '', question: { kind: 'nonsense', preview: 5, at: 'bad' }, turnEnd: null },
] });
assert.equal(cleaned.length, 2, 'only well-formed rows survive');
assert.equal(cleaned[0].workspace, 'alpha');
assert.equal(cleaned[0].question.kind, 'user-question', 'unknown kinds normalize to user-question');
assert.equal(cleaned[0].at, 3000, 'item at = max(question, turnEnd)');
assert.equal(cleaned[1].workspace, '工作区', 'missing workspace names read generically');
assert.equal(cleaned[1].question.toolName, '', 'malformed tool names normalize');
assert.equal(cleaned[1].question.at, 0, 'malformed times normalize to 0');
// Sorting: questions first, then newest first — even when the question is older.
const sorted = sanitizeNotices({ items: [
	{ workspace: 'b', turnEnd: { turn: 9, at: 9000 } },
	{ workspace: 'q', question: { kind: 'approval', at: 1000 } },
	{ workspace: 'a', turnEnd: { turn: 1, at: 5000 } },
] });
assert.equal(sorted.length, 3);
assert.equal(sorted[0].workspace, 'q');
assert.equal(sorted[1].workspace, 'b');
assert.equal(sorted[2].workspace, 'a');
// Hard cap at 12 even when the host sent more (it should not, but defend).
assert.equal(sanitizeNotices({ items: Array.from({ length: 20 }, (_, i) => (
	{ workspace: 'w' + String(i), turnEnd: { turn: 1, at: i } })) }).length, 12);

// The exact wording the user asked for.
assert.equal(noticeHeadline(cleaned[0]), 'alpha会话区有提问');
assert.equal(noticeHeadline({ workspace: 'beta', question: null, turnEnd: { turn: 3, outcome: 'completed', at: 1 } }),
	'beta会话区第3轮对话结束');
assert.match(noticeClockLabel(new Date('2026-11-06T21:05:00').getTime()), /^\d{2}:\d{2}$/);
assert.equal(noticeClockLabel(0), '');
assert.equal(noticeClockLabel(Number.NaN), '');
// The list builder renders plain elements (walkable by test harnesses) and an
// explicit empty state.
const listTree = noticeList(cleaned);
assert.equal(listTree.props.className, 'dnl-notices');
assert.ok(listTree.props.children[0].props.className === 'dnl-notice-head');
const emptyTree = noticeList([]);
assert.ok(JSON.stringify(emptyTree).includes('当前没有会话区提示'));

// ---- source-shape contracts (a paint-order defect headless cannot see) --------
const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
assert.match(src, /if \(!smtcActive && !noticeMode\) return null;/,
	'idle WITHOUT a notice stays hidden — the combined early-return condition');
assert.match(src, /const notices = sanitizeNotices\(st === null \? null : st\.notice\);[\s\S]{0,400}const noticeMode = !smtcActive && notices\.length > 0;/,
	'notice mode is derived from the shared poll BEFORE any early return');
assert.match(src, /panelView !== "notices"\s*\?\s*h\("button", \{\s*type: "button", className: "dnl-dot"/,
	'the red dot is a button gated on the notices view');
assert.match(CSS, /\.dnl-dot\{[^}]*position:absolute[^}]*right:4px;bottom:4px/,
	'the dot anchors at the island bottom-right');
assert.match(CSS, /@media\(prefers-reduced-motion:reduce\)\{\.dnl-dot::before\{animation:none\}\}/,
	'reduced motion stills the dot pulse');
assert.match(CSS, /\.dnl-notice-row-q\{[^}]*color-mix/, 'question rows are visually distinct');

// ---- real React: the island renders notice mode without SMTC ------------------
const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };
const firePoll = () => {
	for (const [id, t] of [...timers]) {
		if (t.repeat) continue;
		if (t.ms === 500) { timers.delete(id); t.fn(); return true; }
	}
	return false;
};
const resolve = async (payload) => {
	await act(async () => {
		pending.at(-1).resolve({ ok: true, json: async () => payload });
		await flush();
	});
};
const byClass = (renderer, cls) => renderer.root.findAll((n) => typeof n.type === 'string'
	&& String(n.props.className || '').split(' ').includes(cls));
// ReactTestInstance graphs are circular (parent/children); JSON.stringify
// would throw, so walk the children for text instead.
const textOf = (node) => {
	const walk = (n) => (typeof n === 'string' || typeof n === 'number'
		? String(n)
		: (n.children || []).map(walk).join(''));
	return walk(node);
};
const idleNotice = {
	active: false, pollMs: 500,
	notice: { serial: 7, items: [
		{ workspace: 'alpha', question: { kind: 'user-question', preview: '要继续吗？', at: 1 }, turnEnd: null },
	] },
};
const idleTurnEnd = {
	active: false, pollMs: 500,
	notice: { serial: 8, items: [
		{ workspace: 'beta', question: null, turnEnd: { turn: 3, outcome: 'completed', at: 2 } },
	] },
};
const trackWithNotice = {
	active: true, playing: true, title: 'T', artist: 'A', app: 'test', pollMs: 500,
	durationSec: 100, positionSec: 1, canToggle: true, coverSerial: 0,
	lyric: { status: 'matched', songId: 1, lines: [{ t: 0, text: 'First' }] },
	notice: { serial: 9, items: [
		{ workspace: 'alpha', question: { kind: 'user-question', preview: '要继续吗？', at: 3 }, turnEnd: null },
	] },
};

let renderer;
try {
	act(() => { renderer = TestRenderer.create(React.createElement(Island)); });
	// idle + no notice → hidden (the pre-0.4.0 contract must survive).
	await resolve({ active: false, pollMs: 500 });
	assert.equal(renderer.toJSON(), null, 'idle without notices renders nothing');

	// idle + question → the pill itself shows the headline; no red dot.
	act(() => firePoll());
	await resolve(idleNotice);
	const island = renderer.root.findByProps({ role: 'status' });
	assert.equal(island.props['aria-label'], '会话区提示：alpha会话区有提问');
	assert.ok(textOf(renderer.root.findByProps({ className: 'dnl-now-text dnl-notice-text' })).includes('alpha会话区有提问'),
		'the collapsed pill carries the headline');
	assert.equal(byClass(renderer, 'dnl-dot').length, 0, 'notice mode shows no red dot');
	assert.equal(byClass(renderer, 'dnl-halo').length, 0, 'notice mode shows no breathing halo');
	// hover-expand reveals the full list.
	await act(async () => { island.props.onMouseEnter({}); await flush(); });
	assert.equal(byClass(renderer, 'dnl-notices').length, 1);
	assert.ok(textOf(renderer.root.findByProps({ className: 'dnl-notice-detail' })).includes('要继续吗？'),
		'the expanded list shows the full question preview');
	assert.equal(byClass(renderer, 'dnl-gear').length, 0, 'notice mode has no gear');
	// leaving collapses again (the 420ms grace timer). The panel content stays
	// mounted (grid 0fr collapse is CSS-only), so the contract is the inert
	// wrapper, not the element's disappearance.
	await act(async () => { island.props.onMouseLeave(); await flush(); });
	act(() => { for (const [id, t] of [...timers]) if (t.ms === 420) { timers.delete(id); t.fn(); } });
	const grow = byClass(renderer, 'dnl-grow')[0];
	assert.equal(grow.props['aria-hidden'], 'true', 'the notice list collapses on leave');
	assert.equal(grow.props.inert, '', 'the collapsed panel is inert');

	// the headline follows the newest notice — as a LyricTransition cross-fade:
	// the outgoing layer keeps the old headline while the new layer fades in.
	act(() => firePoll());
	await resolve(idleTurnEnd);
	const headlines = byClass(renderer, 'dnl-notice-text').map(textOf);
	assert.equal(headlines.length, 2, 'the notice change cross-fades');
	assert.ok(headlines.some((text) => text.includes('beta会话区第3轮对话结束')),
		'the pill reports the round ending in the requested wording');
	assert.ok(headlines.some((text) => text.includes('alpha会话区有提问')),
		'the outgoing headline is still fading out');

	// notices cleared while idle → hidden again.
	act(() => firePoll());
	await resolve({ active: false, pollMs: 500 });
	assert.equal(renderer.toJSON(), null, 'idle + no notice hides the island again');

	// ---- SMTC active: only the red dot; click for the full list ----------------
	act(() => firePoll());
	await resolve(trackWithNotice);
	assert.equal(byClass(renderer, 'dnl-dot').length, 1, 'active + notice shows the red dot');
	const island2 = renderer.root.findByProps({ role: 'status' });
	assert.equal(island2.props['aria-label'], '当前歌词：First', 'the lyric aria stays untouched');
	assert.equal(byClass(renderer, 'dnl-notices').length, 0, 'the full list is NOT shown until the dot is clicked');
	await act(async () => { renderer.root.findByProps({ className: 'dnl-dot' }).props.onClick({ stopPropagation() {} }); await flush(); });
	assert.equal(byClass(renderer, 'dnl-notices').length, 1, 'clicking the dot opens the notice list');
	assert.ok(textOf(renderer.root.findByProps({ className: 'dnl-notice-title' })).includes('alpha会话区有提问'));
	assert.equal(byClass(renderer, 'dnl-dot').length, 0, 'the dot hides while the list is open');
	// the gear ✕ returns to lyrics and the dot comes back.
	const gear = renderer.root.findByProps({ 'aria-label': '返回歌词' });
	await act(async () => { gear.props.onClick({ stopPropagation() {} }); await flush(); });
	assert.equal(byClass(renderer, 'dnl-lines').length, 1, 'lyrics view is back');
	assert.equal(byClass(renderer, 'dnl-notices').length, 0);
	assert.equal(byClass(renderer, 'dnl-dot').length, 1, 'the dot returns with the lyrics view');

	// active + no notice → no dot at all.
	act(() => firePoll());
	await resolve({ ...trackWithNotice, notice: undefined });
	assert.equal(byClass(renderer, 'dnl-dot').length, 0, 'no notice, no dot');
} finally {
	if (renderer) await act(async () => { renderer.unmount(); await flush(); });
}
assert.equal([...timers].filter(([, t]) => !t.repeat).length, 0, 'all one-shot timers removed on unmount');

console.log('PASS: workspace notices — idle pill shows the headline (提问/第x轮对话结束), active pill shows only the red dot, click opens the full list, gear returns to lyrics');

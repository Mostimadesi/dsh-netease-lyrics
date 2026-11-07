// Contracts for the workspace-notice surface in lib/client.js:
//
//   - 浮窗未触发 (no SMTC session) + 有提问/轮次结束 → the pill renders the
//     notice headline itself ("xx会话区有提问" / "xx会话区第x轮对话结束"),
//     hover-expand shows the full list; HOVERING also acks, so the pill fades
//     out (not blinks away) once collapsed (the ghost fade).
//   - 浮窗触发 (SMTC active) → a new notice first INSERTS itself into the
//     collapsed row for NOTICE_INSERT_MS (cross-fading in), then hands back to
//     the lyric row and the quiet red dot at the island's bottom-right; the
//     click opens the notice view (leaving acks), the gear ✕ returns to lyrics.
//   - idle + no notice (and no ghost fading) → completely hidden.
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
const posted = [];

vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
	window: {
		__ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => ({ default: React })); } },
		addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
		matchMedia: () => ({ matches: true }), innerWidth: 1200, innerHeight: 800,
	},
	document: undefined, console, AbortController, AbortSignal,
	fetch: (url, options) => new Promise((resolve) => {
		if (String(url).includes('/notice/ack')) {
			posted.push({ url, options });
			resolve({ ok: true, json: async () => ({ ok: true }) });
			return;
		}
		pending.push({ url, options, resolve });
	}),
	Event: class {}, localStorage: { getItem: () => null, setItem() {} },
	setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id; },
	clearTimeout: (id) => timers.delete(id),
	setInterval: (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms, repeat: true }); return id; },
	clearInterval: (id) => timers.delete(id),
});

const routes = new Map();
// The main-view session, switchable between test phases (the DSH client
// runtime's `retainedBy.mainView > 0` signal, faked as a snapshot store).
let mainById = { s1: { id: 's1', retainedBy: { mainView: 1 } } };
const fakeSessions = { list: { getSnapshot: () => ({ byId: mainById }) } };
plugin.apply({ slots: {
	inject: (_, cb) => cb(),
	register: (opts, component) => { routes.set(opts.key || opts.id, component); return () => {}; },
}, get: (name) => (name === 'sessions' ? fakeSessions : undefined) });
const Island = routes.get('dsh-netease-lyrics-island');
const { sanitizeNotices, noticeHeadline, noticeClockLabel, noticeList, mainSessionIdOf, CSS } = plugin.__test;

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
assert.equal(cleaned[0].sessionId, '', 'a missing session id normalizes to empty');
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

// ---- mainSessionIdOf: the client runtime's main-view signal -------------------
assert.equal(mainSessionIdOf(fakeSessions), 's1', 'the retainedBy.mainView row is the main session');
assert.equal(mainSessionIdOf({ list: { getSnapshot: () => ({ byId: {
	s2: { id: 's2', retainedBy: { mainView: 0 } },
	s3: { id: 's3', retainedBy: {} },
} }) } }), null, 'no mainView retain reads as none');
assert.equal(mainSessionIdOf(null), null, 'a missing service reads as none');
assert.equal(mainSessionIdOf({}), null, 'a service without list reads as none');
assert.equal(mainSessionIdOf({ list: { getSnapshot: () => { throw new Error('boom'); } } }), null,
	'a throwing snapshot must never break the island');

// ---- source-shape contracts (a paint-order defect headless cannot see) --------
const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
assert.match(src, /if \(!smtcActive && !noticeMode && !noticeGhost\) return null;/,
	'idle WITHOUT a notice (or ghost) stays hidden — the combined early-return condition');
assert.match(src, /const mainSessionId = mainSessionIdOf\(clientSessions\);[\s\S]{0,300}const notices = mainSessionId === null \? rawNotices[\s\S]{0,80}\.filter\(\(item\) => item\.sessionId !== mainSessionId\);/,
	'notices are filtered by the main-view session BEFORE any early return');
assert.match(src, /try \{ clientSessions = ctx\.get\("sessions"\) \|\| null; \} catch \{ clientSessions = null; \}/,
	'apply() performs the optional sessions lookup defensively');
assert.match(src, /animation:dnl-dot-in \.18s ease-out both,dnl-dot-pulse 2\.6s ease-in-out \.18s infinite/,
	'the dot fades in, then breathes (no popping)');
assert.match(src, /const rawNotices = sanitizeNotices\(st === null \? null : st\.notice\);/,
	'notice mode is derived from the shared poll BEFORE any early return');
// The insert window is render-phase state (the first frame must already
// show the notice row — an effect would paint a frame late, the v0.3.30 lesson).
assert.match(src, /if \(noticeKey !== "" && noticeKey !== noticeKeyRef\.current\) \{[\s\S]{0,200}?setInsertDeadline\(Date\.now\(\) \+ NOTICE_INSERT_MS\);/,
	'a NEW notice while media plays arms the insert window during render');
assert.match(src, /const inserting = smtcActive && insertDeadline > Date\.now\(\) && notices\.length > 0;/,
	'inserting derives from the deadline, not an effect');
// Ack wiring.
assert.match(src, /const NOTICE_ACK_ROUTE = "\/dsh-netease-lyrics\/notice\/ack";/, 'the ack route exists');
assert.match(src, /const ackNotices = \(\) => \{/,
	'hovering the notice pill acknowledges it');
// The dot renders through dotHold so it can fade out instead of blinking away.
assert.match(src, /dotPresent \|\| \(dotHold && smtcActive\)/,
	'the dot stays mounted one fade cycle after its condition clears');
assert.match(src, /className: "dnl-dot" \+ \(dotPresent \? "" : " dnl-dot-out"\)/,
	'the fading dot is tagged for the fade-out animation');
assert.match(CSS, /\.dnl-dot\{[^}]*position:absolute[^}]*right:4px;bottom:4px/,
	'the dot anchors at the island bottom-right');
assert.match(CSS, /\.dnl-dot-out::before\{animation:dnl-dot-out/,
	'the retiring dot runs a fade animation');
assert.match(CSS, /\.dnl-host-fade\{[^}]*animation:dnl-host-out/,
	'the ghost pill host fades before unmounting');
assert.match(CSS, /@media\(prefers-reduced-motion:reduce\)\{\.dnl-dot::before\{animation:none;opacity:\.95\}\.dnl-dot-out::before\{animation:none;opacity:0\}\.dnl-host-fade\{animation:none;opacity:0\}\}/,
	'reduced motion stills the dot pulse (visible, static), retires the fading dot and ghost instantly');
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
// Tolerance: the insert timer is scheduled as (deadline - Date.now()), which
// drifts a few ms below NOTICE_INSERT_MS; 200ms absorbs it.
const fireTimers = (ms, tolerance = 0) => {
	let fired = 0;
	for (const [id, t] of [...timers]) {
		if (t.repeat) continue;
		if (Math.abs(t.ms - ms) > tolerance) continue;
		timers.delete(id); t.fn(); fired += 1;
	}
	return fired;
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
const trackBase = {
	active: true, playing: true, title: 'T', artist: 'A', app: 'test', pollMs: 500,
	durationSec: 100, positionSec: 1, canToggle: true, coverSerial: 0,
	lyric: { status: 'matched', songId: 1, lines: [{ t: 0, text: 'First' }] },
};
const trackWithNotice = { ...trackBase, notice: { serial: 9, items: [
	{ workspace: 'alpha', question: { kind: 'user-question', preview: '要继续吗？', at: 3 }, turnEnd: null },
] } };
const INSERT_MS = 1800, FADE_MS = 260, COLLAPSE_MS = 420;

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

	// the headline follows the newest notice — as a LyricTransition cross-fade:
	// the outgoing layer keeps the old headline while the new layer fades in.
	// (Tested BEFORE the ghost flow: after a fade-out unmount the transition
	// state is gone, and the re-mount is an APPEARANCE, not a switch.)
	act(() => firePoll());
	await resolve(idleTurnEnd);
	const headlines = byClass(renderer, 'dnl-notice-text').map(textOf);
	assert.equal(headlines.length, 2, 'the notice change cross-fades');
	assert.ok(headlines.some((text) => text.includes('beta会话区第3轮对话结束')),
		'the pill reports the round ending in the requested wording');
	assert.ok(headlines.some((text) => text.includes('alpha会话区有提问')),
		'the outgoing headline is still fading out');
	act(() => fireTimers(FADE_MS, 50)); // clear the cross-fade layers

	// hover-expand reveals the full list AND acknowledges (POST /notice/ack).
	posted.length = 0;
	await act(async () => { island.props.onMouseEnter({}); await flush(); });
	assert.equal(byClass(renderer, 'dnl-notices').length, 1);
	assert.equal(posted.length, 1, 'hovering the notice pill acks');
	assert.ok(textOf(renderer.root.findByProps({ className: 'dnl-notice-detail' })).includes('本轮对话已完成'),
		'the expanded list shows the round outcome');
	assert.equal(byClass(renderer, 'dnl-gear').length, 0, 'notice mode has no gear');
	// leaving collapses again (the 420ms grace timer). The panel content stays
	// mounted (grid 0fr collapse is CSS-only), so the contract is the inert
	// wrapper, not the element's disappearance.
	await act(async () => { island.props.onMouseLeave(); await flush(); });
	act(() => fireTimers(COLLAPSE_MS));
	const grow = byClass(renderer, 'dnl-grow')[0];
	assert.equal(grow.props['aria-hidden'], 'true', 'the notice list collapses on leave');
	assert.equal(grow.props.inert, '', 'the collapsed panel is inert');

	// the host cleared the notices (the ack): the ghost pill FADES instead of
	// vanishing — the host element stays one fade cycle, tagged for the fade
	// animation, then unmounts.
	act(() => firePoll());
	await resolve({ active: false, pollMs: 500 });
	const host = renderer.root.findAll((n) => typeof n.type === 'string'
		&& String(n.props.className || '').startsWith('dnl-host'))[0];
	assert.ok(host, 'the ghost pill is still mounted while fading');
	assert.ok(String(host.props.className).includes('dnl-host-fade'),
		'the retiring pill is tagged for the fade-out');
	act(() => fireTimers(FADE_MS, 50));
	assert.equal(renderer.toJSON(), null, 'after the fade the idle island unmounts');

	// ---- SMTC active: the notice INSERTS first, then hands off to the dot -----
	act(() => firePoll());
	await resolve({ ...trackBase, notice: undefined });
	assert.equal(byClass(renderer, 'dnl-notice-text').length, 0, 'lyric row only, no notice row');
	// A notice arriving DURING playback: the first frame already shows the
	// notice row (render-phase insert), the lyric row cross-fades out, and no
	// dot is up yet (the row itself is announcing).
	act(() => firePoll());
	await resolve(trackWithNotice);
	assert.ok(byClass(renderer, 'dnl-notice-text').length >= 1,
		'the notice row inserts into the collapsed pill while media plays');
	assert.equal(byClass(renderer, 'dnl-dot').length, 0, 'no dot during the insert window');
	// After NOTICE_INSERT_MS the row hands back to the lyric (cross-faded) and
	// the dot appears.
	act(() => fireTimers(INSERT_MS, 200));
	assert.ok(byClass(renderer, 'dnl-now-text').some((n) => textOf(n).includes('First')),
		'the lyric row returns after the insert window');
	assert.equal(byClass(renderer, 'dnl-dot').length, 1, 'the dot takes over after the insert window');
	const island2 = renderer.root.findByProps({ role: 'status' });
	assert.equal(island2.props['aria-label'], '当前歌词：First', 'the lyric aria is restored');
	assert.equal(byClass(renderer, 'dnl-notices').length, 0, 'the full list is NOT shown until the dot is clicked');
	// Clicking the dot opens the notice view; the dot FADES OUT under the
	// opening panel (dotPresent flips with the view, dotHold keeps it one
	// fade cycle) — no instant removal.
	await act(async () => { renderer.root.findByProps({ className: 'dnl-dot' }).props.onClick({ stopPropagation() {} }); await flush(); });
	assert.equal(byClass(renderer, 'dnl-notices').length, 1, 'clicking the dot opens the notice list');
	assert.ok(textOf(renderer.root.findByProps({ className: 'dnl-notice-title' })).includes('alpha会话区有提问'));
	const clickedDot = byClass(renderer, 'dnl-dot')[0];
	assert.ok(clickedDot, 'the dot is still mounted while fading under the panel');
	assert.ok(String(clickedDot.props.className).includes('dnl-dot-out'), 'the clicked dot fades out instead of snapping away');
	act(() => fireTimers(FADE_MS, 50));
	assert.equal(byClass(renderer, 'dnl-dot').length, 0, 'the clicked dot unmounts after the fade');
	// Leaving the expanded notice view acks and collapses; the panel stays on
	// the notices view (the gear ✕ is the way back), so no dot while reading.
	posted.length = 0;
	await act(async () => { island2.props.onMouseLeave(); await flush(); });
	act(() => fireTimers(COLLAPSE_MS));
	assert.equal(posted.length, 1, 'leaving the notice view acks the notices');
	// The panel content stays mounted (grid 0fr collapse is CSS-only, and the
	// list keeps its snapshot while reading) — the contract is the inert wrapper.
	assert.equal(byClass(renderer, 'dnl-grow')[0].props['aria-hidden'], 'true', 'the list collapses');
	assert.equal(byClass(renderer, 'dnl-grow')[0].props.inert, '', 'the collapsed panel is inert');
	// The gear ✕ returns to lyrics; with the notices acked the dot does NOT
	// come back (viewing consumed them).
	act(() => firePoll());
	await resolve({ ...trackBase, notice: undefined });
	const gear = renderer.root.findByProps({ 'aria-label': '返回歌词' });
	await act(async () => { gear.props.onClick({ stopPropagation() {} }); await flush(); });
	assert.equal(byClass(renderer, 'dnl-lines').length, 1, 'lyrics view is back');
	assert.equal(byClass(renderer, 'dnl-dot').length, 0, 'an acked notice does not bring the dot back');

	// ---- passive clear: the dot FADES out (stays mounted, tagged) -------------
	act(() => firePoll());
	await resolve({ ...trackBase, notice: { serial: 11, items: [
		{ workspace: 'beta', question: null, turnEnd: { turn: 6, outcome: 'completed', at: 5 } }] } });
	act(() => fireTimers(INSERT_MS, 200));
	assert.equal(byClass(renderer, 'dnl-dot').length, 1, 'the dot is up again after a fresh notice');
	// The host clears it without any user interaction (TTL / settled remotely):
	// the button must fade out instead of blinking away.
	act(() => firePoll());
	await resolve({ ...trackBase, notice: undefined });
	const fadingDot = byClass(renderer, 'dnl-dot')[0];
	assert.ok(fadingDot, 'the dot is still mounted while fading');
	assert.ok(String(fadingDot.props.className).includes('dnl-dot-out'), 'the dot is tagged as fading out');
	assert.equal(fadingDot.props['aria-hidden'], 'true', 'the fading dot is hidden from a11y');
	act(() => fireTimers(FADE_MS, 50));
	assert.equal(byClass(renderer, 'dnl-dot').length, 0, 'the dot unmounts after the fade');

	// ---- main-view session: notices of the conversation the user is IN stay --
	act(() => firePoll());
	await resolve({ ...trackBase, notice: { serial: 12, items: [
		{ sessionId: 's1', workspace: 'gamma', question: null, turnEnd: { turn: 8, outcome: 'completed', at: 6 } }] } });
	act(() => fireTimers(INSERT_MS, 200));
	assert.equal(byClass(renderer, 'dnl-dot').length, 0,
		'the dot does not show for the session the user is currently viewing');
	// Switching AWAY from that session re-shows it (next poll picks the change).
	// The fresh serial arms a new insert window — burn it, then the dot is due.
	mainById = { s2: { id: 's2', retainedBy: { mainView: 1 } } };
	act(() => firePoll());
	await resolve({ ...trackBase, notice: { serial: 13, items: [
		{ sessionId: 's1', workspace: 'gamma', question: null, turnEnd: { turn: 8, outcome: 'completed', at: 6 } }] } });
	act(() => fireTimers(INSERT_MS, 200));
	assert.equal(byClass(renderer, 'dnl-dot').length, 1,
		'switching away from the session brings its notice back');
	// Switching back fades it out again (dotPresent flips false → fade path).
	mainById = { s1: { id: 's1', retainedBy: { mainView: 1 } } };
	act(() => firePoll());
	await resolve({ ...trackBase, notice: { serial: 14, items: [
		{ sessionId: 's1', workspace: 'gamma', question: null, turnEnd: { turn: 8, outcome: 'completed', at: 6 } }] } });
	const backDot = byClass(renderer, 'dnl-dot')[0];
	assert.ok(backDot, 'the dot is still mounted while fading after switching back');
	assert.ok(String(backDot.props.className).includes('dnl-dot-out'), 'switching back tags the dot as fading out');
	act(() => fireTimers(FADE_MS, 50));
	assert.equal(byClass(renderer, 'dnl-dot').length, 0, 'the dot is gone after switching back');

	// active + no notice → no dot at all.
	act(() => firePoll());
	await resolve({ ...trackWithNotice, notice: undefined });
	assert.equal(byClass(renderer, 'dnl-dot').length, 0, 'no notice, no dot');
} finally {
	if (renderer) await act(async () => { renderer.unmount(); await flush(); });
}
assert.equal([...timers].filter(([, t]) => !t.repeat).length, 0, 'all one-shot timers removed on unmount');

console.log('PASS: workspace notices — idle pill shows the headline and fades after ack; active pill inserts the notice then hands off to the quiet dot; dot fades out after viewing');

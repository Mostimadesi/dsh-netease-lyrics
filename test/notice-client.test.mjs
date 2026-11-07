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
const storeMap = new Map();
const audioCalls = [];
class FakeAudioContext {
	constructor() { this.state = "running"; this.currentTime = 0; this.destination = {}; audioCalls.push("ctx"); }
	createGain() {
		audioCalls.push("gain");
		return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
	}
	createOscillator() {
		audioCalls.push("osc");
		return { type: "", frequency: { setValueAtTime() {} }, connect() {}, start() { audioCalls.push("start"); }, stop() {} };
	}
	resume() { audioCalls.push("resume"); return Promise.resolve(); }
}

vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
	window: {
		__ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => ({ default: React })); } },
		addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
		matchMedia: () => ({ matches: true }), innerWidth: 1200, innerHeight: 800,
		AudioContext: FakeAudioContext,
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
	Event: class {},
	localStorage: {
		getItem: (key) => (storeMap.has(key) ? storeMap.get(key) : null),
		setItem: (key, value) => { storeMap.set(key, String(value)); },
	},
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
// Workspace groups, switchable too (the workspaces service's `items`).
let workspaceItems = [
	{ workspaceId: 'w1', sessionIds: ['s1', 's1b'] },
	{ workspaceId: 'w2', sessionIds: ['s2'] },
];
const fakeWorkspaces = { list: { getSnapshot: () => ({ items: workspaceItems }) } };
plugin.apply({ slots: {
	inject: (_, cb) => cb(),
	register: (opts, component) => { routes.set(opts.key || opts.id, component); return () => {}; },
}, get: (name) => (name === 'sessions' ? fakeSessions
	: name === 'workspaces' ? fakeWorkspaces : undefined) });
const Island = routes.get('dsh-netease-lyrics-island');
const { sanitizeNotices, noticeHeadline, noticeClockLabel, noticeList, mainSessionIdOf, workspaceGroupOf,
	readNoticePrefs, expireTurnEnds, CSS } = plugin.__test;

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

// ---- workspaceGroupOf: workspace-level grouping (v0.4.4) -----------------------
{
	const group = workspaceGroupOf(fakeWorkspaces, 's1');
	assert.ok(group !== null, 'the main session resolves to a workspace group');
	assert.ok(group.has('s1') && group.has('s1b'), 'the group covers the whole workspace');
	assert.equal(group.has('s2'), false, 'other workspaces stay out');
	assert.equal(workspaceGroupOf(fakeWorkspaces, 's2').size, 1, 'a single-session workspace groups to itself');
	assert.equal(workspaceGroupOf(fakeWorkspaces, 'zz'), null, 'an unattached session resolves to nothing');
	assert.equal(workspaceGroupOf(null, 's1'), null, 'a missing service reads as nothing');
	assert.equal(workspaceGroupOf({ list: { getSnapshot: () => { throw new Error('boom'); } } }, 's1'), null,
		'a throwing snapshot must never break the island');
}

// ---- v0.4.5: prefs, retention expiry, sanitize memoization -------------------
{
	const PREFS_KEY = 'dsh.netease-lyrics.notice.v1';
	const defaults = readNoticePrefs();
	assert.equal(defaults.enabled, true, 'notices default on');
	assert.equal(defaults.sound, true, 'the chime defaults on');
	assert.equal(defaults.ttlMinutes, 10, 'retention defaults to 10 minutes');
	storeMap.set(PREFS_KEY, JSON.stringify({ enabled: false, sound: false, ttlMinutes: 99 }));
	const p = readNoticePrefs();
	assert.equal(p.enabled, false);
	assert.equal(p.sound, false);
	assert.equal(p.ttlMinutes, 60, 'retention clamps to 60 minutes');
	storeMap.set(PREFS_KEY, '{bad json');
	assert.equal(readNoticePrefs().enabled, true, 'corrupt prefs fall back to defaults');
	storeMap.delete(PREFS_KEY);

	// Retention expiry: old round endings drop; a question keeps its item.
	const now = Date.now();
	const items = [
		{ sessionId: 'a', workspace: 'w', question: null, turnEnd: { turn: 1, outcome: 'completed', at: now - 20 * 60000 } },
		{ sessionId: 'b', workspace: 'w', question: { kind: 'user-question', preview: 'q', at: now }, turnEnd: { turn: 2, outcome: 'completed', at: now - 20 * 60000 } },
		{ sessionId: 'c', workspace: 'w', question: null, turnEnd: { turn: 3, outcome: 'completed', at: now - 1000 } },
	];
	const expired = expireTurnEnds(items, 10, now);
	assert.equal(expired.length, 2, 'the expired ending-only item drops');
	assert.equal(expired[0].sessionId, 'b');
	assert.equal(expired[0].turnEnd, null, 'a question keeps the item but loses the expired ending');
	assert.equal(expired[1].sessionId, 'c', 'a fresh ending stays');

	// sanitize memoization: one payload object -> one array, forever.
	const payload = { items: [{ workspace: 'x', question: null, turnEnd: { turn: 1, outcome: 'completed', at: 1 } }] };
	assert.equal(sanitizeNotices(payload) === sanitizeNotices(payload), true,
		'sanitizeNotices memoizes by payload identity');
}

// ---- source-shape contracts (a paint-order defect headless cannot see) --------
const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
assert.match(src, /if \(!smtcActive && !noticeMode && !noticeGhost\) return null;/,
	'idle WITHOUT a notice (or ghost) stays hidden — the combined early-return condition');
assert.match(src, /const mainGroup = mainSessionId === null \? null[\s\S]{0,150}workspaceGroupOf\(clientWorkspaces, mainSessionId\)[\s\S]{0,900}const notices = mainGroup === null \? freshNotices[\s\S]{0,80}\.filter\(\(item\) => !mainGroup\.has\(item\.sessionId\)\);/,
	'notices are filtered by the WORKSPACE group of the main session BEFORE any early return');
assert.match(src, /postNoticeAck\(\{ sessionIds: Array\.from\(mainGroup\) \}\);/,
	'visiting a workspace posts the scoped ack naming the whole group');
assert.match(src, /try \{ clientWorkspaces = ctx\.get\("workspaces"\) \|\| null; \} catch \{ clientWorkspaces = null; \}/,
	'apply() performs the optional workspaces lookup defensively');
assert.match(src, /try \{ clientSessions = ctx\.get\("sessions"\) \|\| null; \} catch \{ clientSessions = null; \}/,
	'apply() performs the optional sessions lookup defensively');
assert.match(src, /animation:dnl-dot-in \.18s ease-out both,dnl-dot-pulse 2\.6s ease-in-out \.18s infinite/,
	'the dot fades in, then breathes (no popping)');
assert.match(src, /const noticeOn = noticePrefs\.enabled !== false;[\s\S]{0,120}const rawNotices = noticeOn \? sanitizeNotices\(st === null \? null : st\.notice\) : NO_NOTICES;/,
	'notice mode derives from the shared poll BEFORE any early return, gated by the master switch');
// The insert window is render-phase state (the first frame must already
// show the notice row — an effect would paint a frame late, the v0.3.30 lesson).
assert.match(src, /if \(noticeKey !== "" && noticeKey !== noticeKeyRef\.current\) \{[\s\S]{0,200}?setInsertDeadline\(Date\.now\(\) \+ NOTICE_INSERT_MS\);/,
	'a NEW notice while media plays arms the insert window during render');
assert.match(src, /const inserting = smtcActive && insertDeadline > Date\.now\(\) && notices\.length > 0;/,
	'inserting derives from the deadline, not an effect');
assert.match(src, /const polledBefore = everPolledRef\.current;[\s\S]{0,400}if \(smtcActive && polledBefore\) setInsertDeadline/,
	'the insert window never arms on the cold-mount poll (replay suppression)');
assert.match(src, /if \(noticeRowShown && !expanded\) ackNotices\(\);/,
	'hover-ack only fires while the notice row is actually on screen');
// Ack wiring.
assert.match(src, /const NOTICE_ACK_ROUTE = "\/dsh-netease-lyrics\/notice\/ack";/, 'the ack route exists');
// v0.4.5: arrival chime + retention + master switch + memoization.
assert.match(src, /function playNoticeChime\(\) \{/, 'the synthesized arrival chime exists');
assert.match(src, /const soundOn = noticeOn && noticePrefs\.sound !== false;[\s\S]{0,300}playNoticeChime\(\);/,
	'the chime plays from the arrival effect');
assert.match(src, /expireTurnEnds\(rawNotices, noticePrefs\.ttlMinutes, Date\.now\(\)\)/,
	'the retention setting expires round endings');
assert.match(src, /const noticeOn = noticePrefs\.enabled !== false;/,
	'the master switch gates the whole notice derivation');
assert.match(src, /const noticeSanitizeCache = new WeakMap\(\);/,
	'sanitizeNotices is memoized by payload identity');
assert.match(src, /settingsGroup\("会话区提示"/, 'the settings page exposes the notice group');
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
		{ workspace: 'beta', question: null, turnEnd: { turn: 3, outcome: 'completed', at: Date.now() - 1000 } },
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
const INSERT_MS = 4000, FADE_MS = 260, COLLAPSE_MS = 420;

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
		{ workspace: 'beta', question: null, turnEnd: { turn: 6, outcome: 'completed', at: Date.now() - 1000 } }] } });
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

	// ---- hover-ack gating (v0.4.3): lyric hover must NOT consume notices -----
	const island3 = renderer.root.findByProps({ role: 'status' });
	posted.length = 0;
	await act(async () => { island3.props.onMouseEnter({}); await flush(); });
	assert.equal(posted.length, 0, 'hovering the LYRIC capsule does not ack unseen notices');
	assert.equal(byClass(renderer, 'dnl-grow')[0].props['aria-hidden'], undefined, 'the lyric panel opened for reading');
	// Hovering DURING the insert window DOES count: the headline is on screen.
	act(() => firePoll());
	await resolve({ ...trackBase, notice: { serial: 15, items: [
		{ workspace: 'beta', question: null, turnEnd: { turn: 9, outcome: 'completed', at: Date.now() - 1000 } }] } });
	assert.ok(byClass(renderer, 'dnl-notice-text').length >= 1, 'a fresh notice inserts while media plays');
	await act(async () => { island3.props.onMouseLeave(); await flush(); });
	act(() => fireTimers(COLLAPSE_MS));
	posted.length = 0;
	await act(async () => { island3.props.onMouseEnter({}); await flush(); });
	assert.equal(posted.length, 1, 'hovering during the insert window acks (the headline was visible)');

	// ---- main-view session: notices of the conversation the user is IN stay --
	act(() => firePoll());
	await resolve({ ...trackBase, notice: { serial: 12, items: [
		{ sessionId: 's1', workspace: 'gamma', question: null, turnEnd: { turn: 8, outcome: 'completed', at: Date.now() - 1000 } }] } });
	act(() => fireTimers(INSERT_MS, 200));
	assert.equal(byClass(renderer, 'dnl-dot').length, 0,
		'the dot does not show for the session the user is currently viewing');
	// Switching AWAY from that session re-shows it (next poll picks the change).
	// The fresh serial arms a new insert window — burn it, then the dot is due.
	mainById = { s2: { id: 's2', retainedBy: { mainView: 1 } } };
	act(() => firePoll());
	await resolve({ ...trackBase, notice: { serial: 13, items: [
		{ sessionId: 's1', workspace: 'gamma', question: null, turnEnd: { turn: 8, outcome: 'completed', at: Date.now() - 1000 } }] } });
	act(() => fireTimers(INSERT_MS, 200));
	assert.equal(byClass(renderer, 'dnl-dot').length, 1,
		'switching away from the session brings its notice back');
	// Switching back fades it out again (dotPresent flips false → fade path).
	mainById = { s1: { id: 's1', retainedBy: { mainView: 1 } } };
	act(() => firePoll());
	await resolve({ ...trackBase, notice: { serial: 14, items: [
		{ sessionId: 's1', workspace: 'gamma', question: null, turnEnd: { turn: 8, outcome: 'completed', at: Date.now() - 1000 } }] } });
	const backDot = byClass(renderer, 'dnl-dot')[0];
	assert.ok(backDot, 'the dot is still mounted while fading after switching back');
	assert.ok(String(backDot.props.className).includes('dnl-dot-out'), 'switching back tags the dot as fading out');
	act(() => fireTimers(FADE_MS, 50));
	assert.equal(byClass(renderer, 'dnl-dot').length, 0, 'the dot is gone after switching back');

	// ---- workspace-level grouping (v0.4.4): the mis-reported case ------------
	// A DIFFERENT session of the SAME workspace (the blank conversation DSH
	// lands on when you click the workspace row) hides it too — and the visit
	// consumes the round ending host-side via a scoped ack.
	posted.length = 0;
	act(() => firePoll());
	await resolve({ ...trackBase, notice: { serial: 16, items: [
		{ sessionId: 's1b', workspace: 'gamma', question: null, turnEnd: { turn: 15, outcome: 'completed', at: Date.now() - 1000 } }] } });
	assert.equal(byClass(renderer, 'dnl-dot').length, 0,
		'a notice from another conversation of the viewed workspace is hidden');
	assert.equal(posted.length, 1, 'entering the workspace acks its round endings');
	const scopedBody = JSON.parse(posted[0].options.body);
	assert.ok(Array.isArray(scopedBody.sessionIds), 'the scoped ack names session ids');
	assert.ok(scopedBody.sessionIds.includes('s1') && scopedBody.sessionIds.includes('s1b'),
		'the scoped ack names the whole workspace session group');
	// A QUESTION in the visited workspace is never consumed — no ack fires.
	posted.length = 0;
	act(() => firePoll());
	await resolve({ ...trackBase, notice: { serial: 17, items: [
		{ sessionId: 's1b', workspace: 'gamma', question: { kind: 'user-question', preview: 'q', at: 12 }, turnEnd: null }] } });
	assert.equal(byClass(renderer, 'dnl-dot').length, 0, 'a question from the viewed workspace stays hidden');
	assert.equal(posted.length, 0, 'a question is never acked by visiting');

	// active + no notice → no dot at all.
	act(() => firePoll());
	await resolve({ ...trackWithNotice, notice: undefined });
	assert.equal(byClass(renderer, 'dnl-dot').length, 0, 'no notice, no dot');
} finally {
	if (renderer) await act(async () => { renderer.unmount(); await flush(); });
}
assert.equal([...timers].filter(([, t]) => !t.repeat).length, 0, 'all one-shot timers removed on unmount');

// ---- v0.4.5: master switch, retention TTL, arrival chime ----------------------
{
	const PREFS_KEY = 'dsh.netease-lyrics.notice.v1';
	let r3;
	try {
		// Master switch OFF: every surface is gone; no chime.
		storeMap.set(PREFS_KEY, JSON.stringify({ enabled: false }));
		audioCalls.length = 0;
		act(() => { r3 = TestRenderer.create(React.createElement(Island)); });
		await resolve({ active: false, pollMs: 500, notice: { serial: 30, items: [
			{ workspace: 'beta', question: null, turnEnd: { turn: 20, outcome: 'completed', at: Date.now() - 1000 } }] } });
		assert.equal(r3.toJSON(), null, 'master switch off hides the notice pill entirely');
		assert.equal(audioCalls.length, 0, 'master switch off plays no chime');
		await act(async () => { r3.unmount(); await flush(); });
		storeMap.delete(PREFS_KEY);

		// Defaults back on: the COLD poll with a standing notice plays nothing
		// (a remount is not an arrival); a genuine arrival chimes once; a rapid
		// follow-up is cooldown-suppressed; an expired ending drops the pill.
		audioCalls.length = 0;
		act(() => { r3 = TestRenderer.create(React.createElement(Island)); });
		await resolve({ active: false, pollMs: 500, notice: { serial: 31, items: [
			{ workspace: 'beta', question: null, turnEnd: { turn: 21, outcome: 'completed', at: Date.now() - 1000 } }] } });
		assert.ok(r3.toJSON() !== null, 'the standing notice shows on the cold poll');
		assert.equal(audioCalls.filter((c) => c === 'start').length, 0,
			'no chime on the cold mount (not an arrival)');
		act(() => firePoll());
		await resolve({ active: false, pollMs: 500, notice: { serial: 32, items: [
			{ workspace: 'alpha', question: { kind: 'user-question', preview: 'p', at: Date.now() }, turnEnd: null }] } });
		assert.equal(audioCalls.filter((c) => c === 'start').length, 1,
			'a genuine arrival plays the chime exactly once');
		act(() => firePoll());
		await resolve({ active: false, pollMs: 500, notice: { serial: 33, items: [
			{ workspace: 'beta', question: null, turnEnd: { turn: 22, outcome: 'completed', at: Date.now() - 1000 } }] } });
		assert.equal(audioCalls.filter((c) => c === 'start').length, 1,
			'the cooldown suppresses a rapid second chime');
		act(() => firePoll());
		await resolve({ active: false, pollMs: 500, notice: { serial: 34, items: [
			{ workspace: 'beta', question: null, turnEnd: { turn: 23, outcome: 'completed', at: Date.now() - 20 * 60000 } }] } });
		// With the ending expired the notice set is EMPTY: only the ghost fade
		// holds the island. Had the TTL not applied, the notice would persist
		// and the island would stay — so "gone after the fade" IS the TTL proof.
		act(() => fireTimers(FADE_MS, 50));
		assert.equal(r3.toJSON(), null, 'an expired round ending (retention TTL) lets the pill retire');
	} finally {
		if (r3) await act(async () => { r3.unmount(); await flush(); });
		storeMap.delete(PREFS_KEY);
	}
	assert.equal([...timers].filter(([, t]) => !t.repeat).length, 0, 'prefs block leaves no timers');
}

// ---- cold-mount replay suppression (v0.4.3): refresh/hot-reload while media
// plays with a standing notice must go STRAIGHT to the dot — no 4s insert
// replay of an already-seen notice on every remount.
{
	let r2;
	try {
		act(() => { r2 = TestRenderer.create(React.createElement(Island)); });
		await resolve({ ...trackBase, notice: { serial: 20, items: [
			{ workspace: 'beta', question: null, turnEnd: { turn: 12, outcome: 'completed', at: Date.now() - 1000 } }] } });
		assert.equal(byClass(r2, 'dnl-dot').length, 1,
			'cold mount with playing media + standing notice goes straight to the dot');
		assert.equal(byClass(r2, 'dnl-notice-text').length, 0, 'no insert replay on cold mount');
		const insertTimerPending = [...timers.values()].some((t) => !t.repeat && Math.abs(t.ms - INSERT_MS) <= 200);
		assert.equal(insertTimerPending, false, 'no insert window timer scheduled on cold mount');
		// A genuinely NEW notice after the mount still inserts.
		act(() => firePoll());
		await resolve({ ...trackBase, notice: { serial: 21, items: [
			{ workspace: 'beta', question: null, turnEnd: { turn: 13, outcome: 'completed', at: Date.now() - 1000 } }] } });
		assert.ok(byClass(r2, 'dnl-notice-text').length >= 1, 'post-mount arrivals still insert');
		act(() => fireTimers(INSERT_MS, 200));
		assert.equal(byClass(r2, 'dnl-dot').length, 1, 'the hand-off works after a post-mount insert');
	} finally {
		if (r2) await act(async () => { r2.unmount(); await flush(); });
	}
	assert.equal([...timers].filter(([, t]) => !t.repeat).length, 0, 'cold-mount block leaves no timers');
}

console.log('PASS: workspace notices — idle pill shows the headline and fades after ack; active pill inserts the notice (4 s) then hands off to the quiet dot; lyric hover never acks, insert hover does; cold mounts skip the replay');

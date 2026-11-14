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
const gainTargets = [];
class FakeAudioContext {
	constructor() { this.state = "running"; this.currentTime = 0; this.destination = {}; audioCalls.push("ctx"); }
	createGain() {
		audioCalls.push("gain");
		return {
			gain: {
				setValueAtTime() {},
				linearRampToValueAtTime(value) { gainTargets.push(Number(value)); },
				exponentialRampToValueAtTime() {},
			},
			connect() {},
		};
	}
	createOscillator() {
		audioCalls.push("osc");
		return { type: "", frequency: { setValueAtTime() {} }, connect() {}, start() { audioCalls.push("start"); }, stop() {} };
	}
	resume() { audioCalls.push("resume"); return Promise.resolve(); }
}

let windowCtx = null;
let vmEvent = null;
const windowListeners = new Map();
vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
	window: {
		__ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => ({ default: React })); } },
		addEventListener(name, fn) {
			const list = windowListeners.get(name) ?? (windowListeners.set(name, []), windowListeners.get(name));
			list.push(fn);
		},
		removeEventListener(name, fn) {
			const list = windowListeners.get(name);
			if (list) { const at = list.indexOf(fn); if (at >= 0) list.splice(at, 1); }
		},
		dispatchEvent(event) {
			for (const fn of windowListeners.get(event.type) ?? []) {
				try { fn(event); } catch { /* listener errors are contained */ }
			}
			return true;
		},
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
	Event: class {
		constructor(type) { this.type = type; }
	},
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
	readNoticePrefs, expireTurnEnds, readDisplay, CSS } = plugin.__test;

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
assert.equal(noticeHeadline({ workspace: 'gamma', question: null, turnEnd: { turn: 4, outcome: 'error', at: 1 } }),
	'gamma会话区第4轮对话出错',
	'an errored round gets its own alarm headline (v0.4.53)');
assert.equal(noticeHeadline({ workspace: 'g2', question: null, turnEnd: { turn: 5, outcome: 'aborted', at: 1 } }),
	'g2会话区第5轮对话结束',
	'non-error outcomes keep the plain 结束 headline');
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

// ---- v0.4.8a: the skin read whitelist must cover EVERY skin the select can
// write. v0.4.8 shipped with frosted/solid only, so picking 静谧祝愿/暗夜余烬
// in the gear view persisted the value but readDisplay filtered it back out
// and the select snapped to 默认 — the user's "switching does nothing" report.
// v0.4.9 did it AGAIN (forgot arknights/persona), so the whitelist is now
// SKIN_IDS itself — this loop enumerates the constant's members so a future
// skin added to SKIN_IDS is automatically covered here.
{
	const DISPLAY_KEY = 'dsh.netease-lyrics.display.v1';
	for (const skin of ['frosted', 'solid', 'wishes', 'ember', 'arknights', 'persona']) {
		storeMap.set(DISPLAY_KEY, JSON.stringify({ capsuleStyle: skin }));
		assert.equal(readDisplay().capsuleStyle, skin,
			'readDisplay keeps the ' + skin + ' skin (round-trip)');
	}
	storeMap.set(DISPLAY_KEY, JSON.stringify({ capsuleStyle: 'not-a-skin' }));
	assert.equal(readDisplay().capsuleStyle, undefined, 'unknown skin values still drop');
	storeMap.delete(DISPLAY_KEY);
}


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
assert.match(src, /const lateRoundEnd = \(\(\) => \{[\s\S]{0,600}leftGroup\.has\(item\.sessionId\)[\s\S]{0,200}return item;/,
	'v0.4.54 gap fix: an ending that ENDED before the user left the group is consumed on arrival');
assert.match(src, /leftGroupRef\.current = null;[\s\S]{0,80}leftAtRef\.current = 0;/,
	'the late-ack memory clears after one consumption');
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
// v0.4.6: configurable sound, burst halo, capsule skins.
assert.match(src, /const NOTICE_SOUNDS = \[/, 'the four sound presets exist');
assert.match(src, /function playNoticeSound\(style, repeats, volume\) \{/,
	'the sound dispatcher takes style/repeats/volume');
assert.match(src, /playNoticeSound\(noticePrefs\.soundStyle, noticePrefs\.soundRepeats, noticePrefs\.soundVolume\)/,
	'the arrival effect plays the configured sound');
assert.match(src, /glowMode === "notice" \? noticeRowShown : !noticeMode/,
	'notice glow lights only while a notice row shows');
assert.doesNotMatch(src, /\.dnl-halo-burst\{transform:scale/,
	'the burst halo no longer magnifies (it read as a detached glow ring)');
assert.match(src, /\.dnl-halo-burst\{opacity:1\}/,
	'the burst halo still shows at full strength');
assert.match(src, /"notice", "仅通知到达时"/, 'the glow select offers the notice mode');
assert.match(src, /\.dnl-style-frosted,\.dnl-style-frosted\.dnl-expanded\{/, 'the frosted skin exists');
// v0.4.7/v0.4.8: the frosted skin IS the gradient glass — three signals the
// default pill lacks (a duotone gradient ring via a border-box layer, a
// diagonal brand tint, and an SVG feTurbulence grain), and v0.4.8 moved the
// grain/tint to ::before/::after overlays driven by user CSS variables.
// Guards a regression back to "heavier blur only".
assert.match(src, /\.dnl-style-frosted::before\{background-image:url\(\\?"data:image\/svg\+xml,[\s\S]*?\\?"\);opacity:var\(--dnl-gg-grain,\.3\)\}/,
	'the film grain rides the ::before overlay driven by the grain knob');
assert.match(src, /\.dnl-style-frosted::after\{background-image:linear-gradient[\s\S]*?var\(--dnl-gg-accent,#8b7cff\)[\s\S]*?opacity:var\(--dnl-gg-tint,\.35\)\}/,
	'the brand/violet tint rides the ::after overlay driven by the tint knob');
assert.match(src, /background-clip:border-box;background-origin:border-box/,
	'the gradient ring rides a border-box layer');
assert.match(src, /color-mix\(in srgb,var\(--dsw-alias-brand-primary\) calc\(var\(--dnl-gg-ring,70\) \* 0\.75%\),#0b0b2a\)/,
	'the ring flows into a deep brand corner, brightness scaled by the ring knob');
assert.match(src, /\.dnl-style-solid\{/, 'the solid skin exists');
// v0.4.8: the two wallpaper-derived presets.
assert.match(src, /\.dnl-style-wishes,[\s\S]{0,300}#cfd4ff 65%[\s\S]{0,160}#5b67d8 65%/,
	'the wishes preset carries its lavender→periwinkle ring');
assert.match(src, /\.dnl-style-ember,[\s\S]{0,1200}#2a0f08 58%[\s\S]{0,200}#0d0705 90%/,
	'the ember preset carries its charcoal bed (v3: near-black + a whisper of dark red)');
assert.match(src, /"wishes", "静谧祝愿（紫蓝柔光）"/, 'the style select offers the wishes preset');
assert.match(src, /"ember", "暗夜余烬（炭火余温）"/, 'the style select offers the ember preset');
assert.match(src, /GLASS_ACCENTS = \[/, 'the companion-colour palette exists');
assert.match(src, /const soundOn = noticeOn && noticePrefs\.sound !== false;[\s\S]{0,400}playNoticeSound\(/,
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
// v0.4.53: an errored round is a THIRD notice class — own headline (出错),
// own pill icon (⚠), own red-tinted row (dnl-notice-row-e / dnl-notice-now-e).
const idleTurnError = {
	active: false, pollMs: 500,
	notice: { serial: 10, items: [
		{ workspace: 'gamma', question: null, turnEnd: { turn: 4, outcome: 'error', at: Date.now() - 1000 } },
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

	// ---- v0.4.54 poll-gap fix: switch lands BEFORE the turnEnd arrives -------
	// The round ends while the user watches s1's workspace, but the client
	// only learns of it on the NEXT poll. If the user switches to s2 inside
	// that gap, the old code acked only the CURRENT (s2) group — the s1
	// ending was never consumed and re-showed on every later switch away.
	// The fix acks prevGroup ∪ currentGroup; this sequence reproduces it.
	mainById = { s1: { id: 's1', retainedBy: { mainView: 1 } } };
	// A poll while watching s1 that carries NO s1 notice (the round has not
	// ended yet — nothing to ack; the ref must NOT roll anywhere).
	posted.length = 0;
	act(() => firePoll());
	await resolve({ ...trackBase, notice: { serial: 18, items: [] } });
	assert.equal(posted.length, 0, 'no ack when the watched workspace has no pending ending');
	// The round ENDS host-side (folded), but the user switches away BEFORE
	// the next poll delivers it: the switch render sees no turnEnd at all.
	mainById = { s2: { id: 's2', retainedBy: { mainView: 1 } } };
	act(() => firePoll());
	await resolve({ ...trackBase, notice: { serial: 19, items: [] } });
	assert.equal(posted.length, 0, 'the switch itself posts nothing (the ending has not arrived)');
	// NOW the next poll carries the s1 ending. scopedRoundEnd flips true and
	// the ack must cover BOTH groups — the s1 the round belongs to and the
	// s2 the user has meanwhile landed on.
	act(() => firePoll());
	await resolve({ ...trackBase, notice: { serial: 20, items: [
		{ sessionId: 's1', workspace: 'gamma', question: null, turnEnd: { turn: 21, outcome: 'completed', at: Date.now() - 1000 } }] } });
	assert.equal(posted.length, 1, 'the late-arriving ending is acked');
	const unionBody = JSON.parse(posted[0].options.body);
	assert.ok(unionBody.sessionIds.includes('s1') && unionBody.sessionIds.includes('s1b'),
		'the ack covers the PREVIOUS workspace group (where the round ended)');
	// Deliberately scoped to the LEFT group only: the current group has no
	// pending ending here, and the regular scopedRoundEnd branch handles that
	// case; scope-creeping into never-visited sessions would be wrong.
	// And the stale ending does NOT re-show as a dot: s1 is not the viewed
	// workspace anymore, so the pill/dot is the correct surface — but a
	// switch BACK to s1 must find nothing (host consumed it). Simulated by
	// the host dropping the item after the ack: next poll it is gone.
	act(() => firePoll());
	await resolve({ ...trackBase, notice: { serial: 21, items: [] } });
	mainById = { s1: { id: 's1', retainedBy: { mainView: 1 } } };
	act(() => firePoll());
	await resolve({ ...trackBase, notice: { serial: 22, items: [] } });
	assert.equal(byClass(renderer, 'dnl-dot').length, 0, 'after the union ack, switching back shows no resurrected dot');

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
		assert.equal(audioCalls.filter((c) => c === 'start').length, 2,
			'a genuine arrival plays the default ding pattern (two tones)');
		act(() => firePoll());
		await resolve({ active: false, pollMs: 500, notice: { serial: 33, items: [
			{ workspace: 'beta', question: null, turnEnd: { turn: 22, outcome: 'completed', at: Date.now() - 1000 } }] } });
		assert.equal(audioCalls.filter((c) => c === 'start').length, 2,
			'the cooldown suppresses a rapid second pattern');
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

// ---- v0.4.6: custom sound (style / repeats / volume) ---------------------------
{
	const PREFS_KEY = 'dsh.netease-lyrics.notice.v1';
	let r4;
	try {
		// pulse × 3 repeats at volume 8: three tones per pattern, three
		// pre-scheduled patterns on the audio clock, per-tone gain 0.48.
		storeMap.set(PREFS_KEY, JSON.stringify({ soundStyle: 'pulse', soundRepeats: 3, soundVolume: 8 }));
		audioCalls.length = 0; gainTargets.length = 0;
		act(() => { r4 = TestRenderer.create(React.createElement(Island)); });
		await resolve({ active: false, pollMs: 500 });
		act(() => firePoll());
		await resolve({ active: false, pollMs: 500, notice: { serial: 40, items: [
			{ workspace: 'beta', question: null, turnEnd: { turn: 30, outcome: 'completed', at: Date.now() - 1000 } }] } });
		assert.equal(audioCalls.filter((c) => c === 'start').length, 9,
			'pulse × 3 repeats schedules all nine tones up front');
		assert.ok(gainTargets.some((v) => Math.abs(v - 0.48) < 0.001),
			'volume level 8 drives the per-tone gain (8 × 0.06)');
	} finally {
		if (r4) await act(async () => { r4.unmount(); await flush(); });
		storeMap.delete(PREFS_KEY);
	}
	assert.equal([...timers].filter(([, t]) => !t.repeat).length, 0, 'sound block leaves no timers');
}

// ---- v0.4.6: halo 仅通知到达时 + capsule skins --------------------------------
{
	const DISPLAY_KEY = 'dsh.netease-lyrics.display.v1';
	const islandOf = (r) => r.root.findAll((n) => typeof n.type === 'string'
		&& String(n.props.className || '').startsWith('dnl-island'))[0];
	let r5;
	try {
		storeMap.set(DISPLAY_KEY, JSON.stringify({ glow: 'notice' }));
		act(() => { r5 = TestRenderer.create(React.createElement(Island)); });
		// Playing with no notice: dark.
		await resolve({ ...trackBase, notice: undefined });
		assert.equal(byClass(r5, 'dnl-halo').length, 0, 'notice glow: no halo during plain playback');
		// A notice arrives → insert window → burst halo while the notice row shows.
		act(() => firePoll());
		await resolve(trackWithNotice);
		assert.ok(byClass(r5, 'dnl-halo-burst').length === 1, 'the burst halo shows during the insert window');
		act(() => fireTimers(INSERT_MS, 200));
		assert.equal(byClass(r5, 'dnl-halo').length, 0,
			'the burst goes dark once the notice row hands off to the dot');
		await act(async () => { r5.unmount(); await flush(); });
		// The idle notice pill glows too; the solid skin rides the island class.
		storeMap.set(DISPLAY_KEY, JSON.stringify({ glow: 'notice', capsuleStyle: 'solid' }));
		act(() => { r5 = TestRenderer.create(React.createElement(Island)); });
		await resolve({ active: false, pollMs: 500, notice: { serial: 41, items: [
			{ workspace: 'beta', question: null, turnEnd: { turn: 31, outcome: 'completed', at: Date.now() - 1000 } }] } });
		assert.ok(byClass(r5, 'dnl-halo-burst').length === 1, 'the idle notice pill glows');
		assert.ok(String(islandOf(r5).props.className).includes('dnl-style-solid'),
			'the solid skin class is applied to the island');
	} finally {
		if (r5) await act(async () => { r5.unmount(); await flush(); });
		storeMap.delete(DISPLAY_KEY);
	}
	assert.equal([...timers].filter(([, t]) => !t.repeat).length, 0, 'halo block leaves no timers');
}

// ---- v0.4.8a regression: the gear settings view must survive the gradient
// glass skin. The tuning block references `notice`/`saveNotice`, which live
// in BundleSettings' scope — v0.4.8 shipped without passing them into
// capsuleSettings, so clicking the gear on a frosted island threw
// ReferenceError and React unmounted the WHOLE capsule (the user's
// "the capsule vanished after clicking the gear" report).
{
	const DISPLAY_KEY = 'dsh.netease-lyrics.display.v1';
	storeMap.set(DISPLAY_KEY, JSON.stringify({ capsuleStyle: 'frosted' }));
	let r6;
	try {
		act(() => { r6 = TestRenderer.create(React.createElement(Island)); });
		// Playback mode: the gear lives in the lyrics panel. The standing
		// notice shows as the dot only (no interference with the gear path).
		await resolve({ ...trackBase, notice: undefined });
		const island6 = r6.root.findByProps({ role: 'status' });
		await act(async () => { island6.props.onMouseEnter({}); await flush(); });
		// Opening the settings view must not throw; the tuning knobs must be
		// there and adjustable.
		await act(async () => { r6.root.findByProps({ 'aria-label': '歌词胶囊设置' }).props.onClick({ stopPropagation() {} }); await flush(); });
		const grain = r6.root.findByProps({ 'aria-label': '渐变玻璃颗粒强度' });
		const tint = r6.root.findByProps({ 'aria-label': '渐变玻璃罩染强度' });
		const accent = r6.root.findByProps({ 'aria-label': '渐变玻璃伴侣色' });
		assert.ok(grain && tint && accent, 'the glass tuning block renders in the gear view');
		await act(async () => {
			grain.props.onChange({ target: { value: String(55) } });
			await flush();
		});
		assert.equal(JSON.parse(storeMap.get('dsh.netease-lyrics.notice.v1')).glassGrain, 55,
			'the grain knob persists through the gear view');
		await act(async () => { island6.props.onMouseLeave(); await flush(); });
		act(() => fireTimers(COLLAPSE_MS));
		assert.ok(r6.toJSON() !== null, 'the capsule survives the whole gear interaction');
	} finally {
		if (r6) await act(async () => { r6.unmount(); await flush(); });
		storeMap.delete(DISPLAY_KEY);
		storeMap.delete('dsh.netease-lyrics.notice.v1');
	}
}

// ---- v0.4.9a regression: the decor overlay must actually RENDER its spans.
// v0.4.9 shipped a blanket `.dnl-island>*` position:relative rule that caught
// .dnl-decor itself, collapsing the absolutely-positioned layer into a
// 0-height block the overflow:hidden clipped into nothing — the user saw "no
// effect on any skin". The spans must exist in the tree on a glass skin and
// be absent on the opaque ones.
{
	const PREFS_KEY = 'dsh.netease-lyrics.notice.v1';
	let r7;
	try {
		storeMap.set(PREFS_KEY, JSON.stringify({ decor: 'rain' }));
		act(() => { r7 = TestRenderer.create(React.createElement(Island)); });
		await resolve({ ...trackBase, notice: undefined });
		assert.ok(r7.root.findAll((n) => String(n.props.className || '').includes('dnl-decor-rain')).length === 1,
			'the rain decor layer renders on the default glass skin');
		assert.ok(r7.root.findAll((n) => String(n.props.className || '').includes('dnl-decor-streak')).length === 4,
			'the four rain streaks render');
		// arknights has its own framing — decor is gated off there.
		// The switch goes through the SAME path the gear select uses:
		// writeDisplay (store + DISPLAY_EVENT) — a bare storeMap.set never
		// notifies useDisplay, which is exactly why an earlier draft of this
		// assert saw a stale tree.
		storeMap.set('dsh.netease-lyrics.display.v1', JSON.stringify({ capsuleStyle: 'arknights' }));
		// The switch goes through the SAME path the gear select uses:
		// writeDisplay = store write + DISPLAY_EVENT → useDisplay refreshes.
		// (A bare storeMap.set never notifies the hook — the earlier draft of
		// this assert saw a stale tree for exactly that reason.)
		windowListeners.get('dsh-netease-lyrics-display').forEach((fn) => fn({ type: 'dsh-netease-lyrics-display' }));
		await act(async () => { await flush(); });
		const arkDecors = r7.root.findAll((n) => String(n.props.className || '').includes('dnl-decor'));
		const arkIsland = r7.root.findAll((n) => String(n.props.className || '').startsWith('dnl-island'))[0];
		// 9 = 4 rain streaks + 4 droplets + the layer itself (v0.4.14 added a
		// fourth droplet for a less mechanical cadence).
		assert.ok(arkDecors.length === 9 && String(arkIsland.props.className).includes('dnl-style-arknights'),
			'the decor layer is now ALLOWED on arknights (v0.4.9c) and rides the skin');
	} finally {
		if (r7) await act(async () => { r7.unmount(); await flush(); });
		storeMap.delete(PREFS_KEY);
		storeMap.delete('dsh.netease-lyrics.display.v1');
	}
}

// ---- v0.4.10b: the island holds through the SMTC grace window. A track
// change can flip active:false for a poll or two (session teardown /
// Closed status); one such tick used to unmount the whole capsule.
{
	const graceTimeouts = () => [...timers].filter(([, t]) => t.ms === 3000);
	let r8;
	try {
		act(() => { r8 = TestRenderer.create(React.createElement(Island)); });
		await resolve({ ...trackBase });
		assert.ok(r8.toJSON() !== null, 'playing media mounts the island');
		// One inactive poll: within the grace the island STAYS. (firePoll
		// between resolves: each resolve() consumes the pending fetch; a new
		// request only exists after the poll timer fires.)
		act(() => firePoll());
		await resolve({ active: false, pollMs: 500 });
		assert.ok(r8.toJSON() !== null, 'one inactive poll does not unmount (grace holds)');
		assert.ok(graceTimeouts().length >= 1, 'the grace expiry timer is scheduled');
		// Fire the grace expiry; the next inactive poll retires the island.
		for (const [, t] of graceTimeouts()) t.fn();
		await act(async () => { await flush(); });
		act(() => firePoll());
		await resolve({ active: false, pollMs: 500 });
		assert.equal(r8.toJSON(), null, 'after the grace the island retires');
		// Media returning re-arms the grace.
		act(() => firePoll());
		await resolve({ ...trackBase });
		assert.ok(r8.toJSON() !== null, 'media returning remounts');
	} finally {
		if (r8) await act(async () => { r8.unmount(); await flush(); });
	}
}
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

// ---- v0.4.19: the 雨后玻璃 (rainv2) preset renders its own span set on the
// glass skins (3 rain-silk streaks + density beads + 4 full-pane sliders + 8
// daughter remnants), the knob variables live on the decor element itself, and
// the density knob changes the rendered bead count.
{
	const PREFS_KEY = 'dsh.netease-lyrics.notice.v1';
	let r9;
	try {
		storeMap.set(PREFS_KEY, JSON.stringify({ decor: 'rainv2' }));
		act(() => { r9 = TestRenderer.create(React.createElement(Island)); });
		await resolve({ ...trackBase, notice: undefined });
		assert.ok(r9.root.findAll((n) => String(n.props.className || '').includes('dnl-decor-rainv2')).length === 1,
			'the rainv2 decor layer renders on the default glass skin');
		// v0.4.25 (m02406): the collapsed pill keeps the FULL set mounted and
		// fades non-survivors out via dnl-decor-hide (default decorCollapse 25%
		// of density 7 → 2 top-hanging beads + one streak + one slider visible).
		const clsOf = (n) => String(n.props.className || '');
		const hidden = (what) => r9.root.findAll((n) => clsOf(n).includes(what) && clsOf(n).includes('dnl-decor-hide')).length;
		assert.ok(r9.root.findAll((n) => clsOf(n).includes('dnl-decor-streak')).length === 3,
			'collapsed: all three streaks stay mounted');
		assert.equal(hidden('dnl-decor-streak'), 2, 'collapsed: two streaks carry the hide class');
		assert.ok(r9.root.findAll((n) => clsOf(n).includes('dnl-decor-drop')).length === 11,
			'collapsed: all eleven drops stay mounted');
		assert.equal(hidden('dnl-decor-drop'), 8, 'collapsed: 5 beads + sl2-sl4 carry the hide class');
		assert.equal(hidden('dnl-decor-remnant'), 8, 'collapsed: all remnants carry the hide class');
		const island9 = r9.root.find((n) => String(n.props.className || '').split(' ').includes('dnl-island'));
		await act(async () => { island9.props.onMouseEnter({}); await flush(); });
		assert.equal(hidden('dnl-decor-streak') + hidden('dnl-decor-drop') + hidden('dnl-decor-remnant'), 0,
			'expanded: nothing carries the hide class');
		// The knob variables must ride the decor element: the .dnl-decor-rainv2
		// rule's own defaults would beat anything inherited from the host.
		const decorEl = r9.root.find((n) => String(n.props.className || '').includes('dnl-decor-rainv2'));
		assert.ok(decorEl.props.style, 'the rainv2 decor element carries a style object');
		assert.equal(decorEl.props.style['--dnl-rv2-pace'], '1', 'pace knob defaults to 1 on the decor element');
		assert.equal(decorEl.props.style['--dnl-rv2-hi'], '0.7', 'highlight knob defaults to 0.7');
		assert.equal(decorEl.props.style['--dnl-rv2-trail'], '0.34', 'trail knob defaults to the 0.34 baseline');
	} finally {
		if (r9) await act(async () => { r9.unmount(); await flush(); });
		storeMap.delete(PREFS_KEY);
	}
	let r9b;
	try {
		storeMap.set(PREFS_KEY, JSON.stringify({ decor: 'rainv2', rv2Density: 4, rv2Pace: 150 }));
		act(() => { r9b = TestRenderer.create(React.createElement(Island)); });
		await resolve({ ...trackBase, notice: undefined });
		assert.ok(r9b.root.findAll((n) => String(n.props.className || '').includes('dnl-decor-drop')).length === 8,
			'collapsed: density 4 still mounts the full set');
		assert.equal(r9b.root.findAll((n) => String(n.props.className || '').includes('dnl-decor-drop') && String(n.props.className || '').includes('dnl-decor-hide')).length, 6,
			'collapsed: density 4 at 25% shows one top bead + sl1; the other six drops hide');
		const island9b = r9b.root.find((n) => String(n.props.className || '').split(' ').includes('dnl-island'));
		await act(async () => { island9b.props.onMouseEnter({}); await flush(); });
		assert.ok(r9b.root.findAll((n) => String(n.props.className || '').includes('dnl-decor-drop')).length === 8,
			'expanded: density 4 renders four beads + four sliders');
		const el2 = r9b.root.find((n) => String(n.props.className || '').includes('dnl-decor-rainv2'));
		assert.equal(el2.props.style['--dnl-rv2-pace'], '1.5', 'the pace knob reaches the decor element');
	} finally {
		if (r9b) await act(async () => { r9b.unmount(); await flush(); });
		storeMap.delete(PREFS_KEY);
	}
}

// ---- v0.4.28: the 光点浮尘 v2 (motesv2) preset renders its own dot set on the
// glass skins (density dots with depth classes), carries the mood + motion
// variant classes, and the knobs ride the decor element itself.
{
	const PREFS_KEY = 'dsh.netease-lyrics.notice.v1';
	let r10;
	try {
		storeMap.set(PREFS_KEY, JSON.stringify({ decor: 'motesv2' }));
		act(() => { r10 = TestRenderer.create(React.createElement(Island)); });
		await resolve({ ...trackBase, notice: undefined });
		const clsOf = (n) => String(n.props.className || '');
		const decorEl = r10.root.find((n) => clsOf(n).includes('dnl-decor-motesv2'));
		assert.ok(decorEl, 'the motesv2 decor layer renders on the default glass skin');
		assert.ok(clsOf(decorEl).includes('mv2-mood-dust'), 'default mood class: dust');
		assert.ok(clsOf(decorEl).includes('mv2-motion-wander'), 'default motion class: wander');
		const dots = r10.root.findAll((n) => clsOf(n).includes('dnl-decor-mote2'));
		assert.equal(dots.length, 7, 'collapsed: default density 7 dots all stay mounted');
		const hidden = dots.filter((n) => clsOf(n).includes('dnl-decor-hide')).length;
		assert.equal(hidden, 5, 'collapsed: 25% of 7 → 2 survivors, 5 dots carry the hide class');
		assert.ok(decorEl.props.style, 'the motesv2 decor element carries a style object');
		assert.equal(decorEl.props.style['--dnl-mv2-pace'], '1', 'pace knob defaults to 1 on the decor element');
		assert.equal(decorEl.props.style['--dnl-mv2-glow'], '0.7', 'glow knob defaults to 0.7');
		const island10 = r10.root.find((n) => String(n.props.className || '').split(' ').includes('dnl-island'));
		await act(async () => { island10.props.onMouseEnter({}); await flush(); });
		assert.equal(r10.root.findAll((n) => clsOf(n).includes('dnl-decor-mote2') && clsOf(n).includes('dnl-decor-hide')).length, 0,
			'expanded: no dot carries the hide class');
	} finally {
		if (r10) await act(async () => { r10.unmount(); await flush(); });
		storeMap.delete(PREFS_KEY);
	}
	let r10b;
	try {
		storeMap.set(PREFS_KEY, JSON.stringify({ decor: 'motesv2', mv2Density: 5, mv2Pace: 150, mv2Mood: 'star', mv2Motion: 'gentle' }));
		act(() => { r10b = TestRenderer.create(React.createElement(Island)); });
		await resolve({ ...trackBase, notice: undefined });
		const clsOf = (n) => String(n.props.className || '');
		const decorEl = r10b.root.find((n) => clsOf(n).includes('dnl-decor-motesv2'));
		assert.ok(clsOf(decorEl).includes('mv2-mood-star'), 'mood knob reaches the decor element class');
		assert.ok(clsOf(decorEl).includes('mv2-motion-gentle'), 'motion knob reaches the decor element class');
		assert.equal(decorEl.props.style['--dnl-mv2-pace'], '1.5', 'the pace knob reaches the decor element');
		assert.equal(r10b.root.findAll((n) => clsOf(n).includes('dnl-decor-mote2')).length, 5,
			'density 5 mounts five dots');
	} finally {
		if (r10b) await act(async () => { r10b.unmount(); await flush(); });
		storeMap.delete(PREFS_KEY);
	}
}

// ---- v0.4.53: errored round as a third notice class ---------------------------
{
	let rE;
	try {
		act(() => { rE = TestRenderer.create(React.createElement(Island)); });
		await resolve({ active: false, pollMs: 500 });
		act(() => firePoll());
		await resolve(idleTurnError);
		const island = rE.root.findByProps({ role: 'status' });
		assert.equal(island.props['aria-label'], '会话区提示：gamma会话区第4轮对话出错',
			'the pill headline reads 出错 for an errored round');
		const pill = rE.root.find((n) => String(n.props.className || '').includes('dnl-notice-now'));
		assert.ok(String(pill.props.className).includes('dnl-notice-now-e'),
			'the pill container carries the error tint class');
		const icon = rE.root.findByProps({ className: 'dnl-notice-icon' });
		assert.equal(icon.children[0], '⚠', 'the pill icon is the warning sign, not the check');
		const row = rE.root.find((n) => String(n.props.className || '').includes('dnl-notice-row-e'));
		assert.ok(row, 'the expanded list row carries the error tint class');
	} finally {
		if (rE) await act(async () => { rE.unmount(); await flush(); });
	}
}

console.log('PASS: workspace notices — idle pill shows the headline and fades after ack; active pill inserts the notice (4 s) then hands off to the quiet dot; lyric hover never acks, insert hover does; cold mounts skip the replay');

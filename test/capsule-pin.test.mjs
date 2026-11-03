import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

// Regression: opening the settings view, changing a knob and going back used to
// leave the capsule pinned open, so it stayed expanded after the pointer left.
//
// Root cause: every control inside the settings panel let its click bubble to
// .dnl-island, whose onClick toggles the pin. A pinned capsule ignored
// mouseleave, so it never collapsed again.
let plugin;
let seq = 0;
const timers = new Map();
const pendingRequests = [];

vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
	window: {
		__ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => ({ default: React })); } },
		addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
		matchMedia: () => ({ matches: true }), innerWidth: 1200, innerHeight: 800,
	},
	document: undefined, console, AbortController, AbortSignal,
	fetch: (url, options) => new Promise((resolve) => pendingRequests.push({ url, options, resolve })),
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

const track = {
	active: true, playing: true, title: 'T', artist: 'A', app: 'test',
	durationSec: 100, positionSec: 1, pollMs: 500, canToggle: true,
	lyric: { status: 'matched', songId: 1, lines: [{ t: 0, text: 'one' }, { t: 5, text: 'two' }] },
};

let renderer;
const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
const islandNode = () => renderer.root.findAll((n) => typeof n.type === 'string' && n.type === 'div'
	&& String(n.props.className || '').startsWith('dnl-island'))[0];
const isExpanded = () => islandNode().props.className.includes('dnl-expanded');
const settingsNode = () => renderer.root.findAll((n) => typeof n.type === 'string'
	&& String(n.props.className || '') === 'dnl-settings')[0];

async function runPendingTimers() {
	await act(async () => {
		for (const [id, t] of [...timers]) {
			if (t.repeat) continue;
			timers.delete(id);
			t.fn();
		}
		await flush();
	});
}

/** Click an element whose handler is known to stop propagation. */
function clickGuarded(element) {
	const stopped = { value: false };
	element.props.onClick({ stopPropagation() { stopped.value = true; } });
	assert.ok(stopped.value, 'this control must stop its click before it reaches the island');
}

/**
 * Click a control inside the settings panel the way the DOM does: the panel's
 * container guard runs on the way up, so the island's pin toggle never sees it.
 */
function clickInsidePanel(element) {
	const stopped = { value: false };
	const event = { stopPropagation() { stopped.value = true; } };
	if (typeof element.props.onClick === 'function') element.props.onClick(event);
	if (!stopped.value && typeof element.props.onChange === 'function') {
		// A real click on an input also produces input/change; harmless here.
	}
	const panel = settingsNode();
	assert.ok(panel, 'the settings panel is mounted');
	assert.equal(typeof panel.props.onClick, 'function',
		'the settings panel must stop clicks from bubbling to the pin toggle');
	panel.props.onClick(event);
	assert.ok(stopped.value, 'the panel guard stopped the click');
	// Because propagation stopped, the island's onClick is never invoked here.
}

try {
	act(() => { renderer = TestRenderer.create(React.createElement(Island)); });
	await act(async () => {
		pendingRequests.at(-1).resolve({ ok: true, json: async () => track });
		await flush();
	});
	assert.equal(isExpanded(), false, 'starts collapsed');

	// 1. Hover expands without pinning.
	act(() => { islandNode().props.onMouseEnter(); });
	assert.ok(isExpanded(), 'hover expands');

	// 2. Open settings through the gear (guarded).
	clickGuarded(renderer.root.findByProps({ 'aria-label': '歌词胶囊设置' }));
	assert.ok(settingsNode(), 'settings opened');

	// 3. Click the actual range input - this is the click that used to bubble.
	clickInsidePanel(renderer.root.findAll((n) => n.type === 'input' && n.props.type === 'range')[0]);

	// 4. Back to the lyrics view, then leave the capsule.
	clickGuarded(renderer.root.findByProps({ 'aria-label': '返回歌词' }));
	assert.equal(settingsNode(), undefined, 'returned to lyrics');
	assert.ok(isExpanded(), 'still expanded while the pointer is inside');

	act(() => { islandNode().props.onMouseLeave(); });
	await runPendingTimers();
	assert.equal(isExpanded(), false,
		'the capsule collapses after leaving, even after a settings round-trip');

	// 5. Repeat the cycle: the report said "with some probability", so run it twice.
	act(() => { islandNode().props.onMouseEnter(); });
	clickGuarded(renderer.root.findByProps({ 'aria-label': '歌词胶囊设置' }));
	clickInsidePanel(renderer.root.findAll((n) => n.type === 'select')[0]);
	clickGuarded(renderer.root.findByProps({ 'aria-label': '返回歌词' }));
	act(() => { islandNode().props.onMouseLeave(); });
	await runPendingTimers();
	assert.equal(isExpanded(), false, 'the second round-trip also collapses');

	// 6. A deliberate click on the capsule body still pins it, and leaving then
	//    releases the pin - the pin must never become a trap.
	act(() => { islandNode().props.onMouseEnter(); });
	act(() => { islandNode().props.onClick(); });
	act(() => { islandNode().props.onMouseLeave(); });
	await runPendingTimers();
	assert.equal(isExpanded(), false, 'a deliberate click-pin still releases after leaving');
} finally {
	if (renderer) await act(async () => { renderer.unmount(); await flush(); });
}

console.log('PASS: settings round-trip never leaves the capsule pinned open; click-to-pin still releases');

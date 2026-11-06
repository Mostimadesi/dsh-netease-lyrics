// Regression (real React 18): with the breathing halo ON, changing a lyric LINE
// used to remount the .dnl-kick ripple (its React key contained `index`), which
// replayed a blur+scale animation on every line change. Measured in real Chrome
// screenshot bursts, that extra repaint landed on the same frame as the lyric
// cross-fade and made line changes visibly jump; turning the halo off removed
// exactly that repaint. The ripple is now keyed per TRACK, not per line.
//
// This test would FAIL on the unfixed version: after a line change the kick
// node is a DIFFERENT object (remounted) and its key contains the line index.
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

const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };
const firePoll = () => {
	for (const [id, t] of [...timers]) {
		if (t.repeat) continue;
		if (t.ms === 500) { timers.delete(id); t.fn(); return true; }
	}
	return false;
};
const kick = (renderer) => renderer.root.findAll((n) => typeof n.type === 'string'
	&& String(n.props.className || '').split(' ').includes('dnl-kick'))[0] || null;
const kickKey = (node) => { try { return node?._fiber?.key ?? null; } catch { return null; } };

const lines = [{ t: 0, text: 'one' }, { t: 5, text: 'two' }, { t: 10, text: 'three' }];
const mk = (positionSec, atMs, songId = 1) => ({
	active: true, playing: true, title: 'T', artist: 'A', app: 'test',
	durationSec: 100, pollMs: 500, canToggle: true, positionSec, atMs,
	lyric: { status: 'matched', songId, lines },
});

let renderer;
try {
	// 1. Default halo is ON (no stored preference).
	act(() => { renderer = TestRenderer.create(React.createElement(Island)); });
	await act(async () => { pending.at(-1).resolve({ ok: true, json: async () => mk(0, 1000) }); await flush(); });
	const k0 = kick(renderer);
	assert.ok(k0, 'the per-track ripple is mounted while a line is active');
	const key0 = kickKey(k0);
	assert.equal(String(key0).includes(':0'), false, 'the kick key must NOT contain the line index');

	// 2. A LINE change must NOT remount the ripple.
	act(() => { firePoll(); });
	await act(async () => { pending.at(-1).resolve({ ok: true, json: async () => mk(6, 2000) }); await flush(); });
	const k1 = kick(renderer);
	assert.equal(k1, k0, 'changing the lyric line must NOT remount the ripple');
	assert.equal(kickKey(k1), key0, 'the ripple key stays the same across line changes');

	act(() => { firePoll(); });
	await act(async () => { pending.at(-1).resolve({ ok: true, json: async () => mk(11, 3000) }); await flush(); });
	assert.equal(kick(renderer), k0, 'a second line change also keeps the same ripple node');

	// 3. A TRACK change SHOULD replay the ripple (per-track accent is intended).
	act(() => { firePoll(); });
	await act(async () => { pending.at(-1).resolve({ ok: true, json: async () => mk(0, 4000, 2) }); await flush(); });
	const k2 = kick(renderer);
	assert.notEqual(k2, k0, 'a new track SHOULD remount the ripple (per-track pulse)');
	assert.notEqual(kickKey(k2), key0, 'the ripple key tracks the song identity');
} finally {
	if (renderer) await act(async () => { renderer.unmount(); await flush(); });
}

console.log('PASS: the halo ripple is keyed per track, not per line; line changes never replay it');

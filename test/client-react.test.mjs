import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

test('real React: both overlays survive idle/play/pause/track changes and clean up on unmount', async () => {
  let plugin, sequence = 0;
  const routes = new Map(), timeouts = new Map(), intervals = new Map(), requests = [];
  const timer = (map, fn, ms) => { const id = ++sequence; map.set(id, { fn, ms }); return id; };
  const request = (url, options) => new Promise((resolve, reject) => {
    const pending = { url, options, resolve };
    requests.push(pending);
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const window = {
    __ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => ({ default: React })); } },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    matchMedia: () => ({ matches: true }), innerWidth: 1200, innerHeight: 800,
  };
  vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window, document: undefined, console, AbortController, AbortSignal, fetch: request,
    Event: class {}, localStorage: { getItem: () => null, setItem() {} },
    setTimeout: (fn, ms) => timer(timeouts, fn, ms), clearTimeout: id => timeouts.delete(id),
    setInterval: (fn, ms) => timer(intervals, fn, ms), clearInterval: id => intervals.delete(id),
  });
  plugin.apply({ slots: {
    inject: (_, cb) => cb(),
    register: (opts, component) => { routes.set(opts.key || opts.id, component); return () => {}; },
  } });
  const Island = routes.get('dsh-netease-lyrics-island');
  const Ambient = routes.get('dsh-netease-lyrics-layer');
  let renderer;
  const resolve = async payload => {
    await act(async () => {
      requests.at(-1).resolve({ ok: true, json: async () => payload });
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });
  };
  const poll = () => {
    const entry = [...timeouts].find(([, t]) => t.ms === 500);
    assert.ok(entry, 'next shared poll is scheduled');
    timeouts.delete(entry[0]);
    act(() => entry[1].fn());
  };
  try {
    act(() => { renderer = TestRenderer.create(React.createElement(React.Fragment, null,
      React.createElement(Island), React.createElement(Ambient))); });
    assert.equal(requests.length, 1, 'real mounted overlays make one request');
    assert.equal(intervals.size, 0, 'no idle interpolation timer');
    await resolve({ active: false, pollMs: 500 });
    assert.equal(renderer.toJSON(), null);
    poll();
    const track = {
      active: true, playing: true, title: 'Track', artist: 'Singer', app: 'test',
      durationSec: 100, positionSec: 0, pollMs: 500, canToggle: true,
      lyric: { status: 'matched', songId: 1, lines: [{ t: 0, text: 'First', trans: '译文一' }, { t: 5, text: 'Second', trans: '译文二' }] },
    };
    await resolve(track);
    assert.equal(renderer.root.findAllByProps({ className: 'dnl-lines' }).length, 1);
    assert.equal(intervals.size, 2, 'each playing overlay has a local render tick');
    act(() => renderer.root.findByProps({ className: 'dnl-island' }).props.onMouseEnter());
    act(() => renderer.root.findByProps({ 'aria-label': '歌词胶囊设置' }).props.onClick({ stopPropagation() {} }));
    assert.equal(renderer.root.findAllByProps({ className: 'dnl-settings' }).length, 1);
    act(() => renderer.root.findByProps({ 'aria-label': '返回歌词' }).props.onClick({ stopPropagation() {} }));
    poll(); await resolve({ ...track, positionSec: 6 });
    assert.equal(renderer.root.findAllByProps({ className: 'dnl-lines' }).length, 1, 'line change retains a single list');
    poll(); await resolve({ ...track, positionSec: 7, playing: false });
    assert.equal(intervals.size, 0, 'paused media stops local render ticks');
    poll(); await resolve({ active: false, pollMs: 500 });
    assert.equal(renderer.toJSON(), null, 'active to idle does not violate hook order');
    poll(); await resolve({ ...track, title: 'Other track', lyric: { status: 'loading' } });
    assert.ok(renderer.toJSON(), 'idle to active renders again');
  } finally {
    if (renderer) await act(async () => { renderer.unmount(); await Promise.resolve(); });
  }
  assert.equal(timeouts.size, 0, 'all poll/fade/fallback animation timers removed');
  assert.equal(intervals.size, 0, 'all interpolation intervals removed');
});

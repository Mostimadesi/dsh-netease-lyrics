// Contracts for the v0.4.37 lyric-derived beat driver:
//
//   - createBeatGrid turns a lyric timeline into pulses: a downbeat at every
//     line start (strength 1), word onsets from the yrc timeline (strength
//     .42) or even subdivisions of long word-less lines (strength .45) in
//     between, and SILENCE across instrumental breaks (gap >= restGap).
//   - beatAt(pos) = residual of the latest pulse, strength * e^(-dt/0.3).
//   - The rAF driver samples the grid at the calibrated lookup position and
//     writes --dnl-beat onto the halo; the rings consume it in CSS as
//     brightness + a hint of scale, scaled by --dnl-beat-gain.
//   - 律动源/律动强度 live in settings; the sanitizer whitelists the source
//     and clamps the gain 0-200 (100 = default, persisted only when changed).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';

// ---- load the plugin (same sandbox skeleton as notice-client.test.mjs) -----
let plugin;
vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
	window: {
		__ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => ({ default: React })); } },
		addEventListener() {},
		removeEventListener() {},
		dispatchEvent() {},
		matchMedia: () => ({ matches: true }), innerWidth: 1200, innerHeight: 800,
	},
	document: undefined, console, AbortController, AbortSignal,
	fetch: () => new Promise(() => {}),
	Event: class { constructor(type) { this.type = type; } },
	localStorage: (() => {
		const map = new Map();
		return {
			getItem: (key) => (map.has(key) ? map.get(key) : null),
			setItem: (key, value) => { map.set(key, String(value)); },
		};
	})(),
	setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
});
const { createBeatGrid, readDisplay } = plugin.__test;

// ---- beat grid: shape of the pulse train -------------------------------------
{
	const empty = createBeatGrid([]);
	assert.equal(empty.pulseCount, 0);
	assert.equal(empty.beatAt(10), 0, 'no lyric => silence');
}
{
	// Three lines: 10 -> 12 (2s, subdivided), 12 -> 40 (28s, an instrumental
	// rest). Lower-median gap is 2s => restGap = max(4, 3.5) = 4s.
	const grid = createBeatGrid([{ t: 10, text: 'a' }, { t: 12, text: 'b' }, { t: 40, text: 'c' }]);
	// downbeats at 10 / 12 / 40 (strength 1) + one subdivision at 11 (strength .45)
	assert.equal(grid.pulseCount, 4, 'downbeats plus the 2s-gap subdivision');
	assert.equal(grid.beatAt(10), 1, 'a downbeat fires at the line start');
	assert.ok(Math.abs(grid.beatAt(10 + 0.3) - Math.exp(-1)) < 0.02, 'one tau later the downbeat has decayed to e^-1');
	assert.ok(grid.beatAt(11) > grid.beatAt(10.95), 'the subdivision re-fires at 11');
	assert.ok(Math.abs(grid.beatAt(11) - 0.45) < 0.001, 'subdivision strength is .45');
	assert.ok(grid.beatAt(20) < 0.01, 'the instrumental break stays silent');
	assert.ok(grid.beatAt(39.9) < 0.01, 'silence holds right up to the next line');
	assert.equal(grid.beatAt(40), 1, 'the next line re-fires a downbeat');
	assert.equal(grid.beatAt(5), 0, 'before the first line there is nothing');
}
{
	// Word onsets: a line carrying a yrc word timeline subdivides by words,
	// not by even spacing.
	const grid = createBeatGrid([
		{ t: 10, text: 'hello world', words: [
			{ t: 10, end: 10.4, text: 'hel' },
			{ t: 10.5, end: 10.9, text: 'lo' },
			{ t: 11.2, end: 11.6, text: 'world' },
		] },
		{ t: 12.5, text: 'next' },
	]);
	assert.ok(Math.abs(grid.beatAt(10.5) - 0.42) < 0.001, 'a word onset pulses at .42');
	assert.ok(Math.abs(grid.beatAt(11.2) - 0.42) < 0.001, 'the second onset pulses too');
	assert.ok(grid.beatAt(11.0) < 0.42 * Math.exp(-0.1 / 0.3) + 0.001, 'between words the residual decays');
}
{
	// Monotonic decay between pulses (sampled): no mid-gap re-fires. A gap
	// of 1.4s is below the subdivision floor (1.6s), so nothing re-fires.
	const grid = createBeatGrid([{ t: 0, text: 'a' }, { t: 1.4, text: 'b' }]);
	let prev = grid.beatAt(0.01);
	for (let pos = 0.02; pos < 1.38; pos += 0.1) {
		const cur = grid.beatAt(pos);
		assert.ok(cur <= prev + 1e-9, `decay must be monotonic at ${pos}`);
		prev = cur;
	}
}

// ---- prefs sanitizer: source whitelist + gain clamp ---------------------------
{
	const saved = readDisplay();
	assert.ok(saved !== null && typeof saved === 'object');
}
{
	const { writeDisplay } = plugin.__test;
	writeDisplay({ glowBeatSource: 'off', glowBeatGain: 150 });
	const back = readDisplay();
	assert.equal(back.glowBeatSource, 'off', 'explicit off persists');
	assert.equal(back.glowBeatGain, 150, 'a non-default gain persists');
	writeDisplay({ glowBeatSource: 'bogus', glowBeatGain: 999 });
	const back2 = readDisplay();
	assert.equal(back2.glowBeatSource, undefined, 'a bogus source is dropped');
	assert.equal(back2.glowBeatGain, 200, 'gain clamps at 200');
	writeDisplay({ glowBeatSource: 'lyric', glowBeatGain: 100 });
	const back3 = readDisplay();
	assert.equal(back3.glowBeatSource, 'lyric', 'explicit lyric persists');
	assert.equal(back3.glowBeatGain, undefined, 'the default gain is not persisted');
}

// ---- wiring contracts (source) -------------------------------------------------
const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
{
	assert.match(src, /const haloRef = useRef\(null\);\n\s+const beatSource = prefs\.glowBeatSource === "audio" \? "audio" : \(prefs\.glowBeatSource === "off" \? "off" : "lyric"\);/, 'the driver reads the persisted source (audio lane included)');
	assert.match(src, /createBeatGrid\(lyricForHooks\.lines\)/, 'the driver builds the grid from the RAW lines (the words timeline must survive)');
	assert.match(src, /grid\.beatAt\(clock\.read\(now\)\)/, 'sampling uses the raw playback position (song time, aligned with the audio)');
	assert.match(src, /const playing = st !== null && st\.playing === true;\n\s+let target = playing \? grid\.beatAt/, 'paused playback targets 0 (decays instead of freezing)');
	assert.match(src, /requestAnimationFrame === "function"\) raf = requestAnimationFrame\(tick\);\n\s+else timer = setTimeout\(tick, 50\)/, 'rAF with a timer fallback for harnesses');
	assert.match(src, /ref: haloRef,\n\s+style: \{ "--dnl-glow-dur"/, 'the halo span carries the ref');
	assert.match(src, /"--dnl-beat-gain": String\(\(Number\.isFinite\(prefs\.glowBeatGain\) \? prefs\.glowBeatGain : 100\) \/ 100\)/, 'the gain ships as an inline CSS var');
	assert.ok(src.includes('[beatSource, beatKey, st?.playing]'), 'the effect re-arms on song/source/playback changes (self-contained beat key)');
}
{
	// CSS consumption: the wave svg scales and brightens with the beat.
	const css = plugin.__test.CSS;
	assert.match(css, /\.dnl-halo-wave\{overflow:visible;--dnl-wave-hi:1;--dnl-beat:0\}/, '--dnl-beat defaults to 0');
	assert.match(css, /transform:scale\(calc\(1 \+ var\(--dnl-beat-gain,0\) \* var\(--dnl-beat,0\) \* \.05\)\)/, 'a hint of scale with the beat');
	assert.match(css, /brightness\(calc\(1 \+ var\(--dnl-beat-gain,0\) \* var\(--dnl-beat,0\) \* \.55\)\)/, 'brightness pulse with the beat');
}
{
	// Settings surface.
	assert.match(src, /"aria-label": "律动源"/, 'the source select exists');
	assert.match(src, /\[\["lyric", "歌词拍格（默认）"\], \["audio", "音频 FFT（实验）"\], \["off", "关闭"\]\]/, 'the source select offers lyric (default), audio (experimental) and off');
	assert.match(src, /"aria-label": "律动强度"/, 'the gain slider exists');
	assert.match(src, /type: "range", min: 0, max: 200, step: 5, "aria-label": "律动强度"/, 'the gain slider spans 0-200');
	assert.match(src, /createBeatGrid,/, 'createBeatGrid is exported via __test');
}

console.log('beat-driver contracts OK');

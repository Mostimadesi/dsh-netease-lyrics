import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
// Beat-engine + PulseLayer tests: the synthesized beat is anchored to lyric
// line timestamps (strong, 600ms decay) with a BPM grid between anchors
// (weaker, 180ms decay, phase re-synced at each line start), and the layer
// drives an edge glow (--dshp-energy) plus per-bar scaleY/opacity from the
// extrapolated playback clock — pause freezes, seek re-syncs.
const store = new Map();
let plugin;
let hookIndex = 0;
let states = [];
let refs = [];
let dirty = false;
const effects = [];
let pending = [];
let rafSeq = 0;
const React = {
	createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
	useState: (initial) => {
		const i = hookIndex++;
		if (states[i] === undefined) states[i] = typeof initial === 'function' ? initial() : initial;
		return [states[i], (v) => { states[i] = typeof v === 'function' ? v(states[i]) : v; dirty = true; }];
	},
	useEffect: (fn) => { effects.push(fn); },
	useRef: (initial) => { const i = hookIndex++; if (!refs[i]) refs[i] = { current: initial === undefined ? null : initial }; return refs[i]; },
};
const context = {
	window: {
		__ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => ({ default: React })); } },
		dispatchEvent() {}, matchMedia: () => ({ matches: false }),
		requestAnimationFrame: (fn) => { pending.push(fn); rafSeq += 1; return rafSeq; },
		cancelAnimationFrame: () => {},
		addEventListener() {}, removeEventListener() {},
	},
	localStorage: { getItem: k => store.get(k) || null, setItem: (k, v) => store.set(k, v) },
	Event: class {}, document: undefined, performance: { now: () => 0 }, console,
	setTimeout: (fn) => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
};
vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), context);

const { beatEnergy, barEnergy } = plugin.__pulse;
const LINES = [{ t: 0, text: 'a' }, { t: 2, text: 'b' }, { t: 4, text: 'c' }];

// 1. Line anchors: full energy at the line start, decaying to 0 by 600ms.
assert.equal(beatEnergy(0, LINES, 110), 1, 'full energy at line start');
assert(Math.abs(beatEnergy(0.3, LINES, 110) - 0.5) < 1e-9, 'half decay at 300ms');
// At t=0.6 the anchor has decayed; the surviving value there is the grid
// beat at ~0.545. Verify decay-to-zero at the midpoint between grid beats 1
// and 2 — past the anchor window AND past the grid pulse's 180ms window.
const betweenBeats = 0.5454 + 0.27; // midpoint of beat 1 and beat 2 (~0.815)
assert(beatEnergy(betweenBeats, LINES, 110) < 1e-9, 'both anchor and grid decayed between beats');
assert.equal(beatEnergy(2, LINES, 110), 1, 'second line re-anchors');
// 2. BPM grid: between anchors, weak pulses each beat, phase from the last line.
// beatSec = 60/110 ≈ 0.5454...
const beatSec = 60 / 110;
const mid = beatSec + 1e-9; // first grid beat after the line at t=0
const eMid = beatEnergy(mid, LINES, 110);
assert(Math.abs(eMid - 0.55) < 1e-6, 'grid beat is ~0.55 amplitude');
assert(beatEnergy(mid + 0.18, LINES, 110) < 1e-9, 'grid pulse decays by 180ms');
// grid re-syncs at each anchor: phase measured from the SECOND line at t=2
const afterSecond = 2 + beatSec + 1e-9;
assert(Math.abs(beatEnergy(afterSecond, LINES, 110) - eMid) < 1e-6, 'grid phase re-anchored at the second line');
// 3. No lyrics: bare grid from track start.
assert(Math.abs(beatEnergy(beatSec + 1e-9, [], 110) - 0.55) < 1e-6, 'bare grid without lyrics');
assert(beatEnergy(beatSec + 0.18, [], 110) < 1e-9, 'bare grid decays');
// 4. Bounds: negative/NaN position is safe and zero.
assert.equal(beatEnergy(-1, LINES, 110), 0);
assert.equal(beatEnergy(Number.NaN, LINES, 110), 0);
// 5. barEnergy: bounded, non-uniform across slots, zero when base is zero.
const b0 = barEnergy(0, LINES, 110, 0, 48);
const b1 = barEnergy(0, LINES, 110, 1, 48);
assert(b0 > 0 && b0 <= 1 && b1 > 0 && b1 <= 1, 'bars bounded in 0..1');
assert.notEqual(b0.toFixed(4), b1.toFixed(4), 'bars differ per slot');
assert.equal(barEnergy(betweenBeats, LINES, 110, 0, 48), 0, 'bar zero when beat energy is zero');
// 6. BPM clamps: 40..200 through the whole path.
assert(beatEnergy(60 / 40, [], 40) > 0, 'bpm 40 grid');
assert(beatEnergy(60 / 200, [], 200) > 0, 'bpm 200 grid');

// --- PulseLayer frame-level simulation ---
function mountPulse(prefs, st) {
	hookIndex = 0; states = []; refs = []; dirty = false; effects.length = 0; pending = [];
	store.set('dsh.netease-lyrics.ambient.prefs.v1', JSON.stringify({ pulseEnabled: true, ...prefs }));
	// PulseLayer hook order: useAmbient(useState#0) → useTrackState(st=#1, tick=#2)
	// → coverColor useState(#3). Inject st at slot 1; the clock starts empty,
	// so clock.read(now) === 0 — exactly the track-start scene we assert.
	states[1] = st;
	const element = plugin.__pulse.PulseLayer();
	if (dirty) { hookIndex = 0; dirty = false; plugin.__pulse.PulseLayer(); }
	for (const effect of effects) { try { effect(); } catch {} }
	// Walk: find the host div and its bars. The host uses an OBJECT ref
	// (useRef handle) while bars use function refs — support both.
	const attach = (node, fake) => {
		const r = node.props.ref;
		if (typeof r === 'function') r(fake);
		else if (r && typeof r === 'object') r.current = fake;
	};
	const host = { style: { setProperty(k, v) { host[k] = v; } } };
	const bars = [];
	let hostAttached = false;
	const visit = (node) => {
		if (!node || typeof node !== 'object') return;
		if (typeof node.type === 'function') { visit(node.type(node.props)); return; }
		if (node.props && String(node.props.className) === 'dshp-host' && node.props.ref) {
			attach(node, host);
		}
		if (node.props && String(node.props.className) === 'dshp-bar' && node.props.ref) {
			const fake = { style: {} };
			attach(node, fake);
			bars.push(fake);
		}
		for (const child of node.children || []) visit(child);
	};
	visit(element);
	return { host, bars, pump };
	function pump() {
		const queue = pending; pending = [];
		for (const fn of queue) fn();
	}
}

// 7. Playing: energy > 0 at a line start, bars rise, glow var set.
{
	const clock = { read: () => 0 };
	const st = { active: true, playing: true, lyric: { status: 'matched', lines: LINES }, coverSerial: 0 };
	// inject the clock into the component's useRef anchor: harness maps
	// useTrackState clock via refs — simpler: patch clock.read result per frame.
	const layer = mountPulse({}, st);
	// The harness's useTrackState creates its own clock from st via useState(1);
	// snapshot injection makes clock.read(Date.now()) return pos from the state.
	layer.pump();
	// At t=0 the anchor fires: energy 1 * strength 1.
	assert.equal(layer.host['--dshp-energy'], '1.000', 'glow energy 1 at the line start');
	assert(layer.bars.length === plugin.__pulse.PULSE_BARS, '48 bars rendered');
	assert(layer.bars.some(b => b.style.transform && b.style.transform !== 'scaleY(0)'), 'bars risen');
	assert(layer.bars.every(b => /^scaleY\(\d?\.\d{3}\)$/.test(b.style.transform || 'scaleY(0.000)')), 'bar transforms are scaleY values');
}

// 8. Paused: energy 0, bars flat; inactive: the layer renders null.
{
	const layer = mountPulse({}, { active: true, playing: false, lyric: { status: 'matched', lines: LINES }, coverSerial: 0 });
	layer.pump();
	assert.equal(layer.host['--dshp-energy'], '0', 'paused freezes to zero');
	assert(layer.bars.every(b => (b.style.transform || '') === 'scaleY(0)'), 'bars flat when paused');
	// Inactive: PulseLayer itself returns null (host/bars never mounted).
	hookIndex = 0; states = []; refs = []; dirty = false; effects.length = 0; pending = [];
	store.set('dsh.netease-lyrics.ambient.prefs.v1', JSON.stringify({ pulseEnabled: true }));
	states[1] = { active: false };
	assert.equal(plugin.__pulse.PulseLayer(), null, 'inactive renders null');
}

// 9. Disabled by pref: the layer renders null.
{
	hookIndex = 0; states = []; refs = []; dirty = false; effects.length = 0; pending = [];
	store.set('dsh.netease-lyrics.ambient.prefs.v1', JSON.stringify({ pulseEnabled: false }));
	const out = plugin.__pulse.PulseLayer();
	assert.equal(out, null, 'disabled renders null');
}

// 10. Strength scales the output.
{
	const base = mountPulse({}, { active: true, playing: true, lyric: { status: 'matched', lines: LINES }, coverSerial: 0 });
	base.pump();
	const half = mountPulse({ pulseStrength: 0.5 }, { active: true, playing: true, lyric: { status: 'matched', lines: LINES }, coverSerial: 0 });
	half.pump();
	assert.equal(base.host['--dshp-energy'], '1.000');
	assert.equal(half.host['--dshp-energy'], '0.500', 'strength halves the glow energy');
}

console.log('PASS: beat engine — line anchors (600ms decay), BPM grid (180ms decay, phase re-anchored per line), bare grid, bounds; barEnergy bounded/non-uniform; PulseLayer frames — glow var, 48 bars, pause freeze, inactive hidden, disable, strength scaling.');

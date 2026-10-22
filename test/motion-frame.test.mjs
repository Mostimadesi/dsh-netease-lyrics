import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
// Frame-level test: drives the REAL FloatLine component against fake DOM
// elements and a manually pumped requestAnimationFrame, then asserts the
// per-glyph opacity/transform timeline that limpbus-lyrics defines:
// staggered reveal, wave vs jitter motion, accelerated fall on exit, and the
// classic whole-line fade + drift.
const entries = new Map();
let plugin;
let hookIndex = 0;
let dirty = false;
let states = [];
let refs = [];
const effects = [];
let pending = [];
let rafSeq = 0;

function resetHooks() { hookIndex = 0; states = []; refs = []; dirty = false; }

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
		dispatchEvent() {},
		matchMedia: () => ({ matches: false }),
		requestAnimationFrame: (fn) => { pending.push(fn); rafSeq += 1; return rafSeq; },
		cancelAnimationFrame: () => {},
	},
	localStorage: { getItem: () => null, setItem: () => {} },
	Event: class {},
	document: undefined,
	performance: { now: () => 0 },
	console,
};
vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), context);
plugin.apply({ slots: { inject: (_, cb) => cb(), register: (opts, component) => { entries.set(opts.key || opts.id || opts.name, component); return () => {}; } } });

/** Render one FloatLine and return its fake glyph elements. */
function mountLine(float, props = {}) {
	resetHooks(); effects.length = 0; pending = [];
	const fakes = [];
	let visitIndex = 0;
	const render = (lineProps) => {
		hookIndex = 0;
		if (fakes.length === 0) effects.length = 0;
		const element = plugin.__test.FloatLine(lineProps);
		visitIndex = 0;
		const visit = (node) => {
			if (!node || typeof node !== 'object') return;
			if (typeof node.type === 'function') { visit(node.type(node.props)); return; }
			if (typeof node.props.ref === 'function') {
				const slot = visitIndex++;
				if (!fakes[slot]) fakes[slot] = { style: {} };
				fakes[slot].node = node;
				fakes[slot].textContent = (node.children || []).join('');
				node.props.ref(fakes[slot]);
			}
			for (const child of node.children || []) visit(child);
		};
		visit(element);
		return element;
	};
	render({ float, exiting: false, frozen: false, anim: 'ripple-wave', fontSize: 32, ...props });
	for (const effect of effects) effect();
	return { glyphs: fakes, pump, rerender };
	function pump(now) {
		const queue = pending; pending = [];
		for (const fn of queue) fn(now);
	}
	function rerender(nextProps) {
		render({ float, exiting: false, frozen: false, anim: 'ripple-wave', fontSize: 32, ...props, ...nextProps });
	}
}
const opacityOf = (fake) => Number.parseFloat(fake.style.opacity);
const textOf = (fake) => (fake.node?.children || []).join('');
const byText = (glyphs, text) => glyphs.find(g => textOf(g) === text);

function lineOf(overrides = {}) {
	return {
		key: 'x|0', text: 'abcde', trans: null, x: 0.2, y: 0.5, rot: 6,
		bornAt: 0, exitAt: null, spanMs: 3000, ...overrides,
	};
}

// --- 1. Staggered reveal: rank 0 in first, later ranks follow the cadence. ---
{
	const { glyphs, pump } = mountLine(lineOf());
	pump(0);
	assert.equal(glyphs.length, 5, 'five glyph elements');
	assert(glyphs.every(g => opacityOf(g) === 0), 'nothing visible at t=0');
	pump(140);
	assert.equal(opacityOf(byText(glyphs, 'a')), 1, 'rank 0 fully revealed at 140ms');
	assert.equal(opacityOf(byText(glyphs, 'e')), 0, 'rank 4 (starts 360ms) still hidden');
	pump(360 + 140);
	assert(glyphs.every(g => opacityOf(g) === 1), 'all glyphs revealed after their slots');
}

// --- 2. Wave motion: continuous, per-glyph phase, non-zero after settling. ---
{
	const { glyphs, pump } = mountLine(lineOf());
	pump(1200);
	for (const g of glyphs) {
		assert(!Number.isNaN(opacityOf(g)), 'opacity never NaN');
		assert(!/NaN/.test(g.style.transform || ''), 'transform never NaN');
	}
	const a = byText(glyphs, 'a').style.transform;
	const e = byText(glyphs, 'e').style.transform;
	assert(a && a !== 'none', 'wave moves glyphs');
	assert.notEqual(a, e, 'per-glyph phase differs (wave travels)');
	const yOf = (t) => Number.parseFloat(/translate\(([-\d.]+)px,([-\d.]+)px\)/.exec(t || 'none')?.[2] ?? '0');
	pump(1400);
	const a2 = byText(glyphs, 'a').style.transform;
	assert.notEqual(a, a2, 'wave keeps evolving with time');
	assert(Math.abs(yOf(a2)) < 6, 'wave amplitude stays subtle');
}

// --- 3. Jitter motion: different noise field, still no drift. ---
{
	const { glyphs, pump } = mountLine(lineOf(), { anim: 'drop-jitter' });
	pump(1200);
	const t = byText(glyphs, 'c').style.transform;
	assert(t && t !== 'none', 'jitter moves glyphs');
	assert(!/NaN/.test(t), 'jitter transform never NaN');
}

// --- 4. Fall exit: accelerated downward travel + rotation, in rank order. ---
{
	const float = lineOf();
	const { glyphs, pump } = mountLine(float, { anim: 'drop-wave' });
	pump(1500);
	// Replace the line: exit clock starts now.
	const mounted = mountLine({ ...float, exitAt: 1500 }, { anim: 'drop-wave' });
	mounted.pump(1500);
	mounted.pump(1600);
	const early = mounted.glyphs.find(g => g.textContent === 'a');
	assert(opacityOf(early) < 1, 'rank 0 already fading 100ms into exit');
	const late = mounted.glyphs.find(g => g.textContent === 'e');
	assert.equal(opacityOf(late), 1, 'rank 4 not fading yet (staggered)');
	mounted.pump(2100);
	const fallen = mounted.glyphs.find(g => g.textContent === 'a');
	const m = /translate\(([-\d.]+)px,([-\d.]+)px\)(?: rotate\(([-\d.]+)deg\))?/.exec(fallen.style.transform || '');
	assert(m, 'fall transform shaped as translate+rotate');
	assert(Number(m[2]) > 1, 'glyph fell downward');
	assert(m[3] !== undefined && Math.abs(Number(m[3])) > 0.05, 'fall rotates ±8° at most');
}

// --- 5. Ripple exit: pure fade, no travel. ---
{
	const { glyphs, pump } = mountLine(lineOf({ exitAt: 0 }), { anim: 'ripple-wave' });
	pump(600);
	const a = byText(glyphs, 'a');
	assert(opacityOf(a) < 0.05, 'rank 0 gone well before window end');
	const e = byText(glyphs, 'e');
	assert(opacityOf(e) > 0.2 && opacityOf(e) < 0.8, 'rank 4 mid-fade while rank 0 is already gone (staggered exit)');
	const tyOf = (t) => Math.abs(Number.parseFloat(/translate\(([-\d.]+)px,([-\d.]+)px\)/.exec(t || '')?.[2] ?? '0'));
	assert(tyOf(a.style.transform) < 8, 'ripple exit has no fall travel (only the small wave remains)');
	pump(1300);
	assert(opacityOf(e) < 0.05, 'rank 4 finished by the end of the window');
}

// --- 6. Classic: whole-line fade with drift, no per-glyph stagger. ---
{
	const float = lineOf({ text: 'hello world' });
	const { glyphs, pump } = mountLine(float, { anim: 'classic-fade' });
	const ink = glyphs.filter(g => !String(g.node.props.className).includes('dnla-space'));
	assert(ink.length === 10, 'ten visible glyphs');
	pump(0);
	assert(ink.every(g => opacityOf(g) === 0), 'classic starts hidden');
	// drift starts 5px high and settles to 0, then drifts 8px down near the end
	const tyOf = (t) => Number.parseFloat(/translate\(([-\d.]+)px,([-\d.]+)px\)/.exec(t || '')?.[2] ?? '0');
	assert(tyOf(byText(ink, 'h').style.transform) < -4, 'classic drift starts above');
	pump(150);
	const half = opacityOf(byText(ink, 'h'));
	assert(half > 0.2 && half < 0.9, 'classic fades in over ~300ms');
	pump(600);
	assert(ink.every(g => opacityOf(g) === 1), 'classic fully visible, no stagger');
	pump(2900);
	assert(tyOf(byText(ink, 'h').style.transform) > 5, 'classic drifts down before the end');
}

// --- 7. Frozen (paused media): the frame loop writes nothing. ---
{
	const { glyphs, pump } = mountLine(lineOf(), { frozen: true });
	pump(140);
	pump(600);
	assert(glyphs.every(g => g.style.opacity === undefined || opacityOf(g) === 0),
		'no frames are applied while frozen');
}

// --- 8. Translation group animates on the same clock. ---
{
	const float = lineOf({ text: 'ab', trans: '中文' });
	const { glyphs, pump } = mountLine(float);
	pump(140);
	assert.equal(opacityOf(byText(glyphs, 'a')), 1);
	assert.equal(opacityOf(byText(glyphs, '中')), 1, 'translation rank 0 enters on the same cadence');
	assert.equal(byText(glyphs, '中').style.transform !== undefined, true);
}

// --- 9. Re-render with exitAt starts the exit (the real app path: the
//        line stops being current, AmbientLyrics re-renders with a new
//        float object carrying exitAt). ---
{
	const float = lineOf();
	const { glyphs, pump, rerender } = mountLine(float);
	pump(1200);
	assert.equal(opacityOf(byText(glyphs, 'a')), 1, 'visible before the line is retired');
	rerender({ float: { ...float, exitAt: 1200 }, exiting: true });
	pump(1400);
	assert(opacityOf(byText(glyphs, 'a')) < 0.9, 'exit starts on re-render (rank 0 fading)');
	assert.equal(opacityOf(byText(glyphs, 'e')), 1, 'rank 4 still waiting its exit slot');
	pump(2100);
	assert(opacityOf(byText(glyphs, 'e')) < 0.1, 'all glyphs gone by the end of the window');
}

// --- 10. Independent knobs: jump drives wave/jitter, fall drives the drop. ---
{
	const float = lineOf();
	const tyOf = (t) => Number.parseFloat(/translate\(([-\d.]+)px,([-\d.]+)px\)/.exec(t || '')?.[2] ?? '0');
	const full = mountLine(float, { jump: 10, fall: 48 });
	full.pump(1800);
	const half = mountLine(float, { jump: 5, fall: 48 });
	half.pump(1800);
	const yFull = Math.abs(tyOf(byText(full.glyphs, 'a').style.transform));
	const yHalf = Math.abs(tyOf(byText(half.glyphs, 'a').style.transform));
	assert(yFull > 0.2, 'default jump produces motion');
	assert(Math.abs(yHalf / yFull - 0.5) < 0.02, 'half the jump halves the displacement');
	const still = mountLine(float, { jump: 0, fall: 48 });
	still.pump(1800);
	assert.equal(byText(still.glyphs, 'a').style.transform, 'none', 'jump 0 = no motion (fade only)');
	assert.equal(opacityOf(byText(still.glyphs, 'a')), 1, 'jump 0 keeps the fade-in state');

	// fall distance is independent from jump
	const fallFull = mountLine({ ...float, exitAt: 0 }, { jump: 10, fall: 96, anim: 'drop-wave' });
	fallFull.pump(400);
	const fallSmall = mountLine({ ...float, exitAt: 0 }, { jump: 10, fall: 48, anim: 'drop-wave' });
	fallSmall.pump(400);
	const dFull = Math.abs(tyOf(byText(fallFull.glyphs, 'a').style.transform));
	const dSmall = Math.abs(tyOf(byText(fallSmall.glyphs, 'a').style.transform));
	assert(dFull > 1, 'fall travels');
	assert(Math.abs(dSmall / dFull - 0.5) < 0.05, 'doubling `fall` doubles the drop distance');
}

// --- 11. Classic keeps a retained line visible past its sung interval. ---
{
	const float = lineOf({ text: 'ab', spanMs: 1000 });
	const { glyphs, pump, rerender } = mountLine(float, { anim: 'classic-fade' });
	pump(600);
	assert.equal(opacityOf(byText(glyphs, 'a')), 1, 'classic visible during its interval');
	pump(2500);
	assert.equal(opacityOf(byText(glyphs, 'a')), 1, 'classic stays visible while kept on screen (no auto fade-out)');
	rerender({ float: { ...float, exitAt: 2500 }, exiting: true });
	pump(2800);
	const faded = opacityOf(byText(glyphs, 'a'));
	assert(faded > 0 && faded < 1, 'classic fades only when displaced');
}

console.log('PASS: frame-level choreography — staggered reveal, travelling wave, jitter, accelerated fall+rotation on exit, ripple fade, classic fade+drift, retained-line behaviour, translation group on the same clock, exit-on-re-render, amplitude scaling, no NaN.');


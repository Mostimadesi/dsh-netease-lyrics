import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
// Smoke test for the merged ambient client: loads the REAL lib/client.js in
// a vm sandbox with a minimal React, verifies all three slot registrations
// (island + ambient layer + settings), the floating-line lifecycle with
// synchronized translation animation, boundary clamping, freeze-on-pause,
// disable, prefs persistence, and that the original island still renders.
const store = new Map();
const entries = new Map();
let hookIndex = 0;
let snapshot = null;
let plugin;
// Minimal React mock with working state: setters mark dirty and render()
// re-invokes the component, emulating React's render-phase update handling.
let states = [];
let refs = [];
let dirty = false;
const React = {
	createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
	useState: (initial) => {
		const i = hookIndex++;
		if (states[i] === undefined) states[i] = typeof initial === 'function' ? initial() : initial;
		return [i === 1 && snapshot ? snapshot : states[i], (v) => { states[i] = typeof v === 'function' ? v(states[i]) : v; dirty = true; }];
	},
	useEffect() {}, useRef: () => { const i = hookIndex++; if (!refs[i]) refs[i] = { current: null }; return refs[i]; },
};
// Mutable fetch stub: transport tests swap it to hold a command in flight.
let fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true }) });
const context = { window: { __ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => ({ default: React })); } }, dispatchEvent() {} },
	localStorage: { getItem: k => store.get(k) || null, setItem: (k, v) => store.set(k, v) }, Event: class {}, document: undefined, console,
	fetch: (...args) => fetchImpl(...args), AbortSignal: { timeout: () => undefined },
	// The island defers its collapse (hover hysteresis); the sandbox needs timers.
	setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) };
vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), context);

// 0. One-time migration: an empty new-key + populated legacy key carries the
//    ambient-branch tuning over; an already-populated new key is untouched.
{
	const NEW_KEY = 'dsh.netease-lyrics.ambient.prefs.v1';
	const LEGACY_KEY = 'dsh.netease-lyrics-ambient.prefs.v1';
	store.set(LEGACY_KEY, JSON.stringify({ enabled: true, anim: 'drop-wave', jump: 6, fall: 96, angle: 20, colorMode: 'preset', preset: 'neon' }));
	const entries0 = new Map();
	plugin.apply({ slots: { inject: (_, cb) => cb(), register: (opts, component) => { entries0.set(opts.key || opts.id || opts.name, component); return () => {}; } } });
	hookIndex = 0; states = []; refs = []; dirty = false;
	entries0.get('dsh-netease-lyrics')({ view: 'page' });
	assert.equal(JSON.parse(store.get(NEW_KEY)).anim, 'drop-wave', 'legacy prefs migrated to the new key');
	assert.equal(JSON.parse(store.get(NEW_KEY)).fall, 96, 'legacy fall value migrated');
	assert.equal(JSON.parse(store.get(NEW_KEY)).preset, 'neon', 'legacy preset migrated');
	// second read: new key now populated, legacy is never consulted again
	store.set(LEGACY_KEY, JSON.stringify({ anim: 'classic-fade' }));
	hookIndex = 0; states = []; refs = []; dirty = false;
	entries0.get('dsh-netease-lyrics')({ view: 'page' });
	assert.equal(JSON.parse(store.get(NEW_KEY)).anim, 'drop-wave', 'populated new key wins over legacy');
	store.clear();
}

plugin.apply({ slots: { inject: (_, cb) => cb(), register: (opts, component) => { entries.set(opts.key || opts.id || opts.name, component); return () => {}; } } });
assert(entries.has('dsh-netease-lyrics-island'), 'island overlay entry');
assert(entries.has('dsh-netease-lyrics-layer'), 'ambient layer entry');
assert(entries.has('dsh-netease-lyrics'), 'config slot entry');
// The fake createElement keeps children on the element, but a real component
// receives them as props.children. Passing them through is what lets the walker
// descend into components like LyricTransition instead of losing their subtree.
function nodes(root) {
	if (root && typeof root === 'object') {
		if (typeof root.type === 'function') {
			return nodes(root.type({ ...root.props, children: root.children }));
		}
		return [root, ...(root.children || []).flatMap(nodes)];
	}
	return [];
}
function render(id) {
	hookIndex = 0; states = []; refs = []; dirty = false;
	let out = entries.get(id)();
	while (dirty) { hookIndex = 0; dirty = false; out = entries.get(id)(); }
	return out;
}
// The settings component receives { view } from the slot owner.
function renderCfg(view = 'page') {
	hookIndex = 0; states = []; refs = []; dirty = false;
	let out = entries.get('dsh-netease-lyrics')({ view });
	while (dirty) { hookIndex = 0; dirty = false; out = entries.get('dsh-netease-lyrics')({ view }); }
	return out;
}
// 1. Island still renders (original feature kept).
const ACTIVE = { active: true, playing: true, title: 'T', lyric: { status: 'matched', songId: 7, lines: [{ t: 0, text: '啊 对了', trans: '中文译文' }] } };
snapshot = ACTIVE;
let island = render('dsh-netease-lyrics-island');
assert(nodes(island).some(n => n.props.className === 'dnl-host'), 'island host rendered');
assert(nodes(island).some(n => n.props.className === 'dnl-island'), 'island capsule rendered');
// 2. Ambient layer: per-char spans, translation group, boundary clamping.
let tree = render('dsh-netease-lyrics-layer');
let line = nodes(tree).find(n => n.props.className === 'dnla-line');
assert(line, 'floating line rendered');
assert(/^clamp\(14%,/.test(line.props.style.top), 'top clamped');
assert(/^clamp\(12%,/.test(line.props.style.left), 'left clamped');
const chars = nodes(line).filter(n => String(n.props.className).startsWith('dnla-ch') && !String(n.props.className).includes('dnla-space'));
assert.equal(chars.length, 7, 'three original + four translation chars');
const mainRow = nodes(line).find(n => n.props.className === 'dnla-line-main');
const transRow = nodes(line).find(n => n.props.className === 'dnla-line-trans');
assert(transRow, 'translation row rendered');
// No CSS animation styles: choreography is written by the rAF loop.
assert(!('animationDelay' in (chars[0].props.style || {})), 'no CSS animation-delay choreography');
assert(chars.every(c => typeof c.props.ref === 'function'), 'every char exposes a ref for per-frame writes');
assert(tree.props.className.includes('dnla-anim-ripple-wave'), 'default anim class');
assert(tree.props.className.includes('dnla-style-glow'), 'default style class');
// 3. Paused media freezes.
snapshot = { ...ACTIVE, playing: false };
tree = render('dsh-netease-lyrics-layer');
assert(tree.props.className.includes('dnla-frozen'), 'frozen while paused');
// 4. Inactive session renders nothing (both entries).
snapshot = { active: false };
assert.equal(render('dsh-netease-lyrics-layer'), null, 'layer hidden when inactive');
assert.equal(render('dsh-netease-lyrics-island'), null, 'island hidden when inactive');
// 5. Disabled via settings hides only the ambient layer.
snapshot = ACTIVE;
render('dsh-netease-lyrics-layer');
const settings = renderCfg();
const toggle = nodes(settings).find(n => n.type === 'input' && n.props.type === 'checkbox');
assert(toggle, 'enable toggle exists');
toggle.props.onChange({ target: { checked: false } });
assert.equal(JSON.parse([...store.values()].map(String).find(s => s.includes('"enabled"'))).enabled, false, 'pref persisted');
assert.equal(render('dsh-netease-lyrics-layer'), null, 'nothing when disabled');
assert(nodes(render('dsh-netease-lyrics-island')).some(n => n.props.className === 'dnl-host'), 'island unaffected by ambient toggle');
// 6. Colour mode + manual colours flow into CSS variables (ambient + island).
const reenable = nodes(renderCfg()).find(n => n.type === 'input' && n.props.type === 'checkbox');
reenable.props.onChange({ target: { checked: true } });
const modeSelect = nodes(renderCfg()).find(n => n.type === 'select' && n.props['aria-label'] === '悬浮文字颜色模式');
assert(modeSelect, 'colour-mode selector exists');
assert.equal(modeSelect.children.length, 4, 'four colour modes offered');
modeSelect.props.onChange({ target: { value: 'manual' } });
const page = renderCfg();
const colorInput = nodes(page).find(n => n.type === 'input' && n.props['aria-label'] === '悬浮文字颜色');
assert(colorInput, 'manual colour picker appears in manual mode');
colorInput.props.onChange({ target: { value: '#123456' } });
tree = render('dsh-netease-lyrics-layer');
assert.equal(tree.props.style['--dnla-color'], '#123456');
// theme mode: no inline colour at all (CSS theme tokens take over)
nodes(renderCfg()).find(n => n.type === 'select' && n.props['aria-label'] === '悬浮文字颜色模式')
	.props.onChange({ target: { value: 'theme' } });
tree = render('dsh-netease-lyrics-layer');
assert.equal(tree.props.style['--dnla-color'], undefined, 'theme mode leaves the colour to theme tokens');
// preset mode: palette applied
const modeNow = nodes(renderCfg()).find(n => n.type === 'select' && n.props['aria-label'] === '悬浮文字颜色模式');
modeNow.props.onChange({ target: { value: 'preset' } });
const presetSelect = nodes(renderCfg()).find(n => n.type === 'select' && n.props['aria-label'] === '悬浮预设配色');
assert(presetSelect, 'preset palette selector appears');
presetSelect.props.onChange({ target: { value: 'neon' } });
tree = render('dsh-netease-lyrics-layer');
assert.equal(tree.props.style['--dnla-color'], '#ff9ef5', 'neon preset colour');
assert.equal(tree.props.style['--dnla-glow'], '#b06bff', 'neon preset glow');
const islandColor = nodes(renderCfg()).find(n => n.type === 'input' && n.props['aria-label'] === '原文颜色');
islandColor.props.onChange({ target: { value: '#abcdef' } });
island = render('dsh-netease-lyrics-island');
assert.equal(island.props.style['--dnl-original'], '#abcdef');
// 7. Style selector + gradient colors + ambient font flow through.
const styleSelect = nodes(renderCfg()).find(n => n.type === 'select' && n.props['aria-label'] === '悬浮文字样式');
assert(styleSelect, 'style selector exists');
assert.equal(styleSelect.props.value, 'glow', 'default style glow');
assert.equal(styleSelect.children.length, 4, 'four styles offered');
styleSelect.props.onChange({ target: { value: 'gradient' } });
const ga = nodes(renderCfg()).find(n => n.type === 'input' && n.props['aria-label'] === '渐变起始色');
assert(ga, 'gradient color pickers appear in gradient mode');
ga.props.onChange({ target: { value: '#112233' } });
const gb = nodes(renderCfg()).find(n => n.type === 'input' && n.props['aria-label'] === '渐变结束色');
gb.props.onChange({ target: { value: '#445566' } });
tree = render('dsh-netease-lyrics-layer');
assert(tree.props.className.includes('dnla-style-gradient'), 'layer carries gradient style class');
assert.equal(tree.props.style['--dnla-ga'], '#112233');
assert.equal(tree.props.style['--dnla-gb'], '#445566');
const ambFont = nodes(renderCfg()).find(n => n.type === 'input' && n.props['aria-label'] === '悬浮歌词字体');
ambFont.props.onChange({ target: { value: 'KaiTi' } });
tree = render('dsh-netease-lyrics-layer');
assert.equal(tree.props.style['--dnla-font'], '"KaiTi"', 'ambient font applied to layer');
styleSelect.props.onChange({ target: { value: 'carmen' } });
tree = render('dsh-netease-lyrics-layer');
assert(tree.props.className.includes('dnla-style-carmen'), 'carmen style class');
// 7c. Independent jump/fall knobs, layout, density, translation colour.
const jumpInput = nodes(renderCfg()).find(n => n.type === 'input' && n.props['aria-label'] === '悬浮律动幅度');
assert(jumpInput, 'jump control exists');
assert.equal(Number(jumpInput.props.value), 10, 'default jump 10');
jumpInput.props.onChange({ target: { value: '4' } });
const fallInput = nodes(renderCfg()).find(n => n.type === 'input' && n.props['aria-label'] === '悬浮跌落距离');
assert(fallInput, 'fall control exists');
assert.equal(Number(fallInput.props.value), 48, 'default fall 48');
fallInput.props.onChange({ target: { value: '120' } });
const savedPrefs = JSON.parse([...store.values()].map(String).find(s => s.includes('"jump"')));
assert.equal(savedPrefs.jump, 4, 'jump persisted independently');
assert.equal(savedPrefs.fall, 120, 'fall persisted independently');
const maxLinesInput = nodes(renderCfg()).find(n => n.type === 'input' && n.props['aria-label'] === '悬浮同屏句数');
assert(maxLinesInput, 'max-lines control exists');
assert.equal(Number(maxLinesInput.props.value), 2, 'default 2 lines');
maxLinesInput.props.onChange({ target: { value: '3' } });
assert.equal(JSON.parse([...store.values()].map(String).find(s => s.includes('"maxLines"'))).maxLines, 3, 'maxLines persisted');
// 7c-bis. Appearance direction: tilt (default) / horizontal / vertical.
const orientSelect = nodes(renderCfg()).find(n => n.type === 'select' && n.props['aria-label'] === '悬浮出现方向');
assert(orientSelect, 'orientation selector exists');
assert.equal(orientSelect.children.length, 3, 'tilt + horizontal + vertical offered');
assert.equal(orientSelect.props.value, 'tilt', 'default orientation is the original tilt');
const P = plugin.__test;
assert.equal(P.nextPlacement([], 'horizontal', 12).rot, 0, 'horizontal = exact 0°');
assert.equal(P.nextPlacement([], 'vertical', 12).rot, 0, 'vertical keeps the line upright (writing-mode drives it)');
for (let i = 0; i < 40; i += 1) {
	const rot = P.nextPlacement([], 'tilt', 12).rot;
	assert(rot >= -12 && rot <= 12, 'tilt stays within ±12° by default');
}
for (let i = 0; i < 40; i += 1) {
	const rot = P.nextPlacement([], 'tilt', 25).rot;
	assert(rot >= -25 && rot <= 25, 'tilt honours a custom angle');
}
// Placement must not ping-pong left/right or reuse one spot.
{
	const sides = new Set();
	const ys = new Set();
	for (let i = 0; i < 60; i += 1) {
		const place = P.nextPlacement([], 'tilt', 12);
		sides.add(place.side);
		ys.add(Math.round(place.y * 20));
	}
	assert.equal(sides.size, 2, 'both side bands get used randomly');
	assert(ys.size > 5, 'vertical positions vary across many spots');
}
// Overlap avoidance: a candidate too close to an existing line is rejected.
{
	const alive = [{ side: 'left', y: 0.40 }];
	let clashes = 0;
	for (let i = 0; i < 60; i += 1) {
		const place = P.nextPlacement(alive, 'tilt', 12);
		if (place.side === 'left' && Math.abs(place.y - 0.40) < 0.17) clashes += 1;
	}
	assert.equal(clashes, 0, 'no candidate lands on top of an existing line (28 retries)');
}
const angleInput = nodes(renderCfg()).find(n => n.type === 'input' && n.props['aria-label'] === '悬浮倾斜角度');
assert(angleInput, 'tilt-angle control exists');
assert.equal(Number(angleInput.props.value), 12, 'default tilt angle 12°');
angleInput.props.onChange({ target: { value: '20' } });
assert.equal(JSON.parse([...store.values()].map(String).find(s => s.includes('"angle"'))).angle, 20, 'angle persisted');
orientSelect.props.onChange({ target: { value: 'vertical' } });
tree = render('dsh-netease-lyrics-layer');
assert(tree.props.className.includes('dnla-orient-vertical'), 'vertical orientation class on layer');
// 7c-ter. Floating-line budget: N lines stay alive, only the oldest retires.
{
	const mk = (key, exitAt = null) => ({ key, text: key, trans: null, x: 0.2, y: 0.4, rot: 0, bornAt: 0, exitAt, spanMs: 4000 });
	let floats = [];
	floats = P.selectFloats(floats, mk('a'), 3, 100).floats;
	assert.equal(floats.length, 1, 'first line alive');
	floats = P.selectFloats(floats, mk('b'), 3, 200).floats;
	floats = P.selectFloats(floats, mk('c'), 3, 300).floats;
	assert.equal(floats.length, 3, 'three lines alive at maxLines 3');
	assert(floats.every(f => f.exitAt === null), 'nothing retiring while under budget');
	const step4 = P.selectFloats(floats, mk('d'), 3, 400);
	assert.equal(step4.floats.filter(f => f.exitAt === null).length, 3, 'still exactly three alive');
	assert.equal(step4.retire.length, 1, 'only the oldest retires');
	assert.equal(step4.retire[0].key, 'a', 'the OLDEST line retires first');
	assert.equal(step4.retire[0].exitAt, 400, 'retire clock starts at this spawn');
	// budget 1: each new line retires the previous one
	let single = [];
	single = P.selectFloats(single, mk('a'), 1, 100).floats;
	const s2 = P.selectFloats(single, mk('b'), 1, 200);
	assert.equal(s2.retire.length, 1, 'maxLines 1 retires the previous line');
	assert.equal(s2.floats.filter(f => f.exitAt === null).length, 1, 'only one alive');
}
const transColor = nodes(renderCfg()).find(n => n.type === 'input' && n.props['aria-label'] === '悬浮译文颜色');
assert(transColor, 'translation colour control exists');
transColor.props.onChange({ target: { value: '#9fe3c8' } });
tree = render('dsh-netease-lyrics-layer');
assert.equal(tree.props.style['--dnla-trans-color'], '#9fe3c8', 'translation colour flows to the layer');
assert(tree.props.className.includes('dnla-trans-custom'), 'custom-translation class set');
// 7d. Custom text replaces the SMTC lyric entirely.
const customToggle = nodes(renderCfg()).find(n => n.type === 'input' && n.props['aria-label'] === '启用自定义文本');
assert(customToggle, 'custom-text toggle exists');
customToggle.props.onChange({ target: { checked: true } });
const customArea = nodes(renderCfg()).find(n => n.type === 'textarea' && n.props['aria-label'] === '自定义悬浮文本');
assert(customArea, 'custom textarea exists');
customArea.props.onChange({ target: { value: '第一句\n第二句' } });
const holdInput = nodes(renderCfg()).find(n => n.type === 'input' && n.props['aria-label'] === '自定义文本停留秒数');
assert(holdInput, 'custom hold control exists');
holdInput.props.onChange({ target: { value: '6' } });
snapshot = null; // no media session at all: custom text still renders
tree = render('dsh-netease-lyrics-layer');
assert(tree, 'custom text renders without any media session');
const customLine = nodes(tree).find(n => n.props.className === 'dnla-line');
assert(customLine, 'custom floating line rendered');
assert.strictEqual(JSON.stringify(nodes(customLine).filter(n => /^dnla-ch/.test(String(n.props.className)) && !String(n.props.className).includes('dnla-space')).map(n => n.children[0]).join('')), JSON.stringify('第一句'), 'first custom line shown');
snapshot = ACTIVE;
// 7b. Animation preset selector + single-line toggle.
const animSelect = nodes(renderCfg()).find(n => n.type === 'select' && n.props['aria-label'] === '悬浮动效样式');
assert(animSelect, 'anim selector exists');
assert.equal(animSelect.props.value, 'ripple-wave', 'default anim ripple-wave');
assert.equal(animSelect.children.length, 5, 'five anim presets offered');
animSelect.props.onChange({ target: { value: 'drop-jitter' } });
tree = render('dsh-netease-lyrics-layer');
assert(tree.props.className.includes('dnla-anim-drop-jitter'), 'drop-jitter anim class on layer');
animSelect.props.onChange({ target: { value: 'classic-fade' } });
tree = render('dsh-netease-lyrics-layer');
assert(tree.props.className.includes('dnla-anim-classic-fade'), 'classic-fade anim class on layer');
const singleToggle = nodes(renderCfg()).filter(n => n.type === 'input' && n.props.type === 'checkbox')
	.find(n => n.props.checked === false);
assert(singleToggle, 'single-line toggle exists (off by default)');
singleToggle.props.onChange({ target: { checked: true } });
tree = render('dsh-netease-lyrics-layer');
assert(tree.props.className.includes('dnla-single'), 'single-line class on layer');
// 8. Summary view.
assert.equal(typeof entries.get('dsh-netease-lyrics')({ view: 'summary' }), 'string');

// 9. Choreography math mirrors limpbus-lyrics glyph_motion.py.
const M = plugin.__motion;
assert(M, 'motion helpers exported for tests');
// smooth(): clamp + smoothstep at the midpoint
assert.equal(M.smooth(-1), 0);
assert.equal(M.smooth(2), 1);
assert.equal(M.smooth(0.5), 0.5);
// reveal_phase: rank N starts N*interval later, each fades over `fade`
const start = 0, end = 700, count = 7, interval = 90, fade = 140;
assert.equal(M.revealPhase(0, start, end, 0, count, interval, fade), 0, 'rank 0 starts at 0');
assert.equal(M.revealPhase(140, start, end, 0, count, interval, fade), 1, 'rank 0 fully in after 140ms');
assert.equal(M.revealPhase(200, start, end, 3, count, interval, fade), 0, 'rank 3 waits for its slot (270ms)');
assert.equal(M.revealPhase(410, start, end, 3, count, interval, fade), 1, 'rank 3 done at 270+140');
assert(Math.abs(M.revealPhase(340, start, end, 3, count, interval, fade) - 0.5) < 1e-9, 'rank 3 half-faded at 340ms');
// stagger(): exit spreads in rank order across the window
assert.equal(M.staggerPhase(0, 0, 700, 0, 4, 200), 0, 'rank 0 exit begins immediately');
assert.equal(M.staggerPhase(200, 0, 700, 0, 4, 200), 1, 'rank 0 gone after 200ms');
assert.equal(M.staggerPhase(100, 0, 700, 3, 4, 200), 0, 'rank 3 still solid at 100ms (starts at 500ms)');
assert.equal(M.staggerPhase(700, 0, 700, 3, 4, 200), 1, 'rank 3 gone at window end');
// noise(): deterministic, smooth and bounded
assert.equal(M.noiseValue(11, 2, 1, 5), M.noiseValue(11, 2, 1, 5), 'noise is deterministic');
for (const t of [0, 0.3, 1.7, 5.2]) {
	const v = M.noise(11, 2, 1, t, 6);
	assert(v >= -1 && v <= 1, 'noise within [-1,1]');
}
assert.notEqual(M.noise(11, 2, 1, 0.2, 6), M.noise(11, 3, 1, 0.2, 6), 'per-glyph seeds differ');
// amplitude matches jump*(.35+.65*energy) at the reference's wave energy
assert(Math.abs(M.AMPLITUDE - 10 * (0.35 + 0.65 * 0.32)) < 1e-9);

// 10. Breathing halo on the capsule: four layers by default, theme accent in
//     --dnl-halo, colour source and pace from the settings page, absent when off.
snapshot = { active: true, playing: true, title: 'T', coverSerial: 0,
	lyric: { status: 'matched', songId: 7, lines: [{ t: 0, text: '啊 对了' }] } };
store.clear();
let islandTree = render('dsh-netease-lyrics-island');
const halo = nodes(islandTree).find(n => String(n.props.className).startsWith('dnl-halo'));
assert(halo, 'halo rendered by default');
assert(nodes(islandTree).some(n => n.props.className === 'dnl-shell'), 'island wrapped in the halo shell');
assert.equal(nodes(islandTree).find(n => n.props.className === 'dnl-host').props.style['--dnl-halo'], 'var(--dsw-alias-brand-primary)', 'theme accent drives the halo');
const haloLayers = nodes(halo).filter(n => /^h[1234]$/.test(String(n.props.className)));
assert.equal(haloLayers.length, 4, 'four halo layers (incl. hue drift)');
assert(!halo.props.className.includes('dnl-halo-hold'), 'playing track breathes');
assert.equal(halo.props.style['--dnl-glow-dur'], '5.6s', 'normal pace period');
assert(nodes(halo).some(n => n.props.className === 'dnl-kick'), 'line ripple mounted while a line is active');
snapshot = { ...snapshot, playing: false };
const heldHalo = nodes(render('dsh-netease-lyrics-island')).find(n => String(n.props.className).startsWith('dnl-halo'));
assert(heldHalo.props.className.includes('dnl-halo-hold'), 'paused track holds the breath');
assert(!nodes(heldHalo).some(n => n.props.className === 'dnl-kick'), 'no line ripple while paused');

snapshot = null;
const glowSelect = nodes(renderCfg()).find(n => n.type === 'select' && n.props['aria-label'] === '呼吸灯颜色来源');
assert(glowSelect, 'glow colour-source selector exists');
assert.equal(glowSelect.props.value, 'theme', 'default follows the theme');
const paceSelect = nodes(renderCfg()).find(n => n.type === 'select' && n.props['aria-label'] === '呼吸节奏');
assert(paceSelect, 'pace selector exists while the halo is on');
assert.equal(paceSelect.props.value, 'normal', 'default pace is normal');
paceSelect.props.onChange({ target: { value: 'calm' } });
assert.equal(JSON.parse(store.get('dsh.netease-lyrics.display.v1')).glowPace, 'calm', 'pace persisted');
snapshot = { active: true, playing: true, title: 'T', coverSerial: 0, lyric: { status: 'matched', songId: 7, lines: [{ t: 0, text: '啊' }] } };
const calmHalo = nodes(render('dsh-netease-lyrics-island')).find(n => String(n.props.className).startsWith('dnl-halo'));
assert.equal(calmHalo.props.style['--dnl-glow-dur'], '8.4s', 'calm pace slows the period');
assert.equal(calmHalo.props.style['--dnl-glow-amp'], '.8', 'calm pace dims the lamp');
snapshot = null;
nodes(renderCfg()).find(n => n.type === 'select' && n.props['aria-label'] === '呼吸灯颜色来源')
	.props.onChange({ target: { value: 'cover' } });
assert.equal(JSON.parse(store.get('dsh.netease-lyrics.display.v1')).glow, 'cover', 'cover mode persisted');
snapshot = { active: true, playing: true, title: 'T', coverSerial: 9, lyric: { status: 'matched', songId: 7, lines: [{ t: 0, text: '啊' }] } };
assert(nodes(render('dsh-netease-lyrics-island')).some(n => String(n.props.className).startsWith('dnl-halo')), 'cover mode keeps the halo');
snapshot = null;
nodes(renderCfg()).find(n => n.type === 'select' && n.props['aria-label'] === '呼吸灯颜色来源')
	.props.onChange({ target: { value: 'off' } });
assert(!nodes(renderCfg()).find(n => n.type === 'select' && n.props['aria-label'] === '呼吸节奏'), 'pace selector hides when the halo is off');
snapshot = { active: true, playing: true, title: 'T', lyric: { status: 'matched', songId: 7, lines: [{ t: 0, text: '啊' }] } };
assert(!nodes(render('dsh-netease-lyrics-island')).some(n => String(n.props.className).startsWith('dnl-halo')), 'off removes the halo');

// 11. The halo geometry/motion lives in the injected CSS (the Node harness cannot
//     paint): border-only layers, outward relay, hue drift, ripple, pace scaling.
const haloCss = plugin.__test.CSS;
assert(haloCss.includes('.dnl-halo{position:absolute;inset:0;z-index:0;pointer-events:none;opacity:var(--dnl-glow-amp,1)}'), 'halo is an unfilled box scaled by the pace preset');
assert(!/\.dnl-halo[^{]*\{[^}]*background:/.test(haloCss), 'no halo layer paints a background');
assert(haloCss.includes('.dnl-halo>.h1{inset:-2px;border-width:2px'), 'rim is a 2px hairline at the edge');
assert(haloCss.includes('.dnl-halo>.h2{inset:-7px;border-width:5px'), 'mid halo layer');
assert(haloCss.includes('.dnl-halo>.h3{inset:-16px;border-width:9px'), 'outer bloom layer');
assert(haloCss.includes('.dnl-halo>.h4{inset:-7px;border-width:5px;filter:blur(9px) hue-rotate(18deg)'), 'hue-drift layer');
assert(haloCss.includes('animation-delay:0s') && haloCss.includes('calc(var(--dnl-glow-dur,5.6s) * .05)') && haloCss.includes('calc(var(--dnl-glow-dur,5.6s) * .1)'), 'layers lag proportionally to the period');
assert(haloCss.includes('@keyframes dnl-glow-drift') && haloCss.includes('@keyframes dnl-kick'), 'drift and ripple keyframes exist');
assert(haloCss.includes('.dnl-halo-hold>span{animation:none}') && haloCss.includes('.dnl-halo-hold>.dnl-kick{display:none}'), 'paused state freezes the breath and hides the ripple');
const rimTrack = haloCss.slice(haloCss.indexOf('@keyframes dnl-glow-rim'), haloCss.indexOf('@keyframes dnl-glow-mid'));
assert(/26%\{opacity:\.95\}/.test(rimTrack) && /44%\{opacity:\.85\}/.test(rimTrack), 'fast inhale, then a hold');

// 12. Expansion: one body at a time, driven by the capsule's own box so the
//     collapsed capsule stays as narrow as the lyric line (a hidden panel in
//     the flow used to stretch it), and the transition animates both ways.
{
	// `render` resets hook state on every call; interaction tests need the
	// state a handler wrote to survive into the next render, so this keeps it.
	const rerender = () => {
		hookIndex = 0; dirty = false;
		let out = entries.get('dsh-netease-lyrics-island')();
		let guard = 0;
		while (dirty && guard++ < 10) { hookIndex = 0; dirty = false; out = entries.get('dsh-netease-lyrics-island')(); }
		return out;
	};
	const resetHooks = () => { hookIndex = 0; states = []; refs = []; dirty = false; };
	snapshot = { active: true, playing: true, title: 'T', artist: 'A', durationSec: 200, positionSec: 10,
		canToggle: true, canNext: true, canPrev: true, coverSerial: 0,
		lyric: { status: 'matched', songId: 7, lines: [{ t: 0, text: '第一句', trans: '译文' }, { t: 5, text: '第二句' }] } };
	store.clear();
	resetHooks();
	let islandTree = rerender();
	const islandEl = () => nodes(islandTree).find(n => String(n.props.className || '').startsWith('dnl-island'));
	assert(islandEl(), 'island rendered');
	assert(!islandEl().props.className.includes('dnl-expanded'), 'starts collapsed');
	assert(nodes(islandTree).some(n => n.props.className === 'dnl-crossfade'), 'collapsed body is the lyric line');
	const grow = nodes(islandTree).find(n => n.props.className === 'dnl-grow');
	assert(grow, 'grow wrapper always mounted');
	assert.equal(grow.props['aria-hidden'], 'true', 'collapsed wrapper is hidden from assistive tech');
	assert(nodes(islandTree).some(n => n.props.className === 'dnl-panel'), 'panel stays mounted so its height can animate');
	const collapsedCtl = nodes(islandTree).filter(n => String(n.props.className || '').includes('dnl-ctl'));
	assert.equal(collapsedCtl.length, 5, 'transport controls exist inside the mounted panel');
	assert(collapsedCtl.every(b => b.props.disabled === true), 'collapsed controls are disabled (unfocusable, unclickable)');
	assert.equal(nodes(islandTree).find(n => n.props.className === 'dnl-grow').props.inert, '', 'collapsed wrapper is inert');
	assert(nodes(islandTree).find(n => n.props.className === 'dnl-grow').props['aria-hidden'] === 'true', 'collapsed controls are hidden from assistive tech');

	// Hover opens it through the island's own handler.
	islandEl().props.onMouseEnter();
	islandTree = rerender();
	assert(islandEl().props.className.includes('dnl-expanded'), 'hover expands the capsule');
	assert(nodes(islandTree).some(n => n.props.className === 'dnl-panel'), 'expanded shows the panel');
	assert.equal(nodes(islandTree).find(n => n.props.className === 'dnl-grow').props['aria-hidden'], undefined, 'expanded wrapper is exposed');
	// LyricTransition holds the outgoing content for one 240ms cross-fade, so the
	// collapsed wrapper can still be present right after expanding; what matters
	// is that the island has exactly one body of its own (the panel).
	assert.equal(nodes(islandTree).filter(n => n.props.className === 'dnl-panel').length, 1, 'exactly one expanded body');

	// Leaving the hover collapses again, but only after the hysteresis delay, so a
	// pointer that merely grazes the edge cannot start a collapse/expand loop.
	islandEl().props.onMouseLeave();
	islandTree = rerender();
	assert(islandEl().props.className.includes('dnl-expanded'), 'leaving does not collapse instantly (hysteresis)');
	await new Promise(resolve => setTimeout(resolve, 320));
	islandTree = rerender();
	assert(!islandEl().props.className.includes('dnl-expanded'), 'leaving collapses an unpinned capsule after the delay');

	// Re-entering before the delay expires cancels the pending collapse.
	islandEl().props.onMouseEnter();
	islandTree = rerender();
	islandEl().props.onMouseLeave();
	await new Promise(resolve => setTimeout(resolve, 60));
	islandEl().props.onMouseEnter();
	await new Promise(resolve => setTimeout(resolve, 320));
	islandTree = rerender();
	assert(islandEl().props.className.includes('dnl-expanded'), 'a re-entry cancels the pending collapse');

	// The CSS must actually carry the animation, in both directions.
	const css = plugin.__test.CSS;
	const islandRule = /\.dnl-island\{[^}]*\}/.exec(css);
	assert(islandRule, 'island rule present');
	assert(/max-width \.28s/.test(islandRule[0]) && /border-radius \.28s/.test(islandRule[0]), 'capsule shape transitions');
	const growRule = /\.dnl-grow\{[^}]*\}/.exec(css);
	assert(growRule, 'grow wrapper rule present');
	assert(/grid-template-rows:0fr/.test(growRule[0]), 'collapsed wrapper has zero rows');
	assert(/width:0/.test(growRule[0]), 'collapsed wrapper takes no width (keeps the pill narrow)');
	assert(/grid-template-rows \.28s/.test(growRule[0]) && /width \.28s/.test(growRule[0]), 'both height and width transition');
	const expandedGrow = /\.dnl-expanded \.dnl-grow\{[^}]*\}/.exec(css);
	assert(expandedGrow && /grid-template-rows:1fr/.test(expandedGrow[0]), 'expanded wrapper has one row');
	assert(/width:auto/.test(expandedGrow[0]), 'expanded wrapper takes its natural width');
	assert(css.includes('.dnl-grow-inner{min-height:0'), 'inner clamps its height so 0fr really collapses');
	// The collapsed row now shrinks on the same clock as the panel grows; an
	// instant height:0 made the capsule dip below a stationary pointer.
	const nowWrap = /\.dnl-now-wrap\{[^}]*\}/.exec(css);
	assert(nowWrap, 'collapsed row has its own track');
	assert(/grid-template-rows:1fr/.test(nowWrap[0]) && /grid-template-rows \.28s/.test(nowWrap[0]), 'collapsed track transitions its height');
	const nowCollapsed = /\.dnl-expanded \.dnl-now-wrap\{[^}]*\}/.exec(css);
	assert(nowCollapsed && /grid-template-rows:0fr/.test(nowCollapsed[0]), 'expanded collapses the row through the track');
	assert(!/\.dnl-expanded \.dnl-now\{[^}]*height:0/.test(css), 'no instant height:0 on the collapsed row (caused a hover loop)');
	assert(!css.includes('.dnl-expanded .dnl-now{display:none}'), 'collapsed row keeps its width (display:none narrowed the capsule)');
	// Regression guards against the two bugs this replaced.
	assert(!/\.dnl-island\{[^}]*max-height/.test(css), 'no max-height animation (a bound cannot interpolate intrinsic height)');
	assert(!css.includes('.dnl-collapsed{') && !css.includes('.dnl-expand{'), 'no stacked hidden bodies');
}

// 13. Transport controls: play/pause/next/prev, capability gating, in-flight state.
{
	const rerender = () => {
		hookIndex = 0; dirty = false;
		let out = entries.get('dsh-netease-lyrics-island')();
		let guard = 0;
		while (dirty && guard++ < 10) { hookIndex = 0; dirty = false; out = entries.get('dsh-netease-lyrics-island')(); }
		return out;
	};
	const resetHooks = () => { hookIndex = 0; states = []; refs = []; dirty = false; };
	snapshot = { active: true, playing: true, title: 'T', artist: 'A', durationSec: 200, positionSec: 10,
		canToggle: true, canNext: true, canPrev: true, coverSerial: 0,
		lyric: { status: 'matched', songId: 7, lines: [{ t: 0, text: '第一句' }] } };
	store.clear();
	resetHooks();
	let islandTree = rerender();
	nodes(islandTree).find(n => String(n.props.className || '').startsWith('dnl-island')).props.onMouseEnter();
	islandTree = rerender();
	let all = nodes(islandTree);
	const ctls = () => all.filter(n => String(n.props.className || '').includes('dnl-ctl'));
	assert(nodes(islandTree).some(n => n.props.className === 'dnl-controls'), 'transport row rendered');
	assert.equal(ctls().length, 5, 'five transport buttons (incl. the two seek steps)');
	const byLabel = label => all.find(n => n.props['aria-label'] === label);
	assert(byLabel('上一首') && byLabel('下一首') && byLabel('暂停'), 'prev / next / pause labels');
	assert.equal(byLabel('暂停').children[0], '⏸', 'playing shows the pause glyph');
	for (const label of ['上一首', '暂停', '下一首']) {
		assert(typeof byLabel(label).props.onClick === 'function', label + ' is clickable');
		assert(!byLabel(label).props.disabled, label + ' enabled when the player supports it');
	}

	// Paused track: the main button offers play instead.
	snapshot = { ...snapshot, playing: false };
	islandTree = rerender();
	all = nodes(islandTree);
	assert(all.find(n => n.props['aria-label'] === '播放'), 'paused shows a play button');
	assert.equal(all.find(n => n.props['aria-label'] === '播放').children[0], '▶', 'paused shows the play glyph');

	// Players that report no capability: buttons disable rather than lying.
	snapshot = { ...snapshot, playing: true, canToggle: false, canNext: false, canPrev: false };
	islandTree = rerender();
	all = nodes(islandTree);
	assert(all.find(n => n.props['aria-label'] === '下一首').props.disabled, 'next disabled when canNext=false');
	assert(all.find(n => n.props['aria-label'] === '上一首').props.disabled, 'prev disabled when canPrev=false');
	assert(all.find(n => n.props['aria-label'] === '暂停').props.disabled, 'toggle disabled when canToggle=false');

	// A click must not bubble into the island's pin toggle, and while the host
	// is answering the button reports progress and refuses a second click.
	// A never-resolving fetch keeps the command in flight for the assertion.
	snapshot = { ...snapshot, canToggle: true, canNext: true, canPrev: true };
	islandTree = rerender();
	all = nodes(islandTree);
	const mainBtn = all.find(n => n.props['aria-label'] === '暂停');
	let stopped = false;
	fetchImpl = () => new Promise(() => {});
	mainBtn.props.onClick({ stopPropagation: () => { stopped = true; } });
	assert(stopped, 'transport click stops propagation');
	islandTree = rerender();
	all = nodes(islandTree);
	const pendingBtn = all.find(n => String(n.props.className || '').includes('dnl-ctl-main'));
	assert.equal(pendingBtn.children[0], '…', 'in-flight command shows a pending glyph');
	assert(pendingBtn.props.disabled, 'in-flight command blocks a second click');
	// Restore the stub so it cannot leak into the next block.
	fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true }) });
}

// 14. The active lyric line stays vertically centred even at the very end of a
//     song. The window is computed by a pure helper, so this is exact rather
//     than a guess at what the render happens to produce.
{
	const W = plugin.__test.lyricWindow;
	assert.equal(typeof W, 'function', 'lyricWindow exposed for testing');

	// Mid-song: four real lines either side.
	const mid = W(20, 10, 4, 4);
	assert.equal(mid.length, 9, 'window is always 9 slots');
	assert.equal(JSON.stringify(mid), JSON.stringify([6, 7, 8, 9, 10, 11, 12, 13, 14]), 'mid-song window is unpadded');
	assert.equal(mid.indexOf(10), 4, 'active line is the 5th of 9');

	// Last line: four -1 (padding) after it, so it stays in the middle slot.
	const last = W(20, 19, 4, 4);
	assert.equal(last.length, 9, 'window keeps its size at the end of the song');
	assert.equal(last.indexOf(19), 4, 'final lyric line is STILL the 5th of 9 (not pushed to the bottom)');
	assert.equal(last.filter(i => i === -1).length, 4, 'four trailing slots are padding');

	// First line: symmetric padding before it.
	const first = W(20, 0, 4, 4);
	assert.equal(first.indexOf(0), 4, 'first lyric line is centred too');
	assert.equal(first.filter(i => i === -1).length, 4, 'four leading slots are padding');

	// A lyric shorter than the window: padded on both sides.
	const tiny = W(3, 1, 4, 4);
	assert.equal(tiny.length, 9, 'a 3-line lyric still fills 9 slots');
	assert.equal(tiny.indexOf(1), 4, 'active line stays centred');
	assert.equal(tiny.filter(i => i === -1).length, 6, 'six pads for a 3-line lyric');

	// Edge cases must not throw or invent rows.
	assert.equal(JSON.stringify(W(0, 0, 4, 4)), '[]', 'no lines -> no rows');
	assert.equal(JSON.stringify(W(10, -1, 4, 4)), '[]', 'no active line -> no rows');

	// The rendered rows must agree with the helper. The test harness stubs
	// useEffect, so the playback clock never advances and every render lands on
	// t=0 (the first lyric) - which is exactly the start-of-song case worth
	// checking, and the active row still has to be the middle one.
	store.clear();
	snapshot = { active: true, playing: true, title: 'T', artist: 'A', durationSec: 60, positionSec: 0,
		canToggle: true, canNext: true, canPrev: true, canSeek: true, coverSerial: 0,
		lyric: { status: 'matched', songId: 1, lines: Array.from({ length: 20 }, (_, i) => ({ t: i * 5, text: 'L' + i })) } };
	const resetHooks = () => { hookIndex = 0; states = []; refs = []; dirty = false; };
	const rerender = () => {
		hookIndex = 0; dirty = false;
		let out = entries.get('dsh-netease-lyrics-island')();
		let guard = 0;
		while (dirty && guard++ < 10) { hookIndex = 0; dirty = false; out = entries.get('dsh-netease-lyrics-island')(); }
		return out;
	};
	resetHooks();
	let tree = rerender();
	nodes(tree).find(n => String(n.props.className || '').startsWith('dnl-island')).props.onMouseEnter();
	tree = rerender();
	const rows = nodes(tree).filter(n => /(^|\s)dnl-line(\s|$)/.test(String(n.props.className || '')));
	assert.equal(rows.length, 9, 'nine rows rendered (got ' + rows.length + ')');
	assert.equal(rows.findIndex(r => String(r.props.className).includes('dnl-line-active')), 4, 'rendered active row is the middle one');
	assert.equal(rows.filter(r => String(r.props.className).includes('dnl-line-pad')).length, 4, 'leading pads rendered');
	const pads = rows.filter(r => String(r.props.className).includes('dnl-line-pad'));
	assert(pads.every(r => r.props['aria-hidden'] === 'true'), 'padding rows are hidden from assistive tech');
	assert(pads.every(r => nodes(r).some(n => n.props.className === 'dnl-line-main')), 'padding rows keep their height');
	assert(plugin.__test.CSS.includes('.dnl-line-pad{visibility:hidden}'), 'padding rows are invisible but still take space');
}

// 15. ±5s seek: arithmetic, clamping, capability gating and the request body.
{
	const T = plugin.__test.seekTarget;
	assert.equal(typeof T, 'function', 'seekTarget exposed for testing');

	// Plain steps.
	assert.equal(T(30, 5, 60), 35, 'forward 5s from 30s');
	assert.equal(T(30, -5, 60), 25, 'back 5s from 30s');
	assert.equal(T(0.5, 5, 60), 5.5, 'fractional positions survive');

	// Clamped at both ends of the track.
	assert.equal(T(58, 5, 60), 60, 'forward clamps at the duration');
	assert.equal(T(2, -5, 60), 0, 'back clamps at zero');

	// No movement -> no request.
	assert.equal(T(60, 5, 60), null, 'forward at the very end does nothing');
	assert.equal(T(0, -5, 60), null, 'back at the very start does nothing');

	// Unknown duration still clamps at zero.
	assert.equal(T(3, -5, 0), 0, 'no duration: still clamps the low end');
	assert.equal(T(3, 5, 0), 8, 'no duration: forward is unbounded above');

	// The buttons exist, are gated on canSeek, and post the expected body.
	const base = { active: true, playing: true, title: 'T', artist: 'A', durationSec: 60, positionSec: 30,
		canToggle: true, canNext: true, canPrev: true, canSeek: true, coverSerial: 0,
		lyric: { status: 'matched', songId: 1, lines: [{ t: 0, text: 'A' }] } };
	const resetHooks = () => { hookIndex = 0; states = []; refs = []; dirty = false; };
	const rerender = () => {
		hookIndex = 0; dirty = false;
		let out = entries.get('dsh-netease-lyrics-island')();
		let guard = 0;
		while (dirty && guard++ < 10) { hookIndex = 0; dirty = false; out = entries.get('dsh-netease-lyrics-island')(); }
		return out;
	};
	const openWith = (snap) => {
		snapshot = snap;
		store.clear();
		resetHooks();
		nodes(rerender()).find(n => String(n.props.className || '').startsWith('dnl-island')).props.onMouseEnter();
		return nodes(rerender());
	};

	let all = openWith(base);
	const fwd = all.find(n => n.props['aria-label'] === '前进 5 秒');
	const back = all.find(n => n.props['aria-label'] === '后退 5 秒');
	assert(fwd && back, 'both seek buttons rendered');
	assert(!fwd.props.disabled && !back.props.disabled, 'enabled when canSeek=true');
	assert(typeof fwd.props.onClick === 'function', 'forward is clickable');

	const posted = [];
	fetchImpl = async (url, options) => {
		if (String(url).includes('/control')) posted.push(JSON.parse(options.body));
		return { ok: true, json: async () => ({ ok: true }) };
	};
	fwd.props.onClick({ stopPropagation() {} });
	await new Promise(resolve => setTimeout(resolve, 30));
	assert.equal(posted.length, 1, 'forward click posts exactly one command');
	assert.equal(posted[0].cmd, 'seek', 'command is seek');
	assert.equal(typeof posted[0].pos, 'number', 'position is numeric');

	// A player without seek support disables them instead of failing silently.
	all = openWith({ ...base, canSeek: false });
	assert(all.find(n => n.props['aria-label'] === '前进 5 秒').props.disabled, 'forward disabled when canSeek=false');
	assert(all.find(n => n.props['aria-label'] === '后退 5 秒').props.disabled, 'back disabled when canSeek=false');
	fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true }) });
}

console.log('PASS: island + ambient layer + settings registrations; per-char rAF spans (no CSS animation); clamp; freeze/disable/prefs/styles/font; layered breathing halo (4 layers, relay, hue drift, line ripple, pace presets, theme/cover/off); smooth expand (grid 0fr->1fr animates intrinsic height, monotonic total height, hover hysteresis, collapsed stays text-wide, collapsed controls inert); centred lyric window incl. song start/end; transport controls (play/pause/next/prev, ±5s seek with clamping and capability gating, in-flight guard, propagation stop); entry/exit choreography math matches the reference.');

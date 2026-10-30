// Regression audit: render EVERY state branch of the island, including the ones
// the existing suite never reaches (no track, loading, unmatched, error, and the
// settings view). The capsule-vanished bug lived in exactly such a branch.
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = 'D:\\DeepSeek Harness\\workspace\\plugins_helper\\dsh-netease-lyrics\\lib\\client.js';
const source = fs.readFileSync(SRC, 'utf8');

const store = new Map();
const entries = new Map();
let hookIndex = 0;
let states = [];
let refs = [];
let dirty = false;
let snapshot = null;

const React = {
	createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
	useState: (initial) => {
		const i = hookIndex++;
		if (states[i] === undefined) states[i] = typeof initial === 'function' ? initial() : initial;
		return [i === 1 && snapshot ? snapshot : states[i], (v) => {
			states[i] = typeof v === 'function' ? v(states[i]) : v; dirty = true;
		}];
	},
	useEffect() {},
	useRef: () => { const i = hookIndex++; if (!refs[i]) refs[i] = { current: null }; return refs[i]; },
};

let plugin;
const ctx = {
	window: {
		__ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => ({ default: React })); } },
		dispatchEvent() {}, addEventListener() {}, removeEventListener() {},
	},
	localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) },
	Event: class {}, document: undefined, console,
	setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id),
	fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
	AbortSignal: { timeout: () => undefined },
};
vm.runInNewContext(source, ctx);
plugin.apply({ slots: { inject: (_, cb) => cb(), register: (o, c) => { entries.set(o.key || o.id || o.name, c); return () => {}; } } });

function render(id) {
	hookIndex = 0; refs = []; dirty = false;
	let out = entries.get(id)();
	let guard = 0;
	while (dirty && guard++ < 20) { hookIndex = 0; dirty = false; out = entries.get(id)(); }
	return out;
}
// Fresh mount: clears hook state, then renders (interaction tests start here).
function mount(id) {
	hookIndex = 0; states = []; refs = []; dirty = false;
	return render(id);
}
function walk(root) {
	if (!root || typeof root !== 'object') return [];
	if (Array.isArray(root)) return root.flatMap(walk);
	if (typeof root.type === 'function') return walk(root.type({ ...root.props, children: root.children }));
	return [root, ...(root.children || []).flatMap(walk)];
}

const results = [];
function check(name, fn) {
	try {
		const note = fn();
		results.push({ name, ok: true, note: note || '' });
	} catch (err) {
		results.push({ name, ok: false, note: err.message });
	}
}

const BASE = {
	active: true, playing: true, title: '晴天', artist: '周杰伦', album: '叶惠美',
	durationSec: 253, positionSec: 12, rate: 1,
	canToggle: true, canNext: true, canPrev: true, canSeek: true,
	coverSerial: 3, positionEstimated: false, timelineRefreshes: 0,
	lyric: { status: 'matched', source: 'netease', sourceLabel: '网易云', songId: 7,
		songName: '晴天', artistNames: ['周杰伦'], score: 9,
		lines: [{ t: 0, text: '故事的小黄花', trans: 'the little yellow flower' }, { t: 5, text: '从出生那年就飘着' }] },
};
const LINES20 = Array.from({ length: 20 }, (_, i) => ({ t: i * 5, text: '第' + (i + 1) + '句' }));
const LINES20T = Array.from({ length: 20 }, (_, i) => ({ t: i * 5, text: 'line ' + (i + 1), trans: 'trans ' + (i + 1) }));

// ---- every snapshot shape the host can actually send ----------------------
const STATES = {
	'no track at all (active:false)': { active: false },
	'empty object': {},
	'bridge still starting (no lyric key)': { active: true, playing: true, title: 'T', artist: 'A' },
	'lyric idle': { ...BASE, lyric: { status: 'idle' } },
	'lyric loading': { ...BASE, lyric: { status: 'loading' } },
	'lyric unmatched': { ...BASE, lyric: { status: 'unmatched', attempts: [{ source: 'netease', status: 'unmatched', reason: 'no-confident-match' }] } },
	'lyric error': { ...BASE, lyric: { status: 'error', message: 'network down' } },
	'lyric matched, no lines': { ...BASE, lyric: { status: 'matched', lines: [] } },
	'matched, single line': { ...BASE, lyric: { ...BASE.lyric, lines: [{ t: 0, text: 'only' }] } },
	'matched, no translation': { ...BASE, lyric: { ...BASE.lyric, lines: LINES20 } },
	'matched, with translation': { ...BASE, lyric: { ...BASE.lyric, lines: LINES20T } },
	'paused': { ...BASE, playing: false },
	'zero duration (KuGou)': { ...BASE, durationSec: 0, positionSec: 0, positionEstimated: true, canSeek: false },
	'position past the end': { ...BASE, positionSec: 999 },
	'negative position': { ...BASE, positionSec: -5 },
	'no cover': { ...BASE, coverSerial: 0 },
	'player refuses everything': { ...BASE, canToggle: false, canNext: false, canPrev: false, canSeek: false },
	'huge title': { ...BASE, title: 'A'.repeat(300), artist: 'B'.repeat(300) },
	'emoji title': { ...BASE, title: '🌧️ 雨天', artist: '🎵' },
	'unsynced local lyric': { ...BASE, lyric: { ...BASE.lyric, source: 'local', sourceLabel: '本地文件（无时间轴）', unsynced: true, lines: LINES20 } },
};

for (const [label, snap] of Object.entries(STATES)) {
	check('island renders: ' + label, () => {
		snapshot = snap;
		const tree = render('dsh-netease-lyrics-island');
		if (snap.active !== true) {
			if (tree !== null) throw new Error('expected null for inactive, got a tree');
			return 'null (hidden) as intended';
		}
		if (!tree) throw new Error('returned nothing for an active track');
		const nodes = walk(tree);
		const island = nodes.find(n => String(n.props.className || '').startsWith('dnl-island'));
		if (!island) throw new Error('no .dnl-island in the tree');
		return nodes.length + ' nodes';
	});

	check('ambient layer renders: ' + label, () => {
		snapshot = snap;
		const tree = render('dsh-netease-lyrics-layer');
		if (snap.active !== true) return 'null as intended';
		if (!tree) throw new Error('returned nothing');
		return 'ok';
	});
}

// ---- expansion, settings view, controls -----------------------------------
check('collapsed shows the lyric row and is not expanded', () => {
	states = []; refs = []; hookIndex = 0; dirty = false;
	snapshot = { ...BASE, lyric: { ...BASE.lyric, lines: LINES20T } };
	let tree = mount('dsh-netease-lyrics-island');
	const nodes = walk(tree);
	if (!nodes.some(n => n.props.className === 'dnl-crossfade')) throw new Error('no lyric row');
	const island = nodes.find(n => String(n.props.className || '').startsWith('dnl-island'));
	if (island.props.className.includes('dnl-expanded')) throw new Error('island starts expanded');
	const grow = nodes.find(n => String(n.props.className || '').includes('dnl-grow'));
	if (!grow || grow.props.inert !== '') throw new Error('collapsed panel is not inert');
	return 'collapsed, lyric row visible, panel inert';
});

check('expanded shows the panel and 9 rows', () => {
	snapshot = { ...BASE, lyric: { ...BASE.lyric, lines: LINES20T } };
	let tree = mount('dsh-netease-lyrics-island');
	walk(tree).find(n => String(n.props.className || '').startsWith('dnl-island')).props.onMouseEnter();
	tree = render('dsh-netease-lyrics-island');
	const nodes = walk(tree);
	const rows = nodes.filter(n => /(^|\s)dnl-line(\s|$)/.test(String(n.props.className || '')));
	if (rows.length !== 9) throw new Error('expected 9 rows, got ' + rows.length);
	const active = rows.findIndex(r => String(r.props.className).includes('dnl-line-active'));
	if (active !== 4) throw new Error('active row is #' + active + ', expected 4');
	return '9 rows, active in the middle';
});

check('gear opens and closes the settings view', () => {
	snapshot = { ...BASE };
	let tree = mount('dsh-netease-lyrics-island');
	walk(tree).find(n => String(n.props.className || '').startsWith('dnl-island')).props.onMouseEnter();
	tree = render('dsh-netease-lyrics-island');
	let nodes = walk(tree);
	const gear = nodes.find(n => String(n.props.className || '').includes('dnl-gear'));
	if (!gear) throw new Error('no gear in the lyrics view');
	gear.props.onClick({ stopPropagation() {} });
	tree = render('dsh-netease-lyrics-island');
	nodes = walk(tree);
	if (!nodes.some(n => n.props.className === 'dnl-settings')) throw new Error('settings view did not open');
	const back = nodes.find(n => String(n.props.className || '').includes('dnl-gear'));
	if (!back) throw new Error('no way back');
	back.props.onClick({ stopPropagation() {} });
	tree = render('dsh-netease-lyrics-island');
	nodes = walk(tree);
	if (!nodes.some(n => n.props.className === 'dnl-panel-body')) throw new Error('did not return to lyrics');
	return 'open/close both ways';
});

check('five transport buttons with capability gating', () => {
	snapshot = { ...BASE };
	let tree = mount('dsh-netease-lyrics-island');
	walk(tree).find(n => String(n.props.className || '').startsWith('dnl-island')).props.onMouseEnter();
	tree = render('dsh-netease-lyrics-island');
	const nodes = walk(tree);
	const labels = ['后退 5 秒', '上一首', '暂停', '下一首', '前进 5 秒'];
	for (const l of labels) {
		const b = nodes.find(n => n.props['aria-label'] === l);
		if (!b) throw new Error('missing button: ' + l);
		if (b.props.disabled) throw new Error(l + ' should be enabled');
	}
	return labels.join(' / ');
});

check('collapsed controls are inert', () => {
	snapshot = { ...BASE };
	const nodes = walk(mount('dsh-netease-lyrics-island'));
	const ctls = nodes.filter(n => String(n.props.className || '').includes('dnl-ctl'));
	if (ctls.length && !ctls.every(b => b.props.disabled)) throw new Error('collapsed buttons are clickable');
	const grow = nodes.find(n => String(n.props.className || '').includes('dnl-grow'));
	if (!grow || grow.props.inert !== '') throw new Error('collapsed wrapper is not inert');
	return 'disabled + inert';
});

// ---- no-crash sweep over hostile input ------------------------------------
check('survives null/NaN/string garbage in the snapshot', () => {
	snapshot = { active: true, playing: 'yes', title: null, artist: undefined, durationSec: 'abc',
		positionSec: null, canToggle: 'x', coverSerial: 'y',
		lyric: { status: 'matched', lines: [null, { t: 'a', text: null }, { t: 1, text: 'ok', trans: 5 }] } };
	const tree = render('dsh-netease-lyrics-island');
	if (!tree) throw new Error('crashed on garbage input');
	return 'ok';
});

check('survives a lyric object with a non-array lines field', () => {
	snapshot = { ...BASE, lyric: { status: 'matched', lines: 'not an array' } };
	const tree = render('dsh-netease-lyrics-island');
	if (!tree) throw new Error('crashed');
	return 'ok';
});

// ---- report ---------------------------------------------------------------
let failed = 0;
for (const r of results) {
	if (!r.ok) failed += 1;
	console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.note ? '  [' + r.note + ']' : ''));
}
console.log('');
console.log(failed === 0
	? 'ALL ' + results.length + ' RENDER-AUDIT CHECKS PASS'
	: failed + ' of ' + results.length + ' FAILED');
process.exit(failed === 0 ? 0 : 1);

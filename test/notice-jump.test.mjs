// notice-jump.test.mjs — the v0.4.17 notices click-to-jump contract (12716b7),
// contributed by the dsh-lyin-sessions-manager session. Behavioural proof of:
//   1. a notice WITH sessionId renders a jumpable row (class + title + onClick);
//   2. click prefers window.__dshSessionsManager.openSession (lyin plugin);
//   3. a falsey/throwing capability falls back to core uiWorkspace.openSession;
//   4. the notice is acked ({sessionIds:[sid]}) ONLY when a jump was issued —
//      otherwise the red dot would clear without the user having seen anything;
//   5. a notice WITHOUT sessionId stays inert: no onClick, no title, no class.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';

let plugin;
const posted = [];        // parsed bodies POSTed to /notice/ack
const openedViaCap = [];  // ids passed to __dshSessionsManager.openSession
const openedViaCore = []; // ids passed to uiWorkspace.openSession
let capMode = 'ok';       // 'ok' → true | 'false' → false | 'throw' | 'absent'
let coreAvailable = true;

const fakeWindow = {
	__ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => ({ default: React })); } },
	addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
	matchMedia: () => ({ matches: true }), innerWidth: 1200, innerHeight: 800,
};

vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
	window: fakeWindow,
	document: undefined, console, AbortController, AbortSignal,
	fetch: (url, options) => {
		if (String(url).includes('/notice/ack')) {
			posted.push(JSON.parse(String(options && options.body)));
		}
		return new Promise(() => {});
	},
	Event: class {},
	localStorage: { getItem: () => null, setItem() {} },
	setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
});

const fakeUiWorkspace = { openSession(id) { openedViaCore.push(id); } };
plugin.apply({ slots: { inject: (_, cb) => cb(), register: () => () => {} },
	get: (name) => (name === 'uiWorkspace' && coreAvailable ? fakeUiWorkspace : undefined) });
const { noticeList } = plugin.__test;

function setCap() {
	if (capMode === 'absent') { delete fakeWindow.__dshSessionsManager; return; }
	fakeWindow.__dshSessionsManager = { openSession(id) {
		openedViaCap.push(id);
		if (capMode === 'throw') throw new Error('cap boom');
		return capMode === 'ok';
	} };
}
function reset() {
	posted.length = 0; openedViaCap.length = 0; openedViaCore.length = 0;
	capMode = 'ok'; coreAvailable = true; setCap();
}
function rowsOf(items) {
	const tree = noticeList(items);
	assert.equal(tree.props.className, 'dnl-notices');
	return tree.props.children[1]; // [head, rows[]]
}
const turnItem = (extra) => ({ workspace: 'beta',
	turnEnd: { turn: 3, outcome: 'completed', at: 1730000000000 }, at: 1730000000000, ...extra });
const fakeEvent = () => { let stopped = false; return { stopPropagation() { stopped = true; }, get stopped() { return stopped; } }; };

// ---- 1. a sessionId row is jumpable -------------------------------------------
reset();
{
	const rows = rowsOf([turnItem({ sessionId: 'sess-1' })]);
	const row = rows[0];
	assert.ok(row.props.className.includes('dnl-notice-row-jump'), 'jumpable row carries the jump class');
	assert.equal(row.props.title, '点击跳转到该会话');
	assert.equal(typeof row.props.onClick, 'function');
}

// ---- 2. healthy capability: preferred, acked, core untouched ------------------
{
	const ev = fakeEvent();
	rowsOf([turnItem({ sessionId: 'sess-1' })])[0].props.onClick(ev);
	assert.equal(ev.stopped, true, 'the click never bubbles to the capsule handlers');
	assert.deepEqual([...openedViaCap], ['sess-1'], 'jump goes through the lyin capability first');
	assert.equal(openedViaCore.length, 0, 'core fallback stays untouched when the capability lands');
	assert.deepEqual([...posted], [{ sessionIds: ['sess-1'] }], 'a landed jump acks exactly that session');
}

// ---- 3. capability says false → core fallback ----------------------------------
reset(); capMode = 'false'; setCap();
{
	rowsOf([turnItem({ sessionId: 'sess-2' })])[0].props.onClick(fakeEvent());
	assert.deepEqual([...openedViaCap], ['sess-2']);
	assert.deepEqual([...openedViaCore], ['sess-2'], 'a falsey capability falls back to the core');
	assert.deepEqual([...posted], [{ sessionIds: ['sess-2'] }], 'the fallback jump still acks');
}

// ---- 4. capability throws → core fallback --------------------------------------
reset(); capMode = 'throw'; setCap();
{
	rowsOf([turnItem({ sessionId: 'sess-3' })])[0].props.onClick(fakeEvent());
	assert.deepEqual([...openedViaCore], ['sess-3'], 'a throwing capability falls back too');
	assert.equal(posted.length, 1);
}

// ---- 5. nothing available → no ack ---------------------------------------------
reset(); capMode = 'absent'; setCap(); coreAvailable = false;
{
	rowsOf([turnItem({ sessionId: 'sess-4' })])[0].props.onClick(fakeEvent());
	assert.equal(openedViaCap.length + openedViaCore.length, 0);
	assert.equal(posted.length, 0, 'no navigation issued → the dot must stay (no ack)');
}

// ---- 6. no sessionId → inert row ------------------------------------------------
reset();
{
	const row = rowsOf([turnItem({})])[0];
	assert.ok(!row.props.className.includes('dnl-notice-row-jump'), 'no sessionId → no jump class');
	assert.equal(row.props.title, undefined);
	assert.equal(row.props.onClick, undefined, 'no sessionId → no click handler at all');
}

// ---- 7. empty-string sessionId is inert too ------------------------------------
{
	const row = rowsOf([turnItem({ sessionId: '' })])[0];
	assert.equal(row.props.onClick, undefined, 'empty sessionId behaves as none');
}

console.log('PASS: notice jump — jumpable-row contract, capability-first fallback chain, ack only on issued jump, inert rows without sessionId.');

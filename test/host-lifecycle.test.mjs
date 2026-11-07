import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createLyricRetry } from '../lib/lyric-retry.js';
import { fingerprintOf } from '../lib/lyric-service.js';
import { ackNotices, applyNoticeEvent, basenameOf, createNoticeState, disposeSessionNotices, noticesForWire, workspaceTitleFor } from '../lib/notice-aggregate.js';

// Evaluate the host with inert IO and a Windows platform on every test machine.
// No real PowerShell process, filesystem writes, network requests or timers run.
const source = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
	.replace(/^import .*;\r?$/gm, '')
	.replace('fileURLToPath(import.meta.url)', JSON.stringify('/plugin/lib/index.js'))
	.replace('export function __setSpawnForTests', 'function __setSpawnForTests')
	.replace('export default {', 'globalThis.plugin = {');

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function makeHarness() {
	const timers = new Set();
	const spawned = [];
	const services = [];
	const registered = new Map();
	const listeners = new Map();
	const schedule = (fn, ms) => {
		const timer = { fn, ms, unref() {} };
		timers.add(timer);
		return timer;
	};
	const cancel = timer => timers.delete(timer);
	function fakeSpawn() {
		const proc = new EventEmitter();
		proc.pid = 1000 + spawned.length;
		proc.stdout = new EventEmitter();
		proc.stderr = new EventEmitter();
		proc.stdout.setEncoding = proc.stderr.setEncoding = () => {};
		proc.stdin = new EventEmitter();
		proc.stdin.destroyed = false;
		proc.written = [];
		proc.stdin.write = line => { proc.written.push(JSON.parse(line)); return true; };
		proc.stdin.end = () => { proc.ended = true; };
		proc.kill = () => { proc.killed = true; };
		spawned.push(proc);
		return proc;
	}
	const context = vm.createContext({
		fs: { appendFileSync() {}, statSync() { return { isDirectory: () => false, isFile: () => true }; } },
		os: { homedir: () => '/home' }, path, spawn: fakeSpawn,
		process: { platform: 'win32', env: {}, pid: 42 },
		console: { log() {}, warn() {} }, Buffer, URL,
		setTimeout: schedule, clearTimeout: cancel, fingerprintOf, createLyricRetry,
		ackNotices, applyNoticeEvent, basenameOf, createNoticeState, disposeSessionNotices, noticesForWire, workspaceTitleFor,
		createLyricService(options) {
			const service = {
				options, requests: [], invalidated: [],
				resolve(facts) {
					return new Promise((resolve, reject) => service.requests.push({ facts, resolve, reject }));
				},
				invalidate(fp) { service.invalidated.push(fp); },
				describe() { return {}; },
			};
			services.push(service);
			return service;
		},
	});
	vm.runInContext(source, context, { filename: 'host-lifecycle-index.js' });
	function apply() {
		let cleanup;
		const webServer = {
			register(route) {
				registered.set(route.path, route.handler);
				return () => { if (registered.get(route.path) === route.handler) registered.delete(route.path); };
			},
		};
		const root = {
			effect(fn) { cleanup = fn(); },
			inject(_services, callback) { callback({ webServer }); },
			get: () => webServer, webServer,
			// Real cordis returns a disposer from ctx.on; the notice wiring
			// pushes that into its disposers, so simulate the same contract.
			on(name, listener) {
				const list = listeners.get(name) ?? (listeners.set(name, []), listeners.get(name));
				list.push(listener);
				return () => {
					const at = list.indexOf(listener);
					if (at >= 0) list.splice(at, 1);
				};
			},
		};
		context.plugin.apply(root, { localLyrics: false, maxAutoRetries: 2, retryDelayMs: 5000 });
		return () => cleanup();
	}
	function response() {
		return { writeHead(code) { this.code = code; }, end(body) { this.body = String(body); } };
	}
	function state() {
		const res = response();
		registered.get('/dsh-netease-lyrics/state.json')({ headers: { host: '127.0.0.1:19387' } }, res);
		return JSON.parse(res.body);
	}
	function coverResponse() {
		const res = response();
		registered.get('/dsh-netease-lyrics/cover.png')({ headers: { host: '127.0.0.1:19387' } }, res);
		return res;
	}
	function command(cmd = 'toggle') {
		const req = new EventEmitter();
		req.method = 'POST';
		req.headers = { host: '127.0.0.1:19387' };
		const res = response();
		const done = registered.get('/dsh-netease-lyrics/control')(req, res);
		req.emit('data', Buffer.from(JSON.stringify({ cmd })));
		req.emit('end');
		return { done, res };
	}
	function emit(proc, message) { proc.stdout.emit('data', JSON.stringify(message) + '\n'); }
	function fire(timer) { assert(timers.delete(timer), 'timer is scheduled'); timer.fn(); }
	return { apply, state, coverResponse, command, emit, fire, timers, spawned, services, listeners, registered };
}

const track = (title = 'Song', durationSec = 200) => ({
	type: 'state', active: true, title, artist: 'Artist', album: 'Album', app: 'cloudmusic', durationSec,
});
const matched = name => ({ status: 'matched', songName: name, lines: [{ t: 0, text: name }] });

// A failed spawn has no exit event: error + close must schedule exactly one restart.
{
	const h = makeHarness();
	const dispose = h.apply();
	const failed = h.spawned[0];
	failed.pid = undefined;
	failed.emit('error', new Error('ENOENT'));
	const restart = [...h.timers].find(timer => timer.ms === 1600);
	assert(restart, 'spawn error schedules a restart without waiting for exit');
	failed.emit('close', -2);
	assert.equal([...h.timers].filter(timer => timer.ms === 1600).length, 1, 'close does not duplicate restart');
	assert.equal(h.state().bridge, 'down');
	h.fire(restart);
	assert.equal(h.spawned.length, 2, 'restart replaces the failed spawn');
	h.emit(h.spawned[1], { type: 'ready' });
	assert.equal(h.state().bridge, 'up');
	dispose();
}

// Async pipe errors are handled and release in-flight commands before retrying.
{
	const h = makeHarness();
	const dispose = h.apply();
	const proc = h.spawned[0];
	const request = h.command();
	await flush();
	assert.equal(proc.written.length, 1);
	proc.stdin.emit('error', new Error('EPIPE'));
	await request.done;
	assert.equal(JSON.parse(request.res.body).reason, 'bridge-stdin-error');
	assert.equal(proc.killed, true, 'unusable child is terminated');
	proc.emit('exit', 1);
	proc.emit('close', 1);
	assert.equal([...h.timers].filter(timer => timer.ms === 1600).length, 1, 'one restart for pipe error and exit');
	dispose();
}

// A retired child must not publish data or fail the replacement's commands.
{
	const h = makeHarness();
	const firstDispose = h.apply();
	const oldProc = h.spawned[0];
	const oldRequest = h.command();
	await flush();
	firstDispose();
	await oldRequest.done;
	assert.equal(JSON.parse(oldRequest.res.body).reason, 'bridge-stopped');
	const dispose = h.apply();
	const proc = h.spawned[1];
	h.emit(proc, track('Replacement'));
	const request = h.command();
	await flush();
	// Keep a partial current line while stale stdout/exit arrive.
	proc.stdout.emit('data', '{"type":"ack","id":');
	h.emit(oldProc, track('Stale'));
	oldProc.stderr.emit('data', 'stale stderr');
	oldProc.emit('error', new Error('stale child error'));
	oldProc.stdin.emit('error', new Error('stale pipe error'));
	oldProc.emit('exit', 1);
	oldProc.emit('close', 1);
	assert.equal(h.state().bridge, 'up');
	assert.equal(h.state().title, 'Replacement');
	assert.equal(h.state().detail, '');
	assert.equal([...h.timers].some(timer => timer.ms === 1600), false, 'old exit cannot schedule restart');
	proc.stdout.emit('data', JSON.stringify(proc.written[0].id) + ',"ok":true}\n');
	await request.done;
	assert.equal(JSON.parse(request.res.body).ok, true, 'new command and partial stdout survive old exit');
	dispose();
}

// Late lyric completions stay inert across teardown and same-track re-enable.
{
	const h = makeHarness();
	const firstDispose = h.apply();
	h.emit(h.spawned[0], track());
	const old = h.services[0].requests[0];
	firstDispose();
	old.resolve({ status: 'error' });
	await flush();
	assert.equal([...h.timers].some(timer => timer.ms === 5000), false, 'disabled plugin cannot schedule lyric retry');
	const dispose = h.apply();
	h.emit(h.spawned[1], track());
	assert.equal(h.services[1].requests.length, 1, 'same track resolves freshly on enable');
	h.services[1].requests[0].resolve(matched('Current'));
	await flush();
	assert.equal(h.state().lyric.songName, 'Current');
	dispose();
}

// An old application's promise resolving after re-enable cannot overwrite it.
{
	const h = makeHarness();
	const firstDispose = h.apply();
	h.emit(h.spawned[0], track());
	firstDispose();
	const dispose = h.apply();
	h.emit(h.spawned[1], track());
	h.services[1].requests[0].resolve(matched('New application'));
	await flush();
	h.services[0].requests[0].resolve({ status: 'unmatched' });
	await flush();
	assert.equal(h.state().lyric.songName, 'New application');
	assert.equal(h.state().retry.pending, false);
	dispose();
}

// Version/duration changes resolve again even with the same search fingerprint.
{
	const h = makeHarness();
	const dispose = h.apply();
	const proc = h.spawned[0];
	const service = h.services[0];
	h.emit(proc, track('Song', 0));
	h.emit(proc, track('Song', 0));
	assert.equal(service.requests.length, 1, 'identical polls do not re-resolve');
	h.emit(proc, track('Song', 200));
	assert.equal(service.requests.length, 2, 'newly known duration starts a new resolve');
	h.emit(proc, track('Song (Live)', 200));
	assert.equal(service.requests.length, 3, 'version label starts a new resolve');
	assert.equal(fingerprintOf('Song', 'Artist'), fingerprintOf('Song (Live)', 'Artist'), 'test exercises a fingerprint collision');
	service.requests[2].resolve(matched('Live'));
	await flush();
	service.requests[0].resolve({ status: 'unmatched' });
	service.requests[1].reject(new Error('late studio lookup'));
	await flush();
	assert.equal(h.state().lyric.songName, 'Live', 'old version success/error cannot overwrite latest observation');
	assert.equal(h.state().retry.pending, false);
	// Retry invalidation retains the service's normalized fingerprint contract.
	h.emit(proc, track('Song (Remix)', 200));
	service.requests[3].resolve({ status: 'unmatched' });
	await flush();
	h.fire([...h.timers].find(timer => timer.ms === 5000));
	assert.equal(service.invalidated[0], fingerprintOf('Song (Remix)', 'Artist'));
	assert.equal(service.requests[4].facts.title, 'Song (Remix)');
	assert.equal(service.requests[4].facts.durationSec, 200);
	dispose();
}

// Each application disposes its own lyric service and opts into latest-only work.
{
	const h = makeHarness();
	const firstDispose = h.apply();
	const firstService = h.services[0];
	assert.equal(firstService.options.latestOnly, true);
	let firstDisposals = 0;
	firstService.dispose = () => { firstDisposals++; };
	firstDispose();
	assert.equal(firstDisposals, 1, 'teardown disposes its captured service');
	const dispose = h.apply();
	const secondService = h.services[1];
	let secondDisposals = 0;
	secondService.dispose = () => { secondDisposals++; };
	firstDispose();
	assert.equal(secondDisposals, 0, 'old cleanup cannot dispose a replacement service');
	dispose();
	assert.equal(secondDisposals, 1);
}

// Explicit clears remove old artwork even when the next track has no thumbnail.
{
	const h = makeHarness();
	const dispose = h.apply();
	const proc = h.spawned[0];
	const keyA = JSON.stringify(['cloudmusic', 'A', 'Artist', 'Album']);
	const keyB = JSON.stringify(['qqmusic', 'B', 'Artist', 'Album']);
	h.emit(proc, { type: 'cover', hash: keyA, cleared: true });
	h.emit(proc, { type: 'cover', hash: keyA, mime: 'image/png', dataBase64: Buffer.from('art-a').toString('base64') });
	h.emit(proc, track('A'));
	const firstSerial = h.state().coverSerial;
	assert(firstSerial > 0);
	assert.equal(h.coverResponse().body, 'art-a');
	h.emit(proc, { type: 'cover', hash: keyB, cleared: true });
	h.emit(proc, { ...track('B'), app: 'qqmusic' });
	assert.equal(h.state().coverSerial, 0, 'track without artwork does not expose prior serial');
	assert.equal(h.coverResponse().code, 404, 'old cover bytes are no longer served');
	// A later successful bridge retry publishes a fresh serial and fresh bytes.
	h.emit(proc, { type: 'cover', hash: keyB, mime: 'image/png', dataBase64: Buffer.from('art-b').toString('base64') });
	assert(h.state().coverSerial > firstSerial, 'serials remain unique across clears');
	assert.equal(h.coverResponse().body, 'art-b');
	h.emit(proc, { type: 'cover', hash: '', cleared: true });
	h.emit(proc, { type: 'state', active: false });
	assert.equal(h.state().coverSerial, 0, 'session loss clears artwork');
	assert.equal(h.coverResponse().code, 404);
	dispose();
}

// Workspace notices: globally observed session events surface in state.json,
// following the settle semantics (question → answered/rejected, round ended →
// next round starts). This is the host-side integration of the v0.4.0 module.
{
	const h = makeHarness();
	const dispose = h.apply();
	const session = { id: 'session-1', header: { cwd: 'D:\\ws\\alpha' } };
	const fire = (name, event) => h.listeners.get(name).at(-1)(session, event);

	// ask_user_question opens a question notice; a reply settles it.
	fire('session/event', { type: 'tool/call', data: { name: 'ask_user_question', callId: 'c1',
		arguments: JSON.stringify({ questions: [{ id: 'q1', question: '要继续吗？' }] }) } });
	let notice = h.state().notice;
	assert.equal(notice.items.length, 1, 'the question appears in state.json');
	assert.equal(notice.items[0].workspace, 'alpha', 'title falls back to the cwd basename without a registry');
	assert.equal(notice.items[0].question.kind, 'user-question');
	assert.equal(notice.items[0].question.preview, '要继续吗？');
	fire('session/event', { type: 'user/message', data: { id: 'm1',
		source: { kind: 'user-question-reply', callId: 'c1' }, content: [] } });
	assert.equal(h.state().notice.items.length, 0, 'a reply settles the question notice');

	// approval asked → decided (the never-policy back-to-back pair) nets to nothing.
	fire('session/event', { type: 'approval/asked', data: { id: 'a1', toolName: 'pwsh', reason: 'run command' } });
	fire('session/event', { type: 'approval/decided', data: { id: 'a1', outcome: 'rejected' } });
	assert.equal(h.state().notice.items.length, 0, 'a decided approval leaves no notice');

	// turn/end reports the round; turn/start retires the stale ending.
	fire('session/event', { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } });
	notice = h.state().notice;
	assert.equal(notice.items.length, 1);
	assert.equal(notice.items[0].turnEnd.turn, 3);
	assert.equal(notice.items[0].turnEnd.outcome, 'completed');
	assert.ok(notice.serial > 0, 'the serial advances with the state');
	fire('session/event', { type: 'turn/start', data: { turn: 4 } });
	assert.equal(h.state().notice.items.length, 0, 'the next round starting retires the stale ending');

	// Subagent (child) sessions never generate notices.
	const child = { id: 'session-2', header: { cwd: 'D:\\ws\\alpha', parentSession: 'session-1' } };
	h.listeners.get('session/event').at(-1)(child, { type: 'turn/end', data: { turn: 9, reason: { kind: 'completed' } } });
	assert.equal(h.state().notice.items.length, 0, 'child sessions are ignored');

	// session/disposed drops a still-pending question.
	fire('session/event', { type: 'tool/call', data: { name: 'ask_user_question', callId: 'c2',
		arguments: JSON.stringify({ questions: [{ id: 'q2', question: '确认？' }] }) } });
	assert.equal(h.state().notice.items.length, 1);
	h.listeners.get('session/disposed').at(-1)(session);
	assert.equal(h.state().notice.items.length, 0, 'a disposed session drops its notices');

	// POST /notice/ack consumes the round-ending notices (never questions);
	// v0.4.4 adds an optional sessionIds scope consumed only for those
	// sessions (the "user switched into this workspace" ack).
	fire('session/event', { type: 'tool/call', data: { name: 'ask_user_question', callId: 'c3',
		arguments: JSON.stringify({ questions: [{ id: 'q3', question: '再问一次？' }] }) } });
	fire('session/event', { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } });
	h.listeners.get('session/event').at(-1)({ id: 'session-other', header: { cwd: 'D:\\ws\\beta' } },
		{ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } });
	const mkResponse = () => ({ writeHead(code) { this.code = code; }, end(body) { this.body = String(body); } });
	const ackPost = async (body) => {
		const req = new EventEmitter();
		req.method = 'POST';
		req.headers = { host: '127.0.0.1:19387' };
		const res = mkResponse();
		const done = h.registered.get('/dsh-netease-lyrics/notice/ack')(req, res);
		if (body !== undefined) req.emit('data', Buffer.from(body));
		req.emit('end');
		await done;
		return res;
	};
	// Scoped ack on the OTHER session: only its ending drops.
	const scopedRes = await ackPost('{"sessionIds":["session-other"]}');
	assert.equal(JSON.parse(scopedRes.body).ok, true);
	assert.equal(JSON.parse(scopedRes.body).dropped, true, 'the scoped ack dropped the other session');
	let items = h.state().notice.items;
	assert.equal(items.length, 1, 'the unscoped session keeps its notices through a scoped ack');
	assert.equal(items[0].sessionId, 'session-1');
	assert.ok(items[0].question !== null);
	assert.ok(items[0].turnEnd !== null, 'another session remains untouched');
	// Unscoped list-read ack: consumes the remaining round ending.
	const ackRes = await ackPost('{}');
	assert.equal(JSON.parse(ackRes.body).ok, true);
	assert.equal(JSON.parse(ackRes.body).dropped, true, 'the ack dropped the round ending');
	items = h.state().notice.items;
	assert.equal(items.length, 1);
	assert.ok(items[0].question, 'the question survives the ack');
	assert.equal(items[0].turnEnd, null);
	// Empty body is the unscoped ack; a malformed scope is rejected.
	const badRes = await ackPost('{"sessionIds":[]}');
	assert.equal(badRes.code, 400, 'an empty scope reads as a bad request');
	const badJsonRes = await ackPost('{not json');
	assert.equal(badJsonRes.code, 400, 'bad json rejected');
	// GET is rejected (method not allowed).
	const getRes = mkResponse();
	h.registered.get('/dsh-netease-lyrics/notice/ack')({ method: 'GET', headers: { host: '127.0.0.1:19387' } }, getRes);
	assert.equal(getRes.code, 405, 'ack is POST-only');

	// Teardown unsubscribes both observers.
	dispose();
	assert.equal(h.listeners.get('session/event').length, 0, 'teardown unsubscribes session/event');
	assert.equal(h.listeners.get('session/disposed').length, 0, 'teardown unsubscribes session/disposed');
}

console.log('PASS: host lifecycle — failed spawn, pipe error, retired child, teardown, stale promises, version/duration observation identity, service disposal, artwork clear protocol.');

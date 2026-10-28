import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import vm from 'node:vm';

// Host-half test for the transport route: /control must reject cross-site and
// non-loopback callers, only accept the whitelisted commands, and forward the
// command to the bridge over stdin, matching the ack by id.
const registered = new Map();
const spawned = [];

const fakeWebServer = {
	register(route) { registered.set(route.path, route.handler); return () => registered.delete(route.path); },
};

// A fake bridge child: records stdin writes and lets the test answer with an ack.
function makeFakeProc() {
	const proc = new EventEmitter();
	proc.pid = 4242;
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.stdout.setEncoding = () => {};
	proc.stderr.setEncoding = () => {};
	const written = [];
	proc.stdin = {
		destroyed: false,
		write(chunk) { written.push(chunk); return true; },
		end() {},
	};
	proc.kill = () => {};
	proc.written = written;
	return proc;
}

const pluginModule = await import('../lib/index.js');
pluginModule.__setSpawnForTests?.((cmd, args, options) => {
	const proc = makeFakeProc();
	spawned.push(proc);
	// Report ready on the next tick, as the real bridge does.
	queueMicrotask(() => proc.stdout.emit('data', JSON.stringify({ type: 'ready', pollMs: 500 }) + '\n'));
	return proc;
});

const fakeRoot = {
	inject(services, cb) { cb({ webServer: fakeWebServer }); },
	get(name) { return name === 'webServer' ? fakeWebServer : undefined; },
	webServer: fakeWebServer,
	logger: { info() {}, warn() {}, error() {} },
};
pluginModule.default.apply(fakeRoot);
await new Promise(resolve => setTimeout(resolve, 20));

assert(registered.has('/dsh-netease-lyrics/control'), '/control route registered');

function makeRes() {
	const res = {
		statusCode: 0, headers: {}, body: '',
		writeHead(code, headers) { res.statusCode = code; res.headers = headers || {}; },
		end(body) { res.body = body === undefined ? '' : String(body); },
	};
	return res;
}
function makeReq(method, body, headers) {
	const req = new EventEmitter();
	req.method = method;
	req.headers = Object.assign({ host: '127.0.0.1:19387' }, headers || {});
	req.resume = () => {};
	setImmediate(() => {
		if (body !== undefined) req.emit('data', Buffer.from(body));
		req.emit('end');
	});
	return req;
}
const json = res => JSON.parse(res.body || '{}');

// 1. Method guard.
{
	const res = makeRes();
	await registered.get('/dsh-netease-lyrics/control')(makeReq('GET', undefined), res);
	assert.equal(res.statusCode, 405, 'GET is not allowed');
}

// 2. Cross-site and non-loopback callers are refused.
{
	let res = makeRes();
	await registered.get('/dsh-netease-lyrics/control')(
		makeReq('POST', '{"cmd":"toggle"}', { 'sec-fetch-site': 'cross-site' }), res);
	assert.equal(res.statusCode, 403, 'cross-site denied');

	res = makeRes();
	await registered.get('/dsh-netease-lyrics/control')(
		makeReq('POST', '{"cmd":"toggle"}', { host: '192.168.1.5:19387' }), res);
	assert.equal(res.statusCode, 403, 'non-loopback denied');
}

// 3. Only whitelisted commands reach the bridge.
{
	for (const cmd of ['seek', 'shutdown', 'exec', '']) {
		const res = makeRes();
		await registered.get('/dsh-netease-lyrics/control')(
			makeReq('POST', JSON.stringify({ cmd })), res);
		assert.equal(res.statusCode, 400, 'rejected command: ' + JSON.stringify(cmd));
	}
	const proc = spawned[spawned.length - 1];
	assert.equal(proc.written.length, 0, 'no stdin traffic for rejected commands');
}

// 4. A valid command is forwarded with an id, and the ack resolves the request.
{
	const proc = spawned[spawned.length - 1];
	const before = proc.written.length;
	const res4 = makeRes();
	const pending = registered.get('/dsh-netease-lyrics/control')(makeReq('POST', '{"cmd":"toggle"}'), res4);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(proc.written.length, before + 1, 'one command written to the bridge');
	const sent = JSON.parse(proc.written[proc.written.length - 1]);
	assert.equal(sent.cmd, 'toggle');
	assert.equal(typeof sent.id, 'string', 'command carries a correlation id');

	// Answer as the bridge would.
	proc.stdout.emit('data', JSON.stringify({ type: 'ack', id: sent.id, cmd: 'toggle', ok: true, via: 'explicit' }) + '\n');
	await pending;
	const res = res4;
	assert.equal(res.statusCode, 200);
	assert.equal(json(res).ok, true, 'ack delivered to the caller');
	assert.equal(json(res).via, 'explicit');
}

// 5. A refusal from the bridge is reported, not turned into an error.
{
	const proc = spawned[spawned.length - 1];
	const res5 = makeRes();
	const pending = registered.get('/dsh-netease-lyrics/control')(makeReq('POST', '{"cmd":"next"}'), res5);
	await new Promise(resolve => setImmediate(resolve));
	const sent = JSON.parse(proc.written[proc.written.length - 1]);
	proc.stdout.emit('data', JSON.stringify({ type: 'ack', id: sent.id, cmd: 'next', ok: false, reason: 'no-session' }) + '\n');
	await pending;
	const res = res5;
	assert.equal(res.statusCode, 200, 'a refusal is still a 200');
	assert.equal(json(res).ok, false);
	assert.equal(json(res).reason, 'no-session');
}

// 6. An ack with an unknown id is ignored rather than crashing.
{
	const proc = spawned[spawned.length - 1];
	proc.stdout.emit('data', JSON.stringify({ type: 'ack', id: 'nope', cmd: 'toggle', ok: true }) + '\n');
	proc.stdout.emit('data', JSON.stringify({ type: 'ack', cmd: 'toggle', ok: true }) + '\n');
	assert(true, 'stray acks are ignored');
}

// 7. A bridge that dies while a command is in flight resolves the waiter.
{
	const proc = spawned[spawned.length - 1];
	const res7 = makeRes();
	const pending = registered.get('/dsh-netease-lyrics/control')(makeReq('POST', '{"cmd":"prev"}'), res7);
	await new Promise(resolve => setImmediate(resolve));
	proc.emit('exit', 1);
	await pending;
	const res = res7;
	assert.equal(json(res).ok, false);
	assert.equal(json(res).reason, 'bridge-exited', 'waiter released when the bridge exits');
}

console.log('PASS: /control route (method + fence + whitelist, id-correlated ack, refusal reported, stray ack ignored, bridge exit releases waiter).');

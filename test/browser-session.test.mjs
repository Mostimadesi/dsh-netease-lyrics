import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

// Host-half test for the browser-session reports (v0.4.12): validation of the
// extension payload, freshness TTL, the bvid gate (browser AUMIDs only, override
// wins), and the dedicated loopback listener's HTTP behaviour.
import {
	handleBrowserSessionReport, freshBrowserSession, computeEffectiveBvid,
	createBrowserSessionRequestHandler,
} from '../lib/index.js';

const registered = new Map();
const fakeWebServer = {
	register(route) { registered.set(route.path, route.handler); return () => registered.delete(route.path); },
};
function makeFakeProc() {
	const proc = new EventEmitter();
	proc.pid = 4242;
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.stdout.setEncoding = () => {};
	proc.stderr.setEncoding = () => {};
	proc.stdin = { destroyed: false, write() { return true; }, end() {} };
	proc.kill = () => {};
	return proc;
}
const pluginModule = await import('../lib/index.js');
pluginModule.__setSpawnForTests?.((cmd, args, options) => {
	const proc = makeFakeProc();
	queueMicrotask(() => proc.stdout.emit('data', JSON.stringify({ type: 'ready', pollMs: 500 }) + '\n'));
	return proc;
});
const fakeRoot = {
	config: { browserSessionPort: 51799 }, // keep the apply-time listener off the default port
	inject(services, cb) { cb({ webServer: fakeWebServer }); },
	get(name) { return name === 'webServer' ? fakeWebServer : undefined; },
	webServer: fakeWebServer,
	logger: { info() {}, warn() {}, error() {} },
};
pluginModule.default.apply(fakeRoot);
await new Promise(resolve => setTimeout(resolve, 20));

// 1. payload validation
assert.equal(handleBrowserSessionReport(null), 'bad payload', 'null payload');
assert.equal(handleBrowserSessionReport([]), 'bad payload', 'array payload');
assert.equal(handleBrowserSessionReport({ bvid: 'BV123' }), 'bad bvid', 'short bvid');
assert.equal(handleBrowserSessionReport({ bvid: 'BV1GJ411x7h7!' }), 'bad bvid', 'invalid bvid');
const T0 = 1_700_000_000_000;
assert.equal(handleBrowserSessionReport({
	bvid: 'BV1GJ411x7h7', title: '视频标题',
	positionSec: 12.3456, durationSec: 213, playing: true,
}, T0), '', 'valid report accepted');
const stored = freshBrowserSession(T0 + 1000);
assert.ok(stored, 'report stored');
assert.equal(stored.bvid, 'BV1GJ411x7h7', 'bvid preserved verbatim (case-sensitive)');
assert.equal(stored.title, '视频标题', 'title preserved');
assert.equal(stored.positionSec, 12.3456, 'position preserved');
assert.equal(stored.durationSec, 213, 'duration preserved');
assert.equal(stored.playing, true, 'playing preserved');
// clamps and coercions
handleBrowserSessionReport({ bvid: 'BV1GJ411x7h7', positionSec: -5, durationSec: 'x', playing: 'yes' }, T0);
const clamped = freshBrowserSession(T0);
assert.equal(clamped.positionSec, 0, 'negative position clamps to 0');
assert.equal(clamped.durationSec, 0, 'non-numeric duration clamps to 0');
assert.equal(clamped.playing, false, 'playing requires true');
assert.equal(clamped.title, '', 'missing title becomes empty');
// long title is truncated to 300 chars
handleBrowserSessionReport({ bvid: 'BV1GJ411x7h7', title: 'x'.repeat(500) }, T0);
assert.equal(freshBrowserSession(T0).title.length, 300, 'title truncated');
// 2. freshness TTL (15s)
handleBrowserSessionReport({ bvid: 'BV1GJ411x7h7' }, T0);
assert.ok(freshBrowserSession(T0), 'report is fresh at its timestamp');
assert.ok(freshBrowserSession(T0 + 14_999), 'fresh inside TTL');
assert.ok(freshBrowserSession(T0 + 15_000), 'edge of TTL still fresh (strictly-greater expiry)');
assert.equal(freshBrowserSession(T0 + 15_001), null, 'expired just past TTL');
assert.equal(freshBrowserSession(T0 + 999_999), null, 'long expired');
// 3. bvid gate: override wins, browser AUMIDs only, non-browser never attaches
const fresh = { bvid: 'BV1GJ411x7h7', updatedAt: T0 };
assert.equal(computeEffectiveBvid('Chrome', 'BV1Override00', fresh), 'BV1Override00', 'override wins');
assert.equal(computeEffectiveBvid('Chrome', '', fresh), 'BV1GJ411x7h7', 'Chrome AUMID attaches');
assert.equal(computeEffectiveBvid('Microsoft.MicrosoftEdge.Stable_8wekyb3d8bbwe!MicrosoftEdge', '', fresh), 'BV1GJ411x7h7', 'Edge store AUMID attaches');
assert.equal(computeEffectiveBvid('Mozilla FireFox', '', fresh), 'BV1GJ411x7h7', 'Firefox AUMID attaches');
assert.equal(computeEffectiveBvid('cloudmusic.exe', '', fresh), '', 'music client never attaches');
assert.equal(computeEffectiveBvid('Chrome', '', null), '', 'no fresh report -> empty');
assert.equal(computeEffectiveBvid('Chrome', '', { bvid: '' }), '', 'report without bvid -> empty');

// 4. HTTP behaviour of the dedicated listener's handler
const handler = createBrowserSessionRequestHandler();
function makeRes() {
	const res = {
		statusCode: 0, headers: {}, body: '',
		writeHead(code, headers) { res.statusCode = code; res.headers = headers || {}; },
		end(body) { res.body = body === undefined ? '' : String(body); },
	};
	return res;
}
function makeReq(method, body, url) {
	const req = new EventEmitter();
	req.method = method;
	req.headers = { host: '127.0.0.1:51799' };
	req.url = url || '/dsh-netease-lyrics/browser-session';
	req.resume = () => {};
	setImmediate(() => {
		if (body !== undefined) req.emit('data', Buffer.from(body));
		req.emit('end');
	});
	return req;
}
await (async () => {
	const res = makeRes();
	await handler(makeReq('POST', JSON.stringify({ bvid: 'BV1AbCdEfGh1', title: 't' })), res);
	assert.equal(res.statusCode, 200, 'valid POST -> 200');
	assert.deepEqual(JSON.parse(res.body), { ok: true }, 'valid POST body');
})();
await (async () => {
	const res = makeRes();
	await handler(makeReq('GET'), res);
	assert.equal(res.statusCode, 405, 'GET -> 405');
})();
await (async () => {
	const res = makeRes();
	await handler(makeReq('POST', '{}', '/dsh-netease-lyrics/other'), res);
	assert.equal(res.statusCode, 404, 'unknown path -> 404');
})();
await (async () => {
	const res = makeRes();
	await handler(makeReq('POST', 'not-json'), res);
	assert.equal(res.statusCode, 400, 'bad json -> 400');
})();
await (async () => {
	const res = makeRes();
	await handler(makeReq('POST', JSON.stringify({ bvid: 'nope' })), res);
	assert.equal(res.statusCode, 400, 'bad bvid -> 400');
	assert.equal(JSON.parse(res.body).error, 'bad bvid', 'error names the problem');
})();
await (async () => {
	const res = makeRes();
	await handler(makeReq('POST', 'x'.repeat(5000)), res);
	assert.equal(res.statusCode, 413, 'oversized body -> 413');
})();

console.log('PASS: browser-session reports — payload validation/clamps, 15s TTL, bvid gate (override > browser AUMID > none), handler method/path/body contracts.');
process.exit(0);

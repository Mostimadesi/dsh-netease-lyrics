import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';

// Host-half test for the browser-session reports (v0.4.12): validation of the
// extension payload, freshness TTL, the bvid gate (browser AUMIDs only, override
// wins), and the dedicated loopback listener's HTTP behaviour.
import {
	handleBrowserSessionReport, freshBrowserSession, computeEffectiveBvid, browserTitlesAgree,
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
// The apply-created lyric service captures globalThis.fetch at creation time:
// stub it BEFORE apply so the end-to-end section below (bridge state line ->
// resolve -> state.json read) never touches the real network.
const realFetch = globalThis.fetch;
const json = (payload) => ({ ok: true, json: async () => payload });
const liveFetch = async (url) => {
	const u = String(url);
	if (u.includes('api.bilibili.com/x/web-interface/view?')) return json({ code: 0, data: {
		bvid: 'BV1GJ411x7h7', cid: 137649199, title: '视频标题', duration: 213, owner: { name: 'UP主' } } });
	if (u.includes('api.bilibili.com/x/web-interface/nav')) return json({ code: 0, data: { isLogin: true, wbi_img: {
		img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
		sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } } });
	if (u.includes('api.bilibili.com/x/player/wbi/v2?')) return json({ code: 0, data: { subtitle: {
		subtitles: [{ lan: 'zh-CN', subtitle_url: '//aisubtitle.hdslb.com/live.json' }] } } });
	if (u.startsWith('https://aisubtitle.hdslb.com/live.json')) return json({ body: [
		{ from: 0.5, to: 3, content: '第一句' }, { from: 5, to: 8, content: '第二句' }] });
	if (u.includes('/api/search/get/web')) return json({ code: 200, result: { songCount: 0 } });
	if (u.includes('/soso/fcgi-bin/client_search_cp')) return json({ code: 0, data: { song: { list: [] } } });
	if (u.includes('songsearch.kugou.com')) return json({ status: 1, data: { lists: [] } });
	if (u.includes('app.u.nf.migu.cn')) return json([]);
	throw new Error('unexpected url ' + u);
};
globalThis.fetch = liveFetch;
let bridgeProc = null;
const pluginModule = await import('../lib/index.js');
pluginModule.__setSpawnForTests?.((cmd, args, options) => {
	const proc = makeFakeProc();
	bridgeProc = proc;
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
// 2. freshness TTL (default 10s = two missed heartbeats; config-clamped 5-60s)
handleBrowserSessionReport({ bvid: 'BV1GJ411x7h7' }, T0);
assert.ok(freshBrowserSession(T0), 'report is fresh at its timestamp');
assert.ok(freshBrowserSession(T0 + 9_999), 'fresh inside TTL');
assert.ok(freshBrowserSession(T0 + 10_000), 'edge of TTL still fresh (strictly-greater expiry)');
assert.equal(freshBrowserSession(T0 + 10_001), null, 'expired just past TTL');
assert.equal(freshBrowserSession(T0 + 999_999), null, 'long expired');
// 3. bvid gate: override wins, browser AUMIDs only, and the reported tab must
// be the SAME page as the SMTC session (a background tab's video must never be
// attached to another session's track — that used to run the slow subtitle
// chain for the wrong media and stall the serialized resolve queue).
const fresh = { bvid: 'BV1GJ411x7h7', title: '靛青宇宙【中文CC字幕】_哔哩哔哩_bilibili', updatedAt: T0 };
const pageTitle = '靛青宇宙【中文CC字幕】';
assert.equal(computeEffectiveBvid('Chrome', 'BV1Override00', fresh, pageTitle), 'BV1Override00', 'override wins');
assert.equal(computeEffectiveBvid('Chrome', '', fresh, pageTitle), 'BV1GJ411x7h7', 'Chrome AUMID + matching title attaches');
assert.equal(computeEffectiveBvid('Microsoft.MicrosoftEdge.Stable_8wekyb3d8bbwe!MicrosoftEdge', '', fresh, pageTitle), 'BV1GJ411x7h7', 'Edge store AUMID attaches');
assert.equal(computeEffectiveBvid('Mozilla FireFox', '', fresh, pageTitle), 'BV1GJ411x7h7', 'Firefox AUMID attaches');
assert.equal(computeEffectiveBvid('cloudmusic.exe', '', fresh, pageTitle), '', 'music client never attaches');
assert.equal(computeEffectiveBvid('Chrome', '', null, pageTitle), '', 'no fresh report -> empty');
assert.equal(computeEffectiveBvid('Chrome', '', { bvid: '' }, pageTitle), '', 'report without bvid -> empty');
assert.equal(computeEffectiveBvid('Chrome', '', fresh, '完全不同的视频'), '', 'a different page title blocks the report');
assert.equal(computeEffectiveBvid('Chrome', '', fresh, ''), '', 'an identity-less session gets no bvid');
assert.equal(computeEffectiveBvid('Chrome', '', fresh, undefined), '', 'missing title -> blocked');
// title agreement accepts the suffix and truncated SMTC forms
assert.equal(browserTitlesAgree('靛青宇宙_哔哩哔哩_bilibili', '靛青宇宙'), true, 'suffix stripped on both sides');
assert.equal(browserTitlesAgree('靛青宇宙', '靛青宇宙【中文CC字幕】_哔哩哔哩_bilibili'), true, 'containment counts');
assert.equal(browserTitlesAgree('靛青宇宙', '别的视频'), false, 'unrelated titles do not agree');
assert.equal(browserTitlesAgree('', 'x'), false, 'empty state title never agrees');
assert.equal(browserTitlesAgree('   ', 'x'), false, 'blank state title never agrees');

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

// 5. end-to-end position feed: the extension report overrides the frozen SMTC
// snapshot for browser sessions in state.json (bilibili's player does not
// keep the SMTC timeline moving — verified live 2026-11-09), while music
// sessions keep their own position even when a report is still fresh.
const reportHandler = createBrowserSessionRequestHandler();
await (async () => {
	const res = makeRes();
	await reportHandler(makeReq('POST', JSON.stringify({
		bvid: 'BV1GJ411x7h7', title: '视频标题', positionSec: 12.345, durationSec: 213, playing: false,
	})), res);
	assert.equal(res.statusCode, 200, 'report accepted before the state line');
})();
bridgeProc.stdout.emit('data', JSON.stringify({
	type: 'state', active: true, app: 'Chrome', title: '视频标题', artist: 'UP主',
	album: '', positionSec: 0, durationSec: 0,
}) + '\n');
await new Promise((resolve) => setTimeout(resolve, 1800)); // bilibili chain (300ms request gaps)
await (async () => {
	const res = makeRes();
	registered.get('/dsh-netease-lyrics/state.json')(makeReq('GET'), res);
	const payload = JSON.parse(res.body);
	assert.equal(payload.lyric.status, 'matched', 'bilibili resolved for the browser track');
	assert.equal(payload.lyric.source, 'bilibili', 'source bilibili');
	assert.equal(payload.positionSec, 12.345, 'extension position overrides the frozen SMTC snapshot');
	assert.equal(payload.durationSec, 213, 'extension duration overrides the SMTC zero');
})();
bridgeProc.stdout.emit('data', JSON.stringify({
	type: 'state', active: true, app: 'cloudmusic.exe', title: '晴天', artist: '周杰伦',
	album: '', positionSec: 3.5, durationSec: 269,
}) + '\n');
await new Promise((resolve) => setTimeout(resolve, 120));
await (async () => {
	const res = makeRes();
	registered.get('/dsh-netease-lyrics/state.json')(makeReq('GET'), res);
	const payload = JSON.parse(res.body);
	assert.equal(payload.positionSec, 3.5, 'music sessions keep the SMTC position');
	assert.equal(payload.durationSec, 269, 'music sessions keep the SMTC duration');
})();
// 6. hardening from the live report (2026-11-09): a report whose tab title is
// a DIFFERENT page must not feed the state, and an identity-less (stale)
// session is published as inactive instead of a "未知曲目" capsule.
bridgeProc.stdout.emit('data', JSON.stringify({
	type: 'state', active: true, app: 'Chrome', title: '另一个视频_哔哩哔哩_bilibili', artist: '',
	album: '', positionSec: 7.5, durationSec: 100,
}) + '\n');
await new Promise((resolve) => setTimeout(resolve, 150));
await (async () => {
	const res = makeRes();
	registered.get('/dsh-netease-lyrics/state.json')(makeReq('GET'), res);
	const payload = JSON.parse(res.body);
	assert.equal(payload.positionSec, 7.5, 'a report for another page never overrides the position');
	assert.equal(payload.durationSec, 100, 'and never overrides the duration');
})();
bridgeProc.stdout.emit('data', JSON.stringify({
	type: 'state', active: true, app: 'Chrome', title: '', artist: '', album: '', positionSec: 0, durationSec: 0,
}) + '\n');
await new Promise((resolve) => setTimeout(resolve, 150));
await (async () => {
	const res = makeRes();
	registered.get('/dsh-netease-lyrics/state.json')(makeReq('GET'), res);
	const payload = JSON.parse(res.body);
	assert.equal(payload.active, false, 'an identity-less browser session is published as inactive');
})();
// ...but a real (music) player with missing metadata keeps its capsule: the
// capsule must never disappear just because a player has no title for a beat.
bridgeProc.stdout.emit('data', JSON.stringify({
	type: 'state', active: true, app: 'cloudmusic.exe', title: '', artist: '', album: '', positionSec: 1, durationSec: 200,
}) + '\n');
await new Promise((resolve) => setTimeout(resolve, 150));
await (async () => {
	const res = makeRes();
	registered.get('/dsh-netease-lyrics/state.json')(makeReq('GET'), res);
	const payload = JSON.parse(res.body);
	assert.equal(payload.active, true, 'an identity-less music session stays visible (未知曲目, not a vanished capsule)');
})();
globalThis.fetch = realFetch;

// 6. the self-heal tuning is pinned (user 2026-11-09: 30s / 2 attempts) and the
// positive lyric cache lives 15 days (user 2026-11-09), both source-level so an
// accidental edit cannot silently change the agreed numbers.
const indexSrc = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
const serviceSrc = fs.readFileSync(new URL('../lib/lyric-service.js', import.meta.url), 'utf8');
assert.match(indexSrc, /ORIGIN_REMATCH_DELAY_MS = 30000\b/, 'the origin rematch waits 30s');
assert.match(indexSrc, /ORIGIN_REMATCH_MAX = 2\b/, 'at most two origin rematches per track');
assert.match(serviceSrc, /SUCCESS_TTL_MS = 15 \* 24 \* 60 \* 60 \* 1000/, 'matched lyrics are cached 15 days');

console.log('PASS: browser-session reports — payload validation/clamps, 10s TTL, bvid gate (override > browser AUMID > none), handler method/path/body contracts, self-heal tuning pins.');
process.exit(0);

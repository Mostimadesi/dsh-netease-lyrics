/**
 * dsh-netease-lyrics — host half.
 *
 * Supervises the persistent Windows PowerShell 5.1 SMTC bridge (borrowed
 * from dsh-netease-island, MIT) and layers the lyric pipeline on top:
 *
 *   SMTC state line ──► fingerprint change? ──► lyric-service.resolve()
 *                                             (search → match → LRC → cache)
 *   Routes under /dsh-netease-lyrics:
 *     GET  /state.json   SMTC snapshot + bridge health + matched lyric
 *     GET  /cover.png    current artwork (immutable per ?v=<serial>)
 *     POST /rematch      drop the cached verdict for the current track
 *                        and re-run search/match (loopback only)
 *
 * The browser half (package.json `dsh.client`) renders the floating lyric
 * island into `shell.overlay` and polls /state.json.
 *
 * Playback state comes from Windows SMTC only — no login, no cookie, no
 * account access. The unpatched NetEase desktop client does not register
 * an SMTC session; the documented prerequisite is BetterNCM + InfLink-rs
 * (see README). Lyrics come from music.163.com's undocumented public
 * endpoints (configurable via apiBase).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLyricService, fingerprintOf } from './lyric-service.js';
import { createLyricRetry } from './lyric-retry.js';

// Boot trace: a host half can fail to mount silently (no route, no bridge,
// nothing in any log). Every mount attempt and outcome is appended here so
// that question stays answerable after the fact.
const TRACE_FILE = path.join(
	process.env.DSH_HOME || path.join(os.homedir() || '.', '.dsh'),
	'dsh-netease-lyrics-boot.log',
);

function trace(message) {
	const line = new Date().toISOString() + ' [pid ' + String(process.pid) + '] ' + message + '\n';
	try { fs.appendFileSync(TRACE_FILE, line); } catch {}
	try { console.log('[dsh-netease-lyrics] ' + message); } catch {}
}

trace('lib/index.js loaded');

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE_SCRIPT = path.join(PACKAGE_ROOT, 'lib', 'smtc-bridge.ps1');
const CACHE_FILE = path.join(
	process.env.DSH_HOME || path.join(os.homedir() || '.', '.dsh'),
	'dsh-netease-lyrics-cache.json',
);

const ROUTE_BASE = '/dsh-netease-lyrics';
const IS_WINDOWS = process.platform === 'win32';
const DEFAULT_POLL_MS = 500;
const DEFAULT_APP_PATTERNS = ['cloudmusic', 'netease', 'com.netease', 'qqmusic', 'kugou'];
const MAX_BODY_BYTES = 4096;
const LOOPBACK_HOSTS = /^(localhost|.*\.localhost|127(\.\d{1,3}){3}|::1)$/;

/** Where the offline fallback looks for a `.lrc` sidecar or tagged audio. */
function defaultLocalDirs() {
	const home = os.homedir() || '';
	if (!home) return [];
	return [path.join(home, 'Music'), path.join(home, 'Downloads')]
		.filter((dir) => { try { return fs.statSync(dir).isDirectory(); } catch { return false; } });
}

const pluginConfig = {
	pollMs: DEFAULT_POLL_MS,
	appPatterns: DEFAULT_APP_PATTERNS.slice(),
	apiBase: 'https://music.163.com',
	showTranslation: false,
	retryDelayMs: 15000,
	maxAutoRetries: 2,
	localLyrics: true,
	localDirs: defaultLocalDirs(),
};

function normalizeConfig(raw) {
	const config = {
		pollMs: DEFAULT_POLL_MS,
		appPatterns: DEFAULT_APP_PATTERNS.slice(),
		apiBase: 'https://music.163.com',
		showTranslation: false,
		retryDelayMs: 15000,
		maxAutoRetries: 2,
		localLyrics: true,
		localDirs: defaultLocalDirs(),
	};
	if (!raw || typeof raw !== 'object') return config;

	const poll = Number(raw.pollMs);
	if (Number.isFinite(poll)) config.pollMs = Math.min(5000, Math.max(200, Math.round(poll)));

	const rawPatterns = Array.isArray(raw.appPatterns)
		? raw.appPatterns
		: (typeof raw.appPatterns === 'string' ? raw.appPatterns.split(',') : null);
	if (rawPatterns) {
		const list = rawPatterns
			.map((value) => String(value == null ? '' : value).trim())
			.filter((value) => value !== '' && /^[\x20-\x7e]+$/.test(value));
		if (list.length) config.appPatterns = list;
	}

	if (typeof raw.apiBase === 'string' && /^https?:\/\/[\x21-\x7e]+$/.test(raw.apiBase.trim())) {
		config.apiBase = raw.apiBase.trim().replace(/\/+$/, '');
	}
	if (typeof raw.showTranslation === 'boolean') config.showTranslation = raw.showTranslation;
	const retryDelay = Number(raw.retryDelayMs);
	if (Number.isFinite(retryDelay)) config.retryDelayMs = Math.min(60000, Math.max(5000, Math.round(retryDelay)));
	const maxAuto = Number(raw.maxAutoRetries);
	if (Number.isFinite(maxAuto)) config.maxAutoRetries = Math.min(5, Math.max(0, Math.round(maxAuto)));
	if (typeof raw.localLyrics === "boolean") config.localLyrics = raw.localLyrics;
	const rawDirs = Array.isArray(raw.localDirs)
		? raw.localDirs
		: (typeof raw.localDirs === "string" ? raw.localDirs.split(",") : null);
	if (rawDirs) {
		const dirs = rawDirs
			.map((value) => String(value == null ? "" : value).trim())
			.filter((value) => value !== "" && value.length <= 260)
			.slice(0, 8)
			.map((value) => path.resolve(value));
		if (dirs.length) config.localDirs = dirs;
	}
	return config;
}

// Windows PowerShell 5.1 specifically: pwsh (7+) cannot project the WinRT
// types the bridge needs. Prefer the absolute path so a pwsh shim earlier
// on PATH can never win.
function resolvePowershell() {
	const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
	const absolute = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
	try {
		if (fs.statSync(absolute).isFile()) return absolute;
	} catch {}
	return 'powershell.exe';
}

// ---------------------------------------------------------------- bridge I/O --

const bridge = {
	proc: null,
	ready: false,
	stopped: false,
	restarts: 0,
	timer: null,
	stderr: '',
	fatal: '',
	lastError: '',
	lastExit: null,
	// Transport commands waiting for the bridge's ack, keyed by request id.
	pending: new Map(),
};

let latestState = { type: 'state', active: false };
let cover = null; // { mime, bytes, serial }
let coverSerial = 0;
let stdoutBuffer = '';
let commandSerial = 0;
// Test seam: route tests replace the spawner with a fake child process so they
// can assert on the stdin/ack protocol without launching PowerShell.
let spawnImpl = spawn;
export function __setSpawnForTests(fn) {
	spawnImpl = typeof fn === 'function' ? fn : spawn;
}

let lyricService = null;
let lyricRetry = null;
let currentFingerprint = null;
let lyricInfo = { status: 'idle' }; // idle | loading | matched | unmatched | error

function bridgeHealth() {
	if (!IS_WINDOWS) return 'unsupported';
	if (bridge.fatal) return 'fatal';
	if (bridge.proc && bridge.ready) return 'up';
	if (bridge.proc) return 'starting';
	return 'down';
}

function bridgeDetail() {
	if (!IS_WINDOWS) return '仅支持 Windows（依赖系统 SMTC 媒体会话）';
	if (bridge.fatal) return bridge.fatal;
	if (bridge.lastError) return bridge.lastError;
	if (!bridge.proc && bridge.stderr) return bridge.stderr.slice(-400);
	return '';
}

/** Run one resolve for `fingerprint` and publish the outcome.
 *  Returns without touching state when the track has moved on. */
function resolveAndPublish(fingerprint, track) {
	lyricInfo = { status: 'loading' };
	void lyricService
		.resolve({ title: track.title, artist: track.artist, durationSec: Number(track.durationSec) || 0 })
		.then((result) => {
			// A newer track may have started while we were resolving.
			if (fingerprint !== currentFingerprint) return;
			lyricInfo = result;
			trace('lyric ' + result.status + ' for "' + track.title + '" fp=' + fingerprint);
			if (lyricRetry) lyricRetry.note(fingerprint, result.status);
		})
		.catch(() => {
			if (fingerprint !== currentFingerprint) return;
			lyricInfo = { status: 'error', message: 'resolve threw' };
			if (lyricRetry) lyricRetry.note(fingerprint, 'error');
		});
}

/** Lyric orchestration: react to track changes in the SMTC stream. */
function observeLyrics(msg) {
	if (!msg || msg.active !== true || typeof msg.title !== 'string' || msg.title.trim() === '') {
		if (currentFingerprint !== null) {
			currentFingerprint = null;
			lyricInfo = { status: 'idle' };
			if (lyricRetry) lyricRetry.reset();
		}
		return;
	}
	const fingerprint = fingerprintOf(msg.title, msg.artist);
	if (fingerprint === currentFingerprint) return;
	currentFingerprint = fingerprint;
	if (lyricRetry) lyricRetry.reset(); // fresh budget per track
	resolveAndPublish(fingerprint, msg);
}

function handleLine(line) {
	let msg;
	try {
		msg = JSON.parse(line);
	} catch {
		return;
	}
	if (!msg || typeof msg !== 'object') return;

	switch (msg.type) {
		case 'state':
			latestState = msg;
			bridge.ready = true;
			observeLyrics(msg);
			break;
		case 'ready':
			bridge.ready = true;
			break;
		case 'cover': {
			try {
				const bytes = Buffer.from(String(msg.dataBase64 || ''), 'base64');
				if (bytes.length > 0) {
					coverSerial += 1;
					cover = { mime: String(msg.mime || 'image/jpeg'), bytes, serial: coverSerial };
				}
			} catch {}
			break;
		}
		case 'fatal':
			bridge.fatal = String(msg.message || 'SMTC 不可用');
			bridge.ready = false;
			break;
		case 'ack': {
			// Correlate by id; an ack with no waiter is simply dropped (a command
			// whose HTTP request already timed out).
			const id = typeof msg.id === 'string' ? msg.id : '';
			const waiter = id !== '' ? bridge.pending.get(id) : null;
			if (waiter) {
				bridge.pending.delete(id);
				waiter(msg);
			}
			break;
		}
		case 'error':
			bridge.lastError = String(msg.message || '');
			break;
		default:
			break;
	}
}

function onStdout(chunk) {
	stdoutBuffer += chunk;
	// A single cover line carries a base64 image, so the buffer can
	// legitimately grow large; only guard against a runaway producer with
	// no newline at all.
	if (stdoutBuffer.length > 16 * 1024 * 1024) {
		stdoutBuffer = '';
		return;
	}
	let index;
	while ((index = stdoutBuffer.indexOf('\n')) >= 0) {
		const line = stdoutBuffer.slice(0, index).trim();
		stdoutBuffer = stdoutBuffer.slice(index + 1);
		if (line) handleLine(line);
	}
}

function scheduleRestart() {
	if (bridge.stopped) return;
	if (bridge.timer) clearTimeout(bridge.timer);
	bridge.restarts += 1;
	const delay = Math.min(30000, 1000 * Math.pow(1.6, Math.min(bridge.restarts, 8)));
	bridge.timer = setTimeout(() => {
		bridge.timer = null;
		startBridge();
	}, delay);
	if (bridge.timer && typeof bridge.timer.unref === 'function') bridge.timer.unref();
}

function startBridge() {
	if (!IS_WINDOWS || bridge.stopped || bridge.proc) return;

	const args = [
		'-NoProfile',
		'-NonInteractive',
		'-ExecutionPolicy', 'Bypass',
		'-File', BRIDGE_SCRIPT,
		'-PollMs', String(pluginConfig.pollMs),
		'-AppPattern', pluginConfig.appPatterns.join(','),
	];

	let proc;
	try {
		proc = spawnImpl(resolvePowershell(), args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
	} catch (err) {
		bridge.lastError = String((err && err.message) || err);
		scheduleRestart();
		return;
	}

	bridge.proc = proc;
	bridge.ready = false;
	bridge.stderr = '';

	if (proc.stdout) {
		proc.stdout.setEncoding('utf8');
		proc.stdout.on('data', onStdout);
	}
	if (proc.stderr) {
		proc.stderr.setEncoding('utf8');
		proc.stderr.on('data', (chunk) => {
			bridge.stderr = (bridge.stderr + chunk).slice(-2000);
		});
	}
	proc.on('error', (err) => {
		bridge.lastError = String((err && err.message) || err);
	});
	proc.on('exit', (code) => {
		if (bridge.proc === proc) bridge.proc = null;
		bridge.ready = false;
		stdoutBuffer = '';
		// Anything still waiting on this process will never be acked.
		for (const waiter of bridge.pending.values()) waiter({ ok: false, reason: 'bridge-exited' });
		bridge.pending.clear();
		if (!bridge.stopped) {
			bridge.lastExit = code;
			scheduleRestart();
		}
	});
}

function stopBridge() {
	bridge.stopped = true;
	if (bridge.timer) {
		clearTimeout(bridge.timer);
		bridge.timer = null;
	}
	const proc = bridge.proc;
	bridge.proc = null;
	if (!proc) return;
	try { proc.stdin.end(); } catch {}
	const killTimer = setTimeout(() => {
		try { proc.kill(); } catch {}
	}, 500);
	if (typeof killTimer.unref === 'function') killTimer.unref();
}

/**
 * Send one control command to the bridge and wait for its ack.
 * Returns { ok, reason, via } - never throws, so a route can always answer.
 * `timeoutMs` covers the bridge's own verification window (play/pause wait up
 * to 1.5 s for the state to actually change before falling back to a toggle).
 */
function sendBridgeCommand(cmd, extra, timeoutMs) {
	if (!IS_WINDOWS) return Promise.resolve({ ok: false, reason: 'unsupported' });
	const proc = bridge.proc;
	if (!proc || !proc.stdin || proc.stdin.destroyed) return Promise.resolve({ ok: false, reason: 'bridge-down' });
	const id = 'c' + String(++commandSerial);
	const payload = Object.assign({ cmd, id }, extra || {});
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			bridge.pending.delete(id);
			clearTimeout(timer);
			resolve(result);
		};
		const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), Math.max(500, Number(timeoutMs) || 3000));
		if (typeof timer.unref === 'function') timer.unref();
		bridge.pending.set(id, (msg) => finish({
			ok: msg.ok === true,
			reason: typeof msg.reason === 'string' ? msg.reason : '',
			via: typeof msg.via === 'string' ? msg.via : '',
		}));
		try {
			proc.stdin.write(JSON.stringify(payload) + '\n');
		} catch (err) {
			finish({ ok: false, reason: String((err && err.message) || err) });
		}
	});
}

// -------------------------------------------------------------------- routes --

function sendJson(res, obj, code) {
	const body = Buffer.from(JSON.stringify(obj), 'utf8');
	res.writeHead(code || 200, {
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store',
		'Content-Length': String(body.length),
	});
	res.end(body);
}

function deny(res, code) {
	try {
		res.writeHead(code || 403, { 'Content-Type': 'text/plain; charset=utf-8' });
		res.end('forbidden');
	} catch {}
}

/**
 * Trust fence, mirroring dsh's own connection service: reject cross-site
 * requests, reject an Origin that does not match Host. Reads may be served
 * to non-loopback hosts (widget still renders over LAN); /rematch may not,
 * because it triggers outbound requests from this machine.
 */
function fence(req, res, opts) {
	const headers = (req && req.headers) || {};
	const method = String((req && req.method) || 'GET').toUpperCase();
	void method;

	let hostUrl;
	try {
		hostUrl = new URL('http://' + String(headers.host || ''));
	} catch {
		deny(res, 403);
		return false;
	}

	const hostname = hostUrl.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
	const loopback = LOOPBACK_HOSTS.test(hostname);

	if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
		deny(res, 403);
		return false;
	}
	const origin = headers.origin;
	if (typeof origin === 'string' && origin && origin !== 'null') {
		let originUrl = null;
		try {
			originUrl = new URL(origin);
		} catch {
			deny(res, 403);
			return false;
		}
		if (originUrl.host.toLowerCase() !== hostUrl.host.toLowerCase()) {
			deny(res, 403);
			return false;
		}
	}
	if (opts && opts.requireLoopback && !loopback) {
		deny(res, 403);
		return false;
	}
	return true;
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		let settled = false;
		req.on('data', (chunk) => {
			if (settled) return;
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				settled = true;
				const err = new Error('body too large');
				err.code = 'BODY_TOO_LARGE';
				reject(err);
				try { req.resume(); } catch {}
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			if (settled) return;
			settled = true;
			resolve(Buffer.concat(chunks).toString('utf8'));
		});
		req.on('error', (err) => {
			if (settled) return;
			settled = true;
			reject(err);
		});
	});
}

/** Project the matched lyric for the wire: strip translations when off. */
function lyricForWire() {
	if (lyricInfo === null || typeof lyricInfo !== 'object') return { status: 'idle' };
	if (lyricInfo.status !== 'matched') return lyricInfo;
	const lines = pluginConfig.showTranslation
		? lyricInfo.lines
		: lyricInfo.lines.map((row) => ({ t: row.t, text: row.text }));
	return {
		status: 'matched',
		source: lyricInfo.source || 'netease',
		sourceLabel: lyricInfo.sourceLabel || '网易云',
		fallbackUsed: lyricInfo.fallbackUsed === true,
		attempts: lyricInfo.attempts || [],
		songId: lyricInfo.songId,
		songName: lyricInfo.songName,
		artistNames: lyricInfo.artistNames,
		score: lyricInfo.score,
		lines,
	};
}

/** Duration for the wire: the session's own, or — when the player publishes no
 *  timeline at all (KuGou reports 0) — a bound derived from the last lyric line,
 *  so the progress bar still has an end. A real duration always wins. */
function effectiveDuration() {
	const own = Number(latestState.durationSec) || 0;
	if (own > 0) return own;
	const lines = lyricInfo && Array.isArray(lyricInfo.lines) ? lyricInfo.lines : [];
	const last = lines.length > 0 ? Number(lines[lines.length - 1].t) || 0 : 0;
	return last > 0 ? Math.round((last + 10) * 10) / 10 : 0;
}

// ---------------------------------------------------------------------- plugin --

export default {
	name: 'dsh-netease-lyrics',

	apply(root, config) {
		trace('apply() entered');
		// The cordis loader hands the bundle entry's `config:` to the plugin
		// here. `root.config` is only readable when the fiber declares
		// `inject: ['config']`; reading it unguarded throws, so probe
		// defensively (dev harnesses expose it).
		let fallbackConfig;
		try {
			fallbackConfig = root && root.config;
		} catch {
			fallbackConfig = undefined;
		}
		const effective = normalizeConfig(config || fallbackConfig);
		pluginConfig.pollMs = effective.pollMs;
		pluginConfig.appPatterns = effective.appPatterns;
		pluginConfig.apiBase = effective.apiBase;
		pluginConfig.showTranslation = effective.showTranslation;
		pluginConfig.retryDelayMs = effective.retryDelayMs;
		pluginConfig.maxAutoRetries = effective.maxAutoRetries;
		pluginConfig.localLyrics = effective.localLyrics;
		pluginConfig.localDirs = effective.localDirs;
		trace(
			'config: pollMs=' + String(pluginConfig.pollMs) +
			' appPatterns=' + pluginConfig.appPatterns.join('|') +
			' apiBase=' + pluginConfig.apiBase +
			' showTranslation=' + String(pluginConfig.showTranslation) +
			' retryDelayMs=' + String(pluginConfig.retryDelayMs) +
			' maxAutoRetries=' + String(pluginConfig.maxAutoRetries) +
			' localLyrics=' + String(pluginConfig.localLyrics) +
			' localDirs=' + pluginConfig.localDirs.join('|'),
		);

		// Re-apply support: a disable cycle sets the module-level bridge
		// supervisor's `stopped` flag (stopBridge) and the Loader reuses the
		// same module instance on re-enable — without this reset a fresh
		// apply() would never revive the bridge child process.
		bridge.stopped = false;
		bridge.fatal = '';
		bridge.lastError = '';

		if (lyricRetry) try { lyricRetry.dispose(); } catch {}
		lyricService = createLyricService({
			apiBase: pluginConfig.apiBase,
			cacheFile: CACHE_FILE,
			localLyrics: pluginConfig.localLyrics,
			localDirs: pluginConfig.localDirs,
		});
		lyricRetry = createLyricRetry({
			delayMs: pluginConfig.retryDelayMs,
			maxAutoRetries: pluginConfig.maxAutoRetries,
			schedule: (fn, ms) => {
				const t = setTimeout(fn, ms);
				if (typeof t.unref === 'function') t.unref();
				return t;
			},
			cancel: (handle) => clearTimeout(handle),
			invalidate: (fp) => { try { lyricService.invalidate(fp); } catch {} },
			onAttempt: ({ fingerprint }) => {
				// The retry fired for the fingerprint it was scheduled for;
				// only the live track (still current) gets re-resolved.
				if (fingerprint !== currentFingerprint) return;
				const snapshot = latestState;
				resolveAndPublish(fingerprint, snapshot);
			},
			trace,
		});

		const disposers = [];
		try {
			root.effect(() => () => {
				for (const dispose of disposers.splice(0)) {
					try { dispose(); } catch {}
				}
			});
		} catch (err) {
			trace('root.effect() threw: ' + (err && err.message));
		}

		let mounted = false;

		// Teardown cancels any pending auto-retry timer with the routes.
		disposers.push(() => { if (lyricRetry) try { lyricRetry.dispose(); } catch {} });

		function mountVia(ctx, how) {
			if (mounted) return;
			if (!ctx || !ctx.webServer) {
				trace('mount via ' + how + ' skipped: webServer service unavailable');
				return;
			}
			mounted = true;
			trace('mounting HTTP surface via ' + how);

			disposers.push(ctx.webServer.register({
				kind: 'exact',
				path: ROUTE_BASE + '/state.json',
				handler: (req, res) => {
					if (!fence(req, res)) return;
					sendJson(res, Object.assign({}, latestState, {
						// Players that publish no timeline (KuGou) also report no
						// duration. The last lyric line is a good enough bound for
						// the progress bar, and it never overrides a real duration.
						durationSec: effectiveDuration(),
						bridge: bridgeHealth(),
						detail: bridgeDetail(),
						supported: IS_WINDOWS,
						pollMs: pluginConfig.pollMs,
						appPatterns: pluginConfig.appPatterns,
						showTranslation: pluginConfig.showTranslation,
						coverSerial: cover ? cover.serial : 0,
						lyric: lyricForWire(),
						service: lyricService ? lyricService.describe() : undefined,
						retry: lyricRetry ? lyricRetry.describe() : undefined,
					}));
				},
			}));

			disposers.push(ctx.webServer.register({
				kind: 'exact',
				path: ROUTE_BASE + '/cover.png',
				handler: (req, res) => {
					if (!fence(req, res)) return;
					if (!cover) {
						res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
						res.end('no cover');
						return;
					}
					res.writeHead(200, {
						'Content-Type': cover.mime,
						// The serial changes per track, so the bytes behind a
						// given URL are genuinely immutable.
						'Cache-Control': 'public, max-age=31536000, immutable',
						'Content-Length': String(cover.bytes.length),
					});
					res.end(cover.bytes);
				},
			}));

			disposers.push(ctx.webServer.register({
				kind: 'exact',
				path: ROUTE_BASE + '/rematch',
				handler: async (req, res) => {
					if (!fence(req, res, { requireLoopback: true })) return;
					if (String(req.method || 'GET').toUpperCase() !== 'POST') {
						sendJson(res, { ok: false, error: 'method not allowed' }, 405);
						return;
					}
					let body;
					try {
						body = await readBody(req);
					} catch (err) {
						const tooLarge = !!err && err.code === 'BODY_TOO_LARGE';
						sendJson(res, { ok: false, error: tooLarge ? 'body too large' : 'bad body' }, tooLarge ? 413 : 400);
						return;
					}
					try {
						void JSON.parse(body || '{}');
					} catch {
						sendJson(res, { ok: false, error: 'bad json' }, 400);
						return;
					}
					if (currentFingerprint === null || latestState.active !== true) {
						sendJson(res, { ok: false, error: 'no active track' }, 409);
						return;
					}
					lyricService.invalidate(currentFingerprint);
					if (lyricRetry) lyricRetry.reset(); // manual rematch restores the full retry budget
					resolveAndPublish(currentFingerprint, latestState);
					sendJson(res, { ok: true });
				},
			}));

			disposers.push(ctx.webServer.register({
				kind: 'exact',
				path: ROUTE_BASE + '/control',
				handler: async (req, res) => {
					// Controls drive a real player, so they stay loopback-only.
					if (!fence(req, res, { requireLoopback: true })) return;
					if (String(req.method || 'GET').toUpperCase() !== 'POST') {
						sendJson(res, { ok: false, error: 'method not allowed' }, 405);
						return;
					}
					let body;
					try {
						body = await readBody(req);
					} catch (err) {
						const tooLarge = !!err && err.code === 'BODY_TOO_LARGE';
						sendJson(res, { ok: false, error: tooLarge ? 'body too large' : 'bad body' }, tooLarge ? 413 : 400);
						return;
					}
					let payload;
					try {
						payload = JSON.parse(body || '{}');
					} catch {
						sendJson(res, { ok: false, error: 'bad json' }, 400);
						return;
					}
					// Whitelist: the widget may only ask for these, never a free-form
					// command channel into the bridge.
					const allowed = ['toggle', 'play', 'pause', 'next', 'prev', 'seek'];
					const cmd = typeof payload?.cmd === 'string' ? payload.cmd : '';
					if (!allowed.includes(cmd)) {
						sendJson(res, { ok: false, error: 'unsupported command' }, 400);
						return;
					}
					let extra = null;
					if (cmd === 'seek') {
						// `pos` is seconds. Coerce only real numbers: Number(null) is 0
						// and Number('') is 0, so a plain Number() would accept a
						// missing field as "seek to 0" and then wait on an ack the
						// bridge never sends.
						const raw = payload?.pos;
						const pos = typeof raw === 'number' ? raw
							: typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
						if (!Number.isFinite(pos) || pos < 0) {
							sendJson(res, { ok: false, error: 'bad position' }, 400);
							return;
						}
						// The session's own duration bounds the request; asking past the
						// end is a player error, so clamp here instead.
						const duration = Number(latestState?.durationSec) || 0;
						extra = { pos: duration > 0 ? Math.min(pos, duration) : pos };
					}
					const result = await sendBridgeCommand(cmd, extra, 4000);
					// A refused command is a real answer, not a transport failure:
					// 200 keeps the widget from treating it as a network problem,
					// and `ok:false` plus `reason` tells it what happened.
					sendJson(res, result);
				},
			}));

			startBridge();
			disposers.push(() => stopBridge());
			trace('HTTP surface mounted via ' + how + '; bridge pid ' + String(bridge.proc ? bridge.proc.pid : 'none'));

			if (!IS_WINDOWS) {
				try { console.warn('[dsh-netease-lyrics] 非 Windows 平台：无法读取系统 SMTC 媒体会话，浮层将保持隐藏。'); } catch {}
			}
		}

		// The normal path: fires as soon as `webServer` is present.
		try {
			root.inject(['webServer'], (ctx) => mountVia(ctx, 'inject'));
		} catch (err) {
			trace('root.inject(webServer) threw: ' + (err && err.message));
		}
		// Already-present service (plugin loaded after the webserver settled).
		try {
			if (root.get('webServer') !== undefined) mountVia(root, 'root.get');
		} catch (err) {
			trace('root.get(webServer) threw: ' + (err && err.message));
		}
		// Last resort: never leave the plugin silently unmounted.
		const mountGuard = setTimeout(() => mountVia(root, 'timeout'), 3000);
		if (mountGuard && typeof mountGuard.unref === 'function') mountGuard.unref();
		disposers.push(() => clearTimeout(mountGuard));
	},
};

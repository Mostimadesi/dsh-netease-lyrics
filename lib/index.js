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
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLyricService, fingerprintOf, shouldOriginRematch } from './lyric-service.js';
import { createLyricRetry } from './lyric-retry.js';
import { ackNotices, applyNoticeEvent, basenameOf, createNoticeState, disposeSessionNotices, noticesForWire, workspaceTitleFor } from './notice-aggregate.js';

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
// bilibili subtitle source (v0.4.11): a bvid pins the exact video, so the
// lyrics chain can resolve it without any search scoring. Until the planned
// browser-session extension lands, the only bvid source is the override
// below — empty by default, which keeps the plugin's behaviour unchanged.
const BVID_RE = /^BV[0-9A-Za-z]{10}$/;
// v0.4.12: the browser extension reports the video it is playing to a
// DEDICATED loopback listener on a fixed port (DSH's webServer port is not
// stable across restarts, and the extension cannot read config files). The
// report carries {bvid, title, positionSec, durationSec, playing}; it is
// held in memory only and expires quickly — heartbeats arrive every 5s.
const BROWSER_SESSION_PATH = ROUTE_BASE + '/browser-session';
const BROWSER_SESSION_PORT_DEFAULT = 51789;
// Freshness window for the extension report: must outlast the 5s heartbeat
// (playing tabs are exempt from Chrome's timer throttling) but stay short —
// when the tab closes its SMTC session disappears immediately, and a lingering
// report should not outlive it for long (user feedback 2026-11-09: 15s felt
// long; 10s = two missed heartbeats).
const BROWSER_SESSION_TTL_MS = 10000;
const BROWSER_APP_RE = /chrome|microsoftedge|msedge|firefox|brave/i;

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
	noticeTurnTtlMs: 10 * 60 * 1000,
	bilibiliEnabled: true,
	bilibiliCookiePath: '',
	bilibiliBvidOverride: '',
	browserSessionPort: BROWSER_SESSION_PORT_DEFAULT,
	browserSessionTtlMs: BROWSER_SESSION_TTL_MS,
};

// The shell "Downloads" folder can be relocated (registry move), and
// os.homedir() then misses it. Ask the Windows shell once, cache the result.
// Best effort only: '' on any failure, and the home path stays a candidate.
let shellDownloadsDirCache = null;
function shellDownloadsDir() {
	if (shellDownloadsDirCache !== null) return shellDownloadsDirCache;
	shellDownloadsDirCache = '';
	if (IS_WINDOWS) {
		try {
			const out = execFileSync(resolvePowershell(), ['-NoProfile', '-Command',
				'[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;'
				+ " (New-Object -ComObject Shell.Application).Namespace('shell:Downloads').Self.Path"],
				{ timeout: 4000, windowsHide: true, encoding: 'utf8' });
			const dir = String(out || '').trim();
			if (dir && fs.statSync(dir).isDirectory()) shellDownloadsDirCache = dir;
		} catch { /* keep '' — the home candidate still applies */ }
	}
	return shellDownloadsDirCache;
}
function fileExists(candidate) {
	try { return fs.statSync(candidate).isFile(); } catch { return false; }
}
/** Cookie file candidates in priority order: explicit config, then the
 * profile Downloads folder, then the (possibly relocated) shell Downloads
 * folder. Only these known locations are checked — never a disk scan.
 * `cookies-bilibili.txt` is deliberately tried BEFORE `cookies.txt`: a
 * same-named generic export from another site (or a stale one — verified
 * live 2026-11-09, cookies.txt held an expired SESSDATA returning nav -101)
 * must not shadow the dedicated bilibili export. */
function bilibiliCookieCandidates(configured) {
	const list = [];
	if (configured) list.push(configured);
	const home = os.homedir();
	const homeBase = home ? path.join(home, 'Downloads') : '';
	const homeCandidates = homeBase
		? [path.join(homeBase, 'cookies-bilibili.txt'), path.join(homeBase, 'cookies.txt')] : [];
	list.push(...homeCandidates);
	// The shell lookup costs one PowerShell spawn: only pay it when the
	// profile Downloads folder has no cookie file yet.
	if (!homeCandidates.some(fileExists)) {
		const shellBase = shellDownloadsDir();
		if (shellBase) {
			list.push(path.join(shellBase, 'cookies-bilibili.txt'));
			list.push(path.join(shellBase, 'cookies.txt'));
		}
	}
	return [...new Set(list)];
}
export { bilibiliCookieCandidates };

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
		noticeTurnTtlMs: 10 * 60 * 1000,
		bilibiliEnabled: true,
		bilibiliCookiePath: '',
		bilibiliBvidOverride: '',
		browserSessionPort: BROWSER_SESSION_PORT_DEFAULT,
		browserSessionTtlMs: BROWSER_SESSION_TTL_MS,
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
	// Round-ending retention cap for the notice wire (the browser also applies
	// its own, smaller, per-browser setting; the effective lifetime is the min).
	const noticeTtl = Number(raw.noticeTurnTtlMs);
	if (Number.isFinite(noticeTtl)) config.noticeTurnTtlMs = Math.min(3600000, Math.max(60000, Math.round(noticeTtl)));
	// bilibili subtitle source (v0.4.11).
	if (raw.bilibiliEnabled === false) config.bilibiliEnabled = false;
	if (typeof raw.bilibiliCookiePath === 'string') {
		const cookiePath = raw.bilibiliCookiePath.trim();
		if (cookiePath === '') config.bilibiliCookiePath = '';
		else if (cookiePath.length <= 260 && !/[\0\r\n]/.test(cookiePath)) config.bilibiliCookiePath = cookiePath;
	}
	if (typeof raw.bilibiliBvidOverride === 'string') {
		// bvids are case-sensitive (BV + base58) — trim only, never re-case.
		const bvid = raw.bilibiliBvidOverride.trim();
		config.bilibiliBvidOverride = BVID_RE.test(bvid) ? bvid : '';
	}
	const sessionPort = Number(raw.browserSessionPort);
	if (Number.isFinite(sessionPort)) {
		config.browserSessionPort = Math.min(65535, Math.max(1024, Math.round(sessionPort)));
	}
	const sessionTtl = Number(raw.browserSessionTtlMs);
	if (Number.isFinite(sessionTtl)) {
		config.browserSessionTtlMs = Math.min(60000, Math.max(5000, Math.round(sessionTtl)));
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
let currentObservation = null;
let lifecycleGeneration = 0;
let lifecycleActive = false;
let resolveSerial = 0;
let lyricInfo = { status: 'idle' }; // idle | loading | matched | unmatched | error

// Workspace notices folded from the global session event stream (see
// lib/notice-aggregate.js). Recreated per apply(): a disable cycle must not
// resurrect notices observed while the plugin was inert.
let noticeState = createNoticeState();

/** Subscribe defensively: the plugin runs on whatever context the loader
 *  hands over, and dev harnesses (route tests) provide a fake root without
 *  `on`. Returns the disposer, or null when the verb is unavailable. */
function safeOn(root, name, listener, options) {
	try {
		if (!root || typeof root.on !== 'function') return null;
		const off = root.on(name, listener, options);
		return typeof off === 'function' ? off : null;
	} catch (err) {
		trace('root.on("' + name + '") unavailable: ' + String((err && err.message) || err));
		return null;
	}
}

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

/** The lyrics provider matching the playing media's own app, so the origin
 * source is tried first and the other providers stay a safety net. */
function originSourceFor(appAumid) {
	const low = String(appAumid || '').toLowerCase();
	if (/cloudmusic|netease/.test(low)) return 'netease';
	if (/qqmusic/.test(low)) return 'qq';
	if (/kugou/.test(low)) return 'kugou';
	if (/migu/.test(low)) return 'migu';
	return '';
}

/** Pure position-override computation: the extension's report is the video's
 * real playback position (video.currentTime at report time, extrapolated to
 * now while playing). Returns null when any gate fails. */
export function computeMediaOverride(nowMs, state, fresh, effectiveBvidValue) {
	if (!fresh || !state || state.active !== true) return null;
	if (!BROWSER_APP_RE.test(String(state.app || ''))) return null;
	if (!effectiveBvidValue) return null;
	const elapsedSec = fresh.playing ? Math.max(0, (nowMs - fresh.updatedAt) / 1000) : 0;
	const duration = Number(fresh.durationSec) || 0;
	let position = (Number(fresh.positionSec) || 0) + elapsedSec;
	if (duration > 0 && position > duration) position = duration;
	return { positionSec: Math.round(position * 1000) / 1000, durationSec: duration };
}
function browserSessionMediaOverride(nowMs = Date.now()) {
	const fresh = freshBrowserSession(nowMs);
	if (!fresh || !latestState) return null;
	return computeMediaOverride(nowMs, latestState, fresh, effectiveBvid(latestState.app, latestState.title));
}

// --- self-healing origin rematch --------------------------------------------
// A throttled origin source (netease "API code 406" during a track burst,
// verified live 2026-11-09) would otherwise hand the track to another
// provider and the lyric cache would pin that for its whole TTL. When the
// final result is matched by a non-origin provider while the origin errored,
// re-resolve after 30s (user-tuned 2026-11-09: shorter wait, fewer attempts —
// max 2 per track): invalidate + resolve again with the origin still first.
// A confident origin miss never rematches.
const ORIGIN_REMATCH_DELAY_MS = 30000;
const ORIGIN_REMATCH_MAX = 2;
let originRematchTimer = null;
let originRematchFingerprint = null;
let originRematchCount = 0;
function scheduleOriginRematch(fingerprint, track) {
	if (originRematchFingerprint !== fingerprint) {
		originRematchFingerprint = fingerprint;
		originRematchCount = 0;
	}
	if (originRematchCount >= ORIGIN_REMATCH_MAX) return;
	originRematchCount += 1;
	if (originRematchTimer) clearTimeout(originRematchTimer);
	originRematchTimer = setTimeout(() => {
		originRematchTimer = null;
		// Only meaningful while the same track is still the current one.
		if (!lifecycleActive || fingerprint !== currentFingerprint
			|| !latestState || latestState.active !== true) return;
		trace('origin rematch: re-resolving ' + fingerprint + ' after a throttled origin source');
		lyricService.invalidate(fingerprint);
		resolveAndPublish(fingerprint, latestState);
	}, ORIGIN_REMATCH_DELAY_MS);
	if (typeof originRematchTimer.unref === 'function') originRematchTimer.unref();
}

/** Run one resolve for `fingerprint` and publish the outcome.
 *  Returns without touching state when the track has moved on. */
function resolveAndPublish(fingerprint, track, manualRematch = false) {
	const generation = lifecycleGeneration;
	const observation = currentObservation;
	const serial = ++resolveSerial;
	const service = lyricService;
	const retry = lyricRetry;
	const isCurrent = () => lifecycleActive && generation === lifecycleGeneration
		&& observation === currentObservation && fingerprint === currentFingerprint && serial === resolveSerial;
	lyricInfo = { status: 'loading' };
	void service
		.resolve({
			title: track.title, artist: track.artist,
			durationSec: Number(track.durationSec) || 0,
			// bilibili subtitles are bvid-pinned: the extension's fresh report
			// (browser sessions only) or the debug override supplies it.
			bvid: effectiveBvid(track.app, track.title) || undefined,
			// The media's own provider goes first; multi-source is a net.
			originSource: originSourceFor(track.app) || undefined,
			// A browser session stays video-only even without a bvid, so a
			// report that went stale cannot drop the capsule into the music
			// chain (and back) on every retry.
			browserSession: BROWSER_APP_RE.test(String(track.app || '')) || undefined,
			// Manual rematch is the only path that lets a video session fall
			// through to the music chain (user decision 2026-11-09).
			allowMusicFallback: manualRematch === true ? true : undefined,
		})
		.then((result) => {
			if (!isCurrent()) return;
			lyricInfo = result;
			trace('lyric ' + result.status + ' for "' + track.title + '" fp=' + fingerprint);
			if (retry) retry.note(fingerprint, result.status);
			// Self-heal a throttled origin source: the match is kept and shown,
			// but a delayed rematch re-tries the origin provider first.
			if (shouldOriginRematch(result, originSourceFor(track.app))) {
				scheduleOriginRematch(fingerprint, track);
			}
		})
		.catch(() => {
			if (!isCurrent()) return;
			lyricInfo = { status: 'error', message: 'resolve threw' };
			if (retry) retry.note(fingerprint, 'error');
		});
}

/** Lyric orchestration: react to track changes in the SMTC stream. */
function observeLyrics(msg) {
	if (!lifecycleActive) return;
	if (!msg || msg.active !== true || typeof msg.title !== 'string' || msg.title.trim() === '') {
		if (currentObservation !== null) {
			currentObservation = null;
			currentFingerprint = null;
			resolveSerial += 1;
			lyricInfo = { status: 'idle' };
			if (lyricRetry) lyricRetry.reset();
		}
		return;
	}
	// Search fingerprints intentionally discard version labels; observations must
	// retain them and newly available duration so a different recording re-resolves.
	// The effective bvid joins the identity: switching videos must re-resolve
	// even when SMTC keeps reporting the same title, and a report going stale
	// (tab closed) must drop the capsule back to the music chain.
	const duration = Number(msg.durationSec);
	const observation = JSON.stringify([
		String(msg.app || ''), msg.title.trim(), String(msg.artist || '').trim(),
		String(msg.album || '').trim(), Number.isFinite(duration) && duration > 0 ? Math.round(duration) : 0,
		effectiveBvid(msg.app, msg.title),
	]);
	if (observation === currentObservation) return;
	const fingerprint = fingerprintOf(msg.title, msg.artist);
	currentObservation = observation;
	currentFingerprint = fingerprint;
	if (lyricRetry) lyricRetry.reset(); // fresh budget per observation
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
			if (msg.cleared === true) {
				cover = null;
				break;
			}
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
	bridge.fatal = '';
	stdoutBuffer = '';
	cover = null;
	const generation = lifecycleGeneration;
	const isCurrent = () => bridge.proc === proc && generation === lifecycleGeneration;
	const finalize = (code, reason = 'bridge-exited') => {
		if (!isCurrent()) return;
		bridge.proc = null;
		bridge.ready = false;
		stdoutBuffer = '';
		for (const waiter of bridge.pending.values()) waiter({ ok: false, reason });
		bridge.pending.clear();
		if (!bridge.stopped) {
			bridge.lastExit = code;
			scheduleRestart();
		}
	};

	if (proc.stdout) {
		proc.stdout.setEncoding('utf8');
		proc.stdout.on('data', (chunk) => { if (isCurrent()) onStdout(chunk); });
	}
	if (proc.stderr) {
		proc.stderr.setEncoding('utf8');
		proc.stderr.on('data', (chunk) => {
			if (isCurrent()) bridge.stderr = (bridge.stderr + chunk).slice(-2000);
		});
	}
	// Pipe errors are asynchronous Writable events, not exceptions from write().
	if (proc.stdin && typeof proc.stdin.on === 'function') {
		proc.stdin.on('error', (err) => {
			if (!isCurrent()) return;
			bridge.lastError = String((err && err.message) || err);
			finalize(null, 'bridge-stdin-error');
			try { proc.kill(); } catch {}
		});
	}
	proc.on('error', (err) => {
		if (!isCurrent()) return;
		bridge.lastError = String((err && err.message) || err);
		// Failed spawn emits error + close, but no exit. Retire it here;
		// the identity guard makes the subsequent close a no-op.
		if (!proc.pid) finalize(null, 'bridge-spawn-error');
	});
	proc.on('exit', (code) => finalize(code));
	proc.on('close', (code) => finalize(code));
}

function stopBridge() {
	bridge.stopped = true;
	if (bridge.timer) {
		clearTimeout(bridge.timer);
		bridge.timer = null;
	}
	const proc = bridge.proc;
	bridge.proc = null;
	bridge.ready = false;
	stdoutBuffer = '';
	for (const waiter of bridge.pending.values()) waiter({ ok: false, reason: 'bridge-stopped' });
	bridge.pending.clear();
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

// --- browser-session reports (v0.4.12) --------------------------------------
// The extension posts {bvid, title, positionSec, durationSec, playing} here.
// The report is a LOGIN-FREE page annotation (no cookies, no credentials) and
// stays in memory only; it expires BROWSER_SESSION_TTL_MS after the last
// heartbeat so a closed tab stops contributing its bvid.
let browserSessionState = null;
let browserSessionServer = null;
let browserSessionPort = 0;
let lastTracedBrowserBvid = '';

/** Validate one report and store it. Returns '' on success, else the error. */
export function handleBrowserSessionReport(payload, nowMs = Date.now()) {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'bad payload';
	const bvid = String(payload.bvid || '').trim();
	// bvids are case-sensitive (BV + base58) — validate, never re-case.
	if (!BVID_RE.test(bvid)) return 'bad bvid';
	const title = String(payload.title ?? '').slice(0, 300);
	const positionSec = Number(payload.positionSec);
	const durationSec = Number(payload.durationSec);
	browserSessionState = {
		bvid,
		title,
		positionSec: Number.isFinite(positionSec) && positionSec >= 0 ? positionSec : 0,
		durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0,
		playing: payload.playing === true,
		updatedAt: Number(nowMs) || Date.now(),
	};
	if (bvid !== lastTracedBrowserBvid) {
		lastTracedBrowserBvid = bvid;
		trace('browser-session: bvid=' + bvid + ' playing=' + String(browserSessionState.playing) + ' title=' + title);
	}
	return '';
}

/** The stored report while it is fresh, else null. */
export function freshBrowserSession(nowMs = Date.now()) {
	if (!browserSessionState) return null;
	const ttlMs = Number.isFinite(pluginConfig.browserSessionTtlMs)
		? pluginConfig.browserSessionTtlMs : BROWSER_SESSION_TTL_MS;
	if (nowMs - browserSessionState.updatedAt > ttlMs) return null;
	return browserSessionState;
}

/** Normalized browser tab title for the bvid gate. bilibili appends
 *  "_哔哩哔哩_bilibili" to document.title, and SMTC sometimes reports the
 *  shortened form (verified live 2026-11-09: the same video appeared with and
 *  without the suffix, 400ms apart). */
function normalizeBrowserTitle(value) {
	return String(value || '')
		.replace(/\s*[-_]\s*哔哩哔哩(_bilibili)?\s*$/i, '')
		.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** True when the SMTC title and the extension's reported tab title describe
 *  the same page. This keeps a BACKGROUND tab's video from being attached to
 *  a different session: without it a stale Chrome session (or another tab's
 *  media) ran the slow bilibili subtitle chain for the wrong media and blocked
 *  the serialized resolve queue behind it — the reported "the client song's
 *  lyrics freeze while a bilibili video is also open". */
export function browserTitlesAgree(stateTitle, reportTitle) {
	const state = normalizeBrowserTitle(stateTitle);
	const report = normalizeBrowserTitle(reportTitle);
	if (state === '' || report === '') return false;
	return state === report || state.includes(report) || report.includes(state);
}

/** Pure bvid gate: the override wins (explicit debug), otherwise a fresh
 *  report counts only when the SMTC session really is a browser AND its title
 *  matches the reported tab (the same page). */
export function computeEffectiveBvid(appAumid, override, fresh, stateTitle) {
	if (override) return override;
	if (!fresh || !fresh.bvid) return '';
	if (!BROWSER_APP_RE.test(String(appAumid || ''))) return '';
	if (!browserTitlesAgree(stateTitle, fresh.title)) return '';
	return fresh.bvid;
}
function effectiveBvid(appAumid, stateTitle) {
	return computeEffectiveBvid(appAumid, pluginConfig.bilibiliBvidOverride, freshBrowserSession(), stateTitle);
}

/** HTTP handler for the dedicated loopback listener. */
export function createBrowserSessionRequestHandler() {
	return async function handleBrowserSessionRequest(req, res) {
		if (String(req.method || 'GET').toUpperCase() !== 'POST') {
			sendJson(res, { ok: false, error: 'method not allowed' }, 405);
			return;
		}
		const url = String(req.url || '/');
		const queryAt = url.indexOf('?');
		const pathname = queryAt === -1 ? url : url.slice(0, queryAt);
		if (pathname !== BROWSER_SESSION_PATH) {
			sendJson(res, { ok: false, error: 'not found' }, 404);
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
		const error = handleBrowserSessionReport(payload);
		if (error) {
			sendJson(res, { ok: false, error }, 400);
			return;
		}
		sendJson(res, { ok: true });
	};
}

function stopBrowserSessionListener() {
	if (!browserSessionServer) return;
	try { browserSessionServer.close(); } catch {}
	browserSessionServer = null;
	browserSessionPort = 0;
}

function startBrowserSessionListener() {
	if (!pluginConfig.bilibiliEnabled) { stopBrowserSessionListener(); return; }
	const port = pluginConfig.browserSessionPort;
	if (browserSessionServer && browserSessionPort === port) return;
	stopBrowserSessionListener();
	const server = http.createServer(createBrowserSessionRequestHandler());
	server.on('error', (err) => {
		// EADDRINUSE etc. degrade gracefully: the feature is off, the plugin
		// keeps working, and the extension's posts just fail silently.
		trace('browser-session listener unavailable: ' + String(err?.code || err?.message || err));
		if (browserSessionServer === server) { browserSessionServer = null; browserSessionPort = 0; }
	});
	server.listen(port, '127.0.0.1', () => {
		browserSessionPort = port;
		trace('browser-session listener on 127.0.0.1:' + port + BROWSER_SESSION_PATH);
	});
	// The DSH process is kept alive by its own servers and the bridge child;
	// unref keeps this auxiliary listener from pinning test runs open.
	if (typeof server.unref === 'function') server.unref();
	browserSessionServer = server;
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
		const generation = ++lifecycleGeneration;
		lifecycleActive = true;
		currentFingerprint = null;
		currentObservation = null;
		resolveSerial += 1;
		lyricInfo = { status: 'idle' };
		latestState = { type: 'state', active: false };
		noticeState = createNoticeState();
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
		pluginConfig.noticeTurnTtlMs = effective.noticeTurnTtlMs;
		pluginConfig.bilibiliEnabled = effective.bilibiliEnabled;
		pluginConfig.bilibiliCookiePath = effective.bilibiliCookiePath;
		pluginConfig.bilibiliBvidOverride = effective.bilibiliBvidOverride;
		pluginConfig.browserSessionPort = effective.browserSessionPort;
		pluginConfig.browserSessionTtlMs = effective.browserSessionTtlMs;
		trace(
			'config: pollMs=' + String(pluginConfig.pollMs) +
			' appPatterns=' + pluginConfig.appPatterns.join('|') +
			' apiBase=' + pluginConfig.apiBase +
			' showTranslation=' + String(pluginConfig.showTranslation) +
			' retryDelayMs=' + String(pluginConfig.retryDelayMs) +
			' maxAutoRetries=' + String(pluginConfig.maxAutoRetries) +
			' localLyrics=' + String(pluginConfig.localLyrics) +
			' localDirs=' + pluginConfig.localDirs.join('|') +
			' noticeTurnTtlMs=' + String(pluginConfig.noticeTurnTtlMs) +
			' bilibili=' + (pluginConfig.bilibiliEnabled
				? 'on' + (pluginConfig.bilibiliBvidOverride ? '+bvid-override' : '')
					+ ' browserSessionPort=' + String(pluginConfig.browserSessionPort)
				: 'off'),
		);

		// Re-apply support: a disable cycle sets the module-level bridge
		// supervisor's `stopped` flag (stopBridge) and the Loader reuses the
		// same module instance on re-enable — without this reset a fresh
		// apply() would never revive the bridge child process.
		bridge.stopped = false;
		bridge.fatal = '';
		bridge.lastError = '';

		if (lyricRetry) try { lyricRetry.dispose(); } catch {}
		if (lyricService && typeof lyricService.dispose === 'function') try { lyricService.dispose(); } catch {}
		lyricService = createLyricService({
			latestOnly: true,
			apiBase: pluginConfig.apiBase,
			cacheFile: CACHE_FILE,
			localLyrics: pluginConfig.localLyrics,
			localDirs: pluginConfig.localDirs,
			bilibiliEnabled: pluginConfig.bilibiliEnabled,
			// Candidates (never a scan): explicit config, profile Downloads,
			// then a relocated shell Downloads folder.
			bilibiliCookiePaths: pluginConfig.bilibiliEnabled
				? bilibiliCookieCandidates(pluginConfig.bilibiliCookiePath) : [],
		});
		const service = lyricService;
		lyricRetry = createLyricRetry({
			delayMs: pluginConfig.retryDelayMs,
			maxAutoRetries: pluginConfig.maxAutoRetries,
			schedule: (fn, ms) => {
				const t = setTimeout(fn, ms);
				if (typeof t.unref === 'function') t.unref();
				return t;
			},
			cancel: (handle) => clearTimeout(handle),
			invalidate: (fp) => { try { service.invalidate(fp); } catch {} },
			onAttempt: ({ fingerprint }) => {
				// A disabled or superseded application never starts new work.
				if (!lifecycleActive || generation !== lifecycleGeneration || fingerprint !== currentFingerprint) return;
				const snapshot = latestState;
				resolveAndPublish(fingerprint, snapshot);
			},
			trace,
		});

		const disposers = [];
		try {
			root.effect(() => () => {
				if (generation !== lifecycleGeneration) return;
				lifecycleActive = false;
				lifecycleGeneration += 1;
				currentFingerprint = null;
				currentObservation = null;
				resolveSerial += 1;
				lyricInfo = { status: 'idle' };
				latestState = { type: 'state', active: false };
				if (originRematchTimer) { clearTimeout(originRematchTimer); originRematchTimer = null; }
				for (const dispose of disposers.splice(0)) {
					try { dispose(); } catch {}
				}
			});
		} catch (err) {
			trace('root.effect() threw: ' + (err && err.message));
		}

		let mounted = false;

		// Capture this application's resources so old teardown cannot dispose a replacement.
		const retry = lyricRetry;
		disposers.push(() => { try { retry.dispose(); } catch {} });
		disposers.push(() => { if (typeof service.dispose === 'function') try { service.dispose(); } catch {} });

		// ---- browser-session listener (extension reports, see above) ----
		// Created with the application; a port change on re-apply reopens it,
		// and bilibiliEnabled=false closes it entirely.
		startBrowserSessionListener();
		disposers.push(() => stopBrowserSessionListener());

		// ---- workspace notices (see lib/notice-aggregate.js) ----
		// Workspace display titles resolve at SERIALIZATION time (each state.json
		// read) rather than at event time, so a late-arriving workspaceRegistry
		// is picked up on the next poll without a refresh hook. Probing services
		// through root.get() keeps both the desktop host (registry present) and
		// bare dev harnesses (no registry) working; the directory basename is
		// the fallback.
		const probeService = (name) => {
			try { return root.get(name); } catch { return undefined; }
		};
		const noticeTitleOf = (target) => {
			let list = null;
			try {
				const registry = probeService('workspaceRegistry');
				if (registry && typeof registry.list === 'function') list = registry.list();
			} catch { list = null; }
			const title = list ? workspaceTitleFor(target, list) : '';
			return title !== '' ? title : basenameOf(target.cwd);
		};
		const noticeWire = () => {
			let liveSessionIds = null;
			try {
				const sessions = probeService('sessions');
				if (sessions && typeof sessions.list === 'function') {
					liveSessionIds = new Set(sessions.list().map((s) => s && s.id));
				}
			} catch { liveSessionIds = null; }
			return noticesForWire(noticeState, {
				now: Date.now(),
				liveSessionIds,
				titleOf: noticeTitleOf,
				turnTtlMs: pluginConfig.noticeTurnTtlMs,
			});
		};

		// The fold only observes; it never blocks a session append. Failures are
		// contained here so a malformed event cannot break the event bus.
		const observeSession = safeOn(root, 'session/event', (session, event) => {
			if (!lifecycleActive || generation !== lifecycleGeneration) return;
			try {
				if (applyNoticeEvent(noticeState, session, event, Date.now())) noticeState.serial += 1;
			} catch (err) {
				trace('notice fold threw: ' + String((err && err.message) || err));
			}
		}, { global: true });
		if (observeSession) disposers.push(observeSession);
		const observeSessionDisposal = safeOn(root, 'session/disposed', (session) => {
			if (!lifecycleActive || generation !== lifecycleGeneration) return;
			if (disposeSessionNotices(noticeState, session)) noticeState.serial += 1;
		}, { global: true });
		if (observeSessionDisposal) disposers.push(observeSessionDisposal);

		function mountVia(ctx, how) {
			if (!lifecycleActive || generation !== lifecycleGeneration || mounted) return;
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
					// A stale BROWSER session can report active:true while its media
					// properties are empty (Chrome keeps a session alive after the
					// video is gone — verified live 2026-11-09: the capsule sat on
					// "未知曲目" until the browser was closed). With no title there is
					// no media to show, so it is published as inactive and the capsule
					// retires through its normal grace path. A real music player with
					// momentarily missing metadata keeps its capsule (and its honest
					// "未知曲目"), never a disappearing one.
					const identityLessPhantom = latestState.active === true
						&& String(latestState.title || '').trim() === ''
						&& BROWSER_APP_RE.test(String(latestState.app || ''));
					const baseState = identityLessPhantom
						? Object.assign({}, latestState, { active: false }) : latestState;
					// For browser videos the extension's position is authoritative:
					// bilibili does not keep the SMTC timeline moving (verified
					// live 2026-11-09 — the snapshot freezes and lyrics sit on one
					// line), so a fresh report overrides position/duration here,
					// already extrapolated to this read's moment.
					const mediaOverride = browserSessionMediaOverride();
					sendJson(res, Object.assign({}, baseState, {
						// Players that publish no timeline (KuGou) also report no
						// duration. The last lyric line is a good enough bound for
						// the progress bar, and it never overrides a real duration.
						durationSec: mediaOverride && mediaOverride.durationSec > 0
							? mediaOverride.durationSec : effectiveDuration(),
						...(mediaOverride ? { positionSec: mediaOverride.positionSec } : {}),
						bridge: bridgeHealth(),
						detail: bridgeDetail(),
						supported: IS_WINDOWS,
						pollMs: pluginConfig.pollMs,
						appPatterns: pluginConfig.appPatterns,
						showTranslation: pluginConfig.showTranslation,
						coverSerial: cover ? cover.serial : 0,
						lyric: lyricForWire(),
						// Workspace notices folded from the global session event
						// stream. Pruning happens here, so one read also retires a
						// stale "round ended" record past its TTL.
						notice: noticeWire(),
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
					// The button is the user explicitly asking for a rematch:
					// this is the only path that lets a video session use the
					// music chain (no silent source swap, see resolveSources).
					resolveAndPublish(currentFingerprint, latestState, true);
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

			disposers.push(ctx.webServer.register({
				kind: 'exact',
				path: ROUTE_BASE + '/notice/ack',
				handler: async (req, res) => {
					// Acknowledging is a pure local state mutation (no outbound
					// requests), so it stays on the same fence as reads; POST-only.
					if (!fence(req, res)) return;
					if (String(req.method || 'GET').toUpperCase() !== 'POST') {
						sendJson(res, { ok: false, error: 'method not allowed' }, 405);
						return;
					}
					let payload = {};
					try {
						const body = await readBody(req);
						if (body) payload = JSON.parse(body);
					} catch {
						sendJson(res, { ok: false, error: 'bad json' }, 400);
						return;
					}
					if (payload === null || typeof payload !== 'object') {
						sendJson(res, { ok: false, error: 'bad json' }, 400);
						return;
					}
					// Optional scope: ack only these sessions' round endings —
					// the "user switched INTO this conversation's workspace" ack
					// (the client resolves the workspace's session group). An
					// absent/empty scope means the unscoped list-read ack.
					let sessionIds = null;
					const rawIds = payload.sessionIds;
					if (rawIds !== undefined) {
						const list = Array.isArray(rawIds) ? rawIds : [rawIds];
						const ids = list
							.map((value) => String(value == null ? '' : value))
							.filter((value) => value !== '' && value.length <= 64)
							.slice(0, 64);
						if (ids.length === 0) {
							sendJson(res, { ok: false, error: 'bad session ids' }, 400);
							return;
						}
						sessionIds = new Set(ids);
					}
					const dropped = ackNotices(noticeState, { now: Date.now(), sessionIds });
					sendJson(res, { ok: true, dropped });
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

// dsh-netease-lyrics bridge — content script.
// Reports which bilibili video this tab is playing to the local lyrics
// listener, via the background service worker (the background does the only
// fetch, so no CORS preflight is needed on the page side).
//
// Scope discipline: NO bilibili API calls, NO cookie access, NO credentials.
// The payload is page metadata only: {bvid, title, positionSec, durationSec,
// playing}. Bangumi pages have no bvid and are therefore silent for now.

const HEARTBEAT_MS = 5000;   // keep position fresh while playing
const NAV_CHECK_MS = 1000;   // bilibili is an SPA: watch for bvid changes
const BVID_RE = /\/video\/(BV[0-9A-Za-z]{10})/;

let lastBvid = '';
let lastPayloadJson = '';

function currentBvid() {
	const match = BVID_RE.exec(location.pathname);
	return match ? match[1] : '';
}

function collectReport() {
	const bvid = currentBvid();
	if (!bvid) return null;
	const video = document.querySelector('video');
	const duration = video && Number.isFinite(video.duration) ? video.duration : 0;
	return {
		bvid,
		title: String(document.title || '').slice(0, 300),
		positionSec: video ? Math.round(video.currentTime * 100) / 100 : 0,
		durationSec: Math.round(duration * 100) / 100,
		playing: !!(video && !video.paused && !video.ended),
	};
}

function send(report, force) {
	if (!report) return;
	const json = JSON.stringify(report);
	if (!force && json === lastPayloadJson) return;
	lastPayloadJson = json;
	try {
		const result = chrome.runtime.sendMessage({ type: 'bili-session', report });
		if (result && typeof result.catch === 'function') result.catch(() => {});
	} catch {
		// Extension context invalidated (reloaded/updated) — stay silent.
	}
}

// Playback events change the payload, so they bypass the dedup. Bound with
// capture on document because bilibili's SPA replaces the <video> element on
// navigation — delegation survives the swap. 'ended' matters: without it the
// last report would keep claiming playing=true after the video finishes.
for (const type of ['play', 'pause', 'seeked', 'ended']) {
	document.addEventListener(type, () => send(collectReport(), true), true);
}

setInterval(() => {
	const report = collectReport();
	if (!report) return;
	// The heartbeat BYPASSES the dedup on purpose (fixed 2026-11-09): a paused
	// video's payload never changes, so a deduped heartbeat stopped reaching
	// the host, the 10s freshness window lapsed, the bvid association was
	// dropped mid-watch and the plugin fell back to the music search chain —
	// the subtitles vanished on pause and only came back after resuming.
	// The host only uses the report while an SMTC browser session is active,
	// so an idle background tab costing one localhost POST per 5s is harmless.
	send(report, true);
}, HEARTBEAT_MS);
setInterval(() => {
	const bvid = currentBvid();
	if (bvid !== lastBvid) {
		lastBvid = bvid;
		send(collectReport(), true);
	}
}, NAV_CHECK_MS);

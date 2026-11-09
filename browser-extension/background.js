// dsh-netease-lyrics bridge — background service worker.
// The only network hop: forwards the content script's report to the local
// lyrics listener. host_permissions on http://127.0.0.1/* make this a normal
// same-policy fetch (no CORS). Failures are swallowed: the plugin may be
// disabled, restarted, or simply not installed.

const DEFAULT_PORT = 51789; // keep in sync with the plugin's browserSessionPort config
const PATH = '/dsh-netease-lyrics/browser-session';

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
	if (!msg || msg.type !== 'bili-session' || !msg.report || typeof msg.report !== 'object') {
		return false;
	}
	fetch('http://127.0.0.1:' + DEFAULT_PORT + PATH, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(msg.report),
	}).then((response) => respond({ ok: response.ok })).catch(() => respond({ ok: false }));
	return true; // keep the message channel open for the async respond
});

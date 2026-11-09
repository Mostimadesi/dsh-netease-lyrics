/** bilibili video subtitles as an extra lyric source.
 *
 * Reached only when the resolve facts carry a `bvid` — today from the
 * `bilibiliBvidOverride` config (testing path), later from the planned
 * browser-session extension route. A bvid pins the video exactly, so this
 * branch never uses the title/artist search scorer; without a bvid nothing
 * here is contacted and the original source chain behaves exactly as before.
 *
 * Chain (every step verified live 2026-11-09 with a real login cookie, see
 * HANDOFF-bilibili-subtitle-source.md):
 *   GET /x/web-interface/view?bvid=      -> cid + title        public, no cookie
 *   GET /x/web-interface/nav             -> wbi keys           needs SESSDATA cookie
 *   GET /x/player/wbi/v2?...&w_rid&wts   -> subtitle tracks    NEEDS the Wbi signature:
 *       an unsigned /x/player/v2 request returns code:0 with a full track list
 *       where every subtitle_url is "" — success-shaped but empty. Never use
 *       the unsigned endpoint; "12 tracks, 0 urls" means the signature was
 *       rejected, not that the video has no subtitles.
 *   GET <subtitle_url>                   -> JSON {body:[{from,to,content}]}
 *       the URL is protocol-relative (prepend "https:") and temporary; only
 *       the parsed lines may be cached, never the URL. No cookie needed here.
 *
 * Security: SESSDATA is a login credential. It lives in memory only — never
 * logged, never persisted to state.json or the lyric cache, and never echoed
 * in error messages (say "cookie missing or expired", never print the value).
 */

import { createHash } from 'node:crypto';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';
const BILIBILI_API_BASE = 'https://api.bilibili.com';
const BILIBILI_REFERER = 'https://www.bilibili.com/';
// Fixed de-obfuscation table published with the Wbi signing scheme.
const MIXIN_KEY_ENC_TAB = [
	46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
	33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
	26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
	20, 34, 44, 52,
];
const BVID_RE = /^BV[0-9A-Za-z]{10}$/;

/** Fold img_key + sub_key through the table and keep the first 32 chars. */
export function mixinKeyEnc(imgKey, subKey) {
	const whole = String(imgKey || '') + String(subKey || '');
	let out = '';
	for (const index of MIXIN_KEY_ENC_TAB) out += whole[index] || '';
	return out.slice(0, 32);
}

/**
 * Parse a Netscape cookies.txt export ("Get cookies.txt LOCALLY" layout:
 * tab-separated, 7 columns, comment lines start with '#', http-only cookies
 * start with the '#HttpOnly_' pseudo-comment and ARE data).
 * Exports may cover every site (thousands of rows) — rows are parsed
 * individually and callers must pick their domain, never concatenate.
 */
export function parseNetscapeCookies(text) {
	const rows = [];
	if (typeof text !== 'string' || text.length === 0) return rows;
	for (const rawLine of text.split(/\r\n|\n|\r/)) {
		const line = rawLine.trim();
		if (line.length === 0) continue;
		let data = line;
		if (data.startsWith('#HttpOnly_')) data = data.slice('#HttpOnly_'.length);
		else if (data.startsWith('#')) continue;
		const parts = data.split('\t');
		if (parts.length < 7) continue;
		const domain = String(parts[0] || '').trim().toLowerCase();
		const name = String(parts[5] || '').trim();
		if (!domain || !name) continue;
		rows.push({ domain, name, value: String(parts[6] || ''), expiry: Number(parts[4]) || 0 });
	}
	return rows;
}

/** SESSDATA of bilibili.com (or a subdomain) only — same-named cookies from
 * other sites must never be mistaken for the bilibili login. */
export function extractBilibiliSessdata(rows) {
	if (!Array.isArray(rows)) return '';
	for (const row of rows) {
		if (!row || row.name !== 'SESSDATA') continue;
		const domain = String(row.domain || '');
		if (domain === 'bilibili.com' || domain.endsWith('.bilibili.com')) {
			return String(row.value || '');
		}
	}
	return '';
}

/** Pull {imgKey, subKey} out of a /x/web-interface/nav payload. */
export function wbiKeysFromNav(payload) {
	const imgUrl = String(payload?.data?.wbi_img?.img_url || '');
	const subUrl = String(payload?.data?.wbi_img?.sub_url || '');
	if (!imgUrl || !subUrl) return null;
	const baseName = (url) => {
		const clean = String(url).split('?')[0].split('#')[0];
		const slash = clean.lastIndexOf('/');
		const file = slash >= 0 ? clean.slice(slash + 1) : clean;
		const dot = file.indexOf('.');
		// wbi_img URLs end in ".png" — the key is the bare filename stem.
		return dot > 0 ? file.slice(0, dot) : file;
	};
	const imgKey = baseName(imgUrl);
	const subKey = baseName(subUrl);
	if (!imgKey || !subKey) return null;
	return { imgKey, subKey };
}

/**
 * Build the signed query ("...&wts=...&w_rid=...") for a Wbi endpoint:
 * add wts, sort by key, strip !'()* from values, urlencode, md5 with the
 * mixin key appended.
 */
export function signWbiParams(params, imgKey, subKey, nowSec) {
	const wts = Math.floor(Number(nowSec) > 0 ? Number(nowSec) : Date.now() / 1000);
	const merged = { ...(params || {}), wts };
	const query = Object.keys(merged).sort()
		.map((key) => {
			const value = String(merged[key] ?? '').replace(/[!'()*]/g, '');
			return encodeURIComponent(key) + '=' + encodeURIComponent(value);
		})
		.join('&');
	const wRid = createHash('md5').update(query + mixinKeyEnc(imgKey, subKey)).digest('hex');
	return query + '&w_rid=' + wRid;
}

/**
 * Pick the subtitle track to download: zh-CN first, then AI zh, then the
 * first track that actually carries a URL. Tracks with empty URLs are
 * skipped — an all-empty list is the signature-rejection fingerprint and is
 * reported by the caller, not treated as "no subtitles".
 */
export function pickSubtitleTrack(tracks) {
	if (!Array.isArray(tracks)) return null;
	const usable = tracks.filter((row) => row && typeof row === 'object' && String(row.subtitle_url || '').length > 0);
	if (usable.length === 0) return null;
	for (const lan of ['zh-CN', 'ai-zh']) {
		const hit = usable.find((row) => String(row.lan || '') === lan);
		if (hit) return hit;
	}
	return usable[0];
}

/** Rough script signature of one text run: latin / kana / Han. Used to tell a
 *  bilingual cue from a wrapped one. */
function scriptSignature(text) {
	let sig = '';
	if (/[A-Za-z]/.test(text)) sig += 'L';
	if (/[\u3040-\u30ff]/.test(text)) sig += 'K';
	if (/[\u4e00-\u9fff]/.test(text)) sig += 'H';
	return sig;
}

/**
 * Split one cue's content into {text[, trans]}.
 *
 * A bilingual bilibili track carries BOTH languages inside a single cue,
 * separated by a line break ("アイデンティティ…\n这就是…") — verified live
 * 2026-11-09 on a 2DMV with dual subtitles. The same line break is also how
 * the video wraps a long sentence for display, so the two cases are told
 * apart by script: extra lines in a DIFFERENT script than the first are a
 * translation (rendered as its own smaller row by the client), while lines in
 * the same script are the same sentence wrapped and are joined back together.
 */
export function splitSubtitleCue(content) {
	const parts = String(content == null ? '' : content)
		.split(/\r\n|\n|\r/)
		.map((part) => part.replace(/\s+/g, ' ').trim())
		.filter((part) => part !== '');
	if (parts.length === 0) return null;
	if (parts.length === 1) return { text: parts[0] };
	const head = parts[0];
	const rest = parts.slice(1).join(' ');
	const headSig = scriptSignature(head);
	const restSig = scriptSignature(rest);
	if (headSig !== '' && restSig !== '' && headSig !== restSig) {
		return { text: head, trans: rest };
	}
	return { text: parts.join(' ') };
}

/** subtitle body[] -> sorted [{t, text[, trans]}] (t is already seconds). */
export function subtitlesToLines(body) {
	if (!Array.isArray(body)) return [];
	const rows = [];
	for (const row of body) {
		if (!row || typeof row !== 'object') continue;
		const t = Number(row.from);
		if (!Number.isFinite(t) || t < 0) continue;
		const cue = splitSubtitleCue(row.content);
		if (cue === null) continue;
		rows.push(cue.trans ? { t, text: cue.text, trans: cue.trans } : { t, text: cue.text });
	}
	rows.sort((a, b) => a.t - b.t);
	return rows;
}

function delay(ms, signal) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
		const onAbort = () => { cleanup(); reject(signal.reason || new Error('cancelled')); };
		const cleanup = () => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); };
		if (signal) {
			if (signal.aborted) { clearTimeout(timer); reject(signal.reason || new Error('cancelled')); return; }
			signal.addEventListener('abort', onAbort, { once: true });
		}
	});
}

/**
 * Fetch and map the subtitles for one video. Returns
 * {lines, bvid, title, upName, durationSec, cid, pickedLan, trackCount, urlCount};
 * `lines` is [] when the video simply has no subtitle content (caller then
 * falls back to the regular chain). Throws Errors whose messages never
 * contain cookie material.
 *
 * options: { bvid, sessdata, fetchImpl?, signal?, timeoutMs?, minGapMs?,
 *            wbiKeys? (cached {imgKey, subKey} — skips the nav hop),
 *            onWbiKeys? (callback receiving freshly fetched keys) }
 */
export async function fetchBilibiliSubtitles(options = {}) {
	const fetchImpl = options.fetchImpl || globalThis.fetch;
	if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable');
	// bvids are case-sensitive (BV + base58) — never case-normalize them.
	const bvid = String(options.bvid || '').trim();
	if (!BVID_RE.test(bvid)) throw new Error('invalid bvid');
	const sessdata = String(options.sessdata || '');
	const signal = options.signal || null;
	const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1000, Number(options.timeoutMs)) : 8000;
	const minGapMs = Number.isFinite(options.minGapMs) ? Math.max(0, Number(options.minGapMs)) : 300;
	let lastRequestAt = 0;

	const requestJson = async (url, { withCookie = false } = {}) => {
		const wait = minGapMs - (Date.now() - lastRequestAt);
		if (wait > 0) await delay(wait, signal);
		lastRequestAt = Date.now();
		const controller = new AbortController();
		const onAbort = () => controller.abort(signal.reason || new Error('cancelled'));
		if (signal) {
			if (signal.aborted) throw signal.reason || new Error('cancelled');
			signal.addEventListener('abort', onAbort, { once: true });
		}
		const timer = setTimeout(() => controller.abort(Object.assign(new Error('bilibili request timed out'), { name: 'TimeoutError' })), timeoutMs);
		// The caller's deadline may race this request away; an un-cleared unref'd
		// timer must never hold a test process (or the host) open.
		if (typeof timer.unref === 'function') timer.unref();
		try {
			const headers = {
				'accept': 'application/json, text/plain, */*',
				'referer': BILIBILI_REFERER,
				'user-agent': USER_AGENT,
				'accept-language': 'zh-CN,zh;q=0.9',
			};
			if (withCookie && sessdata) headers.cookie = 'SESSDATA=' + sessdata;
			const response = await fetchImpl(url, { headers, signal: controller.signal });
			if (controller.signal.aborted) throw controller.signal.reason;
			if (!response.ok) throw new Error('HTTP ' + response.status);
			const payload = await response.json();
			if (controller.signal.aborted) throw controller.signal.reason;
			return payload;
		} finally {
			clearTimeout(timer);
			if (signal) signal.removeEventListener('abort', onAbort);
		}
	};

	// 1. view: public metadata hop that yields the cid (and canonical title).
	const view = await requestJson(BILIBILI_API_BASE + '/x/web-interface/view?bvid=' + encodeURIComponent(bvid));
	if (Number(view?.code) !== 0 || !view?.data) throw new Error('bilibili view api code ' + String(view?.code ?? 'null'));
	const cid = Number(view.data.cid);
	if (!Number.isFinite(cid) || cid <= 0) throw new Error('bilibili view api returned no cid');
	const title = String(view.data.title || '');
	const upName = String(view.data.owner?.name || '');
	const durationSec = Number(view.data.duration) || 0;

	// 2. Wbi keys: from the caller's cache when fresh, else the nav hop.
	let keys = options.wbiKeys && options.wbiKeys.imgKey && options.wbiKeys.subKey ? options.wbiKeys : null;
	if (!keys) {
		const nav = await requestJson(BILIBILI_API_BASE + '/x/web-interface/nav', { withCookie: true });
		if (Number(nav?.code) !== 0) {
			throw new Error('bilibili nav api code ' + String(nav?.code ?? 'null') + ' (cookie missing or expired)');
		}
		keys = wbiKeysFromNav(nav);
		if (!keys) throw new Error('bilibili nav api returned no wbi keys');
		if (typeof options.onWbiKeys === 'function') {
			try { options.onWbiKeys(keys); } catch { /* cache bookkeeping is best-effort */ }
		}
	}

	// 3. Signed player hop. code:0 + tracks + empty urls = signature rejected.
	const signedQuery = signWbiParams({ bvid, cid: String(cid) }, keys.imgKey, keys.subKey);
	const player = await requestJson(BILIBILI_API_BASE + '/x/player/wbi/v2?' + signedQuery, { withCookie: true });
	if (Number(player?.code) !== 0 || !player?.data) throw new Error('bilibili player api code ' + String(player?.code ?? 'null'));
	const tracks = Array.isArray(player.data.subtitle?.subtitles) ? player.data.subtitle.subtitles : [];
	const urlCount = tracks.filter((row) => row && typeof row === 'object' && String(row.subtitle_url || '').length > 0).length;
	if (tracks.length > 0 && urlCount === 0) {
		throw new Error('bilibili player api returned ' + tracks.length + ' subtitle tracks with empty urls (wbi signature rejected)');
	}

	// 4. Pick a track and download its JSON (protocol-relative URL, no cookie).
	const track = pickSubtitleTrack(tracks);
	if (!track) {
		return { lines: [], bvid, title, upName, durationSec, cid, pickedLan: '', trackCount: tracks.length, urlCount };
	}
	let subtitleUrl = String(track.subtitle_url || '');
	if (subtitleUrl.startsWith('//')) subtitleUrl = 'https:' + subtitleUrl;
	if (!/^https:\/\//.test(subtitleUrl)) throw new Error('bilibili subtitle url has an unexpected protocol');
	const payload = await requestJson(subtitleUrl);
	return {
		lines: subtitlesToLines(payload?.body),
		bvid, title, upName, durationSec, cid,
		pickedLan: String(track.lan || ''),
		trackCount: tracks.length, urlCount,
	};
}

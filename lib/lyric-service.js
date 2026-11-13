/** Multi-source lyrics, in order: NetEase, QQ, KuGou, Migu, then the local file.
 * None of the desktop clients needs to run for online lyric requests.
 * Source-specific errors, confidence checks, request spacing and bounded caches
 * are shared. All three endpoints are undocumented and can change or be
 * rate-limited; the local-file pass is what keeps the overlay working offline.
 */
import { findLocalLyrics } from './local-lyrics.js';
import { extractBilibiliSessdata, fetchBilibiliSubtitles, parseNetscapeCookies } from './bilibili-subtitles.js';

const DEFAULT_API_BASE = 'https://music.163.com';
const QQ_BASE = 'https://c.y.qq.com';
// QQ's translation stream only exists on the musicu gateway. `fcg_query_lyric_new`
// (what this plugin used to read) returns `trans: ''` for every song measured
// (2026-11-11: 8/8 hot foreign tracks, 0 timed translation lines), so QQ never
// showed a translation in the capsule. `GetPlayLyricInfo` with crypt=0&qrc=0
// hands back BOTH documents as plain base64 LRC — same line count, same
// timestamps (measured 0.000s delta on 47/47 and 88/88 lines), no decryption
// needed. Only QQ's *QRC* word-level stream is 3DES-encrypted (crypt=1), and
// that is deliberately not used here.
const QQ_MUSICU = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const KUGOU_SEARCH_BASE = 'https://songsearch.kugou.com';
const KUGOU_LRC_BASE = 'https://krcs.kugou.com';
const KUGOU_DOWNLOAD_BASE = 'https://lyrics.kugou.com';
// Migu: the search response carries `lrcUrl` and that URL is plain UTF-8 LRC, so
// the whole source is two requests and needs no signature, login or headers.
// The older `search_all.do` endpoints are avoided on purpose: they carry no
// duration at all, which silently disables the version check (a Live take then
// matches the studio original).
const MIGU_SEARCH_BASE = 'https://app.u.nf.migu.cn';
// bilibili video subtitles are a bvid-pinned extra source, NOT a search
// source: a bvid identifies the exact video the user is watching, so the
// title/artist scorer does not apply. It runs ahead of ONLINE_SOURCES when
// the facts carry a bvid and falls back silently.
const SOURCE_LABELS = { netease: '网易云', qq: 'QQ 音乐', kugou: '酷狗音乐', migu: '咪咕音乐', local: '本地文件', bilibili: 'B站字幕' };
const ONLINE_SOURCES = ['netease', 'qq', 'kugou', 'migu'];
const PERSISTABLE_SOURCES = [...ONLINE_SOURCES, 'bilibili'];
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';
const REQUEST_TIMEOUT_MS = 8000;
const MIN_REQUEST_GAP_MS = 800;
const NEGATIVE_TTL_MS = 10 * 60 * 1000;
const ERROR_TTL_MS = 30 * 1000;
// 15 days (user request 2026-11-09): a matched track's lines basically never
// change, so a longer positive cache means fewer upstream requests and no
// provider churn on repeat listens. Negatives/errors keep their short TTLs.
const SUCCESS_TTL_MS = 15 * 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 300;
const PERSIST_DEBOUNCE_MS = 2000;
// Netease /web search throttle observed to persist >=5 min (live probe
// 2026-11-13: still code 405 at t+300s), so the fallback window is sized in
// minutes, not seconds — one avoided 405 round-trip per track adds up.
const NETEASE_SEARCH_FALLBACK_MS = 6 * 60 * 1000;
// The throttle arrives as an HTTP 200 envelope with code 405 ("操作频繁"),
// verified live 2026-11-13 (both anonymous GET and cookie'd POST).
let neteaseSearchFallbackUntil = 0;
function neteaseSearchBlockedCode(data) {
	return Boolean(data) && Number(data.code) === 405;
}
function neteaseSearchBlockedError(err) {
	// request() throws Error('HTTP <status>') without a .status field, so the
	// status has to be recovered from the message it built (our own text).
	const match = /^HTTP (\d+)$/.exec(String(err && err.message || ''));
	const status = match ? Number(match[1]) : 0;
	return status === 405 || status === 429;
}

/** Lowercase, collapse whitespace, drop bracketed noise suffixes (live/翻自/cover). */
function normalizeText(value) {
	let text = String(value == null ? '' : value).toLowerCase();
	text = text.replace(/\s+/g, ' ').trim();
	text = text.replace(/[(（\[【][^)）\]】]{0,40}(live|现场|翻自|cover|remix|伴奏|instrumental)[^)）\]】]{0,40}[)）\]】]/g, ' ').trim();
	return text;
}

/** Stable fingerprint for one SMTC track identity. */
export function fingerprintOf(title, artist) {
	return normalizeText(title) + '|' + normalizeText(artist);
}

/**
 * Parse one LRC document into sorted [{t, text}].
 * Handles [mm:ss], [mm:ss.xx], [mm:ss.xxx] and multi-timestamp lines;
 * skips empty text and stray metadata lines ([ti:] etc. — they carry no
 * minute:second pair so the regex naturally leaves them behind as text
 * without timestamps, which we drop).
 */
export function parseLrc(text) {
	const out = [];
	if (typeof text !== 'string' || text.length === 0) return out;
	// A positive LRC offset advances lyrics: subtract milliseconds from timestamps.
	let offsetSec = 0;
	for (const match of text.matchAll(/\[offset:\s*([+-]?\d+)\s*\]/gi)) {
		const value = Number(match[1]) / 1000;
		if (Number.isFinite(value)) offsetSec = value;
	}
	for (const rawLine of text.split(/\r\n|\n|\r/)) {
		const line = rawLine.trim();
		if (line.length === 0) continue;
		const stampRegex = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
		const stamps = [];
		let match;
		let lastEnd = 0;
		while ((match = stampRegex.exec(line)) !== null) {
			const minutes = Number(match[1]);
			const seconds = Number(match[2]);
			const fracRaw = match[3] == null ? '' : match[3];
			const frac = Number('0.' + fracRaw) || 0;
			stamps.push(minutes * 60 + seconds + frac);
			lastEnd = stampRegex.lastIndex;
		}
		if (stamps.length === 0) continue;
		const textPart = line.slice(lastEnd).trim();
		if (textPart.length === 0) continue;
		for (const t of stamps) out.push({ t: t - offsetSec, text: textPart });
	}
	out.sort((a, b) => a.t - b.t);
	return out;
}

/** Two rows closer than this are the same lyric line (original + translation). */
const BILINGUAL_WINDOW_SEC = 0.25;

/** Script composition of one text run. Ratios, not mere presence: the old
 * placeholder signature ('has latin' → L, 'has kana' → K, 'has Han' → H)
 * misclassified real lyric shapes — a Chinese translation containing one
 * latin word ("come on") shares the LH signature with a Chinese-English
 * mixed original, a Korean original has no signature letter at all — and
 * the fold then glued original and translation into one blob. Measured on
 * probes 2026-11-13; the ratio test (adapted from Hikari16665/dsh-netease-
 * lyrics pairing.js, MIT) classified all 8 probe cases correctly. */
function scriptStats(text) {
	const chars = Array.from(String(text));
	let total = 0, cjk = 0, latin = 0;
	let kana = false, hangul = false;
	for (const ch of chars) {
		const code = ch.codePointAt(0);
		// Skip punctuation/whitespace/digits so "你好，是我" is not diluted
		// by the comma — only letters vote on which script a run carries.
		const isLetter =
			(code >= 0x3040 && code <= 0x30ff) || // kana
			(code >= 0xac00 && code <= 0xd7af) || // hangul
			(code >= 0x3400 && code <= 0x9fff) || // Han (ext A + block)
			(code >= 0xf900 && code <= 0xfaff) || // Han compat
			(code >= 0x0041 && code <= 0x005a) || // A-Z
			(code >= 0x0061 && code <= 0x007a) || // a-z
			(code >= 0x00c0 && code <= 0x024f);   // latin-1 supplement etc.
		if (!isLetter) continue;
		total++;
		if ((code >= 0x3040 && code <= 0x30ff)) kana = true;
		if ((code >= 0xac00 && code <= 0xd7af)) hangul = true;
		if ((code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)) cjk++;
		if ((code >= 0x0041 && code <= 0x005a) || (code >= 0x0061 && code <= 0x007a) || (code >= 0x00c0 && code <= 0x024f)) latin++;
	}
	return {
		cjkRatio: total === 0 ? 0 : cjk / total,
		latinRatio: total === 0 ? 0 : latin / total,
		kana, hangul,
	};
}

/** Dominant script label: which single class a run mostly belongs to. */
function dominantScript(text) {
	const stats = scriptStats(text);
	if (stats.kana) return 'K';
	if (stats.hangul) return 'J';
	if (stats.cjkRatio >= 0.4) return 'H';
	if (stats.latinRatio >= 0.4) return 'L';
	return '';
}

/** Do two runs plausibly belong to different languages? True when one side
 * is dominantly CJK and the other dominantly an alphabet, or when exactly
 * one side carries kana/hangul. Two runs of the SAME script never differ. */
function scriptDiffers(aText, bText) {
	const a = scriptStats(aText), b = scriptStats(bText);
	const aCjk = a.cjkRatio >= 0.4, bCjk = b.cjkRatio >= 0.4;
	const aAlpha = a.latinRatio >= 0.4 || a.kana || a.hangul;
	const bAlpha = b.latinRatio >= 0.4 || b.kana || b.hangul;
	if ((aCjk && bAlpha) || (bCjk && aAlpha)) return true;
	if (a.kana !== b.kana) return true;
	if (a.hangul !== b.hangul) return true;
	return false;
}

/**
 * Fold a SINGLE lyrics document that carries both languages into text+trans.
 *
 * Why only single documents: our four online sources ship the translation as a
 * SEPARATE document that mergeTranslation() pairs by timestamp (measured
 * 2026-11-11 on 8 bilingual songs: 51/51, 82/82, 56/56 … paired, the only
 * unpaired rows being 作词/作曲 staff lines). Those never need folding.
 *
 * A local `.lrc` sidecar or an embedded LRC tag, however, is one document that
 * usually writes the translation on its own line with the SAME timestamp:
 *
 *     [00:06.19]Hello, it's me
 *     [00:06.19]你好，是我
 *
 * parseLrc() keeps that as two rows; currentLineIndex() (a "last row <= pos"
 * binary search) then picks the SECOND one, so the caption showed the
 * translation and the original line disappeared entirely. Verified end to end
 * on a real sidecar before this fix.
 *
 * Rules, in order, for one timestamp group:
 *   - identical text            → one row (a plain duplicate, never a pair)
 *   - runs alternate original/translation: a row in the original's script
 *     class closes the open pair and starts a new one (two fast pairs in one
 *     group each keep their own line), while a row in another script extends
 *     the translation run (translation + romanisation join with \n)
 *   - same script class before any translation → the source wrapped one
 *     sentence across two rows; join them so nothing is lost
 *   - a group opening with punctuation ('...', '♪') → the first script-bearing
 *     row defines the original's language
 *
 * @param {Array<{t:number,text:string}>} rows sorted, from parseLrc()
 * @returns {Array<{t:number,text:string,trans?:string}>}
 */
export function foldBilingualLines(rows) {
	if (!Array.isArray(rows) || rows.length < 2) return Array.isArray(rows) ? rows : [];

	const groups = [];
	for (const row of rows) {
		if (row === null || typeof row !== 'object' || !Number.isFinite(row.t)) continue;
		const text = String(row.text == null ? '' : row.text).trim();
		if (text === '') continue;
		const last = groups[groups.length - 1];
		if (last !== undefined && row.t - last.t <= BILINGUAL_WINDOW_SEC) {
			last.rows.push({ t: row.t, text, trans: row.trans });
		} else {
			groups.push({ t: row.t, rows: [{ t: row.t, text, trans: row.trans }] });
		}
	}

	const out = [];
	for (const group of groups) {
		const first = group.rows[0];
		if (group.rows.length === 1) {
			out.push(first.trans ? first : { t: first.t, text: first.text });
			continue;
		}
		// A row that already carries a `trans` (an online pair) is left alone:
		// folding it again would merge two different lines.
		if (group.rows.some((row) => typeof row.trans === 'string' && row.trans !== '')) {
			for (const row of group.rows) out.push(row);
			continue;
		}
		const distinct = [];
		for (const row of group.rows) {
			if (!distinct.some((seen) => seen.text === row.text)) distinct.push(row);
		}
		if (distinct.length === 1) {
			out.push({ t: first.t, text: distinct[0].text });
			continue;
		}
		// Pair each original run with the translation run that FOLLOWS it.
		//
		// The old fold treated a group as "first row = original, the rest =
		// translation". That is right for the two shapes a local sidecar
		// actually writes ([orig, trans] and [orig-wrapped…, trans, romaji]),
		// but it CORRUPTS a group holding two fast pairs — [orig1, trans1,
		// orig2, trans2] folded orig2 into the translation blob and the line
		// vanished from the display. Dense passages with sub-0.25s line
		// spacing do occur (rap, karaoke timing), so walk the rows as
		// alternating runs: a row in the original's script closes the open
		// pair and starts a new one instead of being swallowed.
		let origText = distinct[0].text;
		const pairs = [];
		let current = { t: distinct[0].t, text: [distinct[0].text], trans: [] };
		for (const row of distinct.slice(1)) {
			const rowSig = dominantScript(row.text);
			const origSig = dominantScript(origText);
			// A group can open with a punctuation row ('...', '♪' — no script
			// class). Let the first script-bearing row define the original's
			// language rather than treating it as a translation of '...'.
			if (origSig === '' && rowSig !== '') {
				origText = row.text;
				current.text.push(row.text);
				continue;
			}
			const sameScript = rowSig !== '' && origSig !== '' && rowSig === origSig;
			const differs = scriptDiffers(origText, row.text);
			if (sameScript || (!differs && rowSig !== '')) {
				if (current.trans.length === 0) {
					// Same language before any translation: the source wrapped
					// one sentence. Join rather than drop the earlier rows,
					// which is what the old "last row wins" lookup did.
					current.text.push(row.text);
				} else {
					pairs.push(current);
					current = { t: row.t, text: [row.text], trans: [] };
				}
			} else {
				// Different script: the translation run (translation +
				// romanisation join with \n, matching mergeTranslation).
				current.trans.push(row.text);
			}
		}
		pairs.push(current);
		for (const pair of pairs) {
			out.push(pair.trans.length === 0
				? { t: pair.t, text: pair.text.join(' ') }
				: { t: pair.t, text: pair.text.join(' '), trans: pair.trans.join('\n') });
		}
	}
	return out;
}

/** parseLrc + foldBilingualLines: for single documents that may be bilingual. */
export function parseLrcFolded(text) {
	return foldBilingualLines(parseLrc(text));
}

/** NetEase YRC line: `[startMs,durMs]content`. */
const YRC_LINE_RE = /^\[(\d+),(\d+)\](.*)$/;
/** NetEase YRC word: `(wordStartMs,wordDurMs,unused)text` — ABSOLUTE ms. */
const YRC_WORD_RE = /\((\d+),(\d+),\d+\)([^([\]]*)/g;

/**
 * Parse NetEase's YRC word-level document into per-word timelines.
 *
 * Requested with `yv=-1` on the same `/api/song/lyric` call that already
 * returns lrc + tlyric, so it costs NO extra request. Measured 2026-11-11:
 * 6 of 10 sampled tracks shipped a YRC stream; `lrc`/`tlyric` were unaffected
 * either way.
 *
 * This is an ENHANCEMENT only, and the rules below exist to keep it that way:
 *   - the caller keeps the LRC lines for everything (text, translation, line
 *     switching); words are attached to an existing line, never used to create,
 *     reorder or re-time one;
 *   - alignment is by LINE TEXT first, because the two documents do not always
 *     have the same number of rows (measured: 十年 48 LRC vs 45 YRC, 十年 Live
 *     92 vs 60 — YRC folds the staff block differently). Text alignment matched
 *     38/48 lines where a pure index zip matched only 17/48;
 *   - alignment falls back to index ONLY when the counts are equal AND text
 *     alignment found nothing (a payload with re-encoded text);
 *   - whichever path is used, the assigned line count must not shrink the
 *     result: a line with no YRC twin simply keeps no `words`;
 *   - words are clamped to their line's window so a corrupt payload cannot
 *     paint outside it.
 *
 * @param {string} text the `yrc.lyric` payload
 * @param {Array<{t:number,text:string}>} lrcLines the already-parsed LRC lines
 * @returns {Array<{t:number,text:string,words?:Array<{t:number,end:number,text:string}>}>}
 *          a NEW array with `words` on the lines that could be aligned
 */
export function attachYrcWords(text, lrcLines) {
	if (typeof text !== 'string' || text === '') return lrcLines;
	if (!Array.isArray(lrcLines) || lrcLines.length === 0) return lrcLines;

	const parsed = [];
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === '') continue;
		// `[ti:]`-style metadata has no `,` between two numbers and is skipped
		// by the line regex on its own.
		const match = YRC_LINE_RE.exec(line);
		if (match === null) continue;
		const content = match[3];
		const words = [];
		let plain = '';
		YRC_WORD_RE.lastIndex = 0;
		let word;
		while ((word = YRC_WORD_RE.exec(content)) !== null) {
			const wordText = word[3];
			if (wordText === '') continue;
			const wordStart = Number(word[1]) || 0;
			const wordDur = Number(word[2]) || 0;
			words.push({ t: wordStart / 1000, end: (wordStart + wordDur) / 1000, text: wordText });
			plain += wordText;
		}
		// The row's own text is the concatenation of its word tokens, which is
		// how the LRC line reads (minus the timing tags).
		parsed.push({ text: (plain !== '' ? plain : content).trim(), words });
	}
	if (parsed.length === 0) return lrcLines;

	// ── alignment ───────────────────────────────────────────────────────────
	// Both documents repeat lines (a chorus), so a plain text→row map would
	// throw every duplicate away — measured on Hello that cost 52 of 53 lines.
	// Instead: group both sides by text and, for each text, pair the i-th
	// occurrence on one side with the i-th on the other. Repeated choruses keep
	// their own word timelines, and a text present a different number of times
	// on each side is simply left unaligned (conservative: no sweep beats a
	// sweep from the wrong line).
	const yrcByText = new Map();
	for (const row of parsed) {
		if (row.text === '') continue;
		if (!yrcByText.has(row.text)) yrcByText.set(row.text, []);
		yrcByText.get(row.text).push(row);
	}
	const lrcSeen = new Map();
	const plan = lrcLines.map((line) => {
		const key = String(line.text == null ? '' : line.text).trim();
		const occurrence = lrcSeen.get(key) || 0;
		lrcSeen.set(key, occurrence + 1);
		const bucket = yrcByText.get(key);
		if (bucket === undefined) return null;
		return bucket[occurrence] === undefined ? null : bucket[occurrence];
	});
	// A text whose occurrence counts differ can still be matched by position up
	// to the shorter side; the loop above already yields null past the end.

	let alignedBy = 'text';
	if (!plan.some(Boolean) && parsed.length === lrcLines.length) {
		// The text did not line up at all but the counts did: zip by index.
		plan.length = 0;
		for (let i = 0; i < lrcLines.length; i += 1) plan.push(parsed[i]);
		alignedBy = 'index';
	}
	if (!plan.some(Boolean)) return lrcLines;

	const out = [];
	for (let i = 0; i < lrcLines.length; i += 1) {
		const line = lrcLines[i];
		const source = plan[i];
		if (!source || source.words.length === 0) { out.push(line); continue; }
		// Clamp each word into [line.t, nextLine.t] (or line.t + 12s for the last
		// line). A payload whose stamps disagree with the LRC timeline then
		// degrades to "no sweep" instead of sweeping outside the line.
		const lower = Number(line.t);
		const nextT = i + 1 < lrcLines.length ? Number(lrcLines[i + 1].t) : NaN;
		const upper = Number.isFinite(nextT) && nextT > lower ? nextT : lower + 12;
		const clamped = [];
		for (const word of source.words) {
			if (!Number.isFinite(word.t) || !Number.isFinite(word.end)) continue;
			if (word.end <= lower || word.t >= upper) continue;
			const start = Math.max(lower, Math.min(upper, word.t));
			const end = Math.max(start, Math.min(upper, word.end));
			if (end - start <= 0) continue;
			clamped.push({ t: Number(start.toFixed(3)), end: Number(end.toFixed(3)), text: word.text });
		}
		if (clamped.length === 0) { out.push(line); continue; }
		out.push({ ...line, words: clamped });
	}
	// Diagnostics for `describe()`: how the words were matched, if at all.
	lastYrcAlignment = { alignedBy, yrcRows: parsed.length, lrcRows: lrcLines.length, withWords: out.filter((row) => Array.isArray(row.words)).length };
	return out;
}
/** Last YRC alignment outcome (counts only; never lyric text). */
let lastYrcAlignment = null;
export function yrcAlignment() { return lastYrcAlignment; }

/** Score one search candidate against the SMTC facts. Higher is better. */
function scoreCandidate(candidate, facts) {
	const candTitle = normalizeText(candidate.name);
	const candArtists = (Array.isArray(candidate.artists) ? candidate.artists : [])
		.map((artist) => normalizeText(artist && artist.name))
		.filter((name) => name.length > 0);

	let score = 0;
	// Title: exact is worth the most; containment still helps (feat./suffix noise).
	if (candTitle.length > 0) {
		if (candTitle === facts.title) score += 4;
		else if (candTitle.includes(facts.title) || facts.title.includes(candTitle)) score += 2;
	}
	// Artist: any overlap counts.
	if (facts.artist && candArtists.some((name) => facts.artist.includes(name) || name.includes(facts.artist))) score += 2;
	// Duration (candidate is ms, facts are seconds): the strongest signal
	// when present — covers/live versions of the same title lose here.
	if (facts.durationSec > 0 && Number.isFinite(candidate.duration) && candidate.duration > 0) {
		const delta = Math.abs(candidate.duration / 1000 - facts.durationSec);
		if (delta <= 2) score += 3;
		else if (delta <= 5) score += 2;
		else if (delta <= 10) score += 1;
		else score -= 2;
	}
	return score;
}

/** Decode QQ's Base64 LRC and common HTML entities without rendering HTML. */
export function decodeQQText(value) {
	if (typeof value !== 'string' || !value) return '';
	const text = /^\s*\[/.test(value) ? value : Buffer.from(value, 'base64').toString('utf8');
	return text.replace(/&#(x[0-9a-f]+|\d+);|&(amp|lt|gt|quot|apos|nbsp);/gi, (all, num, named) => {
		if (num) {
			const code = /^x/i.test(num) ? parseInt(num.slice(1), 16) : Number(num);
			return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
		}
		return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[named.toLowerCase()];
	});
}

function mergeTranslation(main, translation) {
	let cursor = 0;
	return main.map(row => {
		while (cursor + 1 < translation.length && translation[cursor + 1].t <= row.t) cursor++;
		const nearby = [translation[cursor], translation[cursor + 1]].filter(Boolean)
			.sort((a, b) => Math.abs(a.t - row.t) - Math.abs(b.t - row.t))[0];
		return nearby && Math.abs(nearby.t - row.t) <= 0.10
			? { ...row, trans: nearby.text } : row;
	});
}

/** Spread untimed lyrics evenly across the track (best effort, clearly labelled). */
export function synthLines(text, durationSec) {
	const rows = String(text || '').split(/\r\n|\n|\r/).map(line => line.trim()).filter(line => line.length > 0);
	if (rows.length === 0) return [];
	const duration = Number(durationSec) > 0 ? Number(durationSec) : 0;
	const step = duration > 0 ? Math.max(1.5, duration / (rows.length + 1)) : 4;
	return rows.map((line, index) => ({ t: Number((step * (index + 1)).toFixed(2)), text: line }));
}

function selectCandidate(candidates, facts) {
	if (!facts.title) return null;
	return candidates.map(candidate => ({ candidate, score: scoreCandidate(candidate, facts) }))
		.filter(({ candidate, score }) => {
			const title = normalizeText(candidate.name);
			if (!title || !(title === facts.title || title.includes(facts.title) || facts.title.includes(title))) return false;
			if (facts.artist && !candidate.artists.some(row => {
				const artist = normalizeText(row?.name);
				return artist && (facts.artist.includes(artist) || artist.includes(facts.artist));
			})) return false;
			// Refuse different recordings rather than using an apparently strong title match.
			if (facts.durationSec > 0 && candidate.duration > 0 && Math.abs(candidate.duration / 1000 - facts.durationSec) > 10) return false;
			return score >= 4;
		}).sort((a, b) => b.score - a.score)[0] || null;
}

/** Reset the module-level netease search backoff. The fallback window is
 * shared per process (one throttled /web pool blocks the whole pool), which
 * also means node --test runs share it across checks — tests use this to
 * start from a clean slate. */
export function resetNeteaseSearchBackoff() {
	neteaseSearchFallbackUntil = 0;
}

/** Should the host schedule a delayed origin rematch? True only when the
 * result is a successful match from a NON-origin provider while the origin
 * provider itself errored — the throttle/rate-limit fingerprint (verified
 * live 2026-11-09: netease "API code 406" during a burst handed the track to
 * kugou for a week). A confident origin miss is a real miss, never a rematch. */
export function shouldOriginRematch(result, originSource) {
	if (!result || result.status !== 'matched' || !result.source) return false;
	const origin = String(originSource || '');
	if (!origin || result.source === origin) return false;
	return Array.isArray(result.attempts)
		&& result.attempts.some((row) => row && row.source === origin && row.status === 'error');
}

/** The media's own provider goes first when known (QQ Music playing -> QQ
 * lyrics first), then the default order — multi-source is a safety net, not
 * a source swap (user decision 2026-11-09). */
function orderedSources(facts) {
	const origin = String(facts.originSource || '');
	if (!ONLINE_SOURCES.includes(origin)) return ONLINE_SOURCES;
	return [origin, ...ONLINE_SOURCES.filter((source) => source !== origin)];
}

export function createLyricService(options = {}) {
	const apiBase = String(options.apiBase || DEFAULT_API_BASE).replace(/\/+$/, '');
	const fetchImpl = options.fetchImpl || globalThis.fetch;
	const cacheFile = typeof options.cacheFile === 'string' ? options.cacheFile : '';
	const minGapMs = Number.isFinite(options.minRequestGapMs) ? Math.max(0, options.minRequestGapMs) : MIN_REQUEST_GAP_MS;
	const timeoutMs = options.requestTimeoutMs || REQUEST_TIMEOUT_MS;
	// Offline fallback: only consulted after every online source has failed.
	const localOptions = {
		enabled: options.localLyrics !== false,
		dirs: Array.isArray(options.localDirs) ? options.localDirs : [],
		budgetMs: Number.isFinite(options.localBudgetMs) ? options.localBudgetMs : undefined,
	};
	// Bilibili video subtitles: a bvid-pinned extra source (see
	// lib/bilibili-subtitles.js). Without a bvid in the facts nothing here is
	// contacted; without a readable cookie the attempt fails and the chain
	// falls through exactly as before.
	const bilibiliEnabled = options.bilibiliEnabled !== false;
	const bilibiliCookiePaths = (Array.isArray(options.bilibiliCookiePaths) ? options.bilibiliCookiePaths : [])
		.map((value) => String(value == null ? '' : value).trim()).filter(Boolean);
	const bilibiliRequestGapMs = Number.isFinite(options.bilibiliRequestGapMs)
		? Math.max(0, options.bilibiliRequestGapMs) : 300;
	// The whole signed chain runs under ONE deadline. Resolves are serialized,
	// so a hung/throttled bilibili chain used to hold the queue and delay the
	// next track's lyrics (reported live 2026-11-09: a client song's lyrics
	// froze while a bilibili video was also open). Past the budget the chain
	// aborts and the resolve falls back to whatever the session allows.
	const bilibiliChainBudgetMs = Number.isFinite(options.bilibiliChainBudgetMs)
		? Math.max(500, options.bilibiliChainBudgetMs) : 8000;
	const cache = new Map();
	const inflight = new Map();
	const jobs = new Map();
	const latestOnly = options.latestOnly === true;
	let disposed = false, latestKey = null, epoch = 0, activeJob = null;
	const cancelledResult = () => ({ status: 'cancelled', source: null, attempts: [], fetchedAt: Date.now() });
	const abortError = () => Object.assign(new Error('lyric resolution cancelled'), { name: 'AbortError' });
	function checkJob(job) {
		if (disposed || job?.controller.signal.aborted) throw abortError();
	}
	// Race even non-cooperating fetch/body implementations; remove listeners on settlement.
	function abortable(promise, signal) {
		return new Promise((resolve, reject) => {
			const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason || abortError()); };
			if (signal.aborted) { Promise.resolve(promise).catch(() => {}); abort(); return; }
			signal.addEventListener('abort', abort, { once: true });
			Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
		});
	}
	async function request(url, source, accept, read, init) {
		const job = activeJob;
		checkJob(job);
		if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable');
		const wait = minGapMs - (Date.now() - lastRequestAt);
		if (wait > 0) {
			let timer;
			try { await abortable(new Promise(resolve => { timer = setTimeout(resolve, wait); }), job.controller.signal); }
			finally { clearTimeout(timer); }
		}
		checkJob(job);
		lastRequestAt = Date.now();
		const controller = new AbortController();
		const abort = () => controller.abort(job.controller.signal.reason || abortError());
		job.controller.signal.addEventListener('abort', abort, { once: true });
		const timer = setTimeout(() => controller.abort(Object.assign(new Error('lyric request timed out'), { name: 'TimeoutError' })), timeoutMs);
		const referer = source === 'qq' ? 'https://y.qq.com/'
			: source === 'kugou' ? 'https://www.kugou.com/'
			: source === 'migu' ? 'https://music.migu.cn/v3/' : apiBase + '/';
		// `init` carries POST bodies (QQ's musicu gateway). Everything else stays
		// a plain GET, and the shared spacing/abort/timeout still apply either way.
		const method = init && init.method ? String(init.method).toUpperCase() : 'GET';
		const body = init && typeof init.body === 'string' ? init.body : undefined;
		const extraHeaders = (init && init.headers) || undefined;
		try {
			return await abortable((async () => {
				const response = await fetchImpl(url, {
					method,
					...(body === undefined ? {} : { body }),
					headers: { accept, referer, 'user-agent': USER_AGENT, 'accept-language': 'zh-CN,zh;q=0.9', ...(extraHeaders || {}) },
					signal: controller.signal,
				});
				if (controller.signal.aborted) throw controller.signal.reason;
				if (!response.ok) throw new Error('HTTP ' + response.status);
				const value = await read(response);
				if (controller.signal.aborted) throw controller.signal.reason;
				checkJob(job);
				return value;
			})(), controller.signal);
		} finally {
			clearTimeout(timer);
			job.controller.signal.removeEventListener('abort', abort);
		}
	}
	let chain = Promise.resolve(), lastRequestAt = 0, persistTimer = null, note = '';
	let lastAttempts = [];
	// Preserve recording/version labels in cache identity even though search normalization removes them.
	// A bvid (when present) is part of the identity: two videos can share a title,
	// and switching videos must never hit the previous video's cache entry.
	// bvids are case-sensitive (BV + base58) — keep the exact case.
	const trackKey = facts => fingerprintOf(facts.title, facts.artist) + '|' + String(facts.title || '').trim().toLowerCase()
		+ '|' + (Number(facts.durationSec) > 0 ? Math.round(Number(facts.durationSec)) : 0)
		+ (String(facts.bvid || '').trim() ? '|' + String(facts.bvid).trim() : '');
	function trimCache() {
		while (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
	}
	async function restoreCache() {
		if (!cacheFile) return;
		try {
			const fs = await import('node:fs/promises');
			if (disposed) return;
			const parsed = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
			// v1 entries used a single source and a different cache key. Leave the file
			// intact until the first normal save; refetch instead of migrating stale negatives.
			if (parsed.version !== 2 || !Array.isArray(parsed.entries)) return;
			if (disposed) return;
			for (const pair of parsed.entries.slice(-CACHE_MAX_ENTRIES)) {
				if (!Array.isArray(pair) || pair.length !== 2) continue;
				const [key, entry] = pair;
				if (typeof key === 'string' && entry?.status === 'matched'
					// Local files depend on current dirs/settings and may have changed.
					&& PERSISTABLE_SOURCES.includes(entry.source)
					&& Array.isArray(entry.lines) && entry.lines.length
					&& entry.lines.every((row, index) => row && typeof row === 'object'
						&& Number.isFinite(row.t) && typeof row.text === 'string'
						&& (index === 0 || row.t >= entry.lines[index - 1].t))
					&& Number.isFinite(entry.fetchedAt) && Date.now() - entry.fetchedAt < SUCCESS_TTL_MS) cache.set(key, entry);
			}
		} catch { /* Missing/corrupt cache is non-fatal. */ }
	}
	const ready = restoreCache();
	async function persist() {
		if (!cacheFile || disposed) return;
		try {
			const fs = await import('node:fs/promises');
			if (disposed) return;
			await fs.writeFile(cacheFile + '.tmp', JSON.stringify({ version: 2, entries: [...cache].filter(([, entry]) => entry.source !== 'local').slice(-CACHE_MAX_ENTRIES) }), 'utf8');
			if (disposed) return;
			await fs.rename(cacheFile + '.tmp', cacheFile);
		} catch { /* Memory cache remains usable. */ }
	}
	function schedulePersist() {
		if (!cacheFile || disposed || persistTimer !== null) return;
		persistTimer = setTimeout(() => { persistTimer = null; void persist(); }, PERSIST_DEBOUNCE_MS);
		persistTimer.unref?.();
	}
	function enqueue(job) {
		const run = chain.then(job);
		chain = run.then(() => undefined, () => undefined);
		return run;
	}
	async function getJson(url, source) {
		const payload = await request(url, source, 'application/json', response => response.json());
		if (!payload || typeof payload !== 'object') throw new Error('invalid JSON payload');
		if (payload.code !== undefined) {
			const expected = source === 'qq' ? 0 : 200;
			if (Number(payload.code) !== expected) throw new Error('API code ' + payload.code);
		}
		if (source === 'qq' && payload.retcode !== undefined && Number(payload.retcode) !== 0) throw new Error('API retcode ' + payload.retcode);
		// KuGou uses `status`: 1 for the song search, 200 for the lyric endpoints.
		if (source === 'kugou' && payload.status !== undefined
			&& Number(payload.status) !== 1 && Number(payload.status) !== 200) {
			throw new Error('API status ' + payload.status);
		}
		return payload;
	}
	/**
	 * POST one JSON body to QQ's musicu gateway.
	 *
	 * The gateway does not follow `fcg_*`'s envelope conventions: the outer
	 * `code` is 0 on success and the per-module answer lives in
	 * `req.code`/`req.data`, so `getJson`'s QQ rules would reject a perfectly
	 * good response. Errors are surfaced with the module's own code so a
	 * failure reads as "GetPlayLyricInfo req.code=-1", not "unexpected".
	 */
	async function getQQMusicu(moduleName, method, param) {
		const body = JSON.stringify({
			// cv/ct identify a desktop client; the endpoint answers anonymously.
			comm: { ct: '19', cv: '2111', format: 'json', inCharset: 'utf-8', outCharset: 'utf-8' },
			req: { module: moduleName, method, param },
		});
		const payload = await request(QQ_MUSICU, 'qq', 'application/json', response => response.json(), {
			method: 'POST',
			body,
			headers: { 'content-type': 'application/json', origin: 'https://y.qq.com' },
		});
		if (!payload || typeof payload !== 'object') throw new Error('invalid musicu payload');
		if (payload.code !== undefined && Number(payload.code) !== 0) throw new Error('musicu code ' + payload.code);
		const req = payload.req;
		if (!req || typeof req !== 'object') throw new Error('musicu payload has no req');
		if (req.code !== undefined && Number(req.code) !== 0) throw new Error(method + ' req.code ' + req.code);
		const data = req.data;
		if (!data || typeof data !== 'object') throw new Error(method + ' returned no data');
		return data;
	}
	/** QQ hands back plain base64 LRC when the request asks for crypt=0&qrc=0. */
	function decodeQQBase64Lrc(value) {
		if (typeof value !== 'string' || value === '') return '';
		const text = Buffer.from(value, 'base64').toString('utf8');
		// A non-base64 body would decode to mojibake: only accept a document that
		// starts like LRC (a BOM is tolerated).
		if (!/^\ufeff?\[/.test(text)) return '';
		// Still LRC text: reuse the entity decoder fcg's payload already needs.
		return decodeQQText(text);
	}
	/**
	 * QQ's translation document uses placeholder rows for instrumental stretches
	 * and a rights notice on the first line. Measured 2026-11-11 over 10 songs:
	 * `//` accounted for 35 of the "translated" rows. Left in, the capsule would
	 * show a bare `//` under every line that has no real translation — worse
	 * than showing nothing, because it looks like a decoding failure.
	 */
	function dropPlaceholderTranslations(rows) {
		if (!Array.isArray(rows) || rows.length === 0) return rows;
		return rows.filter((row) => {
			const text = String(row.text || '').trim();
			if (text === '') return false;
			// `//`, `///`, a lone `♪`, and other punctuation-only markers.
			if (!/[\p{L}\p{N}]/u.test(text)) return false;
			if (/^QQ音乐|^酷狗|^本翻译|^翻译[:：]|享有本翻译作品/.test(text)) return false;
			return true;
		});
	}
	// Migu hands back the LRC itself, not JSON, so it needs its own fetch that
	// still honours the shared request spacing and timeout.
	async function getText(url, source) {
		const text = await request(url, source, 'text/plain,*/*', response => response.text());
		if (typeof text !== 'string') throw new Error('invalid text payload');
		// Migu serves CRLF and sometimes a BOM.
		return text.replace(/^\ufeff/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	}

	// --- bilibili subtitle chain ------------------------------------------------
// The SESSDATA cookie is a login credential: keep it in memory only, keyed by
// file path + mtime so an updated export is re-read, and never log it or put
// it into results/state. Wbi keys are cached for a day and refreshed once on
// signature rejection ("tracks with empty urls").
const BILIBILI_WBI_TTL_MS = 24 * 60 * 60 * 1000;
let bilibiliWbi = { imgKey: '', subKey: '', fetchedAt: 0 };
// keyed by "path\0mtime": parsed SESSDATA (possibly '' — a file without a
// bilibili row is cached so it is not re-read) and, separately, the login
// verdict from the nav hop ('good'/'bad') — a stale SESSDATA must not poison
// a fresher export sitting in the next candidate slot (verified live:
// cookies.txt held an expired row that returned nav -101 while
// cookies-bilibili.txt was still logged in).
const bilibiliCookieCache = new Map();
const bilibiliCookieVerdicts = new Map();
async function readBilibiliSessionCandidates() {
	if (!bilibiliEnabled || bilibiliCookiePaths.length === 0) return [];
	const fsMod = await import('node:fs/promises');
	const candidates = [];
	for (const candidate of bilibiliCookiePaths) {
		try {
			const stat = await fsMod.stat(candidate);
			if (!stat.isFile()) continue;
			const cacheKey = candidate + '\0' + stat.mtimeMs;
			let sessdata = bilibiliCookieCache.get(cacheKey);
			if (sessdata === undefined) {
				const text = await fsMod.readFile(candidate, 'utf8');
				// Full-site exports reach thousands of rows: parse and keep only
				// the one bilibili.com SESSDATA value.
				sessdata = extractBilibiliSessdata(parseNetscapeCookies(text));
				if (bilibiliCookieCache.size > 8) bilibiliCookieCache.clear();
				bilibiliCookieCache.set(cacheKey, sessdata);
			}
			if (sessdata) {
				const label = candidate.replace(/\\/g, '/').split('/').pop();
				candidates.push({ key: cacheKey, label, sessdata });
			}
		} catch { /* try the next candidate */ }
	}
	return candidates;
}
async function fetchBilibili(facts, job) {
	checkJob(job);
	if (!bilibiliEnabled) throw new Error('bilibili source disabled');
	const candidates = await abortable(readBilibiliSessionCandidates(), job.controller.signal);
	checkJob(job);
	if (candidates.length === 0) throw new Error('bilibili cookie missing or expired (no bilibili SESSDATA in cookies.txt)');
	const wbiKeys = bilibiliWbi.fetchedAt > 0 && Date.now() - bilibiliWbi.fetchedAt < BILIBILI_WBI_TTL_MS
		? { imgKey: bilibiliWbi.imgKey, subKey: bilibiliWbi.subKey } : null;
	const runAttempt = async (attemptOptions) => {
		try {
			return await fetchBilibiliSubtitles(attemptOptions);
		} catch (err) {
			if (!/empty urls/.test(String(err?.message || err))) throw err;
			// Signature rejected (verified live failure shape): drop the cached
			// keys, fetch fresh ones and retry exactly once.
			checkJob(job);
			return await fetchBilibiliSubtitles({ ...attemptOptions, wbiKeys: null });
		}
	};
	let lastError = '';
	// One deadline for the whole chain (every candidate and retry): past the
	// budget the fetches abort and the caller sees a normal attempt error, so
	// the serialized resolve queue is never held hostage by a hung upstream.
	const deadline = new AbortController();
	const onJobAbort = () => deadline.abort(job.controller.signal.reason || new Error('cancelled'));
	job.controller.signal.addEventListener('abort', onJobAbort, { once: true });
	const budgetTimer = setTimeout(
		() => deadline.abort(Object.assign(new Error('bilibili chain budget exceeded'), { name: 'TimeoutError' })),
		bilibiliChainBudgetMs);
	// NOTE: deliberately NOT unref'd. This timer is the only thing that can
	// break a hung chain, so it must keep the loop alive long enough to fire;
	// every normal path clears it in the finally below.
	try {
	for (const candidate of candidates) {
		checkJob(job);
		// A file whose SESSDATA no longer logs in is remembered per mtime:
		// retrying it on every track would waste a nav round-trip, while a
		// re-exported file (new mtime) is re-validated automatically.
		if (bilibiliCookieVerdicts.get(candidate.key) === 'bad') {
			lastError = 'bilibili cookie expired or not logged in (' + candidate.label + ')';
			continue;
		}
		try {
			const result = await abortable(runAttempt({
				bvid: facts.bvid, sessdata: candidate.sessdata, fetchImpl,
				signal: deadline.signal, timeoutMs, minGapMs: bilibiliRequestGapMs,
				wbiKeys,
				onWbiKeys: (keys) => { bilibiliWbi = { ...keys, fetchedAt: Date.now() }; },
			}), deadline.signal);
			bilibiliCookieVerdicts.set(candidate.key, 'good');
			return result;
		} catch (err) {
			checkJob(job);
			const message = String(err?.message || err);
			if (/cookie missing or expired/.test(message)) {
				// The nav hop rejected THIS file's login: try the next export.
				bilibiliCookieVerdicts.set(candidate.key, 'bad');
				lastError = 'bilibili cookie expired or not logged in (' + candidate.label + ')';
				continue;
			}
			throw err;
		}
	}
	if (bilibiliCookieVerdicts.size > 32) bilibiliCookieVerdicts.clear();
	throw new Error(lastError || 'bilibili cookie missing or expired');
	} finally {
		clearTimeout(budgetTimer);
		job.controller.signal.removeEventListener('abort', onJobAbort);
	}
}

async function search(source, facts) {
		const query = (facts.title + ' ' + facts.artist).trim();
		if (source === 'netease') {
			// Primary: /api/search/get/web. Fallback: /api/search/get — the two
			// endpoints keep independent rate-limit pools (live-tested 2026-11-13:
			// 100 sequential anonymous /web requests -> envelope code 405 for
			// >=5 min, while /get answered 200 throughout) and /get returns the
			// same legacy song shape (artists[]/duration ms/mvid), so it is a
			// drop-in for the parser below. The fallback stays a fallback: the
			// primary endpoint is tried first on every track unless we are
			// inside the backoff window.
			let forcedFallback = false;
			if (neteaseSearchFallbackUntil > Date.now()) {
				forcedFallback = true;
			} else if (neteaseSearchFallbackUntil > 0) {
				// Backoff window elapsed - clear it and trust /web again.
				neteaseSearchFallbackUntil = 0;
			}
			let data;
			try {
				data = forcedFallback
					? await getJson(apiBase + '/api/search/get?s=' + encodeURIComponent(query) + '&type=1&limit=10&offset=0', source)
					: await getJson(apiBase + '/api/search/get/web?s=' + encodeURIComponent(query) + '&type=1&limit=10&offset=0', source);
			} catch (err) {
				if (forcedFallback || neteaseSearchBlockedError(err)) throw err;
				// /web failed at the transport level (or a non-200 status) -
				// fall back once before giving up.
				data = await getJson(apiBase + '/api/search/get?s=' + encodeURIComponent(query) + '&type=1&limit=10&offset=0', source);
				neteaseSearchFallbackUntil = Date.now() + NETEASE_SEARCH_FALLBACK_MS;
			}
			if (neteaseSearchBlockedCode(data)) {
				if (forcedFallback) throw new Error('netease search throttled (code 405)');
				// HTTP 200 envelope carrying code 405 "操作频繁" - the primary
				// pool is throttled. Retry once on the fallback endpoint and
				// route subsequent searches around /web for a while.
				data = await getJson(apiBase + '/api/search/get?s=' + encodeURIComponent(query) + '&type=1&limit=10&offset=0', source);
				neteaseSearchFallbackUntil = Date.now() + NETEASE_SEARCH_FALLBACK_MS;
			}
			if (!data.result || !Array.isArray(data.result.songs)) {
				if (data.code === 200 && (!data.result || Number(data.result.songCount) === 0)) return [];
				throw new Error('unexpected search response');
			}
			return data.result.songs.filter(row => row && Number.isFinite(row.id));
		}
		if (source === 'kugou') {
			const url = KUGOU_SEARCH_BASE + '/song_search_v2?keyword=' + encodeURIComponent(query)
				+ '&page=1&pagesize=10&platform=WebFilter&userid=0&clientver=2000';
			const data = await getJson(url, source);
			const lists = data?.data?.lists;
			if (!Array.isArray(lists)) throw new Error('unexpected search response');
			return lists.filter(row => row && /^[0-9a-f]{32}$/i.test(String(row.FileHash || '')))
				.map(row => ({
					id: row.FileHash,
					name: row.SongName || row.FileName || '',
					// KuGou reports every singer in one string.
					artists: String(row.SingerName || '').split(/[、,，&/]/)
						.map(name => ({ name: name.trim() })).filter(artist => artist.name.length > 0),
					// `Duration` is seconds, but tolerate a millisecond payload.
					duration: Number(row.Duration) > 0
						? Number(row.Duration) * (Number(row.Duration) < 10000 ? 1000 : 1) : 0,
				}));
		}
		if (source === 'migu') {
			// Bare array, no envelope. pageSize is ignored by the server (always 20).
			const url = MIGU_SEARCH_BASE + '/pc/resource/song/item/search/v1.0?text='
				+ encodeURIComponent(query) + '&pageNo=1&pageSize=20';
			const rows = await getJson(url, source);
			if (!Array.isArray(rows)) throw new Error('unexpected search response');
			return rows.filter(row => row && typeof row === 'object')
				.map(row => ({
					// copyrightId is not always numeric - keep it a string.
					id: String(row.copyrightId || row.contentId || ''),
					name: row.songName || '',
					artists: (Array.isArray(row.singerList) ? row.singerList : [])
						.map(artist => ({ name: String(artist && artist.name || '') }))
						.filter(artist => artist.name.length > 0),
					// `duration` is seconds here; the scorer works in milliseconds.
					duration: Number(row.duration) > 0 ? Number(row.duration) * 1000 : 0,
					// Only the search response knows the lyric address: there is no
					// endpoint that takes an id and returns lyrics.
					lyricUrl: String(row.lrcUrl || (row.ext && row.ext.lrcUrl) || ''),
				}))
				.filter(row => row.lyricUrl.length > 0);
		}
		const data = await getJson(QQ_BASE + '/soso/fcgi-bin/client_search_cp?format=json&w=' + encodeURIComponent(query) + '&p=1&n=10&t=0&cr=1', source);
		if (!Array.isArray(data.data?.song?.list)) throw new Error('unexpected search response');
		return data.data.song.list.filter(row => row && /^[a-z0-9]+$/i.test(row.songmid || ''))
			.map(row => ({ id: row.songmid, name: row.songname || row.name || '',
				artists: Array.isArray(row.singer) ? row.singer : [], duration: Number(row.interval) * 1000 }));
	}
	async function lyrics(source, candidate, facts) {
		if (source === 'netease') {
			// `yv=-1` asks for the word-level (YRC) stream as well. Same request, so
			// no extra call and no extra rate-limit budget; `lrc`/`tlyric` come back
			// unchanged whether or not YRC exists (measured 2026-11-11).
			const data = await getJson(apiBase + '/api/song/lyric?id=' + encodeURIComponent(candidate.id) + '&lv=1&kv=1&tv=-1&yv=-1', source);
			const main = parseLrc(data.lrc?.lyric);
			// Words are attached to the LRC lines by INDEX, never used to build the
			// list: line text, translation and switching stay exactly as they were,
			// and a line-count mismatch drops them silently (see attachYrcWords).
			return { main: attachYrcWords(data.yrc?.lyric, main), translation: parseLrc(data.tlyric?.lyric) };
		}
		if (source === 'kugou') {
			// The search hash only identifies the recording; a second hop lists the
			// lyric candidates (id + accesskey), and the third returns base64 LRC.
			const meta = await getJson(KUGOU_LRC_BASE + '/search?ver=1&man=yes&client=mobi&keyword=&duration='
				+ encodeURIComponent(String(Number(candidate.duration) || 0)) + '&hash=' + encodeURIComponent(candidate.id), source);
			const candidates = Array.isArray(meta?.candidates) ? meta.candidates.filter(row => row && row.id && row.accesskey) : [];
			if (candidates.length === 0) return { main: [], translation: [] };
			// Prefer the lyric entry whose duration matches the track (krcs reports ms).
			const durationSec = Number(facts?.durationSec) || 0;
			const picked = candidates
				.map(row => ({ row, delta: durationSec > 0 && Number(row.duration) > 0
					? Math.abs(Number(row.duration) / 1000 - durationSec) : 0 }))
				.sort((a, b) => a.delta - b.delta)[0].row;
			const data = await getJson(KUGOU_DOWNLOAD_BASE + '/download?ver=1&client=pc&id=' + encodeURIComponent(picked.id)
				+ '&accesskey=' + encodeURIComponent(picked.accesskey) + '&fmt=lrc&charset=utf8', source);
			const text = Buffer.from(String(data.content || ''), 'base64').toString('utf8');
			return { main: parseLrc(text), translation: [] };
		}
		if (source === 'migu') {
			const text = await getText(candidate.lyricUrl, source);
			return { main: parseLrc(text), translation: [] };
		}
		// QQ, primary path: musicu `GetPlayLyricInfo` with crypt=0&qrc=0 returns
		// the lyric AND the translation as plain base64 LRC in one response, keyed
		// by songMID (what the search already gave us — no extra lookup request).
		// `crypt=0` is what keeps it unencrypted; `qrc=0` avoids the 3DES QRC blobs.
		// Measured 2026-11-11 across 12 songs: lyric 12/12, timed translation 9/12,
		// translation timestamps identical to the lyric's (0.000s delta).
		let musicuMain = [];
		let musicuTrans = [];
		let musicuError = null;
		try {
			const data = await getQQMusicu('music.musichallSong.PlayLyricInfo', 'GetPlayLyricInfo', {
				songMID: String(candidate.id),
				crypt: 0,
				qrc: 0,
				trans: 1,
				type: 0,
			});
			musicuMain = parseLrc(decodeQQBase64Lrc(data.lyric));
			musicuTrans = dropPlaceholderTranslations(parseLrc(decodeQQBase64Lrc(data.trans)));
		} catch (err) {
			musicuError = err;
		}
		if (musicuMain.length > 0) return { main: musicuMain, translation: musicuTrans };
		// QQ, fallback path: the legacy fcg endpoint. It never carries a
		// translation, but it is a second chance at the lyric text itself before
		// the source is declared a miss.
		const url = new URL(QQ_BASE + '/lyric/fcgi-bin/fcg_query_lyric_new.fcg');
		url.search = new URLSearchParams({ songmid: String(candidate.id), format: 'json', g_tk: '5381', loginUin: '0', hostUin: '0',
			inCharset: 'utf8', outCharset: 'utf-8', notice: '0', platform: 'yqq', needNewCode: '0' }).toString();
		const data = await getJson(url.href, source);
		const fallbackMain = parseLrc(decodeQQText(data.lyric));
		// A musicu failure is only interesting when the fallback also has nothing:
		// surfacing it then keeps the attempt reason honest instead of "no lyrics".
		if (fallbackMain.length === 0 && musicuError !== null) throw musicuError;
		return { main: fallbackMain, translation: dropPlaceholderTranslations(parseLrc(decodeQQText(data.trans))) };
	}
	async function resolveSources(facts, job) {
		const attempts = [];
		// Bilibili video subtitles run ahead of the search chain, but only
		// when a bvid pins the exact video — no search scoring happens here.
		if (facts.bvid && bilibiliEnabled) {
			checkJob(job);
			try {
				const sub = await abortable(fetchBilibili(facts, job), job.controller.signal);
				checkJob(job);
				if (Array.isArray(sub.lines) && sub.lines.length > 0) {
					attempts.push({ source: 'bilibili', status: 'matched' });
					lastAttempts = attempts; note = '';
					return { status: 'matched', source: 'bilibili', sourceLabel: SOURCE_LABELS.bilibili,
						fallbackUsed: false, attempts, songId: sub.bvid, songName: sub.title || facts.title,
						artistNames: sub.upName ? [sub.upName] : [], score: 0,
						lines: sub.lines, fetchedAt: Date.now() };
				}
				attempts.push({ source: 'bilibili', status: 'unmatched', reason: 'no-subtitle-content' });
			} catch (err) {
				checkJob(job);
				attempts.push({ source: 'bilibili', status: 'error', reason: String(err?.message || err).slice(0, 240) });
			}
		} else if (facts.browserSession) {
			// Browser session with no bvid: the extension report is missing or
			// stale (its heartbeat must reach us at least every TTL). Recorded
			// as an attempt so the state itself explains the empty capsule
			// instead of showing a bare "未匹配".
			attempts.push({ source: 'bilibili', status: 'unmatched', reason: 'no-bvid-report' });
		}
		// Video sessions stay video-only: an absent subtitle must not silently
		// masquerade as a music track. This holds for a BROWSER session even
		// when the bvid is missing — a paused video whose extension report went
		// stale used to fall into the music chain, come up unmatched and then
		// flip back as a fresh report arrived: the reported unmatched/matched
		// loop. The music chain (and the local-file pass) runs for ordinary
		// media, when the bilibili source is disabled, or when the user asked
		// via the manual rematch button (user decision 2026-11-09).
		const tryMusicChain = facts.allowMusicFallback === true
			|| !bilibiliEnabled
			|| (!facts.bvid && !facts.browserSession);
		if (tryMusicChain) {
			// The media's own provider goes first when known (QQ Music playing
			// -> QQ lyrics), then the default order; multi-source stays a
			// safety net, never a source swap.
			const ordered = orderedSources(facts);
			let originRetried = false;
			const runSource = async (source) => {
				checkJob(job);
				try {
					const selected = selectCandidate(await search(source, facts), facts);
					checkJob(job);
					if (!selected) { attempts.push({ source, status: 'unmatched', reason: 'no-confident-match' }); return null; }
					const { candidate, score } = selected;
					const { main, translation } = await lyrics(source, candidate, facts);
					checkJob(job);
					if (!main.length) { attempts.push({ source, status: 'unmatched', reason: 'no-timed-lyrics' }); return null; }
					attempts.push({ source, status: 'matched' });
					lastAttempts = attempts; note = '';
					return { status: 'matched', source, sourceLabel: SOURCE_LABELS[source] || source,
						fallbackUsed: source !== 'netease', attempts, songId: candidate.id, songName: candidate.name,
						artistNames: candidate.artists.map(row => String(row.name || '')).filter(Boolean), score,
						lines: mergeTranslation(main, translation), fetchedAt: Date.now() };
				} catch (err) {
					checkJob(job);
					attempts.push({ source, status: 'error', reason: String(err?.message || err).slice(0, 240) });
					return null;
				}
			};
			for (const source of ordered) {
				const result = await runSource(source);
				if (result) return result;
				// A flaky first request from the media's own provider (rate
				// limit, timeout) must not hand the track to another provider
				// for a week (7d cache): retry the origin source once, and
				// only when it actually errored — a confident miss is a real
				// miss, not a transient one.
				const lastAttempt = attempts[attempts.length - 1];
				if (source === facts.originSource && !originRetried
					&& lastAttempt && lastAttempt.source === source && lastAttempt.status === 'error') {
					originRetried = true;
					const retryResult = await runSource(source);
					if (retryResult) return retryResult;
				}
			}
			// Last resort: a .lrc next to the audio file, or lyrics inside its tags.
			checkJob(job);
			try {
				const local = await abortable(findLocalLyrics(facts, localOptions), job.controller.signal);
				checkJob(job);
				// A sidecar / embedded LRC is ONE document that may carry both the
				// original line and its translation on the same timestamp — fold it
				// so the translation becomes `trans` instead of shadowing the line.
				let lines = Array.isArray(local.lines)
					? foldBilingualLines(local.lines)
					: parseLrcFolded(local.text || '');
				let unsynced = false;
				if (lines.length === 0 && typeof local.text === 'string' && local.text.trim().length > 0) {
					// Plain (untimed) lyrics: spread them across the track so the overlay
					// can still show something, and label it as such.
					lines = synthLines(local.text, facts.durationSec);
					unsynced = lines.length > 0;
				}
				if (lines.length === 0) {
					attempts.push({ source: 'local', status: 'unmatched', reason: local.reason || 'no-timed-lyrics' });
				} else {
					attempts.push({ source: 'local', status: 'matched' });
					lastAttempts = attempts; note = '';
					const base = local.file ? String(local.file).replace(/\.[^.]+$/, '') : facts.title;
					return { status: 'matched', source: 'local',
						sourceLabel: unsynced ? '本地文件（无时间轴）' : '本地文件',
						fallbackUsed: true, attempts, songId: local.file || base, songName: base,
						artistNames: facts.artist ? [facts.artist] : [], score: 0,
						lines, unsynced, fetchedAt: Date.now() };
				}
			} catch (err) {
				checkJob(job);
				attempts.push({ source: 'local', status: 'error', reason: String(err?.message || err).slice(0, 240) });
			}
		}
		lastAttempts = attempts;
		note = attempts.map(row => row.source + ': ' + row.reason).join('; ');
		const anyError = attempts.some(row => row.status === 'error');
		return { status: anyError ? 'error' : 'unmatched', source: null, attempts, ...(anyError ? { message: note } : {}), fetchedAt: Date.now() };
	}
	async function resolve(facts) {
		if (disposed) return cancelledResult();
		const key = trackKey(facts);
		if (latestOnly && latestKey !== key) {
			latestKey = key; epoch++;
			for (const job of jobs.values()) job.controller.abort(abortError());
		}
		const requestedEpoch = epoch;
		await ready;
		if (disposed || (latestOnly && requestedEpoch !== epoch)) return cancelledResult();
		const cached = cache.get(key);
		if (cached) {
			const ttl = cached.status === 'matched' ? SUCCESS_TTL_MS : cached.status === 'error' ? ERROR_TTL_MS : NEGATIVE_TTL_MS;
			if (Date.now() - cached.fetchedAt < ttl) {
				cache.delete(key); cache.set(key, cached); lastAttempts = cached.attempts || []; return cached;
			}
			cache.delete(key);
		}
		if (inflight.has(key) && !jobs.get(key)?.controller.signal.aborted) return inflight.get(key);
		const rawBvid = String(facts.bvid || '').trim();
		const normalized = {
			title: normalizeText(facts.title), artist: normalizeText(facts.artist),
			durationSec: Number(facts.durationSec) || 0,
			bvid: /^BV[0-9A-Za-z]{10}$/.test(rawBvid) ? rawBvid : '',
			originSource: ONLINE_SOURCES.includes(facts.originSource) ? facts.originSource : '',
			allowMusicFallback: facts.allowMusicFallback === true,
			// A browser session is a video: it stays video-only even when no
			// bvid is attached (a stale extension report must not turn the
			// capsule into a music search for a video title).
			browserSession: facts.browserSession === true,
		};
		const context = { controller: new AbortController() };
		jobs.set(key, context);
		const run = enqueue(async () => {
			checkJob(context);
			activeJob = context;
			try {
				const result = await resolveSources(normalized, context);
				checkJob(context);
				cache.set(key, result); trimCache(); schedulePersist(); return result;
			} finally { if (activeJob === context) activeJob = null; }
		});
		const job = abortable(run, context.controller.signal).catch(err => {
			if (disposed || context.controller.signal.aborted) return cancelledResult();
			throw err;
		}).finally(() => {
			if (inflight.get(key) === job) inflight.delete(key);
			if (jobs.get(key) === context) jobs.delete(key);
		});
		inflight.set(key, job);
		return job;
	}
	function invalidate(fingerprint) {
		for (const key of cache.keys()) if (key.startsWith(fingerprint + '|')) cache.delete(key);
		return ![...inflight.keys()].some(key => key.startsWith(fingerprint + '|'));
	}
	function describe() {
		return { apiBase, providers: bilibiliEnabled ? ['bilibili', ...ONLINE_SOURCES, 'local'] : [...ONLINE_SOURCES, 'local'],
			policy: (bilibiliEnabled ? 'bilibili-subtitle (bvid) > ' : '') + 'netease > qq > kugou > migu > local-file',
			local: { enabled: localOptions.enabled, dirs: localOptions.dirs, budgetMs: localOptions.budgetMs },
			// Counts/booleans only: describe() lands in state.json — never
			// expose cookie paths or any credential material here.
			bilibili: { enabled: bilibiliEnabled, cookieFiles: bilibiliCookiePaths.length,
				hasSession: [...bilibiliCookieCache.values()].some(Boolean), wbiCached: bilibiliWbi.fetchedAt > 0 },
			cacheVersion: 2, cacheFile, entries: cache.size, inflight: inflight.size, latestOnly, disposed, note, lastAttempts };
	}
	function dispose() {
		if (disposed) return;
		disposed = true; epoch++;
		clearTimeout(persistTimer); persistTimer = null;
		for (const job of jobs.values()) job.controller.abort(abortError());
	}
	return { resolve, invalidate, describe, dispose };
}

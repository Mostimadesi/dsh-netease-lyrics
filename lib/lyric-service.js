/** Multi-source lyrics: NetEase first, QQ on no-match/no-LRC/request failure.
 * Neither desktop client needs to run for online lyric requests.
 * Source-specific errors, confidence checks, request spacing and bounded caches
 * are shared. QQ endpoints are undocumented and can change or be rate-limited.
 */
const DEFAULT_API_BASE = 'https://music.163.com';
const QQ_BASE = 'https://c.y.qq.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';
const REQUEST_TIMEOUT_MS = 8000;
const MIN_REQUEST_GAP_MS = 800;
const NEGATIVE_TTL_MS = 10 * 60 * 1000;
const ERROR_TTL_MS = 30 * 1000;
const SUCCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 300;
const PERSIST_DEBOUNCE_MS = 2000;

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
		for (const t of stamps) out.push({ t, text: textPart });
	}
	out.sort((a, b) => a.t - b.t);
	return out;
}

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

export function createLyricService(options = {}) {
	const apiBase = String(options.apiBase || DEFAULT_API_BASE).replace(/\/+$/, '');
	const fetchImpl = options.fetchImpl || globalThis.fetch;
	const cacheFile = typeof options.cacheFile === 'string' ? options.cacheFile : '';
	const minGapMs = Number.isFinite(options.minRequestGapMs) ? Math.max(0, options.minRequestGapMs) : MIN_REQUEST_GAP_MS;
	const timeoutMs = options.requestTimeoutMs || REQUEST_TIMEOUT_MS;
	const cache = new Map();
	const inflight = new Map();
	let chain = Promise.resolve(), lastRequestAt = 0, persistTimer = null, note = '';
	let lastAttempts = [];
	// Preserve recording/version labels in cache identity even though search normalization removes them.
	const trackKey = facts => fingerprintOf(facts.title, facts.artist) + '|' + String(facts.title || '').trim().toLowerCase()
		+ '|' + (Number(facts.durationSec) > 0 ? Math.round(Number(facts.durationSec)) : 0);
	function trimCache() {
		while (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
	}
	async function restoreCache() {
		if (!cacheFile) return;
		try {
			const fs = await import('node:fs/promises');
			const parsed = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
			// v1 entries used a single source and a different cache key. Leave the file
			// intact until the first normal save; refetch instead of migrating stale negatives.
			if (parsed.version !== 2 || !Array.isArray(parsed.entries)) return;
			for (const [key, entry] of parsed.entries.slice(-CACHE_MAX_ENTRIES)) {
				if (typeof key === 'string' && entry?.status === 'matched' && ['netease', 'qq'].includes(entry.source)
					&& Array.isArray(entry.lines) && entry.lines.length && entry.lines.every(row => Number.isFinite(row.t) && typeof row.text === 'string')
					&& Number.isFinite(entry.fetchedAt) && Date.now() - entry.fetchedAt < SUCCESS_TTL_MS) cache.set(key, entry);
			}
		} catch { /* Missing/corrupt cache is non-fatal. */ }
	}
	const ready = restoreCache();
	async function persist() {
		if (!cacheFile) return;
		try {
			const fs = await import('node:fs/promises');
			await fs.writeFile(cacheFile + '.tmp', JSON.stringify({ version: 2, entries: [...cache].slice(-CACHE_MAX_ENTRIES) }), 'utf8');
			await fs.rename(cacheFile + '.tmp', cacheFile);
		} catch { /* Memory cache remains usable. */ }
	}
	function schedulePersist() {
		if (!cacheFile || persistTimer !== null) return;
		persistTimer = setTimeout(() => { persistTimer = null; void persist(); }, PERSIST_DEBOUNCE_MS);
		persistTimer.unref?.();
	}
	function enqueue(job) {
		const run = chain.then(job);
		chain = run.then(() => undefined, () => undefined);
		return run;
	}
	async function getJson(url, source) {
		if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable');
		const wait = minGapMs - (Date.now() - lastRequestAt);
		if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
		lastRequestAt = Date.now();
		const response = await fetchImpl(url, {
			headers: { accept: 'application/json', referer: source === 'qq' ? 'https://y.qq.com/' : apiBase + '/',
				'user-agent': USER_AGENT, 'accept-language': 'zh-CN,zh;q=0.9' },
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) throw new Error('HTTP ' + response.status);
		const payload = await response.json();
		if (!payload || typeof payload !== 'object') throw new Error('invalid JSON payload');
		const expected = source === 'qq' ? 0 : 200;
		if (payload.code !== undefined && Number(payload.code) !== expected) throw new Error('API code ' + payload.code);
		if (source === 'qq' && payload.retcode !== undefined && Number(payload.retcode) !== 0) throw new Error('API retcode ' + payload.retcode);
		return payload;
	}
	async function search(source, facts) {
		const query = (facts.title + ' ' + facts.artist).trim();
		if (source === 'netease') {
			const data = await getJson(apiBase + '/api/search/get/web?s=' + encodeURIComponent(query) + '&type=1&limit=10&offset=0', source);
			if (!data.result || !Array.isArray(data.result.songs)) {
				if (data.code === 200 && (!data.result || Number(data.result.songCount) === 0)) return [];
				throw new Error('unexpected search response');
			}
			return data.result.songs.filter(row => row && Number.isFinite(row.id));
		}
		const data = await getJson(QQ_BASE + '/soso/fcgi-bin/client_search_cp?format=json&w=' + encodeURIComponent(query) + '&p=1&n=10&t=0&cr=1', source);
		if (!Array.isArray(data.data?.song?.list)) throw new Error('unexpected search response');
		return data.data.song.list.filter(row => row && /^[a-z0-9]+$/i.test(row.songmid || ''))
			.map(row => ({ id: row.songmid, name: row.songname || row.name || '',
				artists: Array.isArray(row.singer) ? row.singer : [], duration: Number(row.interval) * 1000 }));
	}
	async function lyrics(source, id) {
		if (source === 'netease') {
			const data = await getJson(apiBase + '/api/song/lyric?id=' + encodeURIComponent(id) + '&lv=1&kv=1&tv=-1', source);
			return { main: parseLrc(data.lrc?.lyric), translation: parseLrc(data.tlyric?.lyric) };
		}
		const url = new URL(QQ_BASE + '/lyric/fcgi-bin/fcg_query_lyric_new.fcg');
		url.search = new URLSearchParams({ songmid: String(id), format: 'json', g_tk: '5381', loginUin: '0', hostUin: '0',
			inCharset: 'utf8', outCharset: 'utf-8', notice: '0', platform: 'yqq', needNewCode: '0' }).toString();
		const data = await getJson(url.href, source);
		return { main: parseLrc(decodeQQText(data.lyric)), translation: parseLrc(decodeQQText(data.trans)) };
	}
	async function resolveSources(facts) {
		const attempts = [];
		for (const source of ['netease', 'qq']) {
			try {
				const selected = selectCandidate(await search(source, facts), facts);
				if (!selected) { attempts.push({ source, status: 'unmatched', reason: 'no-confident-match' }); continue; }
				const { candidate, score } = selected;
				const { main, translation } = await lyrics(source, candidate.id);
				if (!main.length) { attempts.push({ source, status: 'unmatched', reason: 'no-timed-lyrics' }); continue; }
				attempts.push({ source, status: 'matched' });
				lastAttempts = attempts; note = '';
				return { status: 'matched', source, sourceLabel: source === 'qq' ? 'QQ 音乐' : '网易云',
					fallbackUsed: source === 'qq', attempts, songId: candidate.id, songName: candidate.name,
					artistNames: candidate.artists.map(row => String(row.name || '')).filter(Boolean), score,
					lines: mergeTranslation(main, translation), fetchedAt: Date.now() };
			} catch (err) {
				attempts.push({ source, status: 'error', reason: String(err?.message || err).slice(0, 240) });
			}
		}
		lastAttempts = attempts;
		note = attempts.map(row => row.source + ': ' + row.reason).join('; ');
		const anyError = attempts.some(row => row.status === 'error');
		return { status: anyError ? 'error' : 'unmatched', source: null, attempts, ...(anyError ? { message: note } : {}), fetchedAt: Date.now() };
	}
	async function resolve(facts) {
		await ready;
		const key = trackKey(facts);
		const cached = cache.get(key);
		if (cached) {
			const ttl = cached.status === 'matched' ? SUCCESS_TTL_MS : cached.status === 'error' ? ERROR_TTL_MS : NEGATIVE_TTL_MS;
			if (Date.now() - cached.fetchedAt < ttl) {
				cache.delete(key); cache.set(key, cached); lastAttempts = cached.attempts || []; return cached;
			}
			cache.delete(key);
		}
		if (inflight.has(key)) return inflight.get(key);
		const normalized = { title: normalizeText(facts.title), artist: normalizeText(facts.artist), durationSec: Number(facts.durationSec) || 0 };
		const job = enqueue(async () => {
			const result = await resolveSources(normalized);
			cache.set(key, result); trimCache(); schedulePersist(); return result;
		}).finally(() => inflight.delete(key));
		inflight.set(key, job);
		return job;
	}
	function invalidate(fingerprint) {
		for (const key of cache.keys()) if (key.startsWith(fingerprint + '|')) cache.delete(key);
		return ![...inflight.keys()].some(key => key.startsWith(fingerprint + '|'));
	}
	function describe() {
		return { apiBase, providers: ['netease', 'qq'], policy: 'netease-first-qq-fallback',
			cacheVersion: 2, cacheFile, entries: cache.size, inflight: inflight.size, note, lastAttempts };
	}
	return { resolve, invalidate, describe };
}

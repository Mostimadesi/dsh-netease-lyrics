/**
 * Offline lyrics: the last resort after every online source fails.
 *
 * Looks for, in order:
 *   1. a `.lrc` sitting next to the audio file (same basename),
 *   2. the audio file's own tags — ID3v2 `USLT`/`TXXX:LYRICS`/`SYLT` for MP3,
 *      `VORBIS_COMMENT LYRICS|UNSYNCEDLYRICS` for FLAC.
 *
 * The scan is bounded (depth, entry count, wall-clock budget) because it runs on
 * the host's event loop, and the audio files are only ever read head-first:
 * tag blocks live at the start, so a 2 MiB read is enough.
 *
 * Zero dependencies: both tag parsers are small and read the documented layout.
 * KuGou's own `.krc` cache is NOT readable — its v20 files are encrypted with a
 * scheme the known "krc1" XOR+deflate recipe no longer opens (verified against a
 * real file), so encrypted caches are ignored rather than half-parsed.
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_SCAN_ENTRIES = 4000;
const DEFAULT_BUDGET_MS = 1200;
const MAX_TAG_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 2;
const AUDIO_EXT = new Set(['.mp3', '.flac', '.m4a', '.ogg', '.oga', '.wav', '.ape', '.wma', '.aac']);
const SKIP_DIRS = /^(node_modules|\$recycle\.bin|system volume information|\.git)$/i;

/** Lowercase, drop the extension and bracketed noise, keep words/CJK. */
export function normalizeName(value) {
	return String(value == null ? '' : value)
		.toLowerCase()
		.replace(/\.[a-z0-9]{2,5}$/i, ' ')
		.replace(/[（(\[【][^）)\]】]{0,60}[）)\]】]/g, ' ')
		.replace(/[^0-9a-z\u3400-\u9fbf\u3040-\u30ff]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** 0 = not this track; higher = a better match. `.lrc` wins ties over audio. */
export function scorePath(file, title, artist) {
	const base = normalizeName(path.basename(file));
	const ext = path.extname(file).toLowerCase();
	const isLrc = ext === '.lrc';
	if (!base || (!isLrc && !AUDIO_EXT.has(ext))) return 0;
	let score = 0;
	if (base === title) score += 6;
	else if (title.length >= 2 && base.includes(title)) score += 3;
	else if (base.length >= 3 && title.includes(base)) score += 2;
	else return 0;
	if (artist && base.includes(artist)) score += 2;
	if (isLrc) score += 2;
	return score;
}

function decodeText(buffer, encoding) {
	if (encoding === 1 || encoding === 2) {
		let body = buffer;
		if (encoding === 1 && body.length >= 2) {
			// UTF-16 with BOM: honour which endianness was written.
			if (body[0] === 0xff && body[1] === 0xfe) body = body.subarray(2);
			else if (body[0] === 0xfe && body[1] === 0xff) return swap16(body.subarray(2)).toString('utf16le');
			else body = body.subarray(body[0] === 0 || body[1] === 0 ? 0 : 2);
		}
		return body.toString('utf16le');
	}
	if (encoding === 3) return buffer.toString('utf8');
	return buffer.toString('latin1');
}

function swap16(buffer) {
	const out = Buffer.from(buffer);
	for (let i = 0; i + 1 < out.length; i += 2) {
		const tmp = out[i];
		out[i] = out[i + 1];
		out[i + 1] = tmp;
	}
	return out;
}

function stripBom(text) {
	return typeof text === 'string' ? text.replace(/^\uFEFF/, '') : text;
}

function syncsafe(buffer, offset) {
	return ((buffer[offset] & 0x7f) << 21) | ((buffer[offset + 1] & 0x7f) << 14)
		| ((buffer[offset + 2] & 0x7f) << 7) | (buffer[offset + 3] & 0x7f);
}

/** Split a tag body into descriptor + payload at the first terminator. */
function splitDescriptor(body, encoding) {
	const terminator = encoding === 1 || encoding === 2 ? [0, 0] : [0];
	for (let i = 0; i + terminator.length <= body.length; i += terminator[0] === 0 && terminator.length === 2 ? 2 : 1) {
		const hit = terminator.every((value, index) => body[i + index] === value);
		if (!hit) continue;
		return { descriptor: decodeText(body.subarray(0, i), encoding), payload: body.subarray(i + terminator.length) };
	}
	return { descriptor: '', payload: body };
}

/**
 * ID3v2 lyrics. Returns `{ text }` for USLT/TXXX or `{ lines }` for SYLT
 * (which carries its own timestamps). Returns null when nothing usable exists.
 */
export function parseId3Lyrics(buffer) {
	if (!Buffer.isBuffer(buffer) || buffer.length < 10) return null;
	if (buffer.toString('latin1', 0, 3) !== 'ID3') return null;
	const major = buffer[3];
	if (major < 3 || major > 4) return null;
	if (buffer[5] & 0x80) return null; // unsynchronised tags: not handled, skip rather than mis-read
	const end = Math.min(buffer.length, 10 + syncsafe(buffer, 6));
	let offset = 10;
	const headerLength = 10;
	while (offset + headerLength <= end) {
		const id = buffer.toString('latin1', offset, offset + 4);
		if (!/^[A-Z0-9]{4}$/.test(id)) break;
		const size = major === 4 ? syncsafe(buffer, offset + 4) : buffer.readUInt32BE(offset + 4);
		if (size <= 0 || offset + headerLength + size > end) break;
		const body = buffer.subarray(offset + headerLength, offset + headerLength + size);
		offset += headerLength + size;
		if (id === 'USLT' && body.length > 4) {
			const encoding = body[0];
			// layout: encoding, language[3], content descriptor (terminated), text
			const { payload } = splitDescriptor(body.subarray(4), encoding);
			const text = stripBom(decodeText(payload, encoding)).trim();
			if (text) return { text };
		}
		if (id === 'TXXX' && body.length > 1) {
			const encoding = body[0];
			const { descriptor, payload } = splitDescriptor(body.subarray(1), encoding);
			if (/lyric/i.test(descriptor)) {
				const text = stripBom(decodeText(payload, encoding)).trim();
				if (text) return { text };
			}
		}
		if (id === 'SYLT' && body.length > 6) {
			const encoding = body[0];
			const timestampFormat = body[4];
			if (timestampFormat !== 2) continue; // 1 = MPEG frames, not usable here
			const { payload } = splitDescriptor(body.subarray(6), encoding);
			const lines = [];
			let cursor = 0;
			while (cursor < payload.length) {
				const next = payload.indexOf(0, cursor);
				const textEnd = next === -1 ? payload.length : next;
				const chunk = payload.subarray(cursor, textEnd);
				if (textEnd + 5 > payload.length) break;
				const stamp = payload.readUInt32BE(textEnd + 1);
				const text = stripBom(decodeText(chunk, encoding)).trim();
				if (text) lines.push({ t: stamp / 1000, text });
				cursor = textEnd + 5;
			}
			if (lines.length) return { lines };
		}
	}
	return null;
}

/** FLAC metadata blocks: only VORBIS_COMMENT (type 4) carries lyrics. */
export function parseFlacLyrics(buffer) {
	if (!Buffer.isBuffer(buffer) || buffer.length < 8) return null;
	if (buffer.toString('latin1', 0, 4) !== 'fLaC') return null;
	let offset = 4;
	while (offset + 4 <= buffer.length) {
		const header = buffer[offset];
		const last = (header & 0x80) !== 0;
		const type = header & 0x7f;
		const length = buffer.readUIntBE(offset + 1, 3);
		const start = offset + 4;
		const stop = start + length;
		if (stop > buffer.length) break;
		if (type === 4) {
			let cursor = start;
			if (cursor + 4 > stop) break;
			const vendorLength = buffer.readUInt32LE(cursor);
			cursor += 4 + vendorLength;
			if (cursor + 4 > stop) break;
			const count = buffer.readUInt32LE(cursor);
			cursor += 4;
			for (let index = 0; index < count && cursor + 4 <= stop; index += 1) {
				const entryLength = buffer.readUInt32LE(cursor);
				cursor += 4;
				const entry = buffer.toString('utf8', cursor, Math.min(stop, cursor + entryLength));
				cursor += entryLength;
				const split = entry.indexOf('=');
				if (split <= 0) continue;
				const key = entry.slice(0, split).toUpperCase();
				if (key === 'LYRICS' || key === 'UNSYNCEDLYRICS' || key === 'SYNCEDLYRICS') {
					const text = stripBom(entry.slice(split + 1)).trim();
					if (text) return { text };
				}
			}
		}
		if (last) break;
		offset = stop;
	}
	return null;
}

async function readHead(file) {
	let handle;
	try {
		handle = await fs.promises.open(file, 'r');
		const stat = await handle.stat();
		const size = Math.min(stat.size, MAX_TAG_BYTES);
		if (size <= 0) return null;
		const buffer = Buffer.alloc(size);
		await handle.read(buffer, 0, size, 0);
		return buffer;
	} catch {
		return null;
	} finally {
		try { await handle?.close(); } catch { /* already closed */ }
	}
}

async function readText(file) {
	try {
		const stat = await fs.promises.stat(file);
		if (stat.size <= 0 || stat.size > 512 * 1024) return null;
		return stripBom((await fs.promises.readFile(file, 'utf8')).replace(/^\uFEFF/, '')).trim();
	} catch {
		return null;
	}
}

async function collectFiles(dirs, deadline) {
	const files = [];
	let visited = 0;
	const queue = dirs.map(dir => ({ dir, depth: 0 }));
	while (queue.length > 0 && Date.now() < deadline && visited < MAX_SCAN_ENTRIES) {
		const { dir, depth } = queue.shift();
		let entries;
		try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
		for (const entry of entries) {
			if (Date.now() >= deadline || visited >= MAX_SCAN_ENTRIES) break;
			visited += 1;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (depth < MAX_DEPTH && !SKIP_DIRS.test(entry.name)) queue.push({ dir: full, depth: depth + 1 });
			} else if (entry.isFile()) {
				files.push(full);
			}
		}
	}
	return files;
}

/**
 * Find lyrics for one track on disk.
 * Returns `{ lines }` (SYLT), `{ text }` (LRC or unsynchronised), or `{ reason }`.
 */
export async function findLocalLyrics(facts, options = {}) {
	if (options.enabled === false) return { reason: 'disabled' };
	const dirs = (Array.isArray(options.dirs) ? options.dirs : [])
		.filter(dir => typeof dir === 'string' && dir.trim().length > 0)
		.map(dir => path.resolve(dir));
	if (dirs.length === 0) return { reason: 'no-search-dirs' };
	const title = normalizeName(facts?.title);
	if (!title) return { reason: 'no-title' };
	const artist = normalizeName(facts?.artist);
	const budgetMs = Number.isFinite(options.budgetMs) ? Math.max(100, options.budgetMs) : DEFAULT_BUDGET_MS;
	const deadline = Date.now() + budgetMs;

	const files = await collectFiles(dirs, deadline);
	const ranked = files
		.map(file => ({ file, score: scorePath(file, title, artist) }))
		.filter(row => row.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, 8);

	for (const { file } of ranked) {
		if (path.extname(file).toLowerCase() === '.lrc') {
			const text = await readText(file);
			if (text) return { text, file: path.basename(file) };
			continue;
		}
		const sidecar = file.replace(/\.[^./\\]+$/, '.lrc');
		const text = await readText(sidecar);
		if (text) return { text, file: path.basename(sidecar) };
		const head = await readHead(file);
		if (!head) continue;
		const tagged = path.extname(file).toLowerCase() === '.flac' ? parseFlacLyrics(head) : parseId3Lyrics(head);
		if (tagged) return { ...tagged, file: path.basename(file) };
	}
	return { reason: ranked.length > 0 ? 'no-embedded-lyrics' : 'no-local-file' };
}

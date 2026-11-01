import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findLocalLyrics, normalizeName, parseFlacLyrics, parseId3Lyrics, scorePath } from '../lib/local-lyrics.js';

let count = 0;
async function check(name, fn) { await fn(); count += 1; console.log('PASS ' + name); }

/* ---------- tag builders (documented layout, hand-assembled) ---------- */
const syncsafe = n => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
function frame(id, payload, synchsafeSize = false) {
	const size = Buffer.alloc(4);
	if (synchsafeSize) syncsafe(payload.length).copy(size);
	else size.writeUInt32BE(payload.length);
	return Buffer.concat([Buffer.from(id, 'latin1'), size, Buffer.from([0, 0]), payload]);
}
function id3(frames, { version = 3, flags = 0 } = {}) {
	const body = Buffer.concat(frames);
	return Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([version, 0, flags]), syncsafe(body.length), body]);
}
const uslt = text => frame('USLT', Buffer.concat([Buffer.from([3]), Buffer.from('eng'), Buffer.from([0]), Buffer.from(text, 'utf8')]));
const txxx = (description, text) => frame('TXXX', Buffer.concat([Buffer.from([3]), Buffer.from(description, 'utf8'), Buffer.from([0]), Buffer.from(text, 'utf8')]));
function sylt(entries) {
	const parts = [Buffer.from([3]), Buffer.from('eng'), Buffer.from([2, 0]), Buffer.from([0])];
	for (const entry of entries) {
		const stamp = Buffer.alloc(4);
		stamp.writeUInt32BE(entry.t);
		parts.push(Buffer.from(entry.text, 'utf8'), Buffer.from([0]), stamp);
	}
	return frame('SYLT', Buffer.concat(parts));
}
function flac(entries) {
	const vendor = Buffer.from('test', 'utf8');
	const vendorLength = Buffer.alloc(4); vendorLength.writeUInt32LE(vendor.length);
	const total = Buffer.alloc(4); total.writeUInt32LE(entries.length);
	const parts = [vendorLength, vendor, total];
	for (const [key, value] of entries) {
		const entry = Buffer.from(key + '=' + value, 'utf8');
		const length = Buffer.alloc(4); length.writeUInt32LE(entry.length);
		parts.push(length, entry);
	}
	const body = Buffer.concat(parts);
	const header = Buffer.from([0x84, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff]);
	return Buffer.concat([Buffer.from('fLaC', 'latin1'), header, body]);
}

/* ---------- pure helpers ---------- */
await check('normalizeName 去掉扩展名与括号噪声', async () => {
	assert.equal(normalizeName('Adele - Hello (Live).mp3'), 'adele hello');
	assert.equal(normalizeName('周杰伦 - 晴天【伴奏】.flac'), '周杰伦 晴天');
	assert.equal(normalizeName(''), '');
});
await check('scorePath 偏好 .lrc、拒绝无关文件', async () => {
	const title = normalizeName('Hello');
	assert(scorePath('/m/Adele - Hello.lrc', title, 'adele') > scorePath('/m/Adele - Hello.mp3', title, 'adele'));
	assert.equal(scorePath('/m/Other Song.mp3', title, 'adele'), 0);
	assert.equal(scorePath('/m/Adele - Hello.txt', title, 'adele'), 0);
});

/* ---------- ID3 ---------- */
await check('ID3v2.3 USLT 读出带时间轴歌词', async () => {
	const tag = parseId3Lyrics(id3([uslt('[00:01.00]line one\n[00:02.00]line two')]));
	assert.equal(tag.text, '[00:01.00]line one\n[00:02.00]line two');
});
await check('ID3v2.4 TXXX:LYRICS 可读（synchsafe 帧长）', async () => {
	const tag = parseId3Lyrics(id3([frame('TXXX', Buffer.concat([Buffer.from([3]), Buffer.from('LYRICS', 'utf8'), Buffer.from([0]), Buffer.from('[00:03.00]hi', 'utf8')]), true)], { version: 4 }));
	assert.equal(tag.text, '[00:03.00]hi');
});
await check('ID3 SYLT 直接给出时间戳', async () => {
	const tag = parseId3Lyrics(id3([sylt([{ t: 1500, text: '第一句' }, { t: 3250, text: 'second' }])]));
	assert.equal(tag.lines.length, 2);
	assert.equal(tag.lines[0].t, 1.5);
	assert.equal(tag.lines[1].text, 'second');
});
await check('非 ID3 / 含 unsynchronisation 的标签安全返回 null', async () => {
	assert.equal(parseId3Lyrics(Buffer.from('not a tag at all')), null);
	assert.equal(parseId3Lyrics(id3([uslt('x')], { flags: 0x80 })), null);
});

for (const [encoding, bigEndian] of [[1, false], [1, true], [2, true]]) {
	await check(`ID3 UTF-16 encoding=${encoding} BE=${bigEndian}: USLT / SYLT`, async () => {
		const encode = text => {
			const bytes = Buffer.from(text, 'utf16le');
			return bigEndian ? bytes.swap16() : bytes;
		};
		const bom = encoding === 1 ? Buffer.from(bigEndian ? [0xfe, 0xff] : [0xff, 0xfe]) : Buffer.alloc(0);
		const descriptor = Buffer.concat([bom, encode('description'), Buffer.alloc(2)]);
		// Payload inherits descriptor byte order without repeating the BOM.
		const usltBody = Buffer.concat([Buffer.from([encoding]), Buffer.from('eng'), descriptor, encode('Hello 世界')]);
		assert.deepEqual(parseId3Lyrics(id3([frame('USLT', usltBody, true)], { version: 4 })), { text: 'Hello 世界' });
		const pieces = [Buffer.from([encoding]), Buffer.from('eng'), Buffer.from([2, 1]), descriptor];
		for (const [text, time] of [['Hello 世界', 1500], ['second 行', 3250]]) {
			const stamp = Buffer.alloc(4); stamp.writeUInt32BE(time);
			pieces.push(encode(text), Buffer.alloc(2), stamp);
		}
		assert.deepEqual(parseId3Lyrics(id3([frame('SYLT', Buffer.concat(pieces), true)], { version: 4 })), {
			lines: [{ t: 1.5, text: 'Hello 世界' }, { t: 3.25, text: 'second 行' }],
		});
		// A missing/truncated timestamp must not manufacture an entry or throw.
		const truncated = Buffer.concat([Buffer.from([encoding]), Buffer.from('eng'), Buffer.from([2, 1]), descriptor, encode('unfinished'), Buffer.alloc(2), Buffer.alloc(3)]);
		assert.equal(parseId3Lyrics(id3([frame('SYLT', truncated, true)], { version: 4 })), null);
	});
}
await check('ID3 extended headers: v2.3 and v2.4 sizes, truncated headers rejected', async () => {
	for (const version of [3, 4]) {
		const extended = version === 3
			? Buffer.from([0, 0, 0, 6, 0, 0, 0, 0, 0, 0])
			: Buffer.from([0, 0, 0, 6, 1, 0]);
		const lyric = frame('USLT', Buffer.concat([Buffer.from([3]), Buffer.from('eng'), Buffer.from([0]), Buffer.from('extended lyrics')]), version === 4);
		assert.deepEqual(parseId3Lyrics(id3([extended, lyric], { version, flags: 0x40 })), { text: 'extended lyrics' });
		assert.equal(parseId3Lyrics(id3([extended.subarray(0, 4)], { version, flags: 0x40 })), null);
		const oversized = Buffer.from([0, 0, 0, 100]);
		assert.equal(parseId3Lyrics(id3([oversized, lyric], { version, flags: 0x40 })), null);
	}
});

/* ---------- FLAC ---------- */
await check('FLAC VORBIS_COMMENT LYRICS 可读', async () => {
	const tag = parseFlacLyrics(flac([['TITLE', 'Hello'], ['LYRICS', '[00:04.00]flac line']]));
	assert.equal(tag.text, '[00:04.00]flac line');
});
await check('FLAC 无歌词字段返回 null', async () => {
	assert.equal(parseFlacLyrics(flac([['TITLE', 'Hello']])), null);
	assert.equal(parseFlacLyrics(Buffer.from('fLaC')), null);
});

/* ---------- directory scan ---------- */
await check('扫描：标签内歌词、旁车 .lrc 优先、忽略无关文件', async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-local-scan-'));
	try {
		await fs.writeFile(path.join(dir, 'Other Song.mp3'), 'nope');
		await fs.writeFile(path.join(dir, 'Adele - Hello.mp3'), Buffer.concat([id3([uslt('[00:01.00]embedded')]), Buffer.alloc(64)]));
		const embedded = await findLocalLyrics({ title: 'hello', artist: 'adele' }, { dirs: [dir] });
		assert.equal(embedded.text, '[00:01.00]embedded');
		assert.equal(embedded.file, 'Adele - Hello.mp3');

		await fs.writeFile(path.join(dir, 'Adele - Hello.lrc'), '[00:02.00]sidecar', 'utf8');
		const sidecar = await findLocalLyrics({ title: 'hello', artist: 'adele' }, { dirs: [dir] });
		assert.equal(sidecar.text, '[00:02.00]sidecar');
		assert.equal(sidecar.file, 'Adele - Hello.lrc');
	} finally {
		for (const name of ['Other Song.mp3', 'Adele - Hello.mp3', 'Adele - Hello.lrc']) {
			await fs.unlink(path.join(dir, name)).catch(() => {});
		}
		await fs.rmdir(dir).catch(() => {});
	}
});
await check('扫描：未命中给原因，禁用时直接跳过', async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-local-miss-'));
	try {
		await fs.writeFile(path.join(dir, 'Adele - Hello.mp3'), Buffer.alloc(32));
		assert.equal((await findLocalLyrics({ title: 'hello', artist: 'adele' }, { dirs: [dir] })).reason, 'no-embedded-lyrics');
		assert.equal((await findLocalLyrics({ title: 'hello' }, { dirs: [] })).reason, 'no-search-dirs');
		assert.equal((await findLocalLyrics({ title: 'hello' }, { dirs: [dir], enabled: false })).reason, 'disabled');
	} finally {
		await fs.unlink(path.join(dir, 'Adele - Hello.mp3')).catch(() => {});
		await fs.rmdir(dir).catch(() => {});
	}
});

await check('deadline prevents candidate I/O after scan, and reads after a slow stat', async () => {
	const original = { now: Date.now, readdir: fs.readdir, stat: fs.stat, readFile: fs.readFile, open: fs.open };
	let now = 0, statCalls = 0, readCalls = 0;
	try {
		Date.now = () => now;
		fs.readFile = async () => { readCalls++; throw new Error('must not read after deadline'); };
		fs.open = async () => { readCalls++; throw new Error('must not open after deadline'); };
		fs.stat = async () => { statCalls++; now = 100; return { size: 20 }; };
		fs.readdir = async () => [{ isDirectory: () => false, isFile: () => true,
			get name() { now = 100; return 'Hello.lrc'; } }];
		const expired = await findLocalLyrics({ title: 'Hello' }, { dirs: ['/virtual'], budgetMs: 100 });
		assert.equal(expired.reason, 'budget-exhausted');
		assert.equal(statCalls, 0); assert.equal(readCalls, 0);
		now = 0;
		fs.readdir = async () => [{ name: 'Hello.lrc', isDirectory: () => false, isFile: () => true }];
		await findLocalLyrics({ title: 'Hello' }, { dirs: ['/virtual'], budgetMs: 100 });
		assert.equal(statCalls, 1); assert.equal(readCalls, 0);
	} finally {
		Date.now = original.now; fs.readdir = original.readdir; fs.stat = original.stat;
		fs.readFile = original.readFile; fs.open = original.open;
	}
});

console.log('ALL ' + count + ' LOCAL-LYRICS TESTS PASS');

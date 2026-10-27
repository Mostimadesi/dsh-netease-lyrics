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

console.log('ALL ' + count + ' LOCAL-LYRICS TESTS PASS');

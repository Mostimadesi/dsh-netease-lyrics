/** bilibili subtitle source (v0.4.11): unit contracts + service integration.
 * Negative-verified against v0.4.10a (9333b75): the module does not exist and
 * the service ignores `bvid` there, so every section fails on the old HEAD.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLyricService, fingerprintOf } from '../lib/lyric-service.js';
import {
	mixinKeyEnc, parseNetscapeCookies, extractBilibiliSessdata, wbiKeysFromNav,
	signWbiParams, pickSubtitleTrack, subtitlesToLines, splitSubtitleCue, fetchBilibiliSubtitles,
} from '../lib/bilibili-subtitles.js';

let failed = 0;
const check = (name, cond, detail) => {
	console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' :: ' + detail));
	if (!cond) failed += 1;
};

// 1. mixin key — regression pin for the 64-entry table. The keys are the
// widely published example pair; `ea1db1...` matches the community reference
// value, and the live chain check (real verification run) re-proves it.
const MIXIN_EXPECTED = 'ea1db124af3c7062474693fa704f4ff8';
check('mixinKeyEnc table regression pin',
	mixinKeyEnc('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45') === MIXIN_EXPECTED,
	mixinKeyEnc('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45'));
check('mixinKeyEnc length', mixinKeyEnc('a'.repeat(32), 'b'.repeat(32)).length === 32, 'len');

// 2. Netscape cookies parsing: comments skipped, #HttpOnly_ kept, domain kept.
const cookiesText = [
	'# Netscape HTTP Cookie File',
	'# This is a generated file! Do not edit.',
	'',
	'.example.com\tTRUE\t/\tTRUE\t1767225600\tSESSDATA\tdecoy-from-other-site',
	'#HttpOnly_.bilibili.com\tTRUE\t/\tTRUE\t1767225600\tSESSDATA\tsess-bili%2Cvalue',
	'.bilibili.com\tTRUE\t/\tFALSE\t1767225600\tbili_jct\tjct-value',
	'malformed-line-without-tabs',
].join('\n');
const cookieRows = parseNetscapeCookies(cookiesText);
check('parseNetscapeCookies skips comments/malformed, keeps data',
	cookieRows.length === 3 && cookieRows[0].name === 'SESSDATA' && cookieRows[0].value === 'decoy-from-other-site'
		&& cookieRows[1].domain === '.bilibili.com', JSON.stringify(cookieRows));
check('extractBilibiliSessdata takes only the bilibili row',
	extractBilibiliSessdata(cookieRows) === 'sess-bili%2Cvalue', extractBilibiliSessdata(cookieRows));
check('extractBilibiliSessdata empty-safe',
	extractBilibiliSessdata([]) === '' && extractBilibiliSessdata(null) === '' && extractBilibiliSessdata('x') === '', '');

// 3. wbi keys from a nav payload.
const keys = wbiKeysFromNav({ code: 0, data: { wbi_img: {
	img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
	sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } } });
check('wbiKeysFromNav extracts basenames', keys?.imgKey === '7cd084941338484aae1ad9425b84077c'
	&& keys?.subKey === '4932caff0ff746eab6f01bf08b70ac45', JSON.stringify(keys));
check('wbiKeysFromNav null-safe', wbiKeysFromNav({}) === null && wbiKeysFromNav(null) === null, '');

// 4. signing: deterministic, sorted, wts injected, !'()* stripped, md5 hex.
const signed = signWbiParams({ bvid: 'BV1GJ411x7h7', cid: '137649199' },
	'7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45', 1700000000);
check('signWbiParams sorted + wts + 32-hex w_rid',
	/^bvid=BV1GJ411x7h7&cid=137649199&wts=1700000000&w_rid=[0-9a-f]{32}$/.test(signed), signed);
check('signWbiParams regression pin', signed.endsWith('&w_rid=901e03bc9e7b896058c8b28b96ae2c7e'), signed);
check("signWbiParams strips !'()*",
	signWbiParams({ q: 'a!b(c)d*' }, 'k', 's', 1).startsWith('q=abcd&'), signWbiParams({ q: 'a!b(c)d*' }, 'k', 's', 1));
check('signWbiParams deterministic',
	signWbiParams({ bvid: 'BV1GJ411x7h7', cid: '137649199' }, '7cd084941338484aae1ad9425b84077c',
		'4932caff0ff746eab6f01bf08b70ac45', 1700000000) === signed, 'differs');

// 5. track picking: zh-CN > ai-zh > first-with-url; empty-url tracks skipped.
check('pickSubtitleTrack prefers zh-CN', pickSubtitleTrack([
	{ lan: 'en', subtitle_url: 'http://en' }, { lan: 'zh-CN', subtitle_url: 'http://zh' }])?.lan === 'zh-CN', '');
check('pickSubtitleTrack falls back to ai-zh', pickSubtitleTrack([
	{ lan: 'en', subtitle_url: 'http://en' }, { lan: 'ai-zh', subtitle_url: 'http://ai' }])?.lan === 'ai-zh', '');
check('pickSubtitleTrack skips empty urls', pickSubtitleTrack([
	{ lan: 'zh-CN', subtitle_url: '' }, { lan: 'en', subtitle_url: 'http://en' }])?.lan === 'en', '');
check('pickSubtitleTrack null when no urls',
	pickSubtitleTrack([{ lan: 'zh-CN', subtitle_url: '' }]) === null && pickSubtitleTrack([]) === null
		&& pickSubtitleTrack(null) === null, '');

// 6. subtitle body -> lyric lines.
const lines = subtitlesToLines([
	{ from: 2.5, to: 5.1, content: '  第二句 ' }, null, { from: 0.12, content: '' },
	{ from: 0.12, to: 1, content: '第一句' }, { to: 3, content: 'no-from' }]);
check('subtitlesToLines maps/filters/sorts',
	lines.length === 2 && lines[0].t === 0.12 && lines[0].text === '第一句'
		&& lines[1].t === 2.5 && lines[1].text === '第二句', JSON.stringify(lines));
check('subtitlesToLines empty-safe', subtitlesToLines(null).length === 0 && subtitlesToLines({}).length === 0, '');

// 6b. bilingual cues carry BOTH languages inside one entry, separated by a
// line break (verified live 2026-11-09 on a dual-subtitle 2DMV) — they become
// text + trans instead of being flattened onto one line. A same-script extra
// line is the video wrapping a long sentence and is joined, never a trans.
const bilingual = subtitlesToLines([
	{ from: 1, to: 3, content: 'アイデンティティ それは嗜好の\n这就是嗜好的 Identity' },
	{ from: 3, to: 5, content: '同じ言葉の繰り返し\n同一句话的重复' },
	{ from: 5, to: 7, content: '很长的一句中文被字幕工具折成了\n两行显示' },
	{ from: 7, to: 9, content: 'Wrap me across\ntwo english lines' },
	{ from: 9, to: 11, content: '単行' },
	{ from: 11, to: 13, content: '\n\n' },
	{ from: 13, to: 15, content: 'English line\n中文翻译' },
]);
check('bilingual cue -> original + translation',
	bilingual[0].text === 'アイデンティティ それは嗜好の' && bilingual[0].trans === '这就是嗜好的 Identity',
	JSON.stringify(bilingual[0]));
check('second bilingual cue stays a pair',
	bilingual[1].text === '同じ言葉の繰り返し' && bilingual[1].trans === '同一句话的重复', JSON.stringify(bilingual[1]));
check('same-script Chinese wrap is joined, never a translation',
	bilingual[2].text === '很长的一句中文被字幕工具折成了 两行显示' && bilingual[2].trans === undefined,
	JSON.stringify(bilingual[2]));
check('same-script English wrap is joined too',
	bilingual[3].text === 'Wrap me across two english lines' && bilingual[3].trans === undefined, JSON.stringify(bilingual[3]));
check('single-line cue unchanged', bilingual[4].text === '単行' && bilingual[4].trans === undefined, JSON.stringify(bilingual[4]));
check('latin + Han pair counts as bilingual',
	bilingual[5].text === 'English line' && bilingual[5].trans === '中文翻译', JSON.stringify(bilingual[5]));
check('blank cue dropped', bilingual.length === 6, JSON.stringify(bilingual.map((row) => row.text)));
check('splitSubtitleCue empty-safe',
	splitSubtitleCue('') === null && splitSubtitleCue(null) === null && splitSubtitleCue('   ') === null
		&& splitSubtitleCue(' \n ') === null, '');

// 7. full chain with a stubbed fetch: view -> nav -> signed player -> subtitle.
function makeBilibiliFetch() {
	const calls = [];
	const json = (payload) => ({ ok: true, json: async () => payload });
	const fetchImpl = async (url, opts) => {
		calls.push({ url: String(url), headers: { ...opts.headers } });
		if (url.includes('/x/web-interface/view?')) return json({ code: 0, data: {
			bvid: 'BV1GJ411x7h7', cid: 137649199, title: '【官方 MV】测试视频', duration: 213, owner: { name: '测试UP主' } } });
		if (url.includes('/x/web-interface/nav')) return json({ code: 0, data: { isLogin: true, wbi_img: {
			img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
			sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } } });
		if (url.includes('/x/player/wbi/v2?')) return json({ code: 0, data: { subtitle: { subtitles: [
			{ lan: 'en', subtitle_url: '//aisubtitle.hdslb.com/en.json' },
			{ lan: 'zh-CN', subtitle_url: '//aisubtitle.hdslb.com/zh.json' },
			{ lan: 'ko', subtitle_url: '' } ] } } });
		if (url.startsWith('https://aisubtitle.hdslb.com/zh.json')) return json({ body: [
			{ from: 0.12, to: 5.12, content: '永不放弃你' }, { from: 18.55, to: 22.27, content: '我们对爱情并不陌生' } ] });
		throw new Error('unexpected url ' + url);
	};
	fetchImpl.calls = calls;
	return fetchImpl;
}
const chainFetch = makeBilibiliFetch();
const chainResult = await fetchBilibiliSubtitles({
	bvid: 'BV1GJ411x7h7', sessdata: 'sess-test', fetchImpl: chainFetch, minGapMs: 0 });
check('chain maps lines + meta', chainResult.lines.length === 2 && chainResult.pickedLan === 'zh-CN'
	&& chainResult.title === '【官方 MV】测试视频' && chainResult.upName === '测试UP主'
	&& chainResult.trackCount === 3 && chainResult.urlCount === 2, JSON.stringify(chainResult).slice(0, 220));
const viewCall = chainFetch.calls.find((row) => row.url.includes('/x/web-interface/view?'));
const navCall = chainFetch.calls.find((row) => row.url.includes('/x/web-interface/nav'));
const playerCall = chainFetch.calls.find((row) => row.url.includes('/x/player/wbi/v2?'));
const subCall = chainFetch.calls.find((row) => row.url.startsWith('https://aisubtitle.hdslb.com/zh.json'));
check('view is public (no cookie header)',
	viewCall && !viewCall.headers.cookie, JSON.stringify(viewCall?.headers));
check('nav carries SESSDATA cookie', navCall && navCall.headers.cookie === 'SESSDATA=sess-test', JSON.stringify(navCall?.headers));
check('player is signed and carries cookie',
	playerCall && /\/x\/player\/wbi\/v2\?bvid=BV1GJ411x7h7&cid=137649199&wts=\d+&w_rid=[0-9a-f]{32}$/.test(playerCall.url)
		&& playerCall.headers.cookie === 'SESSDATA=sess-test', playerCall?.url);
check('subtitle download upgrades // to https: and needs no cookie',
	subCall && subCall.url === 'https://aisubtitle.hdslb.com/zh.json' && !subCall.headers.cookie, subCall?.url);

// 8. failure shapes: signature rejection is a distinct error; empty tracks
// and API codes are clean errors; bad bvid never reaches the network.
const emptyUrlFetch = async (url) => {
	if (url.includes('/x/web-interface/view?')) return { ok: true, json: async () => ({ code: 0, data: { cid: 1, title: 't' } }) };
	if (url.includes('/x/web-interface/nav')) return { ok: true, json: async () => ({ code: 0, data: { isLogin: true, wbi_img: {
		img_url: 'https://x/aaaa.png', sub_url: 'https://x/bbbb.png' } } }) };
	if (url.includes('/x/player/wbi/v2?')) return { ok: true, json: async () => ({ code: 0, data: { subtitle: { subtitles: [
		{ lan: 'zh-CN', subtitle_url: '' }, { lan: 'en', subtitle_url: '' }] } } }) };
	throw new Error('unexpected url ' + url);
};
let emptyUrlError = '';
try { await fetchBilibiliSubtitles({ bvid: 'BV1GJ411x7h7', sessdata: 's', fetchImpl: emptyUrlFetch, minGapMs: 0 }); }
catch (err) { emptyUrlError = String(err?.message || err); }
check('all-empty subtitle urls -> signature error (never "no subtitles")',
	/empty urls.*signature/.test(emptyUrlError), emptyUrlError);
let apiCodeError = '';
try { await fetchBilibiliSubtitles({ bvid: 'BV1GJ411x7h7', sessdata: 's',
	fetchImpl: async () => ({ ok: true, json: async () => ({ code: -404 }) }), minGapMs: 0 }); }
catch (err) { apiCodeError = String(err?.message || err); }
check('view api code surfaces as error', /view api code -404/.test(apiCodeError), apiCodeError);
let badBvidError = '';
try { await fetchBilibiliSubtitles({ bvid: 'not-a-bvid', fetchImpl: async () => { throw new Error('should not fetch'); } }); }
catch (err) { badBvidError = String(err?.message || err); }
check('invalid bvid rejected before any request', /invalid bvid/.test(badBvidError), badBvidError);

// 9. service integration: bvid-pinned branch ahead of the search chain.
const cookiePath = path.join(os.tmpdir(), 'dnl-bilibili-test-cookies-' + process.pid + '.txt');
fs.writeFileSync(cookiePath, cookiesText.replace('sess-bili%2Cvalue', 'sess-svc%2Ctoken'), 'utf8');
function makeServiceFetch(bilibiliBody = [{ from: 0.5, to: 2, content: '字幕一句' }]) {
	const calls = [];
	const json = (payload) => ({ ok: true, json: async () => payload });
	const fetchImpl = async (url, opts) => {
		calls.push(String(url));
		if (url.includes('api.bilibili.com/x/web-interface/view?')) return json({ code: 0, data: {
			bvid: 'BV1GJ411x7h7', cid: 137649199, title: '视频标题', duration: 213, owner: { name: 'UP主' } } });
		if (url.includes('api.bilibili.com/x/web-interface/nav')) return json({ code: 0, data: { isLogin: true, wbi_img: {
			img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
			sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } } });
		if (url.includes('api.bilibili.com/x/player/wbi/v2?')) return json({ code: 0, data: { subtitle: { subtitles: [
			{ lan: 'zh-CN', subtitle_url: '//aisubtitle.hdslb.com/svc.json' }] } } });
		if (url.startsWith('https://aisubtitle.hdslb.com/svc.json')) return json({ body: bilibiliBody });
		if (url.includes('/api/search/get/web')) return json({ code: 200, result: { songs: [
			{ id: 42, name: '晴天', artists: [{ name: '周杰伦' }], duration: 269000 }] } });
		if (url.includes('/api/song/lyric')) return json({ code: 200,
			lrc: { lyric: '[00:01.00]故事的小黄花\n' }, tlyric: { lyric: '' } });
		if (url.includes('/soso/fcgi-bin/client_search_cp')) return json({ code: 0, data: { song: { list: [] } } });
		if (url.includes('songsearch.kugou.com')) return json({ status: 1, data: { lists: [] } });
		if (url.includes('app.u.nf.migu.cn')) return json([]);
		throw new Error('unexpected url ' + url);
	};
	fetchImpl.calls = calls;
	return fetchImpl;
}
const svcFetch = makeServiceFetch();
const svc = createLyricService({
	fetchImpl: svcFetch, cacheFile: '',
	bilibiliCookiePaths: [cookiePath], bilibiliRequestGapMs: 0,
});
const bvidFacts = { title: '视频标题', artist: 'UP主', durationSec: 213, bvid: 'BV1GJ411x7h7' };
const rBili = await svc.resolve(bvidFacts);
check('bvid resolves via bilibili, ahead of the search chain',
	rBili.status === 'matched' && rBili.source === 'bilibili' && rBili.sourceLabel === 'B站字幕'
		&& rBili.fallbackUsed === false && rBili.songName === '视频标题'
		&& rBili.artistNames[0] === 'UP主' && rBili.lines.length === 1 && rBili.lines[0].text === '字幕一句',
	JSON.stringify(rBili).slice(0, 260));
check('bilibili match never touches the music search APIs',
	svcFetch.calls.filter((url) => url.includes('/api/search/get/web')).length === 0, JSON.stringify(svcFetch.calls));
const callsAfterBili = svcFetch.calls.length;
await svc.resolve(bvidFacts);
check('bilibili result cached per track (no extra http)', svcFetch.calls.length === callsAfterBili,
	callsAfterBili + '->' + svcFetch.calls.length);
await svc.resolve({ ...bvidFacts, bvid: 'BV1AbCdEfGh5' });
check('different bvid re-resolves (bvid is part of the cache key)',
	svcFetch.calls.length > callsAfterBili, callsAfterBili + '->' + svcFetch.calls.length);

// video without subtitles stays video-only: no silent music-source swap
// (user decision 2026-11-09 — manual rematch is the only unlock)
const svcFetchNoSub = makeServiceFetch([]);
const svcNoSub = createLyricService({
	fetchImpl: svcFetchNoSub, cacheFile: '',
	bilibiliCookiePaths: [cookiePath], bilibiliRequestGapMs: 0,
});
const videoFacts = { ...bvidFacts, title: '晴天', artist: '周杰伦', durationSec: 269 };
const rNoSub = await svcNoSub.resolve(videoFacts);
check('video without subtitles stays video-only (no silent music swap)',
	rNoSub.status === 'unmatched' && rNoSub.source === null
		&& rNoSub.attempts.length === 1 && rNoSub.attempts[0].source === 'bilibili'
		&& rNoSub.attempts[0].reason === 'no-subtitle-content'
		&& svcFetchNoSub.calls.every((url) => !url.includes('/api/search/get/web')),
	JSON.stringify(rNoSub));
svcNoSub.invalidate(fingerprintOf('晴天', '周杰伦')); // what the rematch button does
const callsBeforeManual = svcFetchNoSub.calls.length;
const rManual = await svcNoSub.resolve({ ...videoFacts, allowMusicFallback: true });
check('manual rematch unlocks the music chain for the same video',
	rManual.status === 'matched' && rManual.source === 'netease'
		&& rManual.attempts[0].source === 'bilibili' && rManual.attempts[0].status === 'unmatched'
		&& svcFetchNoSub.calls.slice(callsBeforeManual).some((url) => url.includes('/api/search/get/web')),
	JSON.stringify(rManual.attempts));

// cookie missing -> bilibili attempt errors, video stays video-only
fs.writeFileSync(cookiePath, '.example.com\tTRUE\t/\tTRUE\t1767225600\tSESSDATA\tdecoy', 'utf8');
const svcFetchNoCookie = makeServiceFetch();
const svcNoCookie = createLyricService({
	fetchImpl: svcFetchNoCookie, cacheFile: '',
	bilibiliCookiePaths: [cookiePath], bilibiliRequestGapMs: 0,
});
const rNoCookie = await svcNoCookie.resolve({ ...bvidFacts, title: '晴天', artist: '周杰伦', durationSec: 269 });
check('missing SESSDATA keeps the video video-only with a readable error',
	rNoCookie.status === 'error' && rNoCookie.source === null
		&& rNoCookie.attempts[0].source === 'bilibili' && rNoCookie.attempts[0].status === 'error'
		&& /cookie missing or expired/.test(rNoCookie.attempts[0].reason)
		&& !String(rNoCookie.attempts[0].reason).includes('sess-')
		&& svcFetchNoCookie.calls.every((url) => !url.includes('/api/search/get/web')),
	JSON.stringify(rNoCookie.attempts));

// disabled source: bvid is ignored, no bilibili request at all
const svcFetchDisabled = makeServiceFetch();
const svcDisabled = createLyricService({
	fetchImpl: svcFetchDisabled, cacheFile: '',
	bilibiliEnabled: false, bilibiliCookiePaths: [cookiePath], bilibiliRequestGapMs: 0,
});
const rDisabled = await svcDisabled.resolve({ ...bvidFacts, title: '晴天', artist: '周杰伦', durationSec: 269 });
check('bilibiliEnabled=false keeps bvid out of the picture',
	rDisabled.status === 'matched' && rDisabled.source === 'netease'
		&& svcFetchDisabled.calls.every((url) => !url.includes('api.bilibili.com')), rDisabled.source);

// persistence: a cached bilibili entry survives a restart-shaped restore
const cachePath = path.join(os.tmpdir(), 'dnl-bilibili-test-cache-' + process.pid + '.json');
const bilibiliEntry = {
	status: 'matched', source: 'bilibili', sourceLabel: 'B站字幕', fallbackUsed: false,
	attempts: [{ source: 'bilibili', status: 'matched' }], songId: 'BV1GJ411x7h7', songName: '缓存视频',
	artistNames: ['UP主'], score: 0, lines: [{ t: 0.5, text: '缓存字幕' }], fetchedAt: Date.now(),
};
const cacheKey = fingerprintOf('缓存视频', 'UP主') + '|缓存视频|213|BV1GJ411x7h7';
fs.writeFileSync(cachePath, JSON.stringify({ version: 2, entries: [[cacheKey, bilibiliEntry]] }), 'utf8');
const svcFetchRestore = makeServiceFetch();
const svcRestore = createLyricService({
	fetchImpl: svcFetchRestore, cacheFile: cachePath,
	bilibiliCookiePaths: [cookiePath], bilibiliRequestGapMs: 0,
});
const rRestore = await svcRestore.resolve({ title: '缓存视频', artist: 'UP主', durationSec: 213, bvid: 'BV1GJ411x7h7' });
check('bilibili entries persist across restarts (parsed lines, never the url)',
	rRestore.status === 'matched' && rRestore.source === 'bilibili' && rRestore.lines[0].text === '缓存字幕'
		&& svcFetchRestore.calls.length === 0, JSON.stringify(rRestore).slice(0, 200));

// cleanup
try { fs.unlinkSync(cookiePath); } catch {}
try { fs.unlinkSync(cachePath); } catch {}

// 10. multiple cookie exports: a stale SESSDATA must not poison a fresher
// file (verified live 2026-11-09: cookies.txt returned nav -101 while
// cookies-bilibili.txt was still logged in).
function makeMultiCookieFetch(goodSess) {
	const calls = [];
	const json = (payload) => ({ ok: true, json: async () => payload });
	const fetchImpl = async (url, opts) => {
		calls.push({ url: String(url), cookie: String(opts.headers.cookie || '') });
		if (url.includes('api.bilibili.com/x/web-interface/view?')) return json({ code: 0, data: {
			bvid: 'BV1GJ411x7h7', cid: 137649199, title: '视频标题', duration: 213, owner: { name: 'UP主' } } });
		if (url.includes('api.bilibili.com/x/web-interface/nav')) {
			if (opts.headers.cookie === 'SESSDATA=' + goodSess) return json({ code: 0, data: { isLogin: true, wbi_img: {
				img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
				sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } } });
			return json({ code: -101 });
		}
		if (url.includes('api.bilibili.com/x/player/wbi/v2?')) return json({ code: 0, data: { subtitle: {
			subtitles: [{ lan: 'zh-CN', subtitle_url: '//aisubtitle.hdslb.com/mc.json' }] } } });
		if (url.startsWith('https://aisubtitle.hdslb.com/mc.json')) return json({ body: [{ from: 1, to: 2, content: '字幕一句' }] });
		if (url.includes('/api/search/get/web')) return json({ code: 200, result: { songs: [
			{ id: 42, name: '晴天', artists: [{ name: '周杰伦' }], duration: 269000 }] } });
		if (url.includes('/api/song/lyric')) return json({ code: 200, lrc: { lyric: '[00:01.00]故事的小黄花\n' }, tlyric: { lyric: '' } });
		if (url.includes('/soso/fcgi-bin/client_search_cp')) return json({ code: 0, data: { song: { list: [] } } });
		if (url.includes('songsearch.kugou.com')) return json({ status: 1, data: { lists: [] } });
		if (url.includes('app.u.nf.migu.cn')) return json([]);
		throw new Error('unexpected url ' + url);
	};
	fetchImpl.calls = calls;
	return fetchImpl;
}
const cookieBad = path.join(os.tmpdir(), 'dnl-bili-stale-' + process.pid + '.txt');
const cookieGood = path.join(os.tmpdir(), 'dnl-bili-good-' + process.pid + '.txt');
fs.writeFileSync(cookieBad, cookiesText.replace('sess-bili%2Cvalue', 'sess-stale'), 'utf8');
fs.writeFileSync(cookieGood, cookiesText.replace('sess-bili%2Cvalue', 'sess-good'), 'utf8');
const factsMV = { title: '晴天', artist: '周杰伦', durationSec: 269, bvid: 'BV1GJ411x7h7' };
const multiFetch = makeMultiCookieFetch('sess-good');
const svcMulti = createLyricService({
	fetchImpl: multiFetch, cacheFile: '',
	bilibiliCookiePaths: [cookieBad, cookieGood], bilibiliRequestGapMs: 0,
});
const rMulti = await svcMulti.resolve(factsMV);
check('a stale export falls through to the next cookie file and matches bilibili',
	rMulti.status === 'matched' && rMulti.source === 'bilibili' && rMulti.lines[0].text === '字幕一句',
	JSON.stringify(rMulti.attempts));
const staleNavCalls = () => multiFetch.calls.filter((row) => row.cookie === 'SESSDATA=sess-stale'
	&& row.url.includes('/x/web-interface/nav')).length;
check('stale export tried exactly once (verdict cached per mtime)', staleNavCalls() === 1, String(staleNavCalls()));
await svcMulti.resolve({ ...factsMV, bvid: 'BV1ZzZzZzZz9' });
check('verdict cache survives the next track', staleNavCalls() === 1, String(staleNavCalls()));
const allBadFetch = makeMultiCookieFetch('sess-never-used');
const svcAllBad = createLyricService({
	fetchImpl: allBadFetch, cacheFile: '',
	bilibiliCookiePaths: [cookieBad, cookieGood], bilibiliRequestGapMs: 0,
});
const rAllBad = await svcAllBad.resolve(factsMV);
check('all exports expired -> readable labelled error, video stays video-only',
	rAllBad.status === 'error' && rAllBad.source === null
		&& rAllBad.attempts[0].source === 'bilibili' && rAllBad.attempts[0].status === 'error'
		&& /expired or not logged in \(.+\.txt\)/.test(rAllBad.attempts[0].reason)
		&& !String(rAllBad.attempts[0].reason).includes('sess-')
		&& allBadFetch.calls.every((row) => !row.url.includes('/api/search/get/web')),
	JSON.stringify(rAllBad.attempts));

// candidate order: the dedicated bilibili export outranks a same-named
// generic cookies.txt (runtime-conditional — the machine may not have both)
const { bilibiliCookieCandidates } = await import('../lib/index.js');
const candidateList = bilibiliCookieCandidates('');
const bilibiliIdx = candidateList.findIndex((p) => path.basename(p) === 'cookies-bilibili.txt');
const genericIdx = candidateList.findIndex((p) => path.basename(p) === 'cookies.txt');
check('cookies-bilibili.txt outranks cookies.txt in candidate order',
	bilibiliIdx === -1 || genericIdx === -1 || bilibiliIdx < genericIdx,
	JSON.stringify(candidateList.map((p) => path.basename(p))));

// 13-day / 20-day positive TTL boundaries (user request 2026-11-09: 15 days):
// a 13-day-old entry is still served, a 20-day-old one is dropped + refetched.
const agedPath = path.join(os.tmpdir(), 'dnl-bilibili-test-aged-' + process.pid + '.json');
const agedEntry = (days) => ({ ...bilibiliEntry, fetchedAt: Date.now() - days * 24 * 60 * 60 * 1000 });
const agedFacts = { title: '缓存视频', artist: 'UP主', durationSec: 213, bvid: 'BV1GJ411x7h7' };
fs.writeFileSync(agedPath, JSON.stringify({ version: 2, entries: [[cacheKey, agedEntry(13)]] }), 'utf8');
const fetchThirteen = makeServiceFetch();
const svcThirteen = createLyricService({
	fetchImpl: fetchThirteen, cacheFile: agedPath,
	bilibiliCookiePaths: [cookieGood], bilibiliRequestGapMs: 0,
});
const rThirteen = await svcThirteen.resolve(agedFacts);
check('a 13-day-old cached match is still served (15d TTL)',
	rThirteen.status === 'matched' && rThirteen.source === 'bilibili' && rThirteen.lines[0].text === '缓存字幕'
		&& fetchThirteen.calls.length === 0, JSON.stringify(rThirteen).slice(0, 160));
fs.writeFileSync(agedPath, JSON.stringify({ version: 2, entries: [[cacheKey, agedEntry(20)]] }), 'utf8');
const fetchTwenty = makeServiceFetch();
const svcTwenty = createLyricService({
	fetchImpl: fetchTwenty, cacheFile: agedPath,
	bilibiliCookiePaths: [cookieGood], bilibiliRequestGapMs: 0,
});
const rTwenty = await svcTwenty.resolve(agedFacts);
check('a 20-day-old cached match is dropped and refetched',
	fetchTwenty.calls.length > 0, 'calls ' + fetchTwenty.calls.length);
try { fs.unlinkSync(agedPath); } catch {}

// cleanup (part 2)
try { fs.unlinkSync(cookieBad); } catch {}
try { fs.unlinkSync(cookieGood); } catch {}

console.log(failed === 0 ? 'ALL PASS' : failed + ' FAILED');
process.exit(failed === 0 ? 0 : 1);

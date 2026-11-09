import { createLyricService, parseLrc, fingerprintOf } from '../lib/lyric-service.js';

let failed = 0;
const check = (name, cond, detail) => {
	console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' :: ' + detail));
	if (!cond) failed += 1;
};

// 1. LRC parsing
const lrc = parseLrc('[00:01.50]第一句\n[00:05.00][00:09.00]重复句\n[00:12]第三句\n[00:13.999]末句\n[ti:metadata]\n[00:20]      \n');
check('parseLrc count', lrc.length === 5, JSON.stringify(lrc));
check('parseLrc times', lrc[0].t === 1.5 && lrc[1].t === 5 && lrc[2].t === 9 && lrc[3].t === 12, JSON.stringify(lrc));
check('parseLrc sorted+text', lrc[1].text === '重复句' && lrc[2].text === '重复句', JSON.stringify(lrc));

// Offsets apply to the whole document, including metadata after lyric lines.
const advanced = parseLrc('[00:01.00]first\n[00:03.00][00:04.00]repeat\n[offset:+1500]');
check('positive offset advances all timestamps, preserving negative first row',
	JSON.stringify(advanced.map(row => row.t)) === JSON.stringify([-0.5, 1.5, 2.5]), JSON.stringify(advanced));
const delayed = parseLrc('[offset:-500]\n[00:02.00]second\n[00:01.00]first');
check('negative offset delays and sorts timestamps', delayed[0].t === 1.5 && delayed[1].t === 2.5, JSON.stringify(delayed));
check('malformed offset ignored', parseLrc('[offset:nope]\n[00:01]line')[0].t === 1, 'malformed offset changed timing');

// 2. fingerprint normalization
const fp1 = fingerprintOf('晴天 (Live)', ' 周杰伦 ');
const fp2 = fingerprintOf('晴天', '周杰伦');
check('fingerprint normalizes noise', fp1 === fp2, fp1 + ' vs ' + fp2);

// 3. full pipeline with stubbed fetch
let calls = 0;
const fake = async (url) => {
	calls += 1;
	if (url.includes('/api/search/get/web')) {
		return {
			ok: true,
			json: async () => ({
				code: 200,
				result: {
					songs: [
						{ id: 1, name: '别的歌', artists: [{ name: '别人' }], duration: 200000 },
						{ id: 42, name: '晴天', artists: [{ name: '周杰伦' }], duration: 269000 },
					],
				},
			}),
		};
	}
	if (url.includes('/api/song/lyric')) {
		return {
			ok: true,
			json: async () => ({
				code: 200,
				lrc: { lyric: '[00:01.00]故事的小黄花\n[00:04.30]从出生那年就飘着\n' },
				tlyric: { lyric: '[00:01.00]story flower\n' },
			}),
		};
	}
	if (url.includes('/soso/fcgi-bin/client_search_cp')) return { ok: true, json: async () => ({code: 0, data: {song: {list: []}}}) };
	// KuGou search: no candidates (the chain only calls this after the others miss).
	if (url.includes('songsearch.kugou.com')) return { ok: true, json: async () => ({status: 1, data: {lists: []}}) };
	// Migu search: also empty - the response is a bare array, not an envelope.
	if (url.includes('app.u.nf.migu.cn')) return { ok: true, json: async () => [] };
	throw new Error('unexpected url ' + url);
};

const svc = createLyricService({ fetchImpl: fake, cacheFile: '' });
const r1 = await svc.resolve({ title: '晴天', artist: '周杰伦', durationSec: 269 });
check('resolve matched', r1.status === 'matched' && r1.songId === 42, JSON.stringify(r1).slice(0, 200));
check('resolve lines+trans', r1.lines.length === 2 && r1.lines[0].trans === 'story flower', JSON.stringify(r1.lines));

const callsAfterFirst = calls;
const r2 = await svc.resolve({ title: '晴天', artist: '周杰伦', durationSec: 269 });
check('cache hit (no extra http)', r2.status === 'matched' && calls === callsAfterFirst, 'calls ' + callsAfterFirst + '->' + calls);

const r3 = await svc.resolve({ title: '查无此歌', artist: '谁', durationSec: 100 });
check('unmatched on no candidates', r3.status === 'unmatched', JSON.stringify(r3));

// title containment only (no artist overlap, wrong duration) must NOT match
const r4 = await svc.resolve({ title: '晴天', artist: '完全无关歌手', durationSec: 999 });
check('title-only does not match', r4.status === 'unmatched', JSON.stringify(r4));

// network failure degrades to error, never throws
const svcBad = createLyricService({ fetchImpl: async () => { throw new Error('boom'); }, cacheFile: '' });
const r5 = await svcBad.resolve({ title: '晴天', artist: '周杰伦', durationSec: 269 });
check('fetch failure -> error status', r5.status === 'error' && r5.attempts.filter(row => row.reason === 'boom').length === 4, JSON.stringify(r5));

// 5. origin-aware order + one retry for a transient origin failure
//    (user decision 2026-11-09: the media's own provider goes first; the
//    other providers are a safety net, not a source swap)
let orderCalls = [];
let failFirstNeteaseSearch = false;
const orderedFetch = async (url) => {
	orderCalls.push(url);
	if (url.includes('/api/search/get/web')) {
		if (failFirstNeteaseSearch) { failFirstNeteaseSearch = false; return { ok: false, status: 502 }; }
		return { ok: true, json: async () => ({ code: 200, result: { songs: [{ id: 7, name: '晴天', artists: [{ name: '周杰伦' }], duration: 269000 }] } }) };
	}
	if (url.includes('/api/song/lyric')) return { ok: true, json: async () => ({ code: 200, lrc: { lyric: '[00:01.00]网易词\n' }, tlyric: { lyric: '' } }) };
	if (url.includes('/soso/fcgi-bin/client_search_cp')) return { ok: true, json: async () => ({ code: 0, data: { song: { list: [{ songmid: 'q1', songname: '晴天', singer: [{ name: '周杰伦' }], interval: 269 }] } } }) };
	if (url.includes('/lyric/fcgi-bin/fcg_query_lyric_new.fcg')) return { ok: true, json: async () => ({ code: 0, lyric: Buffer.from('[00:01.00]qq词\n').toString('base64'), trans: '' }) };
	if (url.includes('songsearch.kugou.com')) return { ok: true, json: async () => ({ status: 1, data: { lists: [] } }) };
	if (url.includes('app.u.nf.migu.cn')) return { ok: true, json: async () => [] };
	throw new Error('unexpected url ' + url);
};
// origin qq: qq is searched first and wins
const svcQQ = createLyricService({ fetchImpl: orderedFetch, cacheFile: '' });
orderCalls = [];
const rQQ = await svcQQ.resolve({ title: '晴天', artist: '周杰伦', durationSec: 269, originSource: 'qq' });
check('origin source (qq) is searched first and wins',
	rQQ.source === 'qq' && orderCalls[0].includes('/soso/fcgi-bin'),
	JSON.stringify({ source: rQQ.source, first: orderCalls[0] }));
// origin netease with a transient first-search failure: retried once, qq never consulted
const svcRetry = createLyricService({ fetchImpl: orderedFetch, cacheFile: '' });
orderCalls = []; failFirstNeteaseSearch = true;
const rRetry = await svcRetry.resolve({ title: '晴天', artist: '周杰伦', durationSec: 269, originSource: 'netease' });
check('transient origin failure is retried once before other sources',
	rRetry.source === 'netease' && rRetry.attempts.length === 2
		&& rRetry.attempts[0].source === 'netease' && rRetry.attempts[0].status === 'error'
		&& rRetry.attempts[1].source === 'netease' && rRetry.attempts[1].status === 'matched'
		&& orderCalls.every((u) => !u.includes('/soso/fcgi-bin')),
	JSON.stringify({ source: rRetry.source, attempts: rRetry.attempts }));
// a confident origin miss (no candidates) is NOT retried — the chain moves on
let emptyNeteaseCalls = 0;
const emptyFetch = async (url) => {
	orderCalls.push(url);
	if (url.includes('/api/search/get/web')) { emptyNeteaseCalls += 1; return { ok: true, json: async () => ({ code: 200, result: { songCount: 0 } }) }; }
	if (url.includes('/soso/fcgi-bin/client_search_cp')) return { ok: true, json: async () => ({ code: 0, data: { song: { list: [{ songmid: 'q1', songname: '别的歌', singer: [{ name: '别人' }], interval: 100 }] } } }) };
	if (url.includes('songsearch.kugou.com')) return { ok: true, json: async () => ({ status: 1, data: { lists: [] } }) };
	if (url.includes('app.u.nf.migu.cn')) return { ok: true, json: async () => [] };
	throw new Error('unexpected url ' + url);
};
const svcNoRetry = createLyricService({ fetchImpl: emptyFetch, cacheFile: '' });
const rNoRetry = await svcNoRetry.resolve({ title: '晴天', artist: '周杰伦', durationSec: 269, originSource: 'netease' });
check('a confident origin miss is not retried',
	emptyNeteaseCalls === 1 && rNoRetry.status === 'unmatched', JSON.stringify(rNoRetry.attempts));

console.log(failed === 0 ? 'ALL PASS' : failed + ' FAILED');
process.exit(failed === 0 ? 0 : 1);

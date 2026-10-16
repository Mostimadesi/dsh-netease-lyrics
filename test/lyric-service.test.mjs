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
check('fetch failure -> error status', r5.status === 'error' && r5.attempts.length === 2 && r5.attempts.every(row => row.reason === 'boom'), JSON.stringify(r5));

console.log(failed === 0 ? 'ALL PASS' : failed + ' FAILED');
process.exit(failed === 0 ? 0 : 1);

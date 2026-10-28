// Live probe: force the provider chain past netease/qq/kugou so the Migu
// provider itself is what has to answer. Run: node test/live-migu-fallback.mjs
import { createLyricService } from '../lib/lyric-service.js';

const BLOCKED = ['music.163.com', 'c.y.qq.com', 'kugou.com'];
const realFetch = globalThis.fetch;
const fetchImpl = (url, options) => {
	const host = new URL(url).hostname;
	if (BLOCKED.some(h => host === h || host.endsWith('.' + h))) {
		return Promise.reject(new Error('blocked in this probe: ' + host));
	}
	return realFetch(url, options);
};

const cases = [
	{ title: '晴天', artist: '周杰伦', durationSec: 269 },
	{ title: '东风破', artist: '周杰伦', durationSec: 315 },
	// A track Migu is known to lack: must come back unmatched, not mismatched.
	{ title: '月光', artist: 'キタニタツヤ', durationSec: 260 },
];

for (const facts of cases) {
	const service = createLyricService({ fetchImpl, minRequestGapMs: 0, localLyrics: false });
	const started = Date.now();
	const r = await service.resolve(facts);
	console.log(`\n${facts.title} — ${facts.artist} (want ${facts.durationSec}s)`);
	console.log(`  status ${r.status} | source ${r.source} | ${Date.now() - started}ms`);
	for (const row of r.attempts || []) console.log('   ', row.source, row.status, row.reason || '');
	if (r.status === 'matched') {
		console.log(`  song: ${r.songName} — ${(r.artistNames || []).join('/')} | ${r.lines.length} lines`);
		for (const line of r.lines.slice(0, 3)) console.log('   ', line.t, JSON.stringify(line.text));
	}
}

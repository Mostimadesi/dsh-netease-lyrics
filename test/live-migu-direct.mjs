// Direct probe of the Migu endpoints (no provider chain in front of them).
// Run: node test/live-migu-direct.mjs
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';
const HDR = { accept: 'application/json', referer: 'https://music.migu.cn/v3/', 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' };

const queries = [
	{ title: '晴天', artist: '周杰伦', durationSec: 269 },
	{ title: '兰亭序', artist: '周杰伦', durationSec: 256 },
	{ title: '东风破', artist: '周杰伦', durationSec: 315 },
];

for (const facts of queries) {
	const query = (facts.title + ' ' + facts.artist).trim();
	const url = 'https://app.u.nf.migu.cn/pc/resource/song/item/search/v1.0?text='
		+ encodeURIComponent(query) + '&pageNo=1&pageSize=20';
	const started = Date.now();
	const res = await fetch(url, { headers: HDR, signal: AbortSignal.timeout(8000) });
	const rows = await res.json();
	const elapsed = Date.now() - started;
	if (!Array.isArray(rows)) {
		console.log(facts.title, '-> NOT AN ARRAY:', JSON.stringify(rows).slice(0, 200));
		continue;
	}
	const withLrc = rows.filter(r => r && (r.lrcUrl || (r.ext && r.ext.lrcUrl)));
	const best = withLrc.map(r => {
		const dur = Number(r.duration) || 0;
		return { r, delta: dur > 0 ? Math.abs(dur - facts.durationSec) : 9999 };
	}).sort((a, b) => a.delta - b.delta)[0];
	console.log(`\n${facts.title} — ${facts.artist} (want ${facts.durationSec}s)`);
	console.log(`  search: ${res.status} ${elapsed}ms | rows ${rows.length} | with lrcUrl ${withLrc.length}`);
	if (!best) { console.log('  no candidate with lrcUrl'); continue; }
	const r = best.r;
	console.log(`  best: ${r.songName} — ${(r.singerList || []).map(s => s.name).join('/')} | ${r.duration}s (Δ${best.delta}s)`);
	console.log(`  copyrightId: ${r.copyrightId} | contentId: ${r.contentId}`);
	const lrcUrl = r.lrcUrl || r.ext.lrcUrl;
	const lrcRes = await fetch(lrcUrl, { headers: { ...HDR, accept: 'text/plain,*/*' }, signal: AbortSignal.timeout(8000) });
	const raw = await lrcRes.text();
	const timed = (raw.match(/\[\d{1,3}:\d{1,2}/g) || []).length;
	console.log(`  lrc: ${lrcRes.status} ${raw.length}B | timed lines ${timed} | BOM ${raw.charCodeAt(0) === 0xfeff} | CRLF ${raw.includes('\r\n')}`);
	console.log('  head:', JSON.stringify(raw.replace(/^\ufeff/, '').split(/\r?\n/).slice(0, 2)));
}

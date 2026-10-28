// Live probe for the Migu provider: real network, real LRC.
// Run: node test/live-migu.mjs
import { createLyricService } from '../lib/lyric-service.js';

const facts = { title: '晴天', artist: '周杰伦', durationSec: 269 };
const service = createLyricService({ minRequestGapMs: 0, localLyrics: false });
const started = Date.now();
const result = await service.resolve(facts);
const elapsed = Date.now() - started;

console.log('status:', result.status, '| source:', result.source, '| label:', result.sourceLabel);
console.log('elapsed:', elapsed + 'ms', '| lines:', Array.isArray(result.lines) ? result.lines.length : 0);
console.log('song:', result.songName, '—', (result.artistNames || []).join(' / '));
if (Array.isArray(result.attempts)) {
	for (const row of result.attempts) console.log('  attempt', row.source, row.status, row.reason || '');
}
if (Array.isArray(result.lines) && result.lines.length) {
	console.log('first 3 lines:');
	for (const line of result.lines.slice(0, 3)) console.log('  ', line.t, JSON.stringify(line.text));
}

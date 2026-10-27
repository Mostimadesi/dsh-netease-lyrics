import fs from 'node:fs';
const file = new URL('../lib/lyric-service.js', import.meta.url);
const old = fs.readFileSync(file, 'utf8');
const prefix = old.slice(old.indexOf('/** Lowercase'), old.indexOf('/**\n * Build the service.'))
 .replace('if (candArtists.some((name) => facts.artist.includes(name) || name.includes(facts.artist)))', 'if (facts.artist && candArtists.some((name) => facts.artist.includes(name) || name.includes(facts.artist)))');
const header = `/** Multi-source lyrics: NetEase first, QQ on no-match/no-LRC/request failure.
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

`;
fs.writeFileSync(file, header + prefix);

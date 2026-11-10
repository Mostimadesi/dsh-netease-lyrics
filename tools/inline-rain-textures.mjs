// One-shot: inline the generated rain textures into lib/client.js as base64
// constants (the client is a single UMD file, so a relative module import is
// not reliable across the host's loader). Idempotent: replaces the marker
// block if it is already present.
import fs from 'node:fs';

const clientPath = 'lib/client.js';
const beads = fs.readFileSync('lib/decor-rain-beads.png').toString('base64');
const runs = fs.readFileSync('lib/decor-rain-runs.png').toString('base64');

const MARK_START = '/* __RAIN_TEXTURES_START__ */';
const MARK_END = '/* __RAIN_TEXTURES_END__ */';

const block = `${MARK_START}
		/* Rain-on-glass textures baked by tools/make-rain-textures.py and inlined
		 * as data-URIs: the plugin stays dependency-free (no fetch, no CORS, no
		 * install step) while the droplet field keeps its dark refracted rim,
		 * internal caustic and size hierarchy - things a CSS gradient cannot
		 * fake (user report 2026-11-10). */
		const RAIN_BEADS_URI = "data:image/png;base64,${beads}";
		const RAIN_RUNS_URI = "data:image/png;base64,${runs}";
		${MARK_END}`;

let src = fs.readFileSync(clientPath, 'utf8');

if (src.includes(MARK_START)) {
	const start = src.indexOf(MARK_START);
	const end = src.indexOf(MARK_END) + MARK_END.length;
	src = src.slice(0, start) + block + src.slice(end);
} else {
	// Insert right after the route constants, before anything uses them.
	const anchor = 'const REMATCH_ROUTE = "/dsh-netease-lyrics/rematch";';
	const at = src.indexOf(anchor);
	if (at < 0) throw new Error('anchor not found');
	const insertAt = at + anchor.length;
	src = src.slice(0, insertAt) + '\n' + block + src.slice(insertAt);
}

// The CSS references the identifiers, not the old module import names.
src = src.replace(/url\(" \+ RAIN_BEADS \+ "\)/g, 'url(" + RAIN_BEADS_URI + ")');
src = src.replace(/url\(" \+ RAIN_RUNS \+ "\)/g, 'url(" + RAIN_RUNS_URI + ")');

fs.writeFileSync(clientPath, src, 'utf8');
console.log('inlined. beads:', beads.length, 'runs:', runs.length,
	'| refs:', (src.match(/RAIN_BEADS_URI/g) || []).length, (src.match(/RAIN_RUNS_URI/g) || []).length);

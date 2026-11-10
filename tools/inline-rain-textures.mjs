// Inline the rain textures into lib/client.js as base64 constants.
//
// One texture set only (the "normal" density). Density, drop size and strength
// are then dialled at RUNTIME from the prefs panel:
//   density  -> `background-size` (a bigger tile = fewer drops per area)
//   size     -> the same background-size, scaled further
//   strength -> the layer's opacity
// Shipping three baked variants would have cost ~181 KB of base64; one set plus
// CSS knobs gives the same control for a third of the weight.
import fs from 'node:fs';

const clientPath = 'lib/client.js';
const beads = fs.readFileSync('lib/decor-rain-beads.png').toString('base64');
const runs = fs.readFileSync('lib/decor-rain-runs.png').toString('base64');

const MARK_START = '/* __RAIN_TEXTURES_START__ */';
const MARK_END = '/* __RAIN_TEXTURES_END__ */';

const block = `${MARK_START}
		/* Rain-on-glass textures baked by tools/make-rain-textures.py and inlined
		 * as data-URIs: the plugin stays dependency-free (no fetch, no CORS, no
		 * install step). Each droplet is a solid water body with a bright
		 * refracted core, a narrow dark interface ring and a hard specular tick -
		 * a CSS gradient cannot fake that (user report 2026-11-10). Density,
		 * drop size and strength are dialled at runtime through background-size
		 * and opacity, so one texture set covers every setting. */
		const RAIN_BEADS_URI = "data:image/png;base64,${beads}";
		const RAIN_RUNS_URI = "data:image/png;base64,${runs}";
		/* Native tile size of the textures; background-size is derived from it. */
		const RAIN_BEADS_W = 640;
		const RAIN_BEADS_H = 320;
		const RAIN_RUNS_W = 512;
		const RAIN_RUNS_H = 512;
		${MARK_END}`;

let src = fs.readFileSync(clientPath, 'utf8');
if (src.includes(MARK_START)) {
	const start = src.indexOf(MARK_START);
	const end = src.indexOf(MARK_END) + MARK_END.length;
	src = src.slice(0, start) + block + src.slice(end);
} else {
	const anchor = 'const REMATCH_ROUTE = "/dsh-netease-lyrics/rematch";';
	const at = src.indexOf(anchor);
	if (at < 0) throw new Error('anchor not found');
	src = src.slice(0, at + anchor.length) + '\n' + block + src.slice(at + anchor.length);
}
fs.writeFileSync(clientPath, src, 'utf8');
console.log('inlined beads:', beads.length, 'runs:', runs.length, 'chars');

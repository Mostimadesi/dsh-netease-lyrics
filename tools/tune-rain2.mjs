// Tune the v3 rain generator after judging it on the DARK preview (not a white
// viewer): beads read as flat grey pebbles and the runnels as hard bars.
// Fixes: brighter/cooler water, stronger inner lens, softer runnels.
import fs from 'node:fs';

const path = 'tools/make-rain-textures.py';
let s = fs.readFileSync(path, 'utf8');
const edits = [
	// Water is not grey: lift the channel curve so beads glow cool instead of
	// sitting at ~0.75 luma. `screen` blend then does the rest.
	['px[x, y] = (int(min(255, 190 * k)), int(min(255, 214 * k)), int(min(255, 242 * k)), av)',
		'px[x, y] = (int(min(255, 176 * k ** 0.72)), int(min(255, 214 * k ** 0.72)), int(min(255, 252 * k ** 0.72)), av)'],
	// A touch more contrast between the lit interior and the rim.
	['rd.ellipse((pad - rx, pad - ry, pad + rx, pad + ry), outline=255,\n               width=max(1, int(r * 0.12)))',
		'rd.ellipse((pad - rx, pad - ry, pad + rx, pad + ry), outline=255,\n               width=max(1, int(r * 0.095)))'],
	['shade = ImageChops.subtract(shade, rim.point(lambda v: int(v * 0.62)))',
		'shade = ImageChops.subtract(shade, rim.point(lambda v: int(v * 0.70)))'],
	// Runnels: much softer and slightly wider so they read as wet streaks, not
	// dashed vertical lines. (They were 1-px lines blurred by only 0.6.)
	['w = max(0.6, r * (1.0 - t) * 0.8)', 'w = max(1.2, r * (1.0 - t) * 1.5)'],
	['av = int(105 * (1.0 - t) ** 1.5 * alpha_scale / 255)',
		'av = int(78 * (1.0 - t) ** 2.0 * alpha_scale / 255)'],
	['tail = tail.filter(ImageFilter.GaussianBlur(radius=0.6))',
		'tail = tail.filter(ImageFilter.GaussianBlur(radius=1.6))'],
	// Fewer, longer runnels: a wall of bars is worse than a few real streaks.
	['for _ in range(int(14 * (alpha_scale / 200.0))):',
		'for _ in range(int(9 * (alpha_scale / 200.0))):'],
];

let applied = 0;
for (const [from, to] of edits) {
	if (!s.includes(from)) { console.log('MISS:', from.slice(0, 46).replace(/\n/g, ' ')); continue; }
	s = s.replace(from, to);
	applied += 1;
}
fs.writeFileSync(path, s, 'utf8');
console.log('applied', applied, '/', edits.length);

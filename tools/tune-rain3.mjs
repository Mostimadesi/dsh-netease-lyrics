// Final texture pass: give big beads the bright refracted core the reference
// photos show, and make the runnels short wet streaks rather than full-height
// bars. Everything that should be tunable is exposed as a CLI/JSON parameter so
// the user's "density / size / opacity" request is met in the plugin UI.
import fs from 'node:fs';

const path = 'tools/make-rain-textures.py';
let s = fs.readFileSync(path, 'utf8');

const edits = [
	// A bright refracted core: the reference beads have a near-white inner body
	// with the dark rim wrapping it. Add one more lighter pass before the rim.
	['    # Narrow dark interface ring: only the very edge darkens.',
		`    # Bright refracted core (the reference photos show a near-white body
    # inside each drop). Offset slightly up-left, feathering into the water.
    core = Image.new("L", (size, size), 0)
    cd = ImageDraw.Draw(core)
    cx0, cy0 = pad - rx * 0.10, pad - ry * 0.12
    crx, cry = rx * 0.52, ry * 0.50
    cd.ellipse((cx0 - crx, cy0 - cry, cx0 + crx, cy0 + cry), fill=255)
    core = core.filter(ImageFilter.GaussianBlur(radius=max(1.0, r * 0.24)))
    shade = ImageChops.lighter(shade, core.point(lambda v: int(v * 0.55)))

    # Narrow dark interface ring: only the very edge darkens.`],
	// Runnels: shorter real streaks (the "wall of bars" look came from long
	// tails surviving across the whole tile).
	['length = rng.uniform(90, min(300, height * 0.7))', 'length = rng.uniform(40, min(150, height * 0.45))'],
];

let applied = 0;
for (const [from, to] of edits) {
	if (!s.includes(from)) { console.log('MISS:', from.slice(0, 46).replace(/\n/g, ' ')); continue; }
	s = s.replace(from, to);
	applied += 1;
}
fs.writeFileSync(path, s, 'utf8');
console.log('applied', applied, '/', edits.length);

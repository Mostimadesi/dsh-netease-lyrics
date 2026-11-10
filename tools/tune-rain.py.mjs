// Tune the rain generator parameters (kept as a script so the quoting is one
// form only: PowerShell chokes on the nested quotes of a -e one-liner).
import fs from 'node:fs';

const path = 'tools/make-rain-textures.py';
let s = fs.readFileSync(path, 'utf8');
const edits = [
	// Narrower, softer dark rim: the old 0.22r ring made the beads read hollow.
	['width=max(1, int(r * 0.22)))', 'width=max(1, int(r * 0.13)))'],
	['shade = ImageChops.subtract(shade, rim.point(lambda v: int(v * 0.80)))',
		'shade = ImageChops.subtract(shade, rim.point(lambda v: int(v * 0.55)))'],
	// Brighter lens body, gentler rim falloff.
	['lift = 1.28', 'lift = 1.62'],
	['fall = 1.0 - 0.35 * min(1.0, dist2)', 'fall = 1.0 - 0.22 * min(1.0, dist2)'],
	// Denser field (the user asked for adjustable density; the default is now
	// fuller and the CLI scale multiplies it).
	['(int(120 * density), 1.6, 3.6', '(int(210 * density), 1.5, 3.4'],
	['(int(34 * density), 3.6, 6.4', '(int(62 * density), 3.4, 6.2'],
	['(int(9 * density), 6.4, 12.0', '(int(16 * density), 6.2, 12.0'],
	['(120, 175)),   # mist', '(165, 215)),   # mist'],
];

let applied = 0;
for (const [from, to] of edits) {
	if (!s.includes(from)) {
		console.log('MISS:', from.slice(0, 50));
		continue;
	}
	s = s.replace(from, to);
	applied += 1;
}
fs.writeFileSync(path, s, 'utf8');
console.log('applied', applied, '/', edits.length);

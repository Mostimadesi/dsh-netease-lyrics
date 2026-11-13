// One-shot v0.4.36 edit script: restyle wave rings after the official NetEase
// effect-package parameters (white-forward translucent stroke, glow, mixed dot
// sizes via two rects per ring, subtle/vivid brightness knob). Every anchor is
// verified unique before splicing; any mismatch aborts with no write.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(repo, 'lib', 'client.js');
let src = fs.readFileSync(file, 'utf8');

function swapOnce(anchor, replacement, label) {
	const count = src.split(anchor).length - 1;
	if (count !== 1) throw new Error(`${label}: anchor found ${count}x`);
	src = src.replace(anchor, replacement);
}

// ---- 1. sanitizer: glowWaveBright (vivid opt-in, subtle default not persisted) ----
swapOnce(
	'if (raw?.glowWaveScope === "both") out.glowWaveScope = raw.glowWaveScope;',
	'if (raw?.glowWaveScope === "both") out.glowWaveScope = raw.glowWaveScope;\n\tif (raw?.glowWaveBright === "vivid") out.glowWaveBright = raw.glowWaveBright;',
	'sanitizer');

// ---- 2. render: vivid class on the halo span ----
swapOnce(
	'+ (prefs.glowWaveStyle && prefs.glowWaveScope === "both" ? " dnl-wave-both" : "")',
	'+ (prefs.glowWaveStyle && prefs.glowWaveScope === "both" ? " dnl-wave-both" : "")\n\t\t\t\t\t\t+ (prefs.glowWaveStyle && prefs.glowWaveBright === "vivid" ? " dnl-wave-vivid" : "")',
	'vivid class');

// ---- 3. render: comment refresh + two rects per ring ----
swapOnce(
	'The `wt` inner span\n\t\t\t\t\t * carries the rotating dash ring for the "wave" style so the\n\t\t\t\t\t * outer span can keep its static frame. */',
	'Each ring svg carries two\n\t\t\t\t\t * rects (r1/r2) whose differing dash patterns and widths mix dot\n\t\t\t\t\t * sizes, the way the official effect packages mix particle sizes. */',
	'render comment');
const oldRects = 'h("rect", { x: 2, y: 2, width: 96, height: 96, rx: 48, pathLength: 100 })';
if (src.split(oldRects).length - 1 !== 2) throw new Error('render rects: anchor not found twice');
const newRects = '[h("rect", { key: "r1", className: "r1", x: 2, y: 2, width: 96, height: 96, rx: 48, pathLength: 100 }), '
	+ 'h("rect", { key: "r2", className: "r2", x: 2, y: 2, width: 96, height: 96, rx: 48, pathLength: 100 })]';
src = src.split(oldRects).join(newRects);

// ---- 4. settings UI: 音波环亮度 select after the scope select ----
swapOnce(
	'[["collapsed", "仅收起态（默认）"], ["both", "收起 + 展开"]].map(([id, label]) => h("option", { key: id, value: id }, label))))\n\t\t\t\t\t: null,',
	'[["collapsed", "仅收起态（默认）"], ["both", "收起 + 展开"]].map(([id, label]) => h("option", { key: id, value: id }, label))))\n\t\t\t\t\t: null,\n'
	+ '\t\t\t\tprefs.glowWaveStyle ? h("label", { key: "glow-wave-bright", className: "dnl-set-row" }, "音波环亮度",\n'
	+ '\t\t\t\t\th("select", { "aria-label": "音波环亮度",\n'
	+ '\t\t\t\t\t\tvalue: prefs.glowWaveBright === "vivid" ? "vivid" : "subtle",\n'
	+ '\t\t\t\t\t\tonChange: (event) => saveDisplay({ ...readDisplay(), glowWaveBright: event.target.value === "subtle" ? undefined : event.target.value }) },\n'
	+ '\t\t\t\t\t\t[["subtle", "含蓄（默认）"], ["vivid", "鲜明"]].map(([id, label]) => h("option", { key: id, value: id }, label))))\n'
	+ '\t\t\t\t\t: null,',
	'settings bright select');

// ---- 5. CSS block rewrite (anchored on first/last line of the old block) ----
const cssFirst = '".dnl-halo-wave{overflow:visible}",';
const cssLast = '".dnl-halo.dnl-halo-hold.dnl-halo-wave>.w1,.dnl-halo.dnl-halo-hold.dnl-halo-wave>.w2,.dnl-halo.dnl-halo-hold.dnl-halo-wave rect{animation-play-state:paused}",';
const lines = src.split('\n');
const i0 = lines.findIndex((l) => l.trim() === cssFirst);
const i1 = lines.findIndex((l) => l.trim() === cssLast);
if (i0 < 0 || i1 < 0 || i1 - i0 !== 18) throw new Error(`css block: bounds ${i0}..${i1} unexpected`);
const newCss = [
	'".dnl-halo-wave{overflow:visible;--dnl-wave-hi:1}",',
	'".dnl-halo-wave.dnl-wave-vivid{--dnl-wave-hi:1.45}",',
	'".dnl-halo-wave>.w1,.dnl-halo-wave>.w2{position:absolute;pointer-events:none;border:none}",',
	'".dnl-halo-wave svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;display:block;filter:drop-shadow(0 0 2.5px color-mix(in srgb,var(--dnl-halo,var(--dsw-alias-brand-primary)) 55%,transparent))}",',
	'".dnl-halo-wave rect{fill:none;stroke:color-mix(in srgb,var(--dnl-halo,var(--dsw-alias-brand-primary)) 55%,#ffffff);vector-effect:non-scaling-stroke;stroke-linecap:round}",',
	'".dnl-halo-wave .r2{stroke:color-mix(in srgb,var(--dnl-halo,var(--dsw-alias-brand-primary)) 38%,#ffffff)}",',
	'".dnl-halo-wave.dnl-wave-dots>.w1{inset:-13px;opacity:calc(.72 * var(--dnl-wave-hi))}",',
	'".dnl-halo-wave.dnl-wave-dots>.w1 .r1{stroke-width:2.6;stroke-dasharray:.1 3.15;animation:dnl-wave-orbit calc(var(--dnl-glow-dur,5.6s) * 4) linear infinite}",',
	'".dnl-halo-wave.dnl-wave-dots>.w1 .r2{stroke-width:1.4;stroke-dasharray:.1 6.35;opacity:.6;animation:dnl-wave-orbit calc(var(--dnl-glow-dur,5.6s) * 5) linear infinite}",',
	'".dnl-halo-wave.dnl-wave-dots>.w2{inset:-21px;opacity:calc(.42 * var(--dnl-wave-hi))}",',
	'".dnl-halo-wave.dnl-wave-dots>.w2 .r1{stroke-width:2;stroke-dasharray:.1 5.9;animation:dnl-wave-orbit calc(var(--dnl-glow-dur,5.6s) * 7) linear infinite reverse}",',
	'".dnl-halo-wave.dnl-wave-dots>.w2 .r2{stroke-width:1.2;stroke-dasharray:.1 11.15;opacity:.55;animation:dnl-wave-orbit calc(var(--dnl-glow-dur,5.6s) * 9) linear infinite reverse}",',
	'".dnl-halo-wave.dnl-wave-stardust>.w1{inset:-13px;animation:dnl-wave-twinkle var(--dnl-glow-dur,5.6s) ease-in-out infinite}",',
	'".dnl-halo-wave.dnl-wave-stardust>.w1 .r1{stroke-width:3;stroke-dasharray:.1 4.9;animation:dnl-wave-orbit calc(var(--dnl-glow-dur,5.6s) * 5) linear infinite}",',
	'".dnl-halo-wave.dnl-wave-stardust>.w1 .r2{stroke-width:1.6;stroke-dasharray:.1 7.4;opacity:.5;animation:dnl-wave-orbit calc(var(--dnl-glow-dur,5.6s) * 6.5) linear infinite reverse}",',
	'".dnl-halo-wave.dnl-wave-stardust>.w2{inset:-22px;animation:dnl-wave-twinkle var(--dnl-glow-dur,5.6s) ease-in-out infinite;animation-delay:calc(var(--dnl-glow-dur,5.6s) * -.5)}",',
	'".dnl-halo-wave.dnl-wave-stardust>.w2 .r1{stroke-width:2.2;stroke-dasharray:.1 8.2;animation:dnl-wave-orbit calc(var(--dnl-glow-dur,5.6s) * 8) linear infinite reverse}",',
	'".dnl-halo-wave.dnl-wave-stardust>.w2 .r2{stroke-width:1.2;stroke-dasharray:.1 15.7;opacity:.55;animation:dnl-wave-orbit calc(var(--dnl-glow-dur,5.6s) * 11) linear infinite}",',
	'".dnl-halo-wave.dnl-wave-wave>.w1{inset:-11px;opacity:calc(.55 * var(--dnl-wave-hi))}",',
	'".dnl-halo-wave.dnl-wave-wave>.w1 .r1{stroke-width:1.8;stroke-dasharray:7 2.2;animation:dnl-wave-orbit calc(var(--dnl-glow-dur,5.6s) * 3) linear infinite}",',
	'".dnl-halo-wave.dnl-wave-wave>.w1 .r2{stroke-width:1;stroke-dasharray:2.2 5.6;opacity:.6;animation:dnl-wave-orbit calc(var(--dnl-glow-dur,5.6s) * 4.5) linear infinite reverse}",',
	'".dnl-halo-wave.dnl-wave-wave>.w2{inset:-19px;opacity:calc(.33 * var(--dnl-wave-hi))}",',
	'".dnl-halo-wave.dnl-wave-wave>.w2 .r1{stroke-width:1.4;stroke-dasharray:4.4 3.4;animation:dnl-wave-orbit calc(var(--dnl-glow-dur,5.6s) * 5) linear infinite reverse}",',
	'".dnl-halo-wave.dnl-wave-wave>.w2 .r2{stroke-width:.9;stroke-dasharray:1.4 8.6;opacity:.55;animation:dnl-wave-orbit calc(var(--dnl-glow-dur,5.6s) * 7) linear infinite}",',
	'"@keyframes dnl-wave-orbit{to{stroke-dashoffset:-100}}",',
	'"@keyframes dnl-wave-twinkle{0%,100%{opacity:.32;transform:scale(.97)}50%{opacity:calc(.62 * var(--dnl-wave-hi));transform:scale(1.03)}}",',
	cssLast,
];
lines.splice(i0, i1 - i0 + 1, ...newCss.map((l) => '\t\t\t' + l));
src = lines.join('\n');

fs.writeFileSync(file, src);
console.log('client.js edits applied:', i0, '..', i1, '->', newCss.length, 'css lines');

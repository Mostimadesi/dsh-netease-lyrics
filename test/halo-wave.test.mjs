// Style + render contracts for the ambient wave ornaments — v0.4.42: the
// breathing halo and the wave ring are now INDEPENDENT modules (user m07693
// #2): two sibling spans inside one positioning wrapper (.dnl-halobox). The
// wrapper carries the beat driver ref + inline CSS vars; hold parks BOTH
// modules at once. 音波环 works regardless of the 呼吸灯 mode.
//
// stardust = 宇宙尘埃 lifecycle (m07693 #1/#3): every grain is born on the
// band, drifts OUTWARD along its own radius, fades past the rim and respawns —
// constant density, zero JS. Grains NEVER orbit and never random-walk; sizes
// are uniformly small (0.6-1.2u). The whole ring's brightness (+ a hint of
// scale) pulses with the beat on the svg filter (m07693 #4 整环呼吸).
//
// dots/wave keep the fixed SHAPE = rect rings, MOTION = stroke-dashoffset.
// The ring element itself must NEVER rotate — a capsule-shaped ring turned
// 40° swings its long axis ~150px off the pill (the "下垂大U环" bug).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';

const localStore = { raw: null };
let plugin;
vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
	window: {
		__ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => ({ default: React })); } },
		addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
		matchMedia: () => ({ matches: false }), innerWidth: 1200, innerHeight: 800,
	},
	document: undefined, console, AbortController, AbortSignal,
	fetch: () => new Promise(() => {}),
	Event: class {}, localStorage: { getItem: () => localStore.raw, setItem() {} },
	setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
});

const CSS = plugin.__test.CSS;
const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

// ---- 1. wrapper + wave layer base -------------------------------------------
assert.match(CSS, /\.dnl-halobox\{position:absolute;inset:0;z-index:0;pointer-events:none\}/,
	'the positioning wrapper hosts both modules and stays click-through');
assert.match(CSS, /\.dnl-wave\{position:absolute;inset:0;overflow:visible;pointer-events:none;--dnl-wave-hi:1\}/,
	'the wave span lets the rings spill outside; default brightness factor 1');
assert.match(CSS, /\.dnl-wave\.dnl-wave-vivid\{--dnl-wave-hi:1\.45\}/,
	'vivid raises the brightness factor');
assert.match(CSS, /\.dnl-wave>\.w1,\.dnl-wave>\.w2\{position:absolute;pointer-events:none;border:none\}/,
	'w1/w2 ring boxes are border-less and positioned inside the wave span');
assert.match(CSS, /\.dnl-wave svg\{[^}]*overflow:visible[^}]*filter:drop-shadow\(0 0 3px color-mix\(in srgb,var\(--dnl-halo,var\(--dsw-alias-brand-primary\)\) 38%,transparent\)\) brightness\(calc\(1 \+ var\(--dnl-beat-gain,0\) \* var\(--dnl-beat,0\) \* \.55\)\)/,
	'the ring svg paints outside its own box and the WHOLE RING brightness pulses with the beat (m07693 #4)');
assert.match(CSS, /\.dnl-wave svg\{[^}]*transform:scale\(calc\(1 \+ var\(--dnl-beat-gain,0\) \* var\(--dnl-beat,0\) \* \.05\)\)/,
	'a hint of whole-ring scale rides the same beat (stardust no longer opts out)');
assert.match(CSS, /\.dnl-wave rect\{fill:none;stroke:color-mix\(in srgb,var\(--dnl-halo,var\(--dsw-alias-brand-primary\)\) 30%,transparent\);stroke-width:1\.2;vector-effect:non-scaling-stroke;will-change:stroke-dashoffset,stroke,opacity\}/,
	'strokes are brand-tinted against transparent (keeps width under stretching, no hard-coded white)');
assert.match(CSS, /\.dnl-wave \.r2\{stroke:color-mix\(in srgb,var\(--dnl-halo,var\(--dsw-alias-brand-primary\)\) 16%,transparent\)\}/,
	'the second rect is dimmer so the mixed-size dots read as dust, not as a fence');

// ---- 2. dots style --------------------------------------------------------------
assert.match(CSS, /\.dnl-wave\.dnl-wave-dots>\.w1\{inset:-13px;opacity:calc\(\.72 \* var\(--dnl-wave-hi\)\)\}/,
	'dots w1: ring box just outside the pill rim, brightness-scaled');
assert.match(CSS, /\.dnl-wave\.dnl-wave-dots>\.w1 \.r1\{stroke-width:2\.6;stroke-dasharray:\.1 3\.15;animation:dnl-wave-orbit calc\(var\(--dnl-glow-dur,5\.6s\) \* 4\) linear infinite\}/,
	'dots w1 r1: primary dots orbit on 4 cycles per breath');
assert.match(CSS, /\.dnl-wave\.dnl-wave-dots>\.w1 \.r2\{stroke-width:1\.4;stroke-dasharray:\.1 6\.35;opacity:\.6;animation:dnl-wave-orbit calc\(var\(--dnl-glow-dur,5\.6s\) \* 5\) linear infinite\}/,
	'dots w1 r2: smaller sparser dots ride a different period (mixed sizes)');
assert.match(CSS, /\.dnl-wave\.dnl-wave-dots>\.w2\{inset:-21px;opacity:calc\(\.42 \* var\(--dnl-wave-hi\)\)\}/,
	'dots w2: a second, fainter outer ring');
assert.match(CSS, /\.dnl-wave\.dnl-wave-dots>\.w2 \.r1\{stroke-width:2;stroke-dasharray:\.1 5\.9;animation:dnl-wave-orbit calc\(var\(--dnl-glow-dur,5\.6s\) \* 7\) linear infinite reverse\}/,
	'dots w2: primary dots counter-orbit');

// ---- 3. stardust style (v0.4.42 宇宙尘埃 lifecycle) ------------------------------
assert.match(CSS, /\.dnl-wave\.dnl-wave-stardust>\.w1\{inset:-22px;opacity:calc\(\.88 \* var\(--dnl-wave-hi\)\);animation:dnl-wave-twinkle var\(--dnl-glow-dur,5\.6s\) ease-in-out infinite\}/,
	'ONE wide band (-22px out, grains land ~10-30px outside the capsule); the band itself twinkles');
assert.doesNotMatch(CSS, /\.dnl-wave-stardust>\.w2/,
	'the two-orbit pair stays gone (user m07563: 合成一条宽带)');
assert.match(CSS, /\.dnl-wave\.dnl-wave-stardust circle\.dp\{fill:color-mix\(in srgb,var\(--dnl-halo,var\(--dsw-alias-brand-primary\)\) 35%,#ffffff\);stroke:none\}/,
	'grains fill white-forward (official 宇宙尘埃 alpha-white)');
assert.match(CSS, /\.dnl-wave\.dnl-wave-stardust>\.w1 circle\.dp\{animation:dnl-dust-life var\(--dur,9s\) linear var\(--del,0s\) infinite\}/,
	'every grain runs its own lifecycle; --dur/--del are baked per grain so density stays constant');
assert.match(CSS, /@keyframes dnl-dust-life\{0%\{transform:translate\(0,0\);opacity:var\(--peak,\.9\)\}70%\{opacity:calc\(var\(--peak,\.9\) \* \.5\)\}100%\{transform:translate\(var\(--dx,6\),var\(--dy,6\)\);opacity:0\}\}/,
	'born on the band → drift OUTWARD → fade → respawn (user m07693 #1: the official turnover)');
assert.match(CSS, /@keyframes dnl-wave-twinkle\{0%,100%\{opacity:calc\(\.34 \* var\(--dnl-wave-hi\)\)\}50%\{opacity:calc\(\.9 \* var\(--dnl-wave-hi\)\)\}\}/,
	'the twinkle is whole-band brightness breathing (vivid raises the peak)');
assert.doesNotMatch(CSS, /dnl-wave-orbit-g|className: "dg"|\.dnl-wave \.dg/,
	'grains NEVER orbit: the rotating group and its keyframes are gone');

// ---- 4. wave (dashed outline) style ----------------------------------------------
assert.match(CSS, /\.dnl-wave\.dnl-wave-wave>\.w1 \.r1\{stroke-width:1\.8;stroke-dasharray:7 2\.2;animation:dnl-wave-orbit calc\(var\(--dnl-glow-dur,5\.6s\) \* 3\) linear infinite\}/,
	'wave style draws a long-dash ring that flows on 3 cycles per breath');
assert.match(CSS, /\.dnl-wave\.dnl-wave-wave>\.w1 \.r2\{stroke-width:1;stroke-dasharray:2\.2 5\.6;opacity:\.6;animation:dnl-wave-orbit calc\(var\(--dnl-glow-dur,5\.6s\) \* 4\.5\) linear infinite reverse\}/,
	'wave w1 r2: short interleaved dashes counter-flow (ripple moiré)');
assert.match(CSS, /@keyframes dnl-wave-orbit\{to\{stroke-dashoffset:-100\}\}/,
	'the orbit keyframes walk the dashes along the path (never rotate the element)');

// ---- 5. hold / burst / scope / reduced-motion -------------------------------------
assert.match(CSS, /\.dnl-halobox\.dnl-halo-hold \.dnl-halo>span\{animation:none\}/,
	'parked playback: the breathing halo layers freeze (hold lives on the shared wrapper)');
assert.match(CSS, /\.dnl-halobox\.dnl-halo-hold \.dnl-wave>\.w1,\.dnl-halobox\.dnl-halo-hold \.dnl-wave>\.w2,\.dnl-halobox\.dnl-halo-hold \.dnl-wave \.r1,\.dnl-halobox\.dnl-halo-hold \.dnl-wave \.r2,\.dnl-halobox\.dnl-halo-hold \.dnl-wave circle\.dp\{animation-play-state:paused\}/,
	'parked playback also stills the ring boxes, dash orbits AND every grain lifecycle');
assert.doesNotMatch(CSS, /\.dnl-halo-burst>\.w1/,
	'burst no longer hides the ring — breathing lamp and wave ring are independent modules (m07693 #2)');
assert.match(CSS, /\.dnl-shell-expanded \.dnl-wave:not\(\.dnl-wave-both\)>\.w1,\.dnl-shell-expanded \.dnl-wave:not\(\.dnl-wave-both\)>\.w2\{display:none\}/,
	'rings hide in the expanded card unless scope=both');
assert.match(CSS, /\.dnl-wave>\.w1,\.dnl-wave>\.w2\{display:none\}/,
	'reduced-motion removes the rings outright');
assert.doesNotMatch(src, /className: "w3"|dnl-wave-spec/, 'the retired spec tier stays gone');

// ---- 5a. dust render wiring (v0.4.42 lifecycle field) ------------------------------
assert.match(src, /const DUST_ANGLES = \(count\) =>/, 'golden-angle spread helper');
assert.match(src, /i \* 137\.508 - 90/, 'golden-angle (sunflower) spread keeps the field organic');
assert.match(src, /const dustGrains = \(count\) =>/, 'grain factory bakes each grain\'s phase into CSS vars');
assert.match(src, /\+\(0\.6 \+ \(\(i \* 13\) % 6\) \/ 10\)\.toFixed\(2\)/,
	'uniformly small sizes 0.6-1.2u (user m07693 #3: no mixed-size grains)');
assert.match(src, /const drift = 9 \+ \(\(i \* 17\) % 5\);/, 'outward drift 9-13u past the rim');
assert.match(src, /const dur = 7 \+ \(\(i \* 11\) % 7\);/, 'independent 7-13s cycles');
assert.match(src, /const del = -\(\(\(\(i \* 23\) % 100\) \/ 100\) \* dur\);/, 'negative delays desync respawns');
assert.match(src, /\+\(0\.55 \+ \(\(i \* 29\) % 4\) \* 0\.1\)\.toFixed\(2\)/, 'per-grain brightness ceiling');
assert.match(src, /"--dur": dur \+ "s"|"--del": del\.toFixed\(2\) \+ "s"|"--dx": String/,
	'phase/vector vars ship in inline style (CSS animates, zero JS)');
assert.match(src, /dustGrains\(prefs\.glowDustDensity === "dense" \? 300 : 150\)/,
	'two density tiers ship together (user m07563)');
assert.doesNotMatch(src, /DUST_BAND_MIX|querySelectorAll\("circle\.dp"\)|dustNodes/,
	'the per-grain JS random-walk data path is retired (m07693 #4: CSS lifecycle + whole-ring pulse)');

// ---- 5b. band driver (shared --dnl-b0..9 data layer) ---------------------------------
assert.match(src, /Math\.pow\(bandRaw\[i\], 1\.5\)/,
	'bands read fftpow-1.5 shaped targets (vision.json fftpow:1.5)');
assert.match(src, /setProperty\("--dnl-b" \+ i, bands\[i\] < 0\.004 \? "0" : bands\[i\]\.toFixed\(3\)\)/,
	'the driver publishes one --dnl-bN variable per band (kill-threshold shared with --dnl-beat)');
assert.match(src, /const bandAudio = beatSource === "audio" && playing && miss < 3 && audioLive && lastTickAt > 0 && now - lastTickAt < 2000;/,
	'the audio lane only drives bands on fresh ticks (stale helper → quiet field, never frozen grains)');
assert.match(src, /const bandTarget = beatSource === "audio" \? \(bandAudio \? Math\.pow\(bandRaw\[i\], 1\.5\) : 0\) : cur;/,
	'lyric lane drives all ten bands uniformly from the grid (cur) like NCM dust on a vocal line');
assert.match(src, /\}, \[beatSource, beatKey, st\?\.playing\]\);/,
	'the driver effect restarts only on source/song/playing changes (the walk-state deps are gone)');

// ---- 6. render wiring --------------------------------------------------------------
assert.match(src, /\(glowMode === "notice" \? noticeRowShown : !noticeMode\)\) \|\| prefs\.glowWaveStyle\)/,
	'the wrapper appears when EITHER module is on (breathing lamp OR wave ring — independent, m07693 #2)');
assert.match(src, /className: "dnl-halobox"\s*\+\s*\(st\.playing === true \|\| glowMode === "notice" \? "" : " dnl-halo-hold"\)/,
	'hold parks BOTH modules: the class lives on the shared wrapper');
assert.match(src, /className: "dnl-wave dnl-wave-" \+ prefs\.glowWaveStyle/,
	'the wave sibling picks its style class with no glowMode gate');
assert.match(src, /prefs\.glowWaveScope === "both" \? " dnl-wave-both" : ""/,
	'the both-scope class applies only when both is picked');
assert.match(src, /prefs\.glowWaveBright === "vivid" \? " dnl-wave-vivid" : ""/,
	'the vivid class applies only when vivid is picked');
assert.doesNotMatch(src, /dnl-halo-wave/,
	'the fused halo+wave class is gone (siblings inside .dnl-halobox now)');
assert.match(src, /h\("rect", \{ key: "r1", className: "r1", x: 2, y: 2, width: 96, height: 96, rx: 48, pathLength: 100 \}\)/,
	'dots/wave ring svgs still render the r1 rect (pathLength=100)');
assert.match(src, /h\("rect", \{ key: "r2", className: "r2", x: 2, y: 2, width: 96, height: 96, rx: 48, pathLength: 100 \}\)/,
	'dots/wave ring svgs still render the r2 rect (mixed dot sizes)');
assert.doesNotMatch(src, /className: "wt"/,
	'the rotated .wt span stays gone (rotating a capsule ring was the U-shape bug)');

// ---- 7. settings UI ------------------------------------------------------------------
assert.match(src, /h\("h3", \{ key: "grp-glow", className: "dnl-set-group" \}, "呼吸灯"\)/,
	'the 呼吸灯 group header exists');
assert.match(src, /h\("h3", \{ key: "grp-wave", className: "dnl-set-group" \}, "音频环"\)/,
	'the 音频环 group header exists (a separate module, m07693 #2)');
assert.doesNotMatch(src, /prefs\.glow === "theme" \|\| prefs\.glow === "cover" \|\| prefs\.glow === undefined \? h\("label", \{ key: "glow-wave"/,
	'the wave-ring select is no longer gated on the breathing lamp mode');
assert.match(CSS, /\.dnl-set-group\{display:flex;flex-direction:column/,
	'group header styling exists');
assert.match(src, /"aria-label": "音波环样式"/, 'the style select exists');
assert.match(src, /\["dots", "点阵环"\]/, 'dots offered');
assert.match(src, /\["stardust", "星尘环（音频律动）"\]/, 'stardust offered as the audio-reactive face');
assert.match(src, /\["wave", "波形描边"\]/, 'wave offered');
assert.doesNotMatch(src, /\["spec", /, 'the spec bar option stays removed');
assert.match(src, /"aria-label": "尘埃密度"/, 'the dust density select exists (stardust-only)');
assert.match(src, /\["normal", "标准（150 颗，默认）"\]/, 'normal tier = 150 grains');
assert.match(src, /\["dense", "极密（300 颗）"\]/, 'dense tier = 300 grains');
assert.match(src, /glowDustDensity: event\.target\.value === "normal" \? undefined : event\.target\.value/,
	'normal is the unpersisted default');
assert.match(src, /"aria-label": "音波环范围"/, 'the scope select exists');
assert.match(src, /\["both", "收起 \+ 展开"\]/, 'the both scope offered');
assert.match(src, /"aria-label": "音波环亮度"/, 'the brightness select exists');
assert.match(src, /\["subtle", "含蓄（默认）"\]/, 'subtle offered as default');
assert.match(src, /\["vivid", "鲜明"\]/, 'vivid offered');

// ---- 8. sanitizer whitelist -----------------------------------------------------------
assert.match(src, /raw\?\.glowWaveStyle === "dots" \|\| raw\?\.glowWaveStyle === "stardust" \|\| raw\?\.glowWaveStyle === "wave"\) out\.glowWaveStyle = raw\.glowWaveStyle;/,
	'glowWaveStyle is whitelisted to dots/stardust/wave');
assert.match(src, /raw\?\.glowWaveScope === "both"\) out\.glowWaveScope = raw\.glowWaveScope;/,
	'glowWaveScope is whitelisted to both');
assert.match(src, /raw\?\.glowWaveBright === "vivid"\) out\.glowWaveBright = raw\.glowWaveBright;/,
	'glowWaveBright is whitelisted to vivid (subtle is the unpersisted default)');
assert.match(src, /raw\?\.glowDustDensity === "dense"\) out\.glowDustDensity = raw\.glowDustDensity;/,
	'glowDustDensity is whitelisted to dense (normal is the unpersisted default)');

// ---- 9. functional round-trip through readDisplay --------------------------------------
localStore.raw = JSON.stringify({ glowWaveStyle: 'stardust', glowWaveScope: 'both', glowWaveBright: 'vivid', glowDustDensity: 'dense' });
let disp = plugin.__test.readDisplay();
assert.equal(disp.glowWaveStyle, 'stardust', 'stardust round-trips');
assert.equal(disp.glowWaveScope, 'both', 'both scope round-trips');
assert.equal(disp.glowWaveBright, 'vivid', 'vivid brightness round-trips');
assert.equal(disp.glowDustDensity, 'dense', 'dense tier round-trips');
localStore.raw = JSON.stringify({ glowWaveStyle: 'spec', glowWaveScope: 'wide', glowWaveBright: 'blinding', glowDustDensity: 'ultra' });
disp = plugin.__test.readDisplay();
assert.equal(disp.glowWaveStyle, undefined, 'the retired spec value is dropped');
assert.equal(disp.glowWaveScope, undefined, 'unknown scope values are dropped');
assert.equal(disp.glowWaveBright, undefined, 'unknown brightness values are dropped');
assert.equal(disp.glowDustDensity, undefined, 'unknown density values are dropped');
localStore.raw = null;
disp = plugin.__test.readDisplay();
assert.equal(disp.glowWaveBright, undefined, 'absent brightness falls through to subtle');

console.log('halo-wave contract: PASS (v0.4.42 independent modules: .dnl-halobox wrapper, breathing halo + wave ring siblings; stardust = 宇宙尘埃 CSS lifecycle — outward drift, fade, respawn, zero JS; whole-ring beat pulse on svg; dots/wave dash chains; hold parks both; settings groups 呼吸灯/音频环)');

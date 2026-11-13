// Style + render contracts for the ambient wave ornaments.
//
// v0.4.43 宇宙尘埃 rework (user m08159 → m08199 方案 D): the dust field is DOM
// particles, NOT SVG circles. The old build rode `viewBox="0 0 100 100"` with
// `preserveAspectRatio="none"` inside a 484×82 box — 4.84× horizontal scale
// against 0.82× vertical, i.e. a 5.9:1 stretch that turned every round grain
// into a horizontal bar. That was the real reason the effect never matched the
// official one, and no parameter tuning could ever fix it. Particles now use
// `offset-path: rect(0 100% 100% 0 round 999px)` on a -22px inset box: the
// basic shape clamps `round` to half the box height, so the path is the exact
// concentric capsule at any width, with arc-length parameterised spacing.
// Material is a radial-gradient core plus `mix-blend-mode: plus-lighter`, so
// overlaps accumulate light — the additive behaviour of the official WebGL
// particle field (the 解包 files give parameters and rules, never the pipeline).
//
// The breathing halo and the wave ring remain INDEPENDENT sibling modules
// inside one `.dnl-halobox` wrapper (v0.4.42, user m07693 #2): the wrapper
// carries the beat driver ref and the inline CSS vars, and one hold class parks
// both. dots keeps its rect-ring dash chain; 波形描边 (wave) was retired in
// v0.4.43 per user m08199 #5 (点阵环 parked, 星尘环 fixed first).
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
	'w1/w2 boxes are border-less and positioned inside the wave span');
assert.match(CSS, /\.dnl-wave svg\{[^}]*overflow:visible[^}]*filter:drop-shadow\(0 0 3px color-mix\(in srgb,var\(--dnl-halo,var\(--dsw-alias-brand-primary\)\) 38%,transparent\)\) brightness\(calc\(1 \+ var\(--dnl-beat-gain,0\) \* var\(--dnl-beat,0\) \* \.55\)\)/,
	'the ring svg paints outside its own box and the WHOLE RING brightness pulses with the beat (m07693 #4)');
assert.match(CSS, /\.dnl-wave svg\{[^}]*transform:scale\(calc\(1 \+ var\(--dnl-beat-gain,0\) \* var\(--dnl-beat,0\) \* \.05\)\)/,
	'a hint of whole-ring scale rides the same beat');
assert.match(CSS, /\.dnl-wave rect\{fill:none;stroke:color-mix\(in srgb,var\(--dnl-halo,var\(--dsw-alias-brand-primary\)\) 30%,transparent\);stroke-width:1\.2;vector-effect:non-scaling-stroke;will-change:stroke-dashoffset,stroke,opacity\}/,
	'strokes are brand-tinted against transparent (keeps width under stretching, no hard-coded white)');
assert.match(CSS, /\.dnl-wave \.r2\{stroke:color-mix\(in srgb,var\(--dnl-halo,var\(--dsw-alias-brand-primary\)\) 16%,transparent\)\}/,
	'the second rect is dimmer so the mixed-size dots read as dust, not as a fence');

// ---- 2. dots style (the only surviving rect-ring face) ------------------------
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
assert.match(CSS, /@keyframes dnl-wave-orbit\{to\{stroke-dashoffset:-100\}\}/,
	'the orbit keyframes walk the dashes along the path (never rotate the element)');

// ---- 3. stardust: DOM offset-path particles (v0.4.43 方案 D) -------------------
assert.match(CSS, /\.dnl-wave\.dnl-wave-stardust>\.w1\{inset:-4px;isolation:isolate;opacity:calc\(\.86 \* var\(--dnl-wave-hi\)\);animation:dnl-wave-twinkle var\(--dnl-glow-dur,5\.6s\) ease-in-out infinite\}/,
	'ONE tight band (-4px out), and it carries NO filter (v0.4.45: a pulsing filter over N running grain animations re-rasters the whole chain)');
assert.doesNotMatch(CSS, /var\(--dnl-wave-hi\)\);filter:brightness/,
	'the grain group must never take a beat-driven filter again (probe: 33.1 ms/frame at 300 grains)');
assert.match(CSS, /\.dnl-dustpulse\{[^}]*opacity:calc\(\.34 \+ var\(--dnl-beat-gain,0\) \* var\(--dnl-beat,0\) \* \.66\)/,
	'the beat breathing lives on a CHILDLESS sibling layer instead (m08645 #2/#3)');
assert.doesNotMatch(CSS, /\.dnl-wave-stardust>\.w2/,
	'the two-orbit pair stays gone (user m07563: 合成一条宽带)');
// The geometric contract that fixes the 6:1 squash:
assert.match(CSS, /\.dnl-wave \.dnl-dust\{position:absolute;inset:0;offset-path:inset\(0 4px round 999px\);offset-distance:var\(--at,0%\);offset-rotate:0deg;offset-anchor:center;animation:dnl-dust-life var\(--dur,9s\) linear var\(--del,0s\) infinite\}/,
	'the grain element FILLS the band and carries the path; offset-path resolves against the element\'s own border box, so a dot-sized element collapsed the whole ring onto one point (v0.4.43 bug; probe found 60/60 grains within 0.01px, 42px outside the pill)');
assert.match(CSS, /\.dnl-wave \.dnl-dust::after\{content:'';position:absolute;left:50%;top:50%;width:var\(--sz,3px\);height:var\(--sz,3px\);translate:-50% -50%;border-radius:50%;mix-blend-mode:plus-lighter;/,
	'the visible dot is a centred ::after, so it lands exactly on the path anchor and overlaps accumulate light');
assert.match(CSS, /\.dnl-wave\.dnl-hug-slight>\.w1\{inset:-3px\}/,
	'the plain-outset hug mode survives as the user-requested fallback (m08390: 先做略微外扩作为一种设置选项供用户回退)');
assert.match(CSS, /\.dnl-wave\.dnl-hug-slight \.dnl-dust\{offset-path:inset\(0 round 999px\)\}/,
	'fallback mode drops the end pinch and rides the band edge');
assert.match(CSS, /\.dnl-wave \.dnl-dust::after\{[^}]*background:radial-gradient\(circle,rgba\(255,255,255,\.95\) 0%,color-mix\(in srgb,var\(--dnl-halo,var\(--dsw-alias-brand-primary\)\) 42%,#d8e4ff\) 32%,color-mix\(in srgb,var\(--dnl-halo,var\(--dsw-alias-brand-primary\)\) 26%,transparent\) 64%,transparent 100%\)/,
	'a feathered radial core (bright centre → transparent rim) instead of a hard-edged solid disc');
assert.match(CSS, /\.dnl-wave \.dnl-dust\{[^}]*animation:dnl-dust-life var\(--dur,9s\) linear var\(--del,0s\) infinite\}/,
	'every grain runs its own lifecycle; --dur/--del are baked per grain so density stays constant');
assert.match(CSS, /@keyframes dnl-dust-life\{0%\{translate:0 0;opacity:calc\(var\(--peak,\.9\) \* var\(--dnl-dust-glow,1\)\)\}70%\{opacity:calc\(var\(--peak,\.9\) \* var\(--dnl-dust-glow,1\) \* \.55\)\}100%\{translate:calc\(var\(--dx,6px\) \* \(1 \+ var\(--dnl-beat-slow,0\) \* var\(--dnl-beat-gain,0\)\)\) calc\(var\(--dy,6px\) \* \(1 \+ var\(--dnl-beat-slow,0\) \* var\(--dnl-beat-gain,0\)\)\);opacity:0\}\}/,
	'born on the band → drift OUTWARD → fade → respawn; the outward distance swells with the SLOW beat lane (m08390 #2, v0.4.45 detune)');
assert.match(CSS, /@keyframes dnl-wave-twinkle\{0%,100%\{opacity:calc\(\.74 \* var\(--dnl-wave-hi\)\)\}50%\{opacity:calc\(\.92 \* var\(--dnl-wave-hi\)\)\}\}/,
	'the twinkle survives only as weak background noise (m08390 #4: 保留但压弱), so the beat pulse reads as the main motion');
assert.doesNotMatch(CSS, /dnl-wave-orbit-g|\.dnl-wave \.dg|class="dp"/,
	'grains never orbit and are no longer svg circles');
assert.doesNotMatch(CSS, /dnl-wave-wave>|dnl-wave\.dnl-wave-wave/,
	'波形描边 CSS retired (user m08199 #5: 移除波形描边)');

// ---- 4. hold / burst / scope / reduced-motion -------------------------------------
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

// ---- 5. dust render wiring (DOM particles) -----------------------------------------
assert.match(src, /const DUST_SIZE_PX = \{ fine: \[1\.5, 3\], medium: \[2\.5, 4\.5\] \};/,
	'two size tiers ship (user m08205 #1: 1 和 2 都做，设置里可调)');
assert.match(src, /const DUST_COUNT = \(np\) =>/, 'the count helper exists');
assert.match(src, /return np\.glowDustDensity === "dense" \? 300 : 150;/,
	'legacy dense/normal prefs still resolve when no explicit count is saved');
assert.match(src, /const dustGrains = \(count, sizeTier\) =>/, 'the grain factory takes a size tier');
assert.match(src, /h\("i", \{\n\s+key: "d" \+ i,\n\s+className: "dnl-dust",/,
	'grains render as DOM <i class="dnl-dust">, not svg circles');
assert.match(src, /const at = \(i \/ count\) \* 100;/,
	'offset-distance is arc-length parameterised, so equal steps are equally spaced around the capsule');
assert.doesNotMatch(src, /cx: \+\(50 \+ r \* Math\.cos/,
	'the SVG centre-coordinate math is gone (that was the squashed geometry)');
assert.doesNotMatch(src, /preserveAspectRatio: "none", "aria-hidden": "true" \}, dustGrains/,
	'the dust field no longer rides a non-uniformly scaled viewBox');
assert.match(src, /dustGrains\(DUST_COUNT\(prefs\), prefs\.glowDustSize === "fine" \? "fine" : "medium"\)/,
	'the render branch feeds count + size tier');
assert.match(src, /"--sz": px\.toFixed\(2\) \+ "px"/, 'each grain carries its own diameter');

// ---- 6. band driver (shared --dnl-b0..9 data layer) ---------------------------------
assert.match(src, /Math\.pow\(bandRaw\[i\], 1\.5\)/,
	'bands read fftpow-1.5 shaped targets (vision.json fftpow:1.5)');
assert.match(src, /setProperty\("--dnl-b" \+ i, bands\[i\] < 0\.004 \? "0" : bands\[i\]\.toFixed\(3\)\)/,
	'the driver publishes one --dnl-bN variable per band');
assert.match(src, /const bandAudio = beatSource === "audio" && playing && miss < 3 && audioLive && lastTickAt > 0 && now - lastTickAt < 2000;/,
	'the audio lane only drives bands on fresh ticks (stale helper → quiet field)');
assert.match(src, /const bandTarget = beatSource === "audio" \? \(bandAudio \? Math\.pow\(bandRaw\[i\], 1\.5\) : 0\) : cur;/,
	'lyric lane drives all ten bands uniformly from the grid');
assert.match(src, /\}, \[beatSource, beatKey, st\?\.playing\]\);/,
	'the driver effect restarts only on source/song/playing changes');

// ---- 7. render wiring --------------------------------------------------------------
assert.match(src, /\(glowMode === "notice" \? noticeRowShown : !noticeMode\)\) \|\| prefs\.glowWaveStyle\)/,
	'the wrapper appears when EITHER module is on');
assert.match(src, /className: "dnl-halobox"\s*\+\s*\(st\.playing === true \|\| glowMode === "notice" \? "" : " dnl-halo-hold"\)/,
	'hold parks BOTH modules: the class lives on the shared wrapper');
assert.match(src, /style: prefs\.glowWaveStyle === "stardust" \? \{ "--dnl-dust-glow": String\(\(Number\.isFinite\(prefs\.glowDustGlow\) \? prefs\.glowDustGlow : 100\) \/ 100\) \} : null,/,
	'the brightness slider ships as an inline var on the grain container');
assert.match(src, /className: "dnl-wave dnl-wave-" \+ prefs\.glowWaveStyle/,
	'the wave sibling picks its style class with no glowMode gate');
assert.match(src, /prefs\.glowWaveScope === "both" \? " dnl-wave-both" : ""/,
	'the both-scope class applies only when both is picked');
assert.match(src, /prefs\.glowWaveBright === "vivid" \? " dnl-wave-vivid" : ""/,
	'the vivid class applies only when vivid is picked');
assert.doesNotMatch(src, /dnl-halo-wave/,
	'the fused halo+wave class is gone (siblings inside .dnl-halobox now)');
assert.match(src, /h\("rect", \{ key: "r1", className: "r1", x: 2, y: 2, width: 96, height: 96, rx: 48, pathLength: 100 \}\)/,
	'dots still renders its r1 rect (pathLength=100)');
assert.doesNotMatch(src, /className: "wt"/,
	'the rotated .wt span stays gone (rotating a capsule ring was the U-shape bug)');

// ---- 8. settings UI ------------------------------------------------------------------
assert.match(src, /h\("h3", \{ key: "grp-glow", className: "dnl-set-group" \}, "呼吸灯"\)/,
	'the 呼吸灯 group header exists');
assert.match(src, /h\("h3", \{ key: "grp-wave", className: "dnl-set-group" \}, "音频环"\)/,
	'the 音频环 group header exists (a separate module, m07693 #2)');
assert.doesNotMatch(src, /prefs\.glow === "theme" \|\| prefs\.glow === "cover" \|\| prefs\.glow === undefined \? h\("label", \{ key: "glow-wave"/,
	'the wave-ring select is no longer gated on the breathing lamp mode');
assert.match(CSS, /\.dnl-set-group\{display:flex;flex-direction:column/, 'group header styling exists');
assert.match(src, /"aria-label": "音波环样式"/, 'the style select exists');
assert.match(src, /\["dots", "点阵环"\]/, 'dots still offered');
assert.match(src, /\["stardust", "星尘环（宇宙尘埃）"\]/, 'stardust is offered under its official name');
assert.doesNotMatch(src, /\["wave", "波形描边"\]/, '波形描边 is no longer offered (user m08199 #5)');
assert.match(src, /"aria-label": "尘埃数量"/, 'the density slider exists (user m08205 #4)');
assert.match(src, /type: "range", min: 60, max: 300, step: 20, "aria-label": "尘埃数量"/,
	'the count slider spans 60-300');
assert.match(src, /"aria-label": "尘埃粒径"/, 'the size tier select exists (user m08205 #1)');
assert.match(src, /\["fine", "细碎 1\.5-3px"\], \["medium", "适中 2\.5-4\.5px（默认）"\]/,
	'both size tiers are selectable, medium default');
assert.match(src, /"aria-label": "尘埃亮度"/, 'the glow slider exists (user m08205 #3)');
assert.match(src, /type: "range", min: 0, max: 200, step: 5, "aria-label": "尘埃亮度"/,
	'the glow slider spans 0-200');
assert.match(src, /"恢复尘埃默认参数"/, 'a reset button ships with the three knobs');
assert.match(src, /"aria-label": "音波环范围"/, 'the scope select exists');
assert.match(src, /\["both", "收起 \+ 展开"\]/, 'the both scope offered');
assert.match(src, /"aria-label": "音波环亮度"/, 'the brightness select exists');
assert.match(src, /\["vivid", "鲜明"\]/, 'vivid offered');

// ---- 9. sanitizer whitelist -----------------------------------------------------------
assert.match(src, /raw\?\.glowWaveStyle === "dots" \|\| raw\?\.glowWaveStyle === "stardust"\) out\.glowWaveStyle = raw\.glowWaveStyle;/,
	'glowWaveStyle is whitelisted to dots/stardust (wave retired)');
assert.match(src, /if \(Number\.isFinite\(raw\?\.glowDustCount\)\) out\.glowDustCount = Math\.min\(300, Math\.max\(60, Math\.round\(raw\.glowDustCount\)\)\);/,
	'the count clamps to 60-300');
assert.match(src, /if \(raw\?\.glowDustSize === "fine" \|\| raw\?\.glowDustSize === "medium"\) out\.glowDustSize = raw\.glowDustSize;/,
	'the size tier is whitelisted');
assert.match(src, /if \(Number\.isFinite\(raw\?\.glowDustGlow\)\) out\.glowDustGlow = Math\.min\(200, Math\.max\(0, Math\.round\(raw\.glowDustGlow\)\)\);/,
	'the glow clamps to 0-200');
assert.match(src, /raw\?\.glowWaveScope === "both"\) out\.glowWaveScope = raw\.glowWaveScope;/,
	'glowWaveScope is whitelisted to both');
assert.match(src, /raw\?\.glowWaveBright === "vivid"\) out\.glowWaveBright = raw\.glowWaveBright;/,
	'glowWaveBright is whitelisted to vivid');

// ---- 10. functional round-trip through readDisplay --------------------------------------
localStore.raw = JSON.stringify({ glowWaveStyle: 'stardust', glowWaveScope: 'both', glowWaveBright: 'vivid', glowDustCount: 220, glowDustSize: 'fine', glowDustGlow: 140 });
let disp = plugin.__test.readDisplay();
assert.equal(disp.glowWaveStyle, 'stardust', 'stardust round-trips');
assert.equal(disp.glowWaveScope, 'both', 'both scope round-trips');
assert.equal(disp.glowWaveBright, 'vivid', 'vivid brightness round-trips');
assert.equal(disp.glowDustCount, 220, 'the dust count round-trips');
assert.equal(disp.glowDustSize, 'fine', 'the size tier round-trips');
assert.equal(disp.glowDustGlow, 140, 'the glow level round-trips');
localStore.raw = JSON.stringify({ glowWaveStyle: 'wave', glowDustCount: 900, glowDustSize: 'huge', glowDustGlow: 900 });
disp = plugin.__test.readDisplay();
assert.equal(disp.glowWaveStyle, undefined, 'the retired wave value is dropped');
assert.equal(disp.glowDustCount, 300, 'an oversized count clamps down to 300');
assert.equal(disp.glowDustSize, undefined, 'an unknown size tier is dropped');
assert.equal(disp.glowDustGlow, 200, 'an oversized glow clamps down to 200');
localStore.raw = JSON.stringify({ glowDustCount: 10, glowDustGlow: -50 });
disp = plugin.__test.readDisplay();
assert.equal(disp.glowDustCount, 60, 'an undersized count clamps up to 60');
assert.equal(disp.glowDustGlow, 0, 'a negative glow clamps to 0');

console.log('halo-wave contract: PASS (v0.4.43 宇宙尘埃 = DOM offset-path particles on the true capsule outline — round grains that can never be squashed; radial feather + plus-lighter additive blending; count/size/glow knobs; 波形描边 retired, 点阵环 kept; breathing halo and wave ring stay independent siblings in .dnl-halobox; hold parks both; reduced-motion)');

// Generate a phase-frozen preview of the rainv2 preset on a DARK glass pane.
// Per the decor lessons: judge water on the real background (deep navy glass),
// never on a white viewer. Animations are frozen via paused + negative delay.
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';

let plugin;
vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
	window: {
		__ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => ({ default: React })); } },
		addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
		matchMedia: () => ({ matches: false }), innerWidth: 1200, innerHeight: 800,
	},
	document: undefined, console, AbortController, AbortSignal,
	fetch: () => new Promise(() => {}),
	Event: class {}, localStorage: { getItem: () => null, setItem() {} },
	setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
});
const CSS = plugin.__test.CSS;
const v2Start = CSS.indexOf('.dnl-decor-rainv2{--dnl-rv2-pace');
const v2 = CSS.slice(v2Start, CSS.indexOf('.dnl-decor-petalsv2{'));

const spans = ['s1', 's2', 's3', 'b1', 'b2', 'b3', 'b4', 'b5', 'sl1', 'sl2']
	.map((k) => `<span class="dnl-decor-streak ${k}"></span>`).join('')
	// drops need dnl-decor-drop class
	.replaceAll('dnl-decor-streak b', 'dnl-decor-drop b').replaceAll('dnl-decor-streak sl', 'dnl-decor-drop sl');

// phase A: beads hanging (cycle ~40%), sl1 just before departure (50%), sl2 fading out
// phase B: sl1 mid-slide (~65% -> visible trail), beads hanging
const freeze = (sel, delays) => Object.entries(delays)
	.map(([cls, d]) => `${sel} .${cls}{animation-delay:${d}s !important;animation-play-state:paused !important}`).join('\n');

const freezeCommon = { b1: -4.4, b2: -5.2, b3: -4.8, b4: -5.6, b5: -4.2, s1: -0.9, s2: -1.7, s3: -0.4 };
const panelA = freeze('.panelA', { ...freezeCommon, sl1: -6.5, sl2: -12.0 });
const panelB = freeze('.panelB', { ...freezeCommon, sl1: -8.45, sl2: -12.0 });
// trails share the slider's clock
const trails = ['.panelA .sl1::after{animation-delay:-6.5s !important;animation-play-state:paused !important}',
	'.panelA .sl2::after{animation-delay:-12s !important;animation-play-state:paused !important}',
	'.panelB .sl1::after{animation-delay:-8.45s !important;animation-play-state:paused !important}',
	'.panelB .sl2::after{animation-delay:-12s !important;animation-play-state:paused !important}'].join('\n');

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#070b14;font-family:system-ui;padding:28px}
.cap{width:640px;margin:0 auto 26px}
.cap h3{color:#8fa3c8;font:12px/1.4 system-ui;margin:0 0 8px;letter-spacing:.12em}
.pane{position:relative;height:150px;border-radius:20px;overflow:hidden;
	background:linear-gradient(160deg,rgba(23,33,58,.85),rgba(10,16,32,.9));
border:1px solid rgba(120,150,220,.22);
box-shadow:0 8px 26px rgba(2,6,18,.55),inset 0 0 22px rgba(130,160,255,.06)}
.pane .dnl-decor{position:absolute;inset:0}
.txt{position:absolute;inset:0;display:grid;place-items:center;color:#e8eefc;font:15px/1.6 system-ui;opacity:.85}
${'.dnl-decor span{position:absolute;display:block}'}
${v2}
${panelA}
${panelB}
${trails}
</style></head><body>
<div class="cap"><h3>PHASE A — 凝结悬挂（水珠成型静止，sl2 正在淡出）</h3>
<div class="pane panelA"><div class="dnl-decor dnl-decor-rainv2">${spans}</div><div class="txt">雨后玻璃 · 预设预览</div></div></div>
<div class="cap"><h3>PHASE B — 下滑中段（sl1 正在短距下滑，身后是分段残痕）</h3>
<div class="pane panelB"><div class="dnl-decor dnl-decor-rainv2">${spans}</div><div class="txt">雨后玻璃 · 预设预览</div></div></div>
</body></html>`;

fs.writeFileSync(process.argv[2], html, 'utf8');
console.log('written', process.argv[2], html.length, 'bytes');

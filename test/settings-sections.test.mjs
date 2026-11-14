// Settings-sections contract (v0.4.50, user m12299 #0 + m12681 #0).
//
// The capsule settings panel used to be one flat 330-line list: the decor
// picker was buried inside the capsule-style block, and every parameter of
// every skin/decor sat open at once. m12299 asked for two things:
//   - 装饰层 out of 样式, as its own area;
//   - every area collapsible.
// m12681 then trimmed the first cut from nine areas back to six:
//   - 外观 + 胶囊样式 merge;
//   - 文字 + 位置 + 歌词偏移 · 本曲 merge;
//   - 皮肤参数 moves above 装饰层 (right after the style picker it drives)
//     and is renamed 样式参数, because it never was about the skin alone.
//
// Guards: the SEC marker helper, the groupSections splitter, the section list
// and order, decor's independence from the style block, and the <details> CSS.
import assert from 'node:assert/strict';
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
const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const CSS = plugin.__test.CSS;

// ---- 1. the two helpers exist ----------------------------------------------
assert.match(src, /const SEC = \(title, open\) => \(\{ __sec: title, open: open !== false \}\);/,
	'SEC marks a section boundary in the otherwise flat settings array');
assert.match(src, /function groupSections\(flat\)/, 'groupSections turns the flat array into sections');
assert.match(src, /return groupSections\(flat\);/, 'capsuleSettings returns grouped sections, not a flat list');

// ---- 2. every section is a real <details> that can collapse ----------------
assert.match(src, /h\("details", \{\s*key: "sec" \+ i,\s*className: "dnl-set-sec",\s*open: s\.open,\s*"data-sec": s\.title,/,
	'sections render as <details>, so they expand/collapse natively');
assert.match(src, /h\("summary", \{ className: "dnl-set-sum" \}, s\.title\)/,
	'each section has a <summary> header you can click');
assert.match(src, /h\("div", \{ className: "dnl-set-body" \}, s\.body\.flat\(\)\.filter\(Boolean\)\)/,
	'each section body is a div');

// ---- 3. six areas, in reading order (m12681 collapsed the first cut) -------
const sections = [...src.matchAll(/SEC\("([^"]+)"/g)].map((m) => m[1]);
assert.deepEqual(sections,
	['外观', '样式参数', '装饰层', '呼吸灯', '音频环', '文字与位置'],
	'the panel is six areas: look, per-skin knobs, decor, halo, wave, text+position');
assert.ok(!sections.includes('胶囊样式'),
	'胶囊样式 merged into 外观 — the style picker is part of the look, not a sibling of it');
assert.ok(!sections.includes('皮肤参数'), '皮肤参数 was renamed to 样式参数');
assert.ok(!sections.includes('位置'), '位置 merged into 文字与位置');
assert.ok(!sections.includes('歌词偏移 · 本曲'),
	'the per-track offset merged into 文字与位置; its own heading still renders inside the group');

// ---- 4. 装饰层 no longer lives inside the style block ----------------------
const styleAt = src.indexOf('SEC("外观"');
const skinParamsAt = src.indexOf('SEC("样式参数"');
const decorAt = src.indexOf('SEC("装饰层"');
assert.ok(skinParamsAt > styleAt, '样式参数 comes after the style picker that drives it');
assert.ok(decorAt > skinParamsAt, '装饰层 follows 样式参数, so decor sits on top of a configured capsule');
assert.match(src, /SEC\("装饰层"\),/,
	'装饰层 defaults to open — it is the area people come here for, and it used to be invisible');
assert.match(src, /SEC\("外观"\),/,
	'外观 defaults to open — panel opacity and the colour fields are the everyday knobs');

// ---- 5. the merged groups really hold the merged blocks --------------------
const capsuleSelectAt = src.indexOf('"capsule-style"');
const opacityAt = src.indexOf('"panel-opacity"');
assert.ok(capsuleSelectAt > 0 && opacityAt > 0, 'both merged halves still exist');
assert.ok(capsuleSelectAt > styleAt && capsuleSelectAt < skinParamsAt,
	'the capsule-style select sits inside 外观');
const fontAt = src.indexOf('key: "font"');
const resetPosAt = src.indexOf('key: "reset-position"');
const offsetAt = src.indexOf('key: "offset-block"');
const textSecAt = src.indexOf('SEC("文字与位置"');
assert.ok(Math.min(fontAt, resetPosAt, offsetAt) > textSecAt,
	'font, position reset and per-track offset all live inside 文字与位置');
assert.ok(fontAt < resetPosAt && resetPosAt < offsetAt,
	'they keep their reading order: font, then position, then this track\'s offset');

// ---- 6. decor is reachable even when the skin cannot host it ---------------
assert.match(src, /DECOR_GLASS\.has\(SKIN_IDS\.has\(prefs\.capsuleStyle\) \? prefs\.capsuleStyle : "default"\)/,
	'the decor control still knows which skins can host a decor layer');
assert.match(src, /当前皮肤不承载装饰层/,
	'a skin without decor support explains itself instead of silently dropping the whole area');

// ---- 7. the collapsible chrome is styled ----------------------------------
assert.match(CSS, /\.dnl-set-sec\{border:[^}]*border-radius:8px/,
	'sections are visually separated cards');
assert.match(CSS, /\.dnl-set-sum\{cursor:pointer;list-style:none/, 'the summary is a click target with no marker');
assert.match(CSS, /\.dnl-set-sum::-webkit-details-marker\{display:none\}/, 'the default marker is suppressed');
assert.match(CSS, /\.dnl-set-sum::before\{content:"▸"/, 'a custom collapsed arrow is drawn');
assert.match(CSS, /\.dnl-set-sec\[open\]>\.dnl-set-sum::before\{content:"▾"\}/,
	'the arrow flips when the section is open');
assert.match(CSS, /\.dnl-set-body\{display:flex;flex-direction:column/, 'section bodies stack their rows');

// ---- 8. groupSections is resilient ---------------------------------------
// Bodies may contain arrays (the petals/rain blocks are arrays), null (guarded
// blocks), and false — the splitter must flatten and drop the empties.
assert.match(src, /s\.body\.flat\(\)\.filter\(Boolean\)/,
	'bodies flatten nested arrays and drop null/false guards, otherwise React warns on keys');

console.log('ok — six collapsible settings areas (v0.4.50 contract)');

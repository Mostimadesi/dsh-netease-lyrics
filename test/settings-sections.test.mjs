// Settings-sections contract (v0.4.48, user m12299 #0).
//
// The capsule settings panel used to be one flat 330-line list: the decor
// picker was buried inside the capsule-style block, and every parameter of
// every skin/decor sat open at once. m12299 asked for two things:
//   - 装饰层 out of 样式, as its own area;
//   - every area collapsible.
//
// Guards: the SEC marker helper, the groupSections splitter, the section list
// and order, decor's independence from the skin block, and the <details> CSS.
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

// ---- 3. the expected areas, in reading order -------------------------------
const sections = [...src.matchAll(/SEC\("([^"]+)"/g)].map((m) => m[1]);
const expected = ['外观', '胶囊样式', '装饰层', '皮肤参数', '呼吸灯', '音频环', '文字', '位置', '歌词偏移 · 本曲'];
assert.deepEqual(sections.slice(0, expected.length), expected,
	'every settings area is its own section, in the order the user reads them');
assert.ok(sections.length >= expected.length, 'no area was lost in the split');

// ---- 4. 装饰层 no longer lives inside 胶囊样式 ------------------------------
const styleAt = src.indexOf('SEC("胶囊样式"');
const decorAt = src.indexOf('SEC("装饰层"');
const skinParamsAt = src.indexOf('SEC("皮肤参数"');
assert.ok(decorAt > styleAt, '装饰层 comes after 胶囊样式, so it is a sibling section and not nested inside it');
assert.ok(skinParamsAt > decorAt, '皮肤参数 follows 装饰层');
assert.match(src, /SEC\("装饰层"\),/,
	'装饰层 defaults to open — it is the area people come here for, and it used to be invisible');

// ---- 5. decor is reachable even when the skin cannot host it ---------------
assert.match(src, /DECOR_GLASS\.has\(SKIN_IDS\.has\(prefs\.capsuleStyle\) \? prefs\.capsuleStyle : "default"\)/,
	'the decor control still knows which skins can host a decor layer');
assert.match(src, /当前皮肤不承载装饰层/,
	'a skin without decor support explains itself instead of silently dropping the whole area');

// ---- 6. the collapsible chrome is styled ----------------------------------
assert.match(CSS, /\.dnl-set-sec\{border:[^}]*border-radius:8px/,
	'sections are visually separated cards');
assert.match(CSS, /\.dnl-set-sum\{cursor:pointer;list-style:none/, 'the summary is a click target with no marker');
assert.match(CSS, /\.dnl-set-sum::-webkit-details-marker\{display:none\}/, 'the default marker is suppressed');
assert.match(CSS, /\.dnl-set-sum::before\{content:"▸"/, 'a custom collapsed arrow is drawn');
assert.match(CSS, /\.dnl-set-sec\[open\]>\.dnl-set-sum::before\{content:"▾"\}/,
	'the arrow flips when the section is open');
assert.match(CSS, /\.dnl-set-body\{display:flex;flex-direction:column/, 'section bodies stack their rows');

// ---- 7. groupSections is resilient ----------------------------------------
// Bodies may contain arrays (the petals/rain blocks are arrays), null (guarded
// blocks), and false — the splitter must flatten and drop the empties.
assert.match(src, /s\.body\.flat\(\)\.filter\(Boolean\)/,
	'bodies flatten nested arrays and drop null/false guards, otherwise React warns on keys');

console.log('ok — settings are split into collapsible areas (v0.4.48 contract)');

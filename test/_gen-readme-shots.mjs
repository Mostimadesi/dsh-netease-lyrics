// README screenshots: renders the real capsule / panel / ambient lyrics with
// the stylesheet that ships in lib/client.js, so the images match the live UI
// (same class names, same CSS, same tokens). Output is one HTML per shot; take
// it with headless Chrome at the size printed by `--list`.
//
// Usage: node _gen-readme-shots.mjs <outDir> [name ...]
//   node _gen-readme-shots.mjs ../../.shots
//   node _gen-readme-shots.mjs ../../.shots hero ambient
import fs from 'node:fs';
import path from 'node:path';
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

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const nbsp = '\u00a0';

/* ---------- lyrics: the real lines the plugin served for this track ---------- */
const LINES = [
	['ゆってみて？', '你倒是说句话呀？'],
	['Love', 'Love'],
	['Fall in Love', 'Fall in Love'],
	['Should be Love Love Love', 'Should be Love Love Love'],
	['ほら運命すら踊り出し駆け堕ちる', '快看  就连命运本身也开始翩然起舞  疾驰堕落'],
	['とってもとってもハッピーエンドなの！', '真的真的是幸福结局呢！'],
	['世界には、それ以外は要らないの⋯！', '对世界来说的话、除了这个之外任何东西都不需要了⋯！'],
	['「ハッピーエンド」はこれからです！', '“幸福结局”现在才刚刚开始！'],
	['まだメリーバッドエンド、でいいですよ', '暂时保持好坏参半的结局  就可以啦'],
];
const ACTIVE = 5;
const TITLE = 'HaPpyEnD (feat. 巡音ルカ)';
const ARTIST = 'nogi / 巡音ルカ';
const MATCH = '网易云音乐 · 匹配：HaPpyEnD (feat. 巡音ルカ) — nogi / 巡音ルカ';

/* ---------- shared chrome ---------- */
const TONES = `
--dsw-alias-bg-layer-1:#1b1f2a;
--dsw-alias-bg-layer-2:#232838;
--dsw-alias-bg-overlay:#141821;
--dsw-alias-border-l1:rgba(255,255,255,.10);
--dsw-alias-border-l2:rgba(255,255,255,.18);
--dsw-alias-brand-primary:#7c8cff;
--dsw-alias-label-primary:#eef0f7;
--dsw-alias-label-secondary:#a4abbd;
--dsw-alias-label-tertiary:#79808f;
--dsw-alias-state-error-primary:#ff7b7b;
--dsw-alias-state-success-primary:#68d391;`;

// Freeze every animation on a chosen phase so a still frame is reproducible.
const FREEZE = `
.dnl-halo>span,.dnl-halo-wave rect,.dnl-halo-wave>.w1,.dnl-halo-wave>.w2,
.dnla-line,.dnla-ch,.dnl-decor span{animation-play-state:paused !important}
.dnl-halo>.h1{animation-delay:-2.1s !important}
.dnl-halo>.h2{animation-delay:-2.4s !important}
.dnl-halo>.h3{animation-delay:-2.7s !important}
.dnl-halo>.h4{animation-delay:-2.55s !important}
.dnl-halo-wave rect{animation-delay:-1.6s !important}
.dnl-halo-wave>.w1{animation-delay:-1.4s !important}
.dnl-halo-wave>.w2{animation-delay:-4.2s !important}
.dnla-ch{opacity:1 !important;transform:none !important}`;

const fonts = `font-family:"Segoe UI","Yu Gothic UI","Microsoft YaHei UI",system-ui,sans-serif`;

const page = ({ w, h, body, tone = '#0d1017', extra = '' }) => `<!doctype html><meta charset="utf-8">
<style>
html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;${fonts}}
body{background:${tone};${TONES}}
}
${FREEZE}
${extra}
</style>
<style>${CSS}</style>
${body}`;

/* ---------- wallpaper: a stand-in for the desktop behind the capsule ---------- */
const wallpaper = (w, h) => `
<div style="position:fixed;inset:0;background:
  radial-gradient(1100px 620px at 22% 12%, #2b3a5e 0%, transparent 62%),
  radial-gradient(900px 520px at 86% 84%, #3a2b52 0%, transparent 60%),
  linear-gradient(155deg,#10131c 0%,#0a0c12 55%,#0d1017 100%)"></div>
<div style="position:fixed;inset:0;background:radial-gradient(120% 90% at 50% 40%,transparent 40%,rgba(0,0,0,.55) 100%)"></div>`;

/* ---------- capsule parts ---------- */
const ringSvg = '<svg viewBox="0 0 100 100" preserveAspectRatio="none"><rect class="r1" x="2" y="2" width="96" height="96" rx="48" pathLength="100"></rect><rect class="r2" x="2" y="2" width="96" height="96" rx="48" pathLength="100"></rect></svg>';
// The wave rings live INSIDE .dnl-halo — `.dnl-halo-wave > .w1{inset:-13px}` only
// reaches them there, and `.dnl-halo > span{position:absolute}` does the positioning.
const wave = `<span class="w1">${ringSvg}</span><span class="w2">${ringSvg}</span>`;

const halo = (cls, dur = '5.6s') => `
<span class="dnl-halo ${cls}" style="--dnl-glow-dur:${dur};--dnl-glow-amp:1;--dnl-beat-gain:100;--dnl-halo:#8f9bff" aria-hidden="true">
	<span class="h1"></span><span class="h2"></span><span class="h3"></span><span class="h4"></span>${wave}
</span>`;

const nowRow = (text, trans) => `
<div class="dnl-crossfade"><div class="dnl-fade-layer">
	<div class="dnl-now">
		<span class="dnl-now-text">${esc(text)}</span>
		<span class="dnl-now-trans">${esc(trans)}</span>
	</div>
</div></div>`;

const collapsedBody = (text, trans) => `<div class="dnl-now-wrap">${nowRow(text, trans)}</div>`;

const lyricRows = () => LINES.map(([text, trans], i) => {
	const active = i === ACTIVE;
	return `<div class="dnl-line${active ? ' dnl-line-active' : ''}">
		<div class="dnl-line-main">${esc(text)}</div>
		<div class="dnl-line-trans">${esc(trans)}</div>
	</div>`;
}).join('');

const panelBody = (coverSrc) => `
<div class="dnl-panel-body">
	<div class="dnl-head">
		<img class="dnl-cover" src="${coverSrc}" alt="">
		<div class="dnl-head-text">
			<div class="dnl-title">${esc(TITLE)}</div>
			<div class="dnl-artist">${esc(ARTIST)}</div>
			<div class="dnl-match">${esc(MATCH)}<button class="dnl-btn dnl-btn-quiet" type="button">匹配结果</button></div>
		</div>
	</div>
	<div class="dnl-lines">${lyricRows()}</div>
	<div class="dnl-progress">
		<span class="dnl-time">0:46</span>
		<div class="dnl-bar"><div class="dnl-bar-fill" style="width:28.1%"></div></div>
		<span class="dnl-time">2:45</span>
	</div>
	<div class="dnl-controls">
		<button class="dnl-ctl dnl-ctl-sm" type="button">−5s</button>
		<button class="dnl-ctl" type="button">⏮</button>
		<button class="dnl-ctl dnl-ctl-main" type="button">▶</button>
		<button class="dnl-ctl" type="button">⏭</button>
		<button class="dnl-ctl dnl-ctl-sm" type="button">+5s</button>
	</div>
</div>`;

const gear = `<button class="dnl-gear" type="button">⚙</button>`;

const expandedBody = (coverSrc) => `
<div class="dnl-grow"><div class="dnl-grow-inner"><div class="dnl-panel">
	${gear}
	${panelBody(coverSrc)}
</div></div></div>`;

/* ---------- shots ---------- */
const shotHero = () => page({
	w: 900, h: 260,
	body: `${wallpaper(900, 260)}
<div class="dnl-host" style="position:absolute;top:78px;left:50%;transform:translateX(-50%)">
	<div class="dnl-shell">
		${halo('dnl-halo-wave dnl-wave-stardust')}
		<div class="dnl-island">
			<button class="dnl-drag" type="button">⠿</button>
			${collapsedBody(LINES[ACTIVE][0], LINES[ACTIVE][1])}
		</div>
	</div>
</div>`,
});

const shotExpanded = (coverSrc) => page({
	w: 1440, h: 760,
	body: `${wallpaper(1440, 760)}
<div class="dnl-host" style="position:absolute;top:78px;left:50%;transform:translateX(-50%)">
	<div class="dnl-shell dnl-shell-expanded">
		${halo('dnl-halo-wave dnl-wave-stardust')}
		<div class="dnl-island dnl-expanded">
			<button class="dnl-drag" type="button">⠿</button>
			${collapsedBody(LINES[ACTIVE][0], LINES[ACTIVE][1])}
			${expandedBody(coverSrc)}
		</div>
	</div>
</div>
<script>
addEventListener('load',()=>{
	const box=document.querySelector('.dnl-lines'), row=document.querySelector('.dnl-line-active');
	if(box&&row) box.scrollTop = row.offsetTop - box.clientHeight/2 + row.offsetHeight/2;
});
</script>`,
});

// Ambient floating lyrics: three lines at the placements the layout picks
// (side bands, ±12°), each character visible (the live build fades them in
// per frame, which a still frame has to fake).
const ambientLine = (text, trans, x, y, rot) => `
<div class="dnla-line" style="left:${x}%;top:${y}%;--dnla-rot:${rot}deg">
	<div class="dnla-line-main">${[...text].map(c => `<span class="dnla-ch">${esc(c)}</span>`).join('')}</div>
	<div class="dnla-line-trans">${[...trans].map(c => `<span class="dnla-ch">${esc(c)}</span>`).join('')}</div>
</div>`;

const shotAmbient = () => page({
	w: 1440, h: 700,
	body: `${wallpaper(1440, 700)}
<div class="dnla-layer" style="--dnla-color:#eef0f7;--dnla-glow:#8f9bff;--dnla-trans-color:#a4abbd;--dnla-size:22px">
	${ambientLine('とってもとっても', '真的真的是', 19, 32, -9)}
	${ambientLine('ハッピーエンドなの！', '幸福结局呢！', 81, 56, 7)}
	${ambientLine('「ハッピーエンド」は', '“幸福结局”', 22, 74, -5)}
</div>`,
});

const SKINS = [
	['默认（毛玻璃圆角）', '', '#8f9bff'],
	['渐变玻璃', 'dnl-style-frosted', '#8f9bff'],
	['静谧祝愿', 'dnl-style-wishes', '#a89aff'],
	['暗夜余烬', 'dnl-style-ember', '#ff8c42'],
	['方舟观测', 'dnl-style-arknights', '#ff8a00'],
	['月相引路', 'dnl-style-persona', '#7fb8ff'],
];
const shotSkins = () => page({
	w: 1440, h: 760,
	extra: '.dnl-cell{position:relative;width:620px;height:210px;display:flex;align-items:center;justify-content:center}'
		+ '.dnl-cell .dnl-host{position:static !important;transform:none !important}'
		+ '.dnl-grid{display:grid;grid-template-columns:1fr 1fr;gap:0;padding:40px 60px}'
		+ '.dnl-cap{position:absolute;left:0;bottom:6px;color:#79808f;font:400 12px/1 "Segoe UI","Microsoft YaHei UI",sans-serif;letter-spacing:.02em}',
	body: `${wallpaper(1440, 760)}
<div class="dnl-grid">
	${SKINS.map(([label, cls, tint]) => `<div class="dnl-cell">
		<div class="dnl-host">
			<div class="dnl-shell">
				${halo('dnl-halo-wave dnl-wave-stardust')}
				<div class="dnl-island ${cls}">
					<button class="dnl-drag" type="button">⠿</button>
					${collapsedBody(LINES[ACTIVE][0], LINES[ACTIVE][1])}
				</div>
			</div>
		</div>
		<div class="dnl-cap">${label}</div>
	</div>`).join('')}
</div>`,
});

const SHOTS = {
	hero: { file: 'capsule-collapsed.html', size: [900, 260], make: shotHero },
	expanded: { file: 'capsule-expanded.html', size: [1440, 760], make: null },
	ambient: { file: 'ambient-lyrics.html', size: [1440, 700], make: shotAmbient },
	skins: { file: 'capsules-skins.html', size: [1440, 760], make: shotSkins },
};

const outDir = process.argv[2];
if (!outDir) {
	console.error('usage: node _gen-readme-shots.mjs <outDir> [name ...]\nshots: ' + Object.keys(SHOTS).join(' '));
	process.exit(2);
}
const only = process.argv.slice(3);
const names = only.length > 0 ? only : Object.keys(SHOTS);
const coverSrc = process.env.DNL_COVER
	? 'file:///' + process.env.DNL_COVER.replace(/\\/g, '/')
	: 'cover.png';

fs.mkdirSync(outDir, { recursive: true });
for (const name of names) {
	const shot = SHOTS[name];
	if (!shot) { console.error('unknown shot: ' + name); process.exit(2); }
	const html = name === 'expanded' ? shotExpanded(coverSrc) : shot.make();
	fs.writeFileSync(path.join(outDir, shot.file), html);
	console.log(name + '\t' + shot.file + '\t' + shot.size.join('x'));
}

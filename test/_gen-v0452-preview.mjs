import fs from "node:fs";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import React from "react";

/* v0.4.52 preview: the same 300-grain field at beat peak, before and after.
 *
 * Painted on a REALISTIC capsule — 150x84, taken off the user's own screenshot —
 * because every earlier probe used a 440x38 pill and that 11.6:1 shape hid the
 * defect: a 5-9px leg thrown along a golden-angle bearing is a fifth of a squat
 * capsule's height and reads as a thread hanging off it, while on a wide pill
 * the same leg looks like normal dust thickness.
 *
 * Usage: node test/_gen-v0452-preview.mjs <out.html> [rev] [count]
 */

function load(rev) {
	let plugin;
	const src = rev
		? execFileSync("git", ["cat-file", "blob", rev + ":lib/client.js"], {
			cwd: new URL("..", import.meta.url), maxBuffer: 1 << 28,
		}).toString("utf8")
		: fs.readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
	vm.runInNewContext(src, {
		window: {
			__ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => ({ default: React })); } },
			addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
			matchMedia: () => ({ matches: false }), innerWidth: 1400, innerHeight: 1200,
		},
		document: undefined, console, AbortController, AbortSignal,
		fetch: () => new Promise(() => {}),
		Event: class {}, localStorage: { getItem: () => null, setItem() {} },
		setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
	});
	return plugin;
}

function toHtml(el) {
	if (!el || el === false) return "";
	if (typeof el === "string" || typeof el === "number") return String(el);
	if (Array.isArray(el)) return el.map(toHtml).join("");
	const { className, style } = el.props || {};
	return `<i class="${className}" style="${Object.entries(style).map(([k, v]) => k + ":" + v).join(";")}"></i>`;
}

const out = process.argv[2] || "test/_preview-v0452.html";
const rev = process.argv[3] || "HEAD";
const N = Number(process.argv[4] || 300);
const CW = 150;
const CH = 84;

const cols = [
	{ id: "before", tag: `${rev.split(" ")[0]} · 节拍峰值 200%`, plugin: load(rev) },
	{ id: "after", tag: "v0.4.52 · 节拍峰值 200%", plugin: load() },
];

const cells = cols.map((c) => {
	const { CSS, dustGrains, DUST_SPREAD } = c.plugin.__test;
	const spread = DUST_SPREAD({ glowDustSpread: 45 });
	return `
<div class="cell">
  <div class="tag">${c.tag}</div>
  <div class="stage">
    <span class="dnl-wave dnl-wave-stardust dnl-wave-both" style="--dnl-beat:1;--dnl-beat-slow:1;--dnl-beat-gain:2;--dnl-dust-glow:1">
      <span class="w1">${toHtml(dustGrains(N, "medium", spread))}</span><span class="dnl-dustpulse"></span>
    </span>
    <div class="guide"></div>
  </div>
  <style>${CSS}</style>
</div>`;
}).join("");

const html = `<!doctype html><meta charset="utf-8">
<style>
:root{--dsw-alias-brand-primary:#8b7cff;--dsw-alias-label-secondary:#b9c2d8;--dnl-wave-hi:1;--dnl-halo:#8b7cff}
body{margin:0;background:#0b0d14;color:#9fb0c8;font:12px system-ui;display:flex;gap:28px;padding:26px 20px 20px}
.cell{display:flex;flex-direction:column;gap:0}
.tag{height:16px;line-height:16px;text-align:center;opacity:.85}
.stage{position:relative;width:${CW}px;height:${CH}px;margin:64px auto;border-radius:999px;
  background:rgba(28,34,48,.78);box-shadow:inset 0 0 0 .5px rgba(255,255,255,.10)}
.guide{position:absolute;inset:0;border-radius:999px;outline:1px dashed rgba(255,0,255,.45);z-index:3;pointer-events:none}
.dnl-wave .dnl-dust,.dnl-wave .dnl-dust.dnl-dust-live{animation-play-state:paused!important;animation-delay:calc(var(--del,0s) - 3.05s)!important}
</style>
${cells}`;

fs.writeFileSync(out, html, "utf8");
console.log(`wrote ${out} (${rev} vs worktree, ${N} grains, capsule ${CW}x${CH})`);

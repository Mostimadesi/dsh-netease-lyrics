import fs from "node:fs";
import vm from "node:vm";
import React from "react";

/* v0.4.51 preview: 300 grains, bright glass on a dark field, 2x.
 * A = v0.4.50 geometry (constant 2.5-4.5px dots) → saturated band, clumps at the
 *     right cap.
 * B = v0.4.51 (constant ink + static translate on parked grains) → dust again.
 */

let plugin;
vm.runInNewContext(fs.readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"), {
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

const { CSS, dustGrains, DUST_SPREAD, DUST_INK_SCALE } = plugin.__test;
const spread = DUST_SPREAD({ glowDustSpread: 45 });

function toHtml(el, legacy) {
	if (!el || el === false) return "";
	if (typeof el === "string" || typeof el === "number") return String(el);
	if (Array.isArray(el)) return el.map((c) => toHtml(c, legacy)).join("");
	const { className, style } = el.props || {};
	const s = Object.assign({}, style);
	if (legacy) {
		s["--sz"] = (parseFloat(s["--sz"]) / DUST_INK_SCALE(300)).toFixed(2) + "px";
		delete s.translate;
	}
	return `<i class="${className}" style="${Object.entries(s).map(([k, v]) => k + ":" + v).join(";")}"></i>`;
}

const cell = (label, html) => `
  <div class="col">
    <div class="head">${label}</div>
    <div class="clip"><div class="stage">
      <span class="dnl-wave dnl-wave-stardust dnl-wave-both" style="--dnl-beat:0;--dnl-beat-gain:0;--dnl-dust-glow:1">
        <span class="w1">${html}</span><span class="dnl-dustpulse"></span>
      </span>
      <div class="dnl-island"></div>
    </div></div>
  </div>`;

const html = `<!doctype html><meta charset="utf-8">
<style>
:root{--dsw-alias-brand-primary:#8b7cff;--dsw-alias-label-secondary:#b9c2d8;--dnl-wave-hi:1;--dnl-halo:#8b7cff}
body{margin:0;background:linear-gradient(140deg,#101a2e,#05080e 60%,#1a1226);
  color:#e6ebf5;font:12px/1.5 "Segoe UI",system-ui,sans-serif;padding:16px 18px}
.title{font-size:13px;font-weight:600;margin-bottom:10px;color:#dfe6f5}
.row{display:flex;gap:16px}
.head{font-size:10px;color:#93a0b8;margin-bottom:4px}
.clip{width:496px;height:126px;overflow:hidden;position:relative}
.stage{position:absolute;left:8px;top:16px;width:440px;height:38px;transform:scale(1.06);transform-origin:0 0}
.dnl-island{position:absolute;inset:0;border-radius:999px;background:rgba(20,28,44,.72);
  border:.5px solid rgba(255,255,255,.14);z-index:1}
${CSS}
.dnl-wave .dnl-dust,.dnl-wave .dnl-dust.dnl-dust-live{animation-play-state:paused!important;animation-delay:calc(var(--del,0s) - 3.1s)!important}
</style>
<div class="title">星尘环 · 300 颗 · 环带 45%</div>
<div class="row">
${cell("v0.4.50 · 点径恒定 → 环带饱和，右端成团", toHtml(dustGrains(300, "medium", spread), true))}
${cell("v0.4.51 · 墨量恒定 → 更细的尘，无成团", toHtml(dustGrains(300, "medium", spread), false))}
</div>`;

const out = process.argv[2] || "test/_preview-v0451.html";
fs.writeFileSync(out, html, "utf8");
console.log("wrote " + out);

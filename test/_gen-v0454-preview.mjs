import fs from "node:fs";
import vm from "node:vm";
import React from "react";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/* Side-by-side: HEAD (v0.4.52) vs the working copy (v0.4.54).
 *
 * Capsule 132x78 — the size the user actually measured off their screenshot
 * (wider capsules hid the defect for three releases). Three band widths each.
 * Grains are frozen at the same phase in both panes so the only difference is
 * the path expression. */
const root = fileURLToPath(new URL("../", import.meta.url));

function load(src) {
	let plugin;
	vm.runInNewContext(src, {
		window: {
			__ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => ({ default: React })); } },
			addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
			matchMedia: () => ({ matches: false }), innerWidth: 1400, innerHeight: 1200,
		},
		document: undefined, console, AbortController, AbortSignal,
		fetch: () => new Promise(() => {}),
		Event: class {}, localStorage: { getItem: () => null, setItem() {} },
		setTimeout: () => 0, clearTimeout() {}, setInterval() {}, clearInterval() {},
	});
	return plugin.__test;
}

function toHtml(el) {
	if (!el || el === false) return "";
	if (typeof el === "string" || typeof el === "number") return String(el);
	if (Array.isArray(el)) return el.map(toHtml).join("");
	const { className, style } = el.props || {};
	const css = Object.entries(style || {}).map(([k, v]) => `${k}:${v}`).join(";");
	return `<i class="${className}" style="${css}"></i>`;
}

const headSrc = execSync("git cat-file blob HEAD:lib/client.js", { cwd: root, maxBuffer: 1 << 27 }).toString("utf8");
const nowSrc = fs.readFileSync(root + "lib/client.js", "utf8");
const HEADT = load(headSrc);
const NOWT = load(nowSrc);

const W = 132, H = 78, N = 240;
const PCTS = [0, 45, 100];

function pane(T, label, pct) {
	const spread = T.DUST_SPREAD({ glowDustSpread: pct });
	return `<div class="pane" style="--capW:${W}px;--capH:${H}px">
  <div class="tag">${label} · 环带 ${pct}%</div>
  <div class="shell">
    <span class="dnl-halobox" style="--dnl-glow-dur:4s;--dnl-glow-amp:1;--dnl-beat-gain:2;--dnl-beat:0.7;--dnl-beat-slow:0.6">
      <span class="dnl-wave dnl-wave-stardust dnl-wave-both" style="--dnl-wave-hi:1;--dnl-dust-glow:1;--dnl-halo:#8b7cff">
        <span class="w1">${toHtml(T.dustGrains(N, "medium", spread))}</span>
      </span>
    </span>
    <div class="island"></div>
  </div>
</div>`;
}

const rows = PCTS.map((p) => `<div class="row">${pane(HEADT, "HEAD (v0.4.52)", p)}${pane(NOWT, "v0.4.54", p)}</div>`).join("\n");

const html = `<!doctype html><meta charset="utf-8">
<style>
:root{--dsw-alias-brand-primary:#8b7cff;--dsw-alias-bg-overlay:#1a2030;--dsw-alias-label-secondary:#b9c2d8;--dsw-alias-border-l1:rgba(255,255,255,.14)}
body{margin:0;background:#08090e;font:12px/1.3 system-ui;color:#9fb0c8;padding:14px}
.row{display:flex;gap:26px;margin-bottom:14px}
.pane{position:relative}
.tag{height:17px;text-align:center;color:#8fa3bd}
.shell{position:relative;width:var(--capW);height:var(--capH);margin:26px 14px}
.island{position:absolute;inset:0;border-radius:999px;z-index:1;
  background:rgba(26,32,48,.42);border:.5px solid rgba(255,255,255,.10);
  outline:1px dashed rgba(255,0,255,.75)}
${NOWT.CSS}
.w1{position:relative;z-index:2}
.dnl-dust,.dnl-dust.dnl-dust-live{animation-play-state:paused!important;
  animation-delay:calc(var(--del,0s) - 3.05s)!important}
</style>
${rows}
</pre>`;

const dir = fileURLToPath(new URL("./_prev/", import.meta.url));
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(dir + "v0453.html", html, "utf8");

const out = fileURLToPath(new URL("./_prev/v0453.png", import.meta.url));
try { fs.unlinkSync(out); } catch { /* fresh */ }

const port = 9960 + Math.floor(Math.random() * 35);
const chrome = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", [
	"--headless=new", "--disable-gpu", "--hide-scrollbars",
	"--force-device-scale-factor=2", "--window-size=520,560",
	"--remote-debugging-port=" + port,
	"--user-data-dir=" + dir + "u" + Date.now(),
	"--screenshot=" + out,
	"file:///" + dir.replace(/\\/g, "/") + "v0453.html",
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
	for (let i = 0; i < 40; i++) {
		await sleep(250);
		if (fs.existsSync(out) && fs.statSync(out).size > 5000) break;
	}
	console.log(fs.existsSync(out) ? "shot " + fs.statSync(out).size + " bytes" : "SCREENSHOT MISSING");
} finally {
	chrome.kill();
	try { execSync("taskkill /PID " + chrome.pid + " /T /F", { stdio: "ignore" }); } catch { /* gone */ }
}

import fs from "node:fs";
import vm from "node:vm";
import React from "react";

/* Renders the REAL collapsible settings chrome (v0.4.50) with representative
 * rows, so the six areas and their open/closed state can be reviewed without
 * opening the app. Uses __test.CSS verbatim and __test.groupSections verbatim —
 * if the helper changes shape, this preview breaks loudly instead of drifting. */

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

const { SEC, groupSections, CSS } = plugin.__test;

const h = (type, props, ...kids) => React.createElement(type, props, ...kids);

/* One representative control per kind, so each area looks like the real thing. */
const row = (label, control) => h("div", { className: "dnl-set-row", key: label },
	h("span", null, label), control);
const range = (v, min, max) => h("input", { type: "range", min, max, defaultValue: v, disabled: true });
const sel = (opts, i) => h("select", { defaultValue: opts[i], disabled: true }, opts.map((o) => h("option", { key: o }, o)));
const note = (t) => h("p", { className: "dnl-set-note", key: t }, t);

const flat = [
	SEC("外观"),
	row("面板不透明度", range(72, 0, 100)),
	row("装饰颜色", range(60, 0, 100)),
	note("玻璃类皮肤把胶囊底色做成半透明，装饰层就画在这层之上。"),

	SEC("样式参数", false),
	row("玻璃颗粒", range(30, 0, 100)),
	row("玻璃着色", range(35, 0, 100)),
	note("这里的参数属于胶囊本身的外观，与落在上面的装饰层无关。"),

	SEC("装饰层"),
	row("装饰层", sel(["关闭", "雨痕水珠", "雨后玻璃（可调参数）", "樱吹雪（可调参数）", "光点浮尘"], 2)),
	row("贴边方式", sel(["中间外扩 · 两端环绕（默认）", "整体略微外扩"], 0)),
	row("环带厚度", range(45, 0, 100)),
	row("尘埃数量", range(180, 60, 300)),
	row("粒径", sel(["细碎 1.5–3px", "适中 2.5–4.5px"], 1)),
	row("尘埃亮度", range(100, 0, 200)),
	note("装饰层与胶囊样式分开：换皮肤不会重置装饰参数。"),

	SEC("呼吸灯", false),
	row("呼吸灯", sel(["跟随主题", "关闭", "仅通知到达时"], 0)),
	row("律动强度", range(100, 0, 200)),

	SEC("音频环", false),
	row("音频环", sel(["关闭（默认）", "点阵环", "星尘环（宇宙尘埃）"], 2)),
	row("律动源", sel(["歌词节拍", "FFT 音频", "关闭"], 0)),

	SEC("文字与位置", false),
	row("字号", range(14, 10, 22)),
	row("横向位置", range(50, 0, 100)),
];

const tree = groupSections(flat);

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* Serialise real React elements (this repo has no react-dom/server). */
function toHtml(el) {
	if (el === null || el === undefined || el === false || el === true) return "";
	if (typeof el === "string" || typeof el === "number") return esc(el);
	if (Array.isArray(el)) return el.map(toHtml).join("");
	const p = el.props || {};
	const name = el.type;
	const attrs = [];
	if (p.className) attrs.push(`class="${esc(p.className)}"`);
	if (p["data-sec"]) attrs.push(`data-sec="${esc(p["data-sec"])}"`);
	if (name === "details" && p.open) attrs.push("open");
	if (p.defaultValue !== undefined) attrs.push(`value="${esc(p.defaultValue)}"`);
	if (p.type && name === "input") attrs.push(`type="${esc(p.type)}"`);
	if (p.min !== undefined) attrs.push(`min="${esc(p.min)}"`);
	if (p.max !== undefined) attrs.push(`max="${esc(p.max)}"`);
	if (name === "input" && p.disabled) attrs.push("disabled");
	if (name === "select" && p.disabled) attrs.push("disabled");
	const kids = el.props.children;
	/* A serialised <select> has no live defaultValue, so the browser would show
	 * the first option — mark the intended one or the preview lies about the
	 * current setting. */
	if (name === "select" && kids) {
		const list = Array.isArray(kids) ? kids : [kids];
		const body = list.map((o) => {
			const op = o.props || {};
			const hit = op.children === p.defaultValue ? " selected" : "";
			return `<option${hit}>${esc(op.children)}</option>`;
		}).join("");
		return `<select${attrs.length ? " " + attrs.join(" ") : ""}>${body}</select>`;
	}
	return `<${name}${attrs.length ? " " + attrs.join(" ") : ""}>${kids === undefined ? "" : toHtml(kids)}</${name}>`;
}

const html = `<!doctype html><meta charset="utf-8">
<title>capsule settings · six collapsible areas (v0.4.50)</title>
<style>
body{margin:0;background:#0b0f17;color:#e8ecf6;font:13px/1.55 "Segoe UI",system-ui,sans-serif;padding:26px 30px}
h1{margin:0 0 3px;font-size:15px;font-weight:600}
.sub{margin:0 0 18px;color:#8d97ad;font-size:11px}
.panel{width:392px;background:color-mix(in srgb,#1a2130 88%,#000);border:.5px solid rgba(255,255,255,.09);
  border-radius:12px;padding:10px 12px}
${CSS}
/* the preview is inert: no hover affordances that would imply interactivity */
.dnl-set-sec{pointer-events:none}
.dnl-set-row{font-size:11px}
.dnl-set-row>span:first-child{min-width:74px}
.dnl-set-row input[type=range]{width:112px;accent-color:#8b7cff}
.dnl-set-row select{max-width:186px}
</style>
<h1>胶囊设置 · 6 个可折叠区</h1>
<p class="sub">v0.4.50 · 外观 / 样式参数 / 装饰层 / 呼吸灯 / 音频环 / 文字与位置 · 样式参数在装饰层之前</p>
<div class="panel">${toHtml(tree)}</div>
`;

const out = process.argv[2] || "test/_settings-v0450.html";
fs.writeFileSync(out, html, "utf8");
console.log("wrote " + out);

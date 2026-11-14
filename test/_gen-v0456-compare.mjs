// Render one panel from a given client.js so HEAD and the worktree can be
// compared at the REAL capsule shape (132x78 — the 440x38 shape used by three
// earlier probe rounds is why they measured nothing).
//
// Override CSS MUST come after the plugin CSS: `.dnl-shell{position:relative}`
// is the same specificity and the later rule wins. Put the overrides first and
// the stage column blows the ring open, which already produced fake numbers once.
//
// HTML is built by concatenation, not a nested template literal — a nested `${}`
// with object literals inside raised "Missing } in template expression".
//
// Usage: node test/_gen-v0456-compare.mjs <client.js> <out.html> [count] [spread0-100] [beat0-2]
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import React from "react";

const [srcPath, outPath, countArg, spreadArg, beatArg, phaseArg] = process.argv.slice(2);
const count = Number(countArg || 300);
const spread = Number(spreadArg || 0) / 100;
const beat = Number(beatArg || 0);
// Freeze several phases: the leg (or the slide) only shows late in a grain's life.
const phases = (phaseArg || "0.55,0.8,0.95").split(",").map(Number);

let plugin;
vm.runInNewContext(fs.readFileSync(srcPath, "utf8"), {
	window: {
		__ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => ({ default: React })); } },
		addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
		matchMedia: () => ({ matches: false }), innerWidth: 1440, innerHeight: 900,
	},
	document: undefined, console, AbortController, AbortSignal,
	fetch: () => new Promise(() => {}),
	Event: class {}, localStorage: { getItem: () => null, setItem() {} },
	setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
});

const { CSS, dustGrains } = plugin.__test;

function styleAttr(style) {
	if (!style || !Object.keys(style).length) return "";
	const pairs = [];
	for (const k of Object.keys(style)) pairs.push(k + ":" + style[k]);
	return ' style="' + pairs.join(";") + '"';
}

function toHtml(el) {
	if (el === null || el === undefined || el === false) return "";
	if (typeof el === "string" || typeof el === "number") return String(el);
	if (Array.isArray(el)) return el.map(toHtml).join("");
	const { type, props } = el;
	if (typeof type === "string") {
		let attrs = "";
		for (const k of Object.keys(props)) {
			if (k === "style" || k === "children") continue;
			attrs += " " + (k === "className" ? "class" : k) + '="' + String(props[k]).replace(/"/g, "&quot;") + '"';
		}
		return "<" + type + attrs + styleAttr(props.style) + ">" + toHtml(props.children) + "</" + type + ">";
	}
	return toHtml(type(props));
}

const grains = dustGrains(count, "medium", spread);
const w1 = React.createElement("span", { className: "w1" }, ...grains);
const wave = React.createElement("span", { className: "dnl-wave dnl-wave-stardust dnl-wave-both", style: { "--dnl-wave-hi": "1" } }, w1);
const halobox = React.createElement("div", { className: "dnl-halobox" }, wave);
const island = React.createElement("div", { className: "dnl-island" }, React.createElement("span", null, "1"));
const shell = React.createElement("div", { className: "dnl-shell" }, halobox, island);
const host = React.createElement("div", { className: "dnl-host" }, shell);

const base = [
	"html,body{margin:0;background:radial-gradient(120% 120% at 50% 0%,#1b2340,#0a0d17 70%)}",
	":root{--dsw-alias-brand-primary:#8b7cff;--dsw-alias-label-primary:#e8ecf6;--dsw-alias-label-secondary:#b9c2d8;--dsw-alias-bg-overlay:#141b2b;--dsw-alias-border-l1:rgba(255,255,255,.14)}",
	"body{padding:14px}",
	"#rows{display:flex;flex-direction:column;gap:8px}",
	".row{position:relative;height:110px}",
	".tag{position:absolute;left:2px;top:2px;font:10px/1 ui-monospace,monospace;color:#7f8aa3}",
	".stage{position:absolute;left:96px;top:10px;width:132px;height:78px}",
	".dnl-host{position:absolute;inset:0;display:block;left:0;top:0;transform:none;width:100%;height:100%}",
	".dnl-shell{position:absolute;inset:0;display:block;width:100%;height:100%}",
	".dnl-island{position:absolute;inset:0;width:100%;height:100%;border-radius:999px;box-sizing:border-box;",
	"border:.5px solid rgba(255,255,255,.12);background:rgba(20,28,44,.72);backdrop-filter:none!important}",
	".dnl-halobox{position:absolute;inset:0;z-index:0;pointer-events:none}",
	".dnl-wave{position:absolute;inset:0;pointer-events:none;opacity:1}",
	".dnl-wave .dnl-dustpulse{opacity:0!important}",
	".dnl-island *{visibility:hidden}",
	".guide{position:absolute;inset:-1px;border-radius:999px;border:1.2px solid #ff2fd0;opacity:.6;pointer-events:none}",
	".w1,.w2{--dnl-wave-hi:1}",
	beat ? ".dnl-halobox{--dnl-beat-slow:1;--dnl-beat-gain:" + beat + ";--dnl-beat:1}" : "",
].join("\n");

const rows = phases.map((ph) => {
	const freeze = ".dnl-wave .dnl-dust{animation-play-state:paused!important;animation-delay:calc(var(--del,0s) - var(--dur,9s) * " + ph + ")!important}";
	return [
		'<div class="row">',
		'<div class="tag">phase ' + Math.round(ph * 100) + '%</div>',
		'<style>' + freeze + '</style>',
		'<div class="stage">',
		toHtml(host),
		'<div class="guide"></div>',
		"</div></div>",
	].join("\n");
});

const html = [
	'<!doctype html><meta charset="utf-8">',
	"<style>" + CSS + "</style>",
	"<style>" + base + "</style>",
	'<div id="rows">',
	rows.join("\n"),
	"</div>",
].join("\n");

fs.writeFileSync(outPath, html, "utf8");
console.log("wrote " + outPath + " (" + count + " grains, spread " + (spread * 100) + "%, beat " + beat + ", phases " + phases.join("/") + ")");

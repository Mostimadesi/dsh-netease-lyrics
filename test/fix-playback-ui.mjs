import fs from 'node:fs';
const p = new URL('../lib/client.js', import.meta.url);
let s = fs.readFileSync(p, 'utf8');
function replace(a,b){if(!s.includes(a))throw Error('missing anchor: '+a);s=s.replace(a,b);}
replace('\t\tfunction ColorSettings(props) {', `
		const DISPLAY_KEY = "dsh.netease-lyrics.display.v1";
		const DISPLAY_EVENT = "dsh-netease-lyrics-display";
		function readDisplay() {
			try {
				const raw = JSON.parse(localStorage.getItem(DISPLAY_KEY) || "{}");
				const out = {};
				if (typeof raw?.font === "string" && raw.font.length <= 200) out.font = raw.font;
				if (Number.isFinite(raw?.x) && Number.isFinite(raw?.y)) {
					out.x = Math.min(1, Math.max(0, raw.x)); out.y = Math.min(1, Math.max(0, raw.y));
				}
				return out;
			} catch { return {}; }
		}
		function writeDisplay(next) {
			try { localStorage.setItem(DISPLAY_KEY, JSON.stringify(next)); }
			catch { return false; }
			window.dispatchEvent(new Event(DISPLAY_EVENT)); return true;
		}
		function useDisplay() {
			const [prefs, setPrefs] = useState(readDisplay);
			useEffect(() => {
				const refresh = () => setPrefs(readDisplay());
				window.addEventListener(DISPLAY_EVENT, refresh); window.addEventListener("storage", refresh);
				return () => { window.removeEventListener(DISPLAY_EVENT, refresh); window.removeEventListener("storage", refresh); };
			}, []);
			return prefs;
		}
		// Font names are quoted individually; arbitrary CSS declarations/URLs are never accepted.
		function fontStack(value) {
			return String(value || "").split(/[,，]/).map(x => x.trim()).filter(Boolean)
				.map(x => JSON.stringify(x)).join(", ") || "inherit";
		}
		function clampPlacement(x, y, width, height, vw, vh) {
			const half = Math.min(width / 2, Math.max(0, (vw - 16) / 2));
			return { x: Math.max(8 + half, Math.min(vw - 8 - half, x)),
				y: Math.max(8, Math.min(Math.max(8, vh - height - 8), y)) };
		}
		function ColorSettings(props) {`);
replace('const [error, setError] = useState("");\n\t\t\tif (props.view === "summary") return "歌词字体颜色";', `const [error, setError] = useState("");
			const prefs = useDisplay();
			if (props.view === "summary") return "歌词颜色、字体与浮层位置";
			const saveDisplay = (next) => setError(writeDisplay(next) ? "" : "浏览器无法保存设置，请检查存储权限。");`);
replace('h("h3", null, "歌词字体颜色"),','h("h3", null, "歌词外观与位置"),');
replace('error ? h("p", { role: "alert" }, error) : null);', `h("label", { className: "dnl-font-row" }, "歌词字体（本机已安装的字体名称，可用逗号分隔）",
					h("input", { type: "text", "aria-label": "歌词字体", maxLength: 200,
						placeholder: "例如：Microsoft YaHei, Noto Sans CJK SC", value: prefs.font || "",
						onChange: event => saveDisplay({ ...readDisplay(), font: event.target.value }) })),
				h("p", null, "留空跟随 DSH 字体；字体需已安装在当前设备，未安装时由浏览器回退。"),
				h("button", { type: "button", onClick: () => saveDisplay({ ...readDisplay(), font: "" }) }, "恢复默认字体"),
				h("p", null, "拖动浮层上的 ⠿ 手柄即可移动，位置会自动记住；默认位于顶部偏右。"),
				h("button", { type: "button", onClick: () => { const next = { ...readDisplay() }; delete next.x; delete next.y; saveDisplay(next); } }, "重置浮层位置"),
				error ? h("p", { role: "alert" }, error) : null);`);
replace('\t\tfunction formatTime(sec) {', `		// Sample-and-hold aware clock: repeated readings do not restart interpolation.
		// During ordinary playback small corrections cannot move the lyric clock backwards.
		function createPlaybackClock() {
			let anchor = null;
			function read(now) {
				if (!anchor) return 0;
				const elapsed = anchor.playing ? Math.min(2, Math.max(0, (now - anchor.at) / 1000)) * anchor.rate : 0;
				const value = anchor.position + elapsed;
				return anchor.duration > 0 ? Math.min(anchor.duration, value) : value;
			}
			function update(payload, now) {
				const identity = [payload.app, payload.title, payload.artist, payload.album].join("|");
				const raw = Math.max(0, Number(payload.positionSec) || 0);
				const rate = Number(payload.rate) > 0 ? Number(payload.rate) : 1;
				const playing = payload.active === true && payload.playing === true;
				const stamp = Number(payload.atMs) || 0;
				if (anchor && identity === anchor.identity && stamp && stamp <= anchor.stamp) return;
				const predicted = read(now);
				const seek = anchor && (Math.abs(raw - anchor.raw) > 1.5 + Math.max(0, (now - anchor.received) / 1000) * rate
					|| raw < anchor.raw - 1.5 || Math.abs(raw - predicted) > 2.5);
				if (anchor && identity === anchor.identity && !seek && playing && anchor.playing && raw === anchor.raw) {
					anchor.stamp = stamp; anchor.received = now; return;
				}
				const continuous = anchor && identity === anchor.identity && !seek && playing && anchor.playing;
				anchor = { identity, raw, position: continuous ? Math.max(raw, predicted) : raw,
					at: now, received: now, stamp, playing, rate, duration: Number(payload.durationSec) || 0 };
			}
			return { update, read };
		}

		function formatTime(sec) {`);
// Keep snapshot as hook 1 for existing component tests.
replace('const [st, setSt] = useState(null);', `const [st, setSt] = useState(null);
			const prefs = useDisplay();
			const [dragPosition, setDragPosition] = useState(null);
			const hostRef = useRef(null);
			const dragRef = useRef(null);
			const suppressClick = useRef(false);`);
replace('const anchorRef = useRef(null);', 'const anchorRef = useRef(null);\n\t\t\tif (!anchorRef.current) anchorRef.current = createPlaybackClock();');
replace(`anchorRef.current = {
									atLocal: Date.now(),
									positionSec: Number(payload.positionSec) || 0,
									playing: payload.playing === true,
									rate: Number(payload.rate) || 0,
								};`, 'anchorRef.current.update(payload, Date.now());');
replace('if (st === null || st.active !== true) return null;', `// Clamp after expansion, font changes and window resizing so saved positions stay reachable.
			useEffect(() => {
				const fit = () => {
					const el = hostRef.current; if (!el) return;
					const box = el.getBoundingClientRect();
					const vw = window.innerWidth, vh = window.innerHeight;
					const location = dragPosition || { x: (prefs.x ?? 0.70) * vw, y: prefs.y === undefined ? 12 : prefs.y * vh };
					const clamped = clampPlacement(location.x, location.y, box.width, box.height, vw, vh);
					el.style.left = clamped.x + "px"; el.style.top = clamped.y + "px";
				};
				fit(); window.addEventListener("resize", fit);
				const observer = typeof ResizeObserver === "function" ? new ResizeObserver(fit) : null;
				if (hostRef.current && observer) observer.observe(hostRef.current);
				return () => { window.removeEventListener("resize", fit); observer?.disconnect(); };
			}, [expanded, prefs.x, prefs.y, prefs.font, dragPosition, st?.active]);

			if (st === null || st.active !== true) return null;`);
replace(`const anchor = anchorRef.current;
			const rate = anchor && anchor.rate > 0 ? anchor.rate : 1;
			const elapsed = anchor && anchor.playing ? ((Date.now() - anchor.atLocal) / 1000) * rate : 0;
			const pos = anchor ? Math.max(0, anchor.positionSec + elapsed) : 0;`, 'const pos = anchorRef.current.read(Date.now());');
replace('return h("div", { className: "dnl-host", style: Object.fromEntries(COLOR_FIELDS.filter(([key]) => colors[key]).map(([key, , variable]) => [variable, colors[key]])) },', `const startDrag = event => {
				if (event.button !== 0) return;
				event.stopPropagation(); event.preventDefault();
				const box = hostRef.current?.getBoundingClientRect(); if (!box) return;
				dragRef.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x: box.left + box.width / 2, y: box.top, moved: false };
				event.currentTarget.setPointerCapture(event.pointerId);
			};
			const moveDrag = event => {
				const drag = dragRef.current; if (!drag || drag.id !== event.pointerId) return;
				const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
				if (Math.hypot(dx, dy) < 4 && !drag.moved) return;
				drag.moved = true; suppressClick.current = true;
				const box = hostRef.current.getBoundingClientRect();
				drag.position = clampPlacement(drag.x + dx, drag.y + dy, box.width, box.height, window.innerWidth, window.innerHeight);
				setDragPosition(drag.position);
			};
			const endDrag = event => {
				const drag = dragRef.current; if (!drag || drag.id !== event.pointerId) return;
				if (drag.moved && drag.position) {
					const saved = writeDisplay({ ...readDisplay(), x: drag.position.x / window.innerWidth, y: drag.position.y / window.innerHeight });
					if (saved) setDragPosition(null);
				}
				dragRef.current = null;
				if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
			};
			const style = Object.fromEntries(COLOR_FIELDS.filter(([key]) => colors[key]).map(([key, , variable]) => [variable, colors[key]]));
			if (prefs.font) style["--dnl-font"] = fontStack(prefs.font);
			style.left = dragPosition ? dragPosition.x + "px" : ((prefs.x ?? 0.70) * 100) + "vw";
			style.top = dragPosition ? dragPosition.y + "px" : prefs.y === undefined ? "12px" : (prefs.y * 100) + "vh";
			return h("div", { className: "dnl-host", ref: hostRef, style },`);
replace('onClick: () => {\n\t\t\t\t\t\tif (!expanded)', 'onClick: () => {\n\t\t\t\t\t\tif (suppressClick.current) { suppressClick.current = false; return; }\n\t\t\t\t\t\tif (!expanded)');
replace('\t\t\t\t\t!expanded\n', `					h("button", { type: "button", className: "dnl-drag", "aria-label": "拖动歌词浮层", title: "拖动以移动歌词浮层",
						onPointerDown: startDrag, onPointerMove: moveDrag, onPointerUp: endDrag, onPointerCancel: endDrag,
						onClick: event => { event.stopPropagation(); suppressClick.current = false; } }, "⠿"),
					!expanded
`);
replace('top:12px;left:50%;', 'top:12px;left:70%;');
replace('pointer-events:auto;cursor:default;max-width:', 'position:relative;pointer-events:auto;cursor:default;max-width:');
replace('padding:6px 16px;', 'padding:6px 16px 6px 30px;');
replace('font-family:inherit;user-select:none}', 'font-family:var(--dnl-font,inherit);user-select:none}');
replace('padding:12px 14px;cursor:pointer}', 'padding:12px 14px 12px 30px;cursor:pointer}');
replace('\t\t].join("");', `			".dnl-drag{position:absolute;left:6px;top:50%;transform:translateY(-50%);width:20px;height:28px;padding:0;border:0;border-radius:4px;cursor:grab;touch-action:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:16px}.dnl-drag:active{cursor:grabbing}.dnl-drag:focus-visible{outline:2px solid var(--dsw-alias-brand-primary)}.dnl-font-row{display:flex;flex-direction:column;gap:8px;margin-top:16px}.dnl-font-row input{font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:6px 8px;width:min(100%,420px)}",
		].join("");`);
fs.writeFileSync(p,s);

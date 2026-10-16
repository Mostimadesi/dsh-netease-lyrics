window.__ModuleLoader__.load({
	id: "dsh-netease-lyrics",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		/**
		 * React arrives through the module system's CJS interop shape
		 * (`{ default: ReactAPI }`); unwrap defensively and fall back to a
		 * global so a missing React kills only the island, never the boot
		 * batch.
		 */
		let ReactApi;
		try {
			const reactModule = require("react");
			ReactApi = reactModule !== null && typeof reactModule === "object" && typeof reactModule.default === "object"
				? reactModule.default
				: reactModule;
		} catch {
			ReactApi = typeof window !== "undefined" ? window.React : undefined;
		}
		if (ReactApi === null || typeof ReactApi !== "object" || typeof ReactApi.createElement !== "function") {
			ReactApi = undefined;
		}

		/**
		 * dsh-netease-lyrics — browser half.
		 *
		 * Registers one `shell.overlay` entry: a top-center lyric island.
		 * Collapsed it shows the current lyric line (extrapolated between
		 * polls from positionSec / playing / rate); hovering expands it into
		 * cover + track + a scrolling lyric window + progress. Unmatched
		 * tracks fall back to "title — artist" with a manual rematch button
		 * in the expanded state. No active SMTC session → renders nothing.
		 *
		 * All state comes from the host half's /state.json route (SMTC facts
		 * are host-owned; the browser only extrapolates and renders). Colors
		 * come exclusively from theme tokens so light/dark both hold.
		 */
		const STATE_ROUTE = "/dsh-netease-lyrics/state.json";
		const COVER_ROUTE = "/dsh-netease-lyrics/cover.png";
		const REMATCH_ROUTE = "/dsh-netease-lyrics/rematch";

		const inject = ["slots"];
		const COLOR_KEY = "dsh.netease-lyrics.colors.v1";
		const COLOR_EVENT = "dsh-netease-lyrics-colors";
		const COLOR_FIELDS = [
			["original", "原文颜色", "--dnl-original"],
			["translation", "译文颜色", "--dnl-translation"],
			["active", "当前句高亮", "--dnl-active"],
		];
		function readColors() {
			try {
				const raw = JSON.parse(localStorage.getItem(COLOR_KEY) || "{}");
				return Object.fromEntries(COLOR_FIELDS.filter(([key]) => /^#[0-9a-f]{6}$/i.test(raw?.[key] || "")).map(([key]) => [key, raw[key]]));
			} catch { return {}; }
		}
		function writeColors(next) {
			try { localStorage.setItem(COLOR_KEY, JSON.stringify(next)); }
			catch { return false; }
			window.dispatchEvent(new Event(COLOR_EVENT));
			return true;
		}
		function useColors() {
			const [colors, setColors] = useState(readColors);
			useEffect(() => {
				const refresh = () => setColors(readColors());
				window.addEventListener(COLOR_EVENT, refresh);
				window.addEventListener("storage", refresh);
				return () => {
					window.removeEventListener(COLOR_EVENT, refresh);
					window.removeEventListener("storage", refresh);
				};
			}, []);
			return colors;
		}

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
		function ColorSettings(props) {
			const colors = useColors();
			const [error, setError] = useState("");
			const prefs = useDisplay();
			if (props.view === "summary") return "歌词颜色、字体与浮层位置";
			const saveDisplay = (next) => setError(writeDisplay(next) ? "" : "浏览器无法保存设置，请检查存储权限。");
			const save = (next) => setError(writeColors(next) ? "" : "浏览器无法保存设置，请检查存储权限。");
			return h("section", { className: "dnl-settings" },
				h("h3", null, "歌词外观与位置"),
				h("p", null, "修改后立即生效，保存在当前浏览器。未自定义的颜色跟随明暗主题。"),
				...COLOR_FIELDS.map(([key, label]) => h("label", { key, className: "dnl-color-row" },
					h("span", null, label),
					h("input", { type: "color", "aria-label": label, value: colors[key] || "#808080",
						onChange: (event) => save({ ...readColors(), [key]: event.target.value }) }),
					h("span", null, colors[key] || "跟随主题"),
					h("button", { type: "button", disabled: !colors[key], onClick: () => {
						const next = { ...readColors() }; delete next[key]; save(next);
					} }, "恢复默认"))),
				h("button", { type: "button", onClick: () => save({}) }, "恢复全部主题默认"),
				h("label", { className: "dnl-font-row" }, "歌词字体（本机已安装的字体名称，可用逗号分隔）",
					h("input", { type: "text", "aria-label": "歌词字体", maxLength: 200,
						placeholder: "例如：Microsoft YaHei, Noto Sans CJK SC", value: prefs.font || "",
						onChange: event => saveDisplay({ ...readDisplay(), font: event.target.value }) })),
				h("p", null, "留空跟随 DSH 字体；字体需已安装在当前设备，未安装时由浏览器回退。"),
				h("button", { type: "button", onClick: () => saveDisplay({ ...readDisplay(), font: "" }) }, "恢复默认字体"),
				h("p", null, "拖动浮层上的 ⠿ 手柄即可移动，位置会自动记住；默认位于顶部偏右。"),
				h("button", { type: "button", onClick: () => { const next = { ...readDisplay() }; delete next.x; delete next.y; saveDisplay(next); } }, "重置浮层位置"),
				error ? h("p", { role: "alert" }, error) : null);
		}

		const h = ReactApi === undefined ? null : ReactApi.createElement;
		const useState = ReactApi === undefined ? null : ReactApi.useState;
		const useEffect = ReactApi === undefined ? null : ReactApi.useEffect;
		const useRef = ReactApi === undefined ? null : ReactApi.useRef;

		/** Binary search: index of the last line with t <= pos (-1 before first). */
		function currentLineIndex(lines, pos) {
			let lo = 0;
			let hi = lines.length - 1;
			let ans = -1;
			while (lo <= hi) {
				const mid = (lo + hi) >> 1;
				if (lines[mid].t <= pos) {
					ans = mid;
					lo = mid + 1;
				} else {
					hi = mid - 1;
				}
			}
			return ans;
		}

		// Sample-and-hold aware clock: repeated readings do not restart interpolation.
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

		// At most two layers: outgoing lyric fades out while the current one fades in.
		// Identity changes only at a lyric boundary, never on the 250ms clock tick.
		function LyricTransition(props) {
			const [frame, setFrame] = useState(() => ({ identity: props.identity, content: props.children, previous: null }));
			useEffect(() => {
				setFrame(old => old.identity === props.identity ? old : {
					identity: props.identity, content: props.children,
					previous: { identity: old.identity, content: old.content },
				});
				const timer = setTimeout(() => setFrame(old => old.identity === props.identity
					? { ...old, previous: null } : old), 240);
				return () => clearTimeout(timer);
			}, [props.identity]);
			return h("div", { className: "dnl-crossfade" },
				frame.previous ? h("div", { key: "old:" + frame.previous.identity,
					className: "dnl-fade-layer dnl-fade-out", "aria-hidden": true }, frame.previous.content) : null,
				h("div", { key: "new:" + props.identity,
					className: "dnl-fade-layer" + (frame.previous ? " dnl-fade-in" : "") }, props.children));
		}

		function formatTime(sec) {
			if (!Number.isFinite(sec) || sec < 0) return "0:00";
			const m = Math.floor(sec / 60);
			const s = Math.floor(sec % 60);
			return m + ":" + (s < 10 ? "0" : "") + s;
		}

		function LyricIsland() {
			const colors = useColors();
			const [st, setSt] = useState(null);
			const prefs = useDisplay();
			const [dragPosition, setDragPosition] = useState(null);
			const hostRef = useRef(null);
			const dragRef = useRef(null);
			const suppressClick = useRef(false);
			const [expanded, setExpanded] = useState(false);
			const [pinned, setPinned] = useState(false);
			const [rematching, setRematching] = useState(false);
			const [tick, setTick] = useState(0);
			const anchorRef = useRef(null);
			if (!anchorRef.current) anchorRef.current = createPlaybackClock();
			const pollRef = useRef(0);

			/* Poll the host route; keep the last good snapshot on failure. */
			useEffect(() => {
				let stopped = false;
				let timer = null;
				const scheduleNext = (delay) => {
					if (stopped) return;
					timer = setTimeout(run, delay);
				};
				const run = async () => {
					try {
						const response = await fetch(STATE_ROUTE, {
							headers: { accept: "application/json" },
							signal: AbortSignal.timeout(4000),
						});
						if (response.ok) {
							const payload = await response.json();
							if (!stopped && payload !== null && typeof payload === "object") {
								anchorRef.current.update(payload, Date.now());
								pollRef.current = Number(payload.pollMs) || 1000;
								setSt(payload);
							}
						}
					} catch {
						// Host restarting or route not mounted yet: retry later.
					}
					scheduleNext(Math.min(Math.max(pollRef.current || 1000, 250), 5000));
				};
				void run();
				return () => {
					stopped = true;
					if (timer !== null) clearTimeout(timer);
				};
			}, []);

			/* Animation-ish tick for local extrapolation. */
			useEffect(() => {
				const timer = setInterval(() => setTick((value) => value + 1), 250);
				return () => clearInterval(timer);
			}, []);
			void tick;

			// Clamp after expansion, font changes and window resizing so saved positions stay reachable.
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

			if (st === null || st.active !== true) return null;

			const pos = anchorRef.current.read(Date.now());
			const duration = Number(st.durationSec) || 0;

			const lyric = st.lyric !== null && typeof st.lyric === "object" ? st.lyric : { status: "idle" };
			const lines = Array.isArray(lyric.lines) ? lyric.lines : [];
			const index = lines.length > 0 ? currentLineIndex(lines, pos) : -1;
			const currentLine = index >= 0 ? lines[index] : null;

			const title = typeof st.title === "string" ? st.title : "";
			const artist = typeof st.artist === "string" ? st.artist : "";
			const fallbackLabel = (title + (artist !== "" ? " — " + artist : "")).trim();

			const rematch = async () => {
				if (rematching) return;
				setRematching(true);
				try {
					await fetch(REMATCH_ROUTE, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: "{}",
						signal: AbortSignal.timeout(4000),
					});
				} catch {
					// The next poll picks the outcome up either way.
				} finally {
					setRematching(false);
				}
			};

			const collapsedText =
				currentLine !== null
					? currentLine.text
					: lyric.status === "matched" || lyric.status === "loading"
						? fallbackLabel !== "" ? fallbackLabel : "…"
						: fallbackLabel !== "" ? fallbackLabel : "…";

			const collapsedStatus =
				lyric.status === "unmatched" || lyric.status === "error" ? " · 未匹配" : "";

					/* ---------- expanded lyric window ---------- */
			const windowStart = Math.max(0, index - 4);
			const windowEnd = Math.min(lines.length - 1, index + 4);
			const rows = [];
			if (lines.length > 0) {
				for (let i = windowStart; i <= windowEnd; i += 1) {
					const active = i === index;
					rows.push(
						h("div", {
							key: "l" + String(i),
							className: "dnl-line" + (active ? " dnl-line-active" : ""),
						},
							h("div", { className: "dnl-line-main" }, lines[i].text),
							typeof lines[i].trans === "string" && lines[i].trans !== ""
								? h("div", { className: "dnl-line-trans" }, lines[i].trans)
								: null,
						),
					);
				}
			}

			const progressPct =
				duration > 0 ? Math.min(100, Math.max(0, (pos / duration) * 100)) : 0;

			const coverSerial = Number(st.coverSerial) || 0;
			const matchedNote =
				lyric.status === "matched"
					? (lyric.sourceLabel || (lyric.source === 'qq' ? 'QQ 音乐' : '网易云')) + '歌词 · 匹配：' + (lyric.songName || "?") + (Array.isArray(lyric.artistNames) && lyric.artistNames.length > 0 ? " — " + lyric.artistNames.join(" / ") : "")
					: lyric.status === "loading"
						? "正在匹配歌词…"
						: lyric.status === "unmatched"
							? "网易云和 QQ 均未找到可信的带时间歌词"
							: lyric.status === "error" && typeof lyric.message === "string"
								? "歌词获取失败：" + lyric.message
								: "";

			const startDrag = event => {
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
			return h("div", { className: "dnl-host", ref: hostRef, style },
				h("div", {
					className: "dnl-island" + (expanded ? " dnl-expanded" : ""),
					onMouseEnter: () => setExpanded(true),
					onMouseLeave: () => { if (!pinned) setExpanded(false); },
					onClick: () => {
						if (suppressClick.current) { suppressClick.current = false; return; }
						if (!expanded) { setExpanded(true); setPinned(true); }
						else setPinned((value) => !value);
					},
					role: "status",
					"aria-label": "当前歌词：" + collapsedText,
				},
					h("button", { type: "button", className: "dnl-drag", "aria-label": "拖动歌词浮层", title: "拖动以移动歌词浮层",
						onPointerDown: startDrag, onPointerMove: moveDrag, onPointerUp: endDrag, onPointerCancel: endDrag,
						onClick: event => { event.stopPropagation(); suppressClick.current = false; } }, "⠿"),
					!expanded
						? h(LyricTransition, { identity: [st.app, st.title, st.artist, lyric.songId, index, collapsedText, currentLine?.trans].join("|") },
							h("div", { className: "dnl-now" },
								h("span", { className: "dnl-now-text" }, collapsedText),
								currentLine && typeof currentLine.trans === "string" && currentLine.trans.trim()
									? h("span", { className: "dnl-now-trans" }, currentLine.trans) : null,
								collapsedStatus !== ""
									? h("span", { className: "dnl-now-sub" }, collapsedStatus) : null))
						: h("div", { className: "dnl-panel" },
							h("div", { className: "dnl-head" },
								coverSerial > 0
									? h("img", {
										className: "dnl-cover",
										src: COVER_ROUTE + "?v=" + String(coverSerial),
										alt: "",
										draggable: false,
									})
									: null,
								h("div", { className: "dnl-head-text" },
									h("div", { className: "dnl-title" }, title !== "" ? title : "未知曲目"),
									h("div", { className: "dnl-artist" }, artist !== "" ? artist : ""),
									h("div", { className: "dnl-match" },
										matchedNote,
										(lyric.status === "unmatched" || lyric.status === "error") && st.active === true
											? h("button", {
												type: "button",
												className: "dnl-btn",
												disabled: rematching,
												onClick: (event) => {
													event.stopPropagation();
													void rematch();
												},
											}, rematching ? "重试中…" : "重新匹配")
											: null,
									),
								),
							),
							rows.length > 0
								? h(LyricTransition, { identity: [st.app, st.title, st.artist, lyric.songId, index].join("|") }, h("div", { className: "dnl-lines" }, rows))
								: h("div", { className: "dnl-lines dnl-lines-empty" }, "暂无歌词"),
							h("div", { className: "dnl-progress" },
								h("span", { className: "dnl-time" }, formatTime(pos)),
								h("div", { className: "dnl-bar" },
									h("div", { className: "dnl-bar-fill", style: { width: progressPct.toFixed(1) + "%" } }),
								),
								h("span", { className: "dnl-time" }, formatTime(duration)),
							),
						),
				),
			);
		}

		function apply(ctx) {
			/** Everything here is decorative: a missing React or slots seat
			 *  must never break the boot batch. */
			try {
				if (ReactApi === undefined) return;
				if (ctx.slots === null || typeof ctx.slots !== "object") return;
				ctx.slots.inject("shell.overlay", () => ctx.slots.register(
					{
						name: "shell.overlay",
						id: "dsh-netease-lyrics",
						order: 500,
						label: "歌词浮层",
					},
					LyricIsland,
				));
				ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register(
					{ name: "plugins.bundle.config", key: "dsh-netease-lyrics" }, ColorSettings));
			} catch {
				// Overlay unavailable: nothing renders, nothing breaks.
			}
		}

		const CSS = [
			".dnl-host{position:fixed;top:12px;left:70%;transform:translateX(-50%);z-index:1000;pointer-events:none;display:flex;justify-content:center}",
			".dnl-island{position:relative;pointer-events:auto;cursor:default;max-width:min(560px,70vw);border-radius:999px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);box-shadow:0 6px 24px rgba(0,0,0,.18);padding:6px 16px 6px 30px;transition:max-width .18s ease,padding .18s ease;font-family:var(--dnl-font,inherit);user-select:none}",
			".dnl-expanded{border-radius:14px;max-width:min(640px,86vw);padding:12px 14px 12px 30px;cursor:pointer}",
			".dnl-now{display:flex;flex-direction:column;align-items:center;gap:1px;min-height:22px;min-width:0}",
			".dnl-now-text{color:var(--dnl-original,var(--dsw-alias-label-primary));font-size:13px;line-height:22px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:48vw}",
			".dnl-now-sub{color:var(--dsw-alias-label-tertiary);font-size:11px;flex:none}",
			".dnl-panel{display:flex;flex-direction:column;gap:10px}",
			".dnl-head{display:flex;gap:10px;align-items:center}",
			".dnl-cover{width:44px;height:44px;border-radius:8px;object-fit:cover;flex:none;border:.5px solid var(--dsw-alias-border-l1)}",
			".dnl-head-text{min-width:0;display:flex;flex-direction:column;gap:1px}",
			".dnl-title{color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dnl-artist{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dnl-match{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;display:flex;align-items:center;gap:8px;white-space:nowrap;overflow:hidden}",
			".dnl-btn{color:var(--dsw-alias-label-primary);background:transparent;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);padding:1px 8px;font-size:11px;line-height:16px;cursor:pointer;font-family:inherit;flex:none}",
			".dnl-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}",
			".dnl-btn:disabled{opacity:.5;cursor:default}",
			".dnl-lines{display:flex;flex-direction:column;gap:4px;max-height:184px;overflow:hidden;-webkit-mask-image:linear-gradient(180deg,transparent,#000 18%,#000 82%,transparent);mask-image:linear-gradient(180deg,transparent,#000 18%,#000 82%,transparent)}",
			".dnl-lines-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;justify-content:center;align-items:center;height:60px}",
			".dnl-line{display:flex;flex-direction:column;align-items:center;text-align:center}",
			".dnl-line-main{color:var(--dnl-original,var(--dsw-alias-label-secondary));font-size:12px;line-height:18px;transition:color .15s ease}",
			".dnl-line-trans{color:var(--dnl-translation,var(--dsw-alias-label-secondary));font-size:11px;line-height:15px}",
			".dnl-line-active .dnl-line-main{color:var(--dnl-active,var(--dnl-original,var(--dsw-alias-brand-primary)));font-size:13px;font-weight:600}",
			".dnl-progress{display:flex;align-items:center;gap:8px}",
			".dnl-time{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:12px;font-variant-numeric:tabular-nums;flex:none}",
			".dnl-bar{flex:1;height:3px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}",
			".dnl-bar-fill{height:100%;border-radius:2px;background:var(--dsw-alias-brand-primary)}",
			".dnl-now-trans{color:var(--dnl-translation,var(--dsw-alias-label-secondary));font-size:11px;line-height:16px;max-width:48vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dnl-settings{color:var(--dsw-alias-label-primary);padding:12px 0}.dnl-settings p{color:var(--dsw-alias-label-secondary);font-size:12px}.dnl-color-row{display:flex;align-items:center;gap:12px;padding:10px 0;flex-wrap:wrap}.dnl-color-row input{width:40px;height:28px;cursor:pointer}.dnl-settings button{font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:4px 10px;cursor:pointer}.dnl-settings button:disabled{opacity:.5}",
			".dnl-drag{position:absolute;left:6px;top:50%;transform:translateY(-50%);width:20px;height:28px;padding:0;border:0;border-radius:4px;cursor:grab;touch-action:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:16px}.dnl-drag:active{cursor:grabbing}.dnl-drag:focus-visible{outline:2px solid var(--dsw-alias-brand-primary)}.dnl-font-row{display:flex;flex-direction:column;gap:8px;margin-top:16px}.dnl-font-row input{font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:6px 8px;width:min(100%,420px)}",
			".dnl-crossfade{display:grid;min-width:0}.dnl-fade-layer{grid-area:1/1;min-width:0}.dnl-fade-out{pointer-events:none;animation:dnl-lyric-out 220ms ease-out both}.dnl-fade-in{animation:dnl-lyric-in 220ms ease-out both}@keyframes dnl-lyric-out{from{opacity:1;transform:translateY(0)}to{opacity:0;transform:translateY(-3px)}}@keyframes dnl-lyric-in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:translateY(0)}}@media(prefers-reduced-motion:reduce){.dnl-fade-in{animation:none}.dnl-fade-out{display:none;animation:none}.dnl-island,.dnl-line-main{transition:none}}",
		].join("");
		const cssTag = "dsh-netease-lyrics/island.css";
		if (typeof document !== "undefined") {
			let tag = document.querySelector("style[data-plugin-css=" + JSON.stringify(cssTag) + "]");
			if (tag === null) {
				tag = document.createElement("style");
				tag.dataset.pluginCss = cssTag;
				document.head.appendChild(tag);
			}
			tag.textContent = CSS;
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

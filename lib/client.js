window.__ModuleLoader__.load({
	id: "dsh-netease-lyrics",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		/**
		 * dsh-netease-lyrics — browser half.
		 *
		 * TWO `shell.overlay` entries:
		 *
		 *  1. The lyric island: a top-center hover-expandable capsule with
		 *     the current line, cover, a scrolling lyric window and
		 *     rematch. Draggable via the `⠿` handle; colors / font /
		 *     position persist per browser.
		 *  2. Ambient floating lyrics (limpbus-lyrics-inspired): the
		 *     current line materializes at a random spot inside the
		 *     left/right side bands (overlap-rejected), entering
		 *     per-character with a staggered reveal, then waving or
		 *     jittering, and exiting in rank order — ripple fade or
		 *     accelerated fall — when displaced by newer lines. Original
		 *     text AND translation animate on the same glyph timeline.
		 *     pointer-events:none; paused media freezes every animation.
		 *
		 * State comes from the host half
		 * (/dsh-netease-lyrics/state.json), polled once and shared
		 * by both entries.
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

		const STATE_ROUTE = "/dsh-netease-lyrics/state.json";
		const COVER_ROUTE = "/dsh-netease-lyrics/cover.png";
		const REMATCH_ROUTE = "/dsh-netease-lyrics/rematch";

		const inject = ["slots"];

		/* ---------------- shared appearance prefs (original keys) ---------------- */

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

		/* ---------------- ambient-only prefs ---------------- */

		const AMBIENT_KEY = "dsh.netease-lyrics.ambient.prefs.v1";
		const AMBIENT_EVENT = "dsh-netease-lyrics-prefs";
		const AMBIENT_STYLES = [
			["glow", "白芯发光"],
			["classic", "经典纯色"],
			["gradient", "渐变字芯"],
			["carmen", "卡门的声音"],
		];
		const AMBIENT_ANIMS = [
			["ripple-wave", "波纹·波动（默认）"],
			["ripple-jitter", "波纹·抖动"],
			["drop-wave", "跌落·波动"],
			["drop-jitter", "跌落·抖动"],
			["classic-fade", "整句渐隐"],
		];
		const AMBIENT_ORIENTS = [
			["tilt", "倾斜出现（原版随机 ±8°）"],
			["horizontal", "横向正交（0°）"],
			["vertical", "竖向正交（90°）"],
		];
		const COLOR_MODES = [
			["manual", "手动取色"],
			["theme", "跟随当前主题"],
			["cover", "跟随专辑封面（自动取主色）"],
			["preset", "预设配色"],
		];
		const COLOR_PRESETS = {
			dawn: { label: "晨曦（暖金）", color: "#ffd9a8", glow: "#ff9e6b" },
			ocean: { label: "海洋（青蓝）", color: "#a8e6ff", glow: "#4fb3ff" },
			neon: { label: "霓虹（品红）", color: "#ff9ef5", glow: "#b06bff" },
			forest: { label: "森林（青绿）", color: "#b8f5c8", glow: "#4fd18b" },
			mono: { label: "黑白（极简）", color: "#f2f2f2", glow: "#9a9a9a" },
		};
		function readAmbient() {
			try {
				const raw = JSON.parse(localStorage.getItem(AMBIENT_KEY) || "{}");
				const out = {};
				out.enabled = raw?.enabled !== false; // default on
				out.style = AMBIENT_STYLES.some(([id]) => id === raw?.style) ? raw.style : "glow";
				out.anim = AMBIENT_ANIMS.some(([id]) => id === raw?.anim) ? raw.anim : "ripple-wave";
				out.orientation = AMBIENT_ORIENTS.some(([id]) => id === raw?.orientation) ? raw.orientation
					: (raw?.layout === "vertical" ? "vertical" : "tilt");
				out.angle = Number.isFinite(raw?.angle) ? Math.min(25, Math.max(0, raw.angle)) : 12;
				out.singleLine = raw?.singleLine === true;
				out.maxLines = Number.isFinite(raw?.maxLines) ? Math.min(4, Math.max(1, Math.round(raw.maxLines))) : 2;
				// Legacy: a single 0..2 `amplitude` scaled both knobs.
				const legacy = Number.isFinite(raw?.amplitude) ? Math.max(0, Math.min(2, raw.amplitude)) : null;
				out.jump = Number.isFinite(raw?.jump) ? Math.min(30, Math.max(0, raw.jump))
					: (legacy !== null ? Math.round(10 * legacy) : 10);
				out.fall = Number.isFinite(raw?.fall) ? Math.min(128, Math.max(0, raw.fall))
					: (legacy !== null ? Math.round(48 * legacy) : 48);
				out.colorMode = COLOR_MODES.some(([id]) => id === raw?.colorMode) ? raw.colorMode
					: (raw && (raw.color || raw.glow) ? "manual" : "theme");
				out.preset = raw && COLOR_PRESETS[raw.preset] ? raw.preset : "ocean";
				if (/^#[0-9a-f]{6}$/i.test(raw?.color || "")) out.color = raw.color;
				if (/^#[0-9a-f]{6}$/i.test(raw?.glow || "")) out.glow = raw.glow;
				if (/^#[0-9a-f]{6}$/i.test(raw?.ga || "")) out.ga = raw.ga;
				if (/^#[0-9a-f]{6}$/i.test(raw?.gb || "")) out.gb = raw.gb;
				if (/^#[0-9a-f]{6}$/i.test(raw?.transColor || "")) out.transColor = raw.transColor;
				if (Number.isFinite(raw?.fontSize)) out.fontSize = Math.min(32, Math.max(12, Math.round(raw.fontSize)));
				if (typeof raw?.font === "string" && raw.font.length <= 200) out.font = raw.font;
				out.customEnabled = raw?.customEnabled === true;
				if (typeof raw?.customText === "string") out.customText = raw.customText.slice(0, 4000);
				if (Number.isFinite(raw?.customHold)) out.customHold = Math.min(30, Math.max(1, Math.round(raw.customHold)));
				return out;
			} catch { return { enabled: true, style: "glow", anim: "ripple-wave", layout: "horizontal", jump: 10, fall: 48, maxLines: 2, colorMode: "theme" }; }
		}
		function writeAmbient(next) {
			try { localStorage.setItem(AMBIENT_KEY, JSON.stringify(next)); }
			catch { return false; }
			window.dispatchEvent(new Event(AMBIENT_EVENT));
			return true;
		}
		function useAmbient() {
			const [prefs, setPrefs] = useState(readAmbient);
			useEffect(() => {
				const refresh = () => setPrefs(readAmbient());
				window.addEventListener(AMBIENT_EVENT, refresh);
				window.addEventListener("storage", refresh);
				return () => { window.removeEventListener(AMBIENT_EVENT, refresh); window.removeEventListener("storage", refresh); };
			}, []);
			return prefs;
		}

		// Font names are quoted individually; arbitrary CSS never accepted.
		function fontStack(value) {
			return String(value || "").split(/[,，]/).map(x => x.trim()).filter(Boolean)
				.map(x => JSON.stringify(x)).join(", ") || "inherit";
		}

		/**
		 * Dominant colour of the album cover, for "follow the cover" text
		 * colour. Same-origin route → no canvas tainting. The average is
		 * pushed toward readable-on-dark: saturation up, lightness clamped
		 * into a mid-high band, so a very dark/bright cover still yields
		 * legible lyric text.
		 */
		function sampleCoverColor(src) {
			return new Promise((resolve, reject) => {
				if (typeof document === "undefined" || typeof Image !== "function") {
					reject(new Error("no-canvas"));
					return;
				}
				const img = new Image();
				const timer = setTimeout(() => reject(new Error("timeout")), 8000);
				img.onerror = () => { clearTimeout(timer); reject(new Error("load")); };
				img.onload = () => {
					clearTimeout(timer);
					try {
						const canvas = document.createElement("canvas");
						const size = 12;
						canvas.width = size; canvas.height = size;
						const ctx = canvas.getContext("2d", { willReadFrequently: true });
						if (!ctx) { reject(new Error("ctx")); return; }
						ctx.drawImage(img, 0, 0, size, size);
						const data = ctx.getImageData(0, 0, size, size).data;
						let r = 0, g = 0, b = 0, n = 0;
						for (let i = 0; i < data.length; i += 4) {
							if (data[i + 3] < 128) continue;
							r += data[i]; g += data[i + 1]; b += data[i + 2]; n += 1;
						}
						if (n === 0) { reject(new Error("empty")); return; }
						resolve(readableColor(r / n, g / n, b / n));
					} catch (err) { reject(err); }
				};
				img.src = src;
			});
		}
		function readableColor(r, g, b) {
			// RGB -> HSL, lift saturation, clamp lightness for contrast.
			r /= 255; g /= 255; b /= 255;
			const max = Math.max(r, g, b), min = Math.min(r, g, b);
			let h = 0, s = 0;
			const l = (max + min) / 2;
			if (max !== min) {
				const d = max - min;
				s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
				if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
				else if (max === g) h = ((b - r) / d + 2) / 6;
				else h = ((r - g) / d + 4) / 6;
			}
			const sat = Math.min(1, Math.max(0.35, s));
			const light = Math.min(0.78, Math.max(0.58, l));
			return hslToHex(h, sat, light);
		}
		function hslToHex(h, s, l) {
			const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
			const p = 2 * l - q;
			const channel = (t) => {
				let u = t;
				if (u < 0) u += 1;
				if (u > 1) u -= 1;
				if (u < 1 / 6) return p + (q - p) * 6 * u;
				if (u < 1 / 2) return q;
				if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
				return p;
			};
			const hex = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
			return "#" + hex(channel(h + 1 / 3)) + hex(channel(h)) + hex(channel(h - 1 / 3));
		}
		function clampPlacement(x, y, width, height, vw, vh) {
			const half = Math.min(width / 2, Math.max(0, (vw - 16) / 2));
			return { x: Math.max(8 + half, Math.min(vw - 8 - half, x)),
				y: Math.max(8, Math.min(Math.max(8, vh - height - 8), y)) };
		}

		const h = ReactApi === undefined ? null : ReactApi.createElement;
		const useState = ReactApi === undefined ? null : ReactApi.useState;
		const useEffect = ReactApi === undefined ? null : ReactApi.useEffect;
		const useRef = ReactApi === undefined ? null : ReactApi.useRef;

		/* ---------------- track state (polled once, shared) ---------------- */

		/** Binary search: index of the last line with t <= pos (-1 before first). */
		function currentLineIndex(lines, pos) {
			let lo = 0;
			let hi = lines.length - 1;
			let ans = -1;
			while (lo <= hi) {
				const mid = (lo + hi) >> 1;
				if (lines[mid].t <= pos) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
			}
			return ans;
		}

		// Sample-and-hold aware clock (same contract as the original island).
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

		/** One poller for the whole bundle: state snapshot + clock + tick. */
		function useTrackState() {
			const [st, setSt] = useState(null);
			const [tick, setTick] = useState(0);
			const anchorRef = useRef(null);
			if (!anchorRef.current) anchorRef.current = createPlaybackClock();
			const pollRef = useRef(0);
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
			/* Local tick for extrapolation between polls. */
			useEffect(() => {
				const timer = setInterval(() => setTick((value) => value + 1), 250);
				return () => clearInterval(timer);
			}, []);
			void tick;
			return { st, clock: anchorRef.current };
		}

		// At most two layers: outgoing lyric fades out while the current one fades in.
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

		/* ================= ambient floating lyrics ================= */

		/**
		 * Random spot inside a side band, rejecting candidates that would
		 * land on top of a line already on screen. The side is random (not
		 * alternating) so consecutive lines do not ping-pong left/right.
		 *
		 * orientation: "tilt" (random angle), "horizontal" (exact 0°),
		 * "vertical" (exact orthogonal column — CSS writing-mode makes the
		 * glyphs run top-to-bottom while staying upright).
		 */
		function nextPlacement(alive, orientation, angle) {
			const pend = Array.isArray(alive) ? alive : [];
			const maxAngle = Number.isFinite(angle) ? Math.max(0, Math.min(25, angle)) : 12;
			let fallback = null;
			for (let attempt = 0; attempt < 28; attempt += 1) {
				const side = Math.random() < 0.5 ? "left" : "right";
				const x = side === "left" ? 0.12 + Math.random() * 0.14 : 0.74 + Math.random() * 0.14;
				const y = 0.18 + Math.random() * 0.62;
				const rot = orientation === "vertical" || orientation === "horizontal"
					? 0
					: (Math.random() * 2 - 1) * maxAngle;
				const candidate = { side, x, y, rot };
				if (fallback === null) fallback = candidate;
				const clash = pend.some(f => f.side === side && Math.abs(f.y - y) < 0.17);
				if (!clash) return candidate;
			}
			// Fully occupied band: jitter the fallback slightly so it is still varied.
			return { ...fallback, y: Math.min(0.8, fallback.y + (Math.random() * 0.06 - 0.03)) };
		}

		/**
		 * Floating-line budget: keep at most `maxLines` lines ALIVE at once.
		 * A new line joins the screen; previous lines keep waving until the
		 * budget is exceeded, and only then the OLDEST alive lines start
		 * their staggered exit (from now). Exiting lines stay rendered until
		 * the caller's removal timer drops them.
		 */
		function selectFloats(floats, fresh, maxLines, nowMs) {
			const kept = floats.filter(f => f.key !== fresh.key);
			const target = [...kept, fresh];
			const alive = target.reduce((n, f) => n + (f.exitAt === null ? 1 : 0), 0);
			let over = alive - maxLines;
			const keep = [];
			const retire = [];
			for (const f of target) {
				if (f.exitAt === null && over > 0) {
					retire.push({ ...f, exitAt: nowMs });
					over -= 1;
				} else {
					keep.push(f);
				}
			}
			return { floats: [...keep, ...retire], retire };
		}

		/* ---- glyph choreography, ported from limpbus-lyrics glyph_motion.py ----
		 * There the song position is the animation clock; here wall-clock
		 * elapsed time stands in for it, so every frame is derived from time
		 * alone (pause/re-render cannot leave stale state).
		 *
		 *   reveal_phase   : glyph N starts REVEAL_INTERVAL after N-1, fades
		 *                    over REVEAL_FADE, damped shiver while settling
		 *   stagger        : exit spreads across EXIT_WINDOW in rank order
		 *   wave / jitter  : continuous motion after the entrance settles
		 *   fall_*         : EXIT drops with leaving² acceleration (+8°/-8°
		 *                    rotation), not an entrance drop
		 *   classic        : whole-line fade (300 in / 600 out) + drift
		 */
		const EXIT_WINDOW = 700; // ms, whole exit window (exit_duration 600 + margin)
		const REVEAL_INTERVAL = 90; // ms between consecutive glyph entries
		const REVEAL_FADE = 140; // ms per-glyph fade
		const CLASSIC_ENTRY = 300;
		const CLASSIC_EXIT = 600;
		const FALL_BASE = 48; // px at a 32px font; scales with the configured size
		// jump * (.35 + .65 * energy) with jump = 10 and energy = .32 (the
		// reference uses a fixed .32 energy when audio reaction is off).
		const AMPLITUDE = 10 * (0.35 + 0.65 * 0.32);

		function smooth(value) {
			const v = Math.max(0, Math.min(1, value));
			return v * v * (3 - 2 * v);
		}
		function noiseValue(seed, rank, axis, sample) {
			let v = (Math.imul(seed, 0x9E3779B1) + Math.imul(rank, 0x85EBCA77)
				+ Math.imul(axis, 0xC2B2AE3D) + (sample | 0)) >>> 0;
			v = Math.imul(v ^ (v >>> 16), 0x7FEB352D) >>> 0;
			v = Math.imul(v ^ (v >>> 15), 0x846CA68B) >>> 0;
			return ((v ^ (v >>> 16)) >>> 0) / 0xFFFFFFFF * 2 - 1;
		}
		function noise(seed, rank, axis, seconds, frequency) {
			const clock = seconds * frequency;
			const sample = Math.floor(clock);
			const weight = smooth(clock - sample);
			const first = noiseValue(seed, rank, axis, sample);
			return first + (noiseValue(seed, rank, axis, sample + 1) - first) * weight;
		}
		function revealPhase(pos, start, end, rank, count, interval, fade) {
			const total = Math.max(0, end - start);
			if (total === 0) return pos >= end ? 1 : 0;
			fade = Math.min(fade, total);
			if (count > 1) interval = Math.min(interval, Math.max(0, (total - fade) / (count - 1)));
			return Math.max(0, Math.min(1, (pos - start - rank * interval) / Math.max(1e-6, fade)));
		}
		function staggerPhase(pos, start, end, rank, count, duration) {
			const total = Math.max(0, end - start);
			if (total === 0) return pos >= end ? 1 : 0;
			duration = Math.min(duration, total);
			const delay = count > 1 ? (total - duration) * rank / (count - 1) : 0;
			return Math.max(0, Math.min(1, (pos - start - delay) / duration));
		}

		/**
		 * Glyph entries for one language group (original text or its
		 * translation). Spaces keep their advance but never take a slot in
		 * the stagger cadence, matching the reference (zero-ink glyphs are
		 * skipped there too).
		 */
		function glyphEntries(refs, text) {
			const chars = Array.from(text);
			const entries = [];
			for (let i = 0; i < chars.length; i += 1) {
				const el = refs.current[i];
				if (!el) continue;
				const space = chars[i] === " " || chars[i] === "\u3000";
				entries.push({ el, space, rank: 0 });
			}
			let rank = 0;
			for (const entry of entries) if (!entry.space) entry.rank = rank++;
			return { entries, count: rank };
		}

		function charSpans(text, refs) {
			return Array.from(text).map((ch, i) => h("span", {
				key: i,
				className: "dnla-ch" + (ch === " " ? " dnla-space" : ""),
				ref: (el) => { refs.current[i] = el; },
			}, ch === " " ? "\u00a0" : ch));
		}

		function FloatLine(props) {
			const f = props.float;
			const mainRefs = useRef([]);
			const transRefs = useRef([]);
			const live = useRef(props);
			live.current = props;
			const timing = useRef({ bornAt: f.bornAt || 0, exitAt: f.exitAt ?? null, pausedAt: 0 });

			useEffect(() => {
				let stopped = false;
				let rafId = 0;
				const raf = typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
					? window.requestAnimationFrame.bind(window) : (fn) => setTimeout(() => fn(Date.now()), 16);
				const reduced = typeof window !== "undefined" && typeof window.matchMedia === "function"
					&& window.matchMedia("(prefers-reduced-motion: reduce)").matches;
				// Glyph groups never change for a mounted line: resolve once.
				const groups = { main: null, trans: null };

				const frame = (now) => {
					if (stopped) return;
					const p = live.current;
					const t = timing.current;
					// Adopt timestamps from the latest props: the exit clock
					// starts on the render that retires this line.
					if (Number(p.float.bornAt) && p.float.bornAt !== t.bornAt) t.bornAt = p.float.bornAt;
					const nextExit = p.float.exitAt ?? null;
					if (nextExit !== t.exitAt) t.exitAt = nextExit;
					if (p.frozen === true) {
						t.pausedAt = t.pausedAt || now;
						rafId = raf(frame);
						return;
					}
					if (t.pausedAt) {
						const delta = now - t.pausedAt;
						t.bornAt += delta;
						if (t.exitAt !== null) t.exitAt += delta;
						t.pausedAt = 0;
					}
					const age = now - t.bornAt;
					const exitAge = t.exitAt !== null ? now - t.exitAt : null;
					const anim = p.anim || "ripple-wave";
					const spanMs = Math.max(1, Number(f.spanMs) || 6000);
					// Two independent knobs, exactly like the reference:
					// `jump` (律动幅度, 0-30) drives the wave/jitter amplitude,
					// `fall` (跌落距离, 0-128 px at a 32px font) the exit drop.
					const jump = Number.isFinite(p.jump) ? Math.max(0, Math.min(30, p.jump)) : 10;
					const fallPx = Number.isFinite(p.fall) ? Math.max(0, Math.min(128, p.fall)) : 48;
					const amp = jump * (0.35 + 0.65 * 0.32);
					const fallDistance = fallPx * (Number(p.fontSize) || 18) / 32;
					const tilt = (Number(f.rot) || 0) * Math.PI / 180;
					const falling = anim === "drop-wave" || anim === "drop-jitter";
					const shaking = anim === "ripple-jitter" || anim === "drop-jitter";

					const applyGroup = (slot, refs, text, seedBase) => {
						if (groups[slot] === null) groups[slot] = glyphEntries(refs, text);
						const group = groups[slot];
						const entryEnd = Math.min(
							Math.max(700, REVEAL_INTERVAL * Math.max(0, group.count - 1) + REVEAL_FADE),
							Math.max(1200, spanMs * 0.8),
						);
						for (const entry of group.entries) {
							const el = entry.el;
							if (entry.space) {
								el.style.opacity = "0";
								el.style.transform = "none";
								continue;
							}
							let opacity = 1;
							let dx = 0;
							let dy = 0;
							let rot = 0;
							if (reduced) {
								opacity = exitAge !== null ? 0 : 1;
							} else if (anim === "classic-fade") {
								// Whole-line fade. A line that is merely KEPT on screen
								// (maxLines budget) stays fully visible past its sung
								// interval; only a displaced line fades out.
								const fadeIn = Math.max(1, Math.min(CLASSIC_ENTRY, spanMs / 2));
								const inOpacity = Math.min(1, age / fadeIn);
								const outOpacity = exitAge !== null
									? Math.max(0, 1 - smooth(exitAge / CLASSIC_EXIT))
									: 1;
								opacity = inOpacity * outOpacity;
								const remaining = exitAge !== null
									? Math.max(0, CLASSIC_EXIT - exitAge)
									: Math.max(0, spanMs - age);
								dy = 8 * (1 - Math.min(1, remaining / CLASSIC_EXIT))
									- 5 * (1 - Math.min(1, age / CLASSIC_ENTRY));
							} else {
								const entering = revealPhase(age, 0, entryEnd, entry.rank, group.count, REVEAL_INTERVAL, REVEAL_FADE);
								const leaving = exitAge === null ? 0
									: staggerPhase(exitAge, 0, EXIT_WINDOW, entry.rank, group.count, falling ? 350 : 200);
								const settle = smooth(entering);
								opacity = settle * (1 - smooth(leaving));
								const sec = age / 1000;
								const seed = 11 + seedBase;
								if (shaking) {
									dx = amp * 0.3 * noise(seed, entry.rank, 0, sec, 6);
									dy = amp * 0.5 * noise(seed, entry.rank, 1, sec, 6);
								} else {
									// Damped shiver while settling, then the wave.
									dx = amp * 0.3 * noise(seed, entry.rank, 0, sec, 6) * (1 - settle);
									dy = amp * 0.4 * Math.sin(sec * 2 * Math.PI * 1.5 - entry.rank * 0.6) * settle
										+ amp * 0.5 * noise(seed, entry.rank, 1, sec, 6) * (1 - settle);
								}
								if (falling) {
									const distance = fallDistance * leaving * leaving;
									// Screen-vertical fall expressed in the tilted line frame.
									dx += Math.sin(tilt) * distance;
									dy += Math.cos(tilt) * distance;
									rot = (noiseValue(seed, entry.rank, 2, 0) >= 0 ? 8 : -8) * leaving * leaving;
								}
							}
							el.style.opacity = opacity.toFixed(3);
							el.style.transform = (Math.abs(dx) + Math.abs(dy) + Math.abs(rot)) < 0.01
								? "none"
								: "translate(" + dx.toFixed(2) + "px," + dy.toFixed(2) + "px)"
									+ (Math.abs(rot) > 0.01 ? " rotate(" + rot.toFixed(2) + "deg)" : "");
						}
					};

					applyGroup("main", mainRefs, f.text, 0);
					if (f.trans) applyGroup("trans", transRefs, f.trans, 100003);
					rafId = raf(frame);
				};

				rafId = raf(frame);
				return () => {
					stopped = true;
					if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
						window.cancelAnimationFrame(rafId);
					}
				};
			}, []);

			return h("div", {
				className: "dnla-line" + (props.exiting ? " dnla-line-exit" : ""),
				style: {
					left: "clamp(12%, " + (f.x * 100).toFixed(2) + "%, 88%)",
					top: "clamp(14%, " + (f.y * 100).toFixed(2) + "%, 82%)",
					"--dnla-rot": f.rot.toFixed(2) + "deg",
				},
				"aria-hidden": "true",
			},
				h("div", { className: "dnla-line-main" }, charSpans(f.text, mainRefs)),
				f.trans
					? h("div", { className: "dnla-line-trans" }, charSpans(f.trans, transRefs))
					: null,
			);
		}

		function AmbientLyrics() {
			const prefs = useAmbient();
			const { st, clock } = useTrackState();
			const [floats, setFloats] = useState([]);
			const [customIndex, setCustomIndex] = useState(0);
			const [coverColor, setCoverColor] = useState(null);
			const lastKey = useRef(null);
			const timersRef = useRef([]);

			/* Clear pending removal timers on unmount. */
			useEffect(() => () => {
				for (const t of timersRef.current) clearTimeout(t);
			}, []);

			/* Custom text: each non-empty line becomes one floating line. */
			const customLines = prefs.customEnabled === true && typeof prefs.customText === "string"
				? prefs.customText.split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, 30)
				: [];
			const customActive = customLines.length > 0;
			const customHoldMs = Math.max(1, Math.min(30, prefs.customHold === undefined ? 4 : prefs.customHold)) * 1000;
			const customSig = customLines.join("\n");

			/* Cycle custom lines on a hold timer (independent of playback). */
			useEffect(() => {
				if (!customActive) return;
				const timer = setInterval(() => setCustomIndex(i => i + 1), customHoldMs);
				return () => clearInterval(timer);
			}, [customActive, customHoldMs, customLines.length]);
			useEffect(() => { setCustomIndex(0); }, [customSig]);

			/* "Follow the cover": sample the current artwork's dominant colour. */
			useEffect(() => {
				if (prefs.colorMode !== "cover") return;
				const serial = st !== null && st.active === true ? Number(st.coverSerial) || 0 : 0;
				if (!serial) return;
				let cancelled = false;
				sampleCoverColor(COVER_ROUTE + "?v=" + serial)
					.then(color => { if (!cancelled) setCoverColor(color); })
					.catch(() => { if (!cancelled) setCoverColor(null); });
				return () => { cancelled = true; };
			}, [prefs.colorMode, st !== null && st.active === true ? Number(st.coverSerial) || 0 : 0]);

			const playing = st !== null && st.active === true && st.playing === true;
			if (!customActive && (st === null || st.active !== true || prefs.enabled === false)) {
				if (floats.length !== 0 || lastKey.current !== null) {
					lastKey.current = null;
					setFloats([]);
				}
				return null;
			}
			if (customActive && prefs.enabled === false) {
				if (floats.length !== 0 || lastKey.current !== null) {
					lastKey.current = null;
					setFloats([]);
				}
				return null;
			}

			/* Resolve the active line source: custom text beats the SMTC lyric. */
			let text = null;
			let trans = null;
			let key = null;
			let spanMs = 6000;
			if (customActive) {
				const idx = customIndex % customLines.length;
				text = customLines[idx];
				key = "custom|" + idx;
				spanMs = customHoldMs;
			} else {
				const lyric = st.lyric !== null && typeof st.lyric === "object" ? st.lyric : { status: "idle" };
				const lines = Array.isArray(lyric.lines) ? lyric.lines : [];
				const index = lines.length > 0 ? currentLineIndex(lines, clock.read(Date.now())) : -1;
				if (lyric.status === "matched" && index >= 0) {
					text = lines[index].text;
					trans = typeof lines[index].trans === "string" && lines[index].trans.trim() !== "" ? lines[index].trans : null;
					key = [lyric.songId, index].join("|");
					spanMs = lines[index + 1] && Number(lines[index + 1].t) > Number(lines[index].t)
						? (Number(lines[index + 1].t) - Number(lines[index].t)) * 1000
						: 6000;
				}
			}

			if (key !== null && key !== lastKey.current) {
				lastKey.current = key;
				const nowMs = typeof performance !== "undefined" && typeof performance.now === "function"
					? performance.now() : Date.now();
				const aliveNow = floats.filter(f => f.exitAt === null);
				const placement = nextPlacement(aliveNow, prefs.orientation || "tilt", prefs.angle);
				const fresh = { key, text, trans, ...placement, bornAt: nowMs, exitAt: null, spanMs };
				const maxLines = Math.min(4, Math.max(1, Number(prefs.maxLines) || 2));
				const selection = selectFloats(floats, fresh, maxLines, nowMs);
				setFloats(selection.floats);
				for (const old of selection.retire) {
					const t = setTimeout(() => {
						timersRef.current = timersRef.current.filter(x => x !== t);
						setFloats(list => list.filter(f => f.key !== old.key));
					}, EXIT_WINDOW + 1200);
					timersRef.current.push(t);
				}
			} else if (key === null && lastKey.current !== null) {
				// Track ended / unmatched / custom cleared: drop everything.
				lastKey.current = null;
				setFloats([]);
			}

			const style = {};
			const mode = prefs.colorMode || "theme";
			if (mode === "cover" && coverColor) {
				style["--dnla-color"] = coverColor;
				style["--dnla-glow"] = coverColor;
			} else if (mode === "preset") {
				const preset = COLOR_PRESETS[prefs.preset] || COLOR_PRESETS.ocean;
				style["--dnla-color"] = preset.color;
				style["--dnla-glow"] = preset.glow;
			} else if (mode === "manual") {
				if (prefs.color) style["--dnla-color"] = prefs.color;
				if (prefs.glow) style["--dnla-glow"] = prefs.glow;
			}
			// mode === "theme": no inline colour, CSS falls back to theme tokens.
			if (prefs.ga) style["--dnla-ga"] = prefs.ga;
			if (prefs.gb) style["--dnla-gb"] = prefs.gb;
			if (prefs.transColor) style["--dnla-trans-color"] = prefs.transColor;
			if (prefs.font) style["--dnla-font"] = fontStack(prefs.font);
			if (prefs.fontSize) style["--dnla-size"] = prefs.fontSize + "px";
			style.pointerEvents = "none";

			const frozen = customActive ? false : !playing;
			return h("div", {
				className: "dnla-layer dnla-style-" + (prefs.style || "glow")
					+ " dnla-anim-" + (prefs.anim || "ripple-wave")
					+ " dnla-orient-" + (prefs.orientation || "tilt")
					+ (prefs.singleLine === true ? " dnla-single" : "")
					+ (prefs.transColor ? " dnla-trans-custom" : "")
					+ (frozen ? " dnla-frozen" : ""),
				style,
			},
				floats.map(f => h(FloatLine, {
					key: f.key,
					float: f,
					exiting: f.exitAt !== null,
					frozen,
					anim: prefs.anim || "ripple-wave",
					fontSize: prefs.fontSize || 18,
					jump: prefs.jump === undefined ? 10 : prefs.jump,
					fall: prefs.fall === undefined ? 48 : prefs.fall,
				})),
			);
		}

		/* ================= original lyric island ================= */

		function LyricIsland() {
			const colors = useColors();
			const { st, clock } = useTrackState();
			const prefs = useDisplay();
			const [dragPosition, setDragPosition] = useState(null);
			const hostRef = useRef(null);
			const dragRef = useRef(null);
			const suppressClick = useRef(false);
			const [expanded, setExpanded] = useState(false);
			const [pinned, setPinned] = useState(false);
			const [rematching, setRematching] = useState(false);

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

			const pos = clock.read(Date.now());
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

		/* ================= settings (island + ambient) ================= */

		function BundleSettings(props) {
			const colors = useColors();
			const prefs = useDisplay();
			const ambient = useAmbient();
			const [error, setError] = useState("");
			if (props.view === "summary") return "歌词胶囊与环境悬浮歌词：颜色、字体、位置与开关";
			const saveDisplay = (next) => setError(writeDisplay(next) ? "" : "浏览器无法保存设置，请检查存储权限。");
			const saveColors = (next) => setError(writeColors(next) ? "" : "浏览器无法保存设置，请检查存储权限。");
			const saveAmbient = (next) => setError(writeAmbient(next) ? "" : "浏览器无法保存设置，请检查存储权限。");
			return h("section", { className: "dnla-settings" },
				/* ---- ambient ---- */
				h("h3", null, "环境悬浮歌词（limpbus 风格）"),
				h("p", null, "歌词句随机浮现在面板左右两侧，轻微倾斜、逐字浮现并随播放轻轻起伏（译文与原文同步动画）；暂停时冻结。"),
				h("label", { className: "dnla-row" },
					h("input", { type: "checkbox", checked: ambient.enabled !== false,
						onChange: (event) => saveAmbient({ ...readAmbient(), enabled: event.target.checked }) }),
					h("span", null, "启用环境悬浮歌词")),
				/* ---- custom text ---- */
				h("h4", { style: { margin: "14px 0 4px" } }, "自定义文本（暂时代替播放器歌词）"),
				h("label", { className: "dnla-row" },
					h("input", { type: "checkbox", checked: ambient.customEnabled === true,
						"aria-label": "启用自定义文本",
						onChange: (event) => saveAmbient({ ...readAmbient(), customEnabled: event.target.checked }) }),
					h("span", null, "启用自定义文本悬浮")),
				h("label", { className: "dnla-font-row" }, "悬浮内容（每行一句，最多 30 句；开启后不再跟随网易云/QQ 歌词）",
					h("textarea", { "aria-label": "自定义悬浮文本", rows: 5, maxLength: 4000,
						placeholder: "例如：\n今晚的月色真美\n风也温柔",
						value: ambient.customText || "",
						onChange: event => saveAmbient({ ...readAmbient(), customText: event.target.value }) })),
				h("label", { className: "dnla-row" }, "每句停留（1–30 秒，默认 4）",
					h("input", { type: "number", min: 1, max: 30, "aria-label": "自定义文本停留秒数",
						value: ambient.customHold ?? 4,
						onChange: (event) => {
							const v = Number(event.target.value);
							if (Number.isFinite(v)) saveAmbient({ ...readAmbient(), customHold: Math.min(30, Math.max(1, Math.round(v))) });
						} })),
				/* ---- layout ---- */
				h("h4", { style: { margin: "14px 0 4px" } }, "排版与密度"),
				h("label", { className: "dnla-row" }, "出现方向",
					h("select", { "aria-label": "悬浮出现方向", value: ambient.orientation || "tilt",
						onChange: (event) => saveAmbient({ ...readAmbient(), orientation: event.target.value }) },
						AMBIENT_ORIENTS.map(([id, label]) => h("option", { key: id, value: id }, label))),
					h("span", null, "倾斜＝每句随机角度出现（原版观感）；横向/竖向＝严格水平或垂直出现，不带倾斜")),
				(ambient.orientation === "tilt" || ambient.orientation === undefined)
					? h("label", { className: "dnla-row" }, "倾斜角度（0–25°，默认 12°；仅“倾斜出现”生效）",
						h("input", { type: "number", min: 0, max: 25, step: 1, "aria-label": "悬浮倾斜角度",
							value: ambient.angle ?? 12,
							onChange: (event) => {
								const v = Number(event.target.value);
								if (Number.isFinite(v)) saveAmbient({ ...readAmbient(), angle: Math.min(25, Math.max(0, v)) });
							} }))
					: null,
				h("label", { className: "dnla-row" }, "同屏句数（1–4，默认 2；超出后最旧的先退场）",
					h("input", { type: "number", min: 1, max: 4, "aria-label": "悬浮同屏句数",
						value: ambient.maxLines ?? 2,
						onChange: (event) => {
							const v = Number(event.target.value);
							if (Number.isFinite(v)) saveAmbient({ ...readAmbient(), maxLines: Math.min(4, Math.max(1, Math.round(v))) });
						} })),
				h("label", { className: "dnla-row" },
					h("input", { type: "checkbox", checked: ambient.singleLine === true,
						onChange: (event) => saveAmbient({ ...readAmbient(), singleLine: event.target.checked }) }),
					h("span", null, "允许单行显示（长句不自动换行，可能横跨窗口中部）")),
				/* ---- motion ---- */
				h("h4", { style: { margin: "14px 0 4px" } }, "律动与动效"),
				h("label", { className: "dnla-row" }, "动效样式",
					h("select", { "aria-label": "悬浮动效样式", value: ambient.anim || "ripple-wave",
						onChange: (event) => saveAmbient({ ...readAmbient(), anim: event.target.value }) },
						AMBIENT_ANIMS.map(([id, label]) => h("option", { key: id, value: id }, label))),
					h("span", null, "逐字入场为淡入 + 轻微阻尼颤动；波纹＝退场原地逐字淡出，跌落＝退场逐字加速下坠并轻微旋转；波动＝正弦行进波，抖动＝平滑噪声颤动")),
				h("label", { className: "dnla-row" }, "律动幅度（0–30，默认 10；调小更稳、调大更活跃）",
					h("input", { type: "number", min: 0, max: 30, "aria-label": "悬浮律动幅度",
						value: ambient.jump ?? 10,
						onChange: (event) => {
							const v = Number(event.target.value);
							if (Number.isFinite(v)) saveAmbient({ ...readAmbient(), jump: Math.min(30, Math.max(0, v)) });
						} })),
				h("label", { className: "dnla-row" }, "跌落距离（0–128，默认 48；仅“跌落”类动效的退场下坠距离）",
					h("input", { type: "number", min: 0, max: 128, "aria-label": "悬浮跌落距离",
						value: ambient.fall ?? 48,
						onChange: (event) => {
							const v = Number(event.target.value);
							if (Number.isFinite(v)) saveAmbient({ ...readAmbient(), fall: Math.min(128, Math.max(0, v)) });
						} })),
				h("p", null, "入场/退场节奏为固定值；律动幅度与跌落距离互不影响。"),
				/* ---- colour ---- */
				h("h4", { style: { margin: "14px 0 4px" } }, "颜色与文字样式"),
				h("label", { className: "dnla-row" }, "文字样式",
					h("select", { "aria-label": "悬浮文字样式", value: ambient.style || "glow",
						onChange: (event) => saveAmbient({ ...readAmbient(), style: event.target.value }) },
						AMBIENT_STYLES.map(([id, label]) => h("option", { key: id, value: id }, label))),
					h("span", null, "白芯发光＝白字芯+彩色光晕；经典纯色＝纯色加深影；渐变字芯＝双色渐变文字；卡门的声音＝暖白字芯+琥珀光晕")),
				h("label", { className: "dnla-row" }, "文字颜色模式",
					h("select", { "aria-label": "悬浮文字颜色模式", value: ambient.colorMode || "theme",
						onChange: (event) => saveAmbient({ ...readAmbient(), colorMode: event.target.value }) },
						COLOR_MODES.map(([id, label]) => h("option", { key: id, value: id }, label)))),
				(ambient.colorMode === "preset")
					? h("label", { className: "dnla-row" }, "预设配色",
						h("select", { "aria-label": "悬浮预设配色", value: ambient.preset || "ocean",
							onChange: (event) => saveAmbient({ ...readAmbient(), preset: event.target.value }) },
							Object.entries(COLOR_PRESETS).map(([id, def]) => h("option", { key: id, value: id }, def.label))))
					: null,
				(ambient.colorMode === "cover")
					? h("p", null, "跟随封面：读取当前专辑封面主色并自动提升可读性；无封面或采样失败时回退主题色。")
					: null,
				(ambient.colorMode === "theme")
					? h("p", null, "跟随主题：原文走主题主文字色、光晕走主题强调色，明暗主题自动适配。")
					: null,
				(ambient.style === "gradient")
					? h("label", { className: "dnla-row" }, "渐变双色",
						h("input", { type: "color", "aria-label": "渐变起始色", value: ambient.ga || "#7aa2ff",
							onChange: (event) => saveAmbient({ ...readAmbient(), ga: event.target.value }) }),
						h("span", null, "→"),
						h("input", { type: "color", "aria-label": "渐变结束色", value: ambient.gb || "#e879f9",
							onChange: (event) => saveAmbient({ ...readAmbient(), gb: event.target.value }) }))
					: null,
				(ambient.colorMode === "manual" && ambient.style !== "gradient")
					? h("label", { className: "dnla-row" }, "悬浮文字颜色（留空跟随主题）",
						h("input", { type: "color", "aria-label": "悬浮文字颜色", value: ambient.color || "#e8e8ec",
							onChange: (event) => saveAmbient({ ...readAmbient(), color: event.target.value }) }),
						h("button", { type: "button", disabled: !ambient.color, onClick: () => {
							const next = { ...readAmbient() }; delete next.color; saveAmbient(next);
						} }, "恢复默认"))
					: null,
				(ambient.colorMode === "manual" && ambient.style === "glow")
					? h("label", { className: "dnla-row" }, "悬浮光晕颜色（留空跟随主题强调色）",
						h("input", { type: "color", "aria-label": "悬浮光晕颜色", value: ambient.glow || "#7aa2ff",
							onChange: (event) => saveAmbient({ ...readAmbient(), glow: event.target.value }) }),
						h("button", { type: "button", disabled: !ambient.glow, onClick: () => {
							const next = { ...readAmbient() }; delete next.glow; saveAmbient(next);
						} }, "恢复默认"))
					: null,
				h("label", { className: "dnla-row" }, "译文颜色（仅翻译行；留空跟随原文颜色）",
					h("input", { type: "color", "aria-label": "悬浮译文颜色", value: ambient.transColor || "#a9b4c8",
						onChange: (event) => saveAmbient({ ...readAmbient(), transColor: event.target.value }) }),
					h("button", { type: "button", disabled: !ambient.transColor, onClick: () => {
						const next = { ...readAmbient() }; delete next.transColor; saveAmbient(next);
					} }, "恢复默认")),
				/* ---- type ---- */
				h("h4", { style: { margin: "14px 0 4px" } }, "字体"),
				h("label", { className: "dnla-row" }, "悬浮字号（12–32px，默认 18）",
					h("input", { type: "number", min: 12, max: 32, "aria-label": "悬浮字号",
						value: ambient.fontSize ?? 18,
						onChange: (event) => {
							const v = Number(event.target.value);
							if (Number.isFinite(v)) saveAmbient({ ...readAmbient(), fontSize: Math.min(32, Math.max(12, Math.round(v))) });
						} })),
				h("label", { className: "dnla-font-row" }, "悬浮歌词字体（本机已安装的字体名称，可用逗号分隔；留空跟随下方胶囊字体）",
					h("input", { type: "text", "aria-label": "悬浮歌词字体", maxLength: 200,
						placeholder: "例如：Microsoft YaHei, Noto Sans CJK SC", value: ambient.font || "",
						onChange: event => saveAmbient({ ...readAmbient(), font: event.target.value }) })),
				h("button", { type: "button", onClick: () => {
					const next = { ...readAmbient() }; delete next.font; saveAmbient(next);
				} }, "恢复默认悬浮字体"),
				/* ---- island (original) ---- */
				h("h3", { style: { marginTop: "20px" } }, "歌词胶囊（原版浮窗）"),
				h("p", null, "修改后立即生效，保存在当前浏览器。未自定义的颜色跟随明暗主题。"),
				...COLOR_FIELDS.map(([key, label]) => h("label", { key, className: "dnl-color-row" },
					h("span", null, label),
					h("input", { type: "color", "aria-label": label, value: colors[key] || "#808080",
						onChange: (event) => saveColors({ ...readColors(), [key]: event.target.value }) }),
					h("span", null, colors[key] || "跟随主题"),
					h("button", { type: "button", disabled: !colors[key], onClick: () => {
						const next = { ...readColors() }; delete next[key]; saveColors(next);
					} }, "恢复默认"))),
				h("button", { type: "button", onClick: () => saveColors({}) }, "恢复全部主题默认"),
				h("label", { className: "dnl-font-row" }, "歌词字体（本机已安装的字体名称，可用逗号分隔）",
					h("input", { type: "text", "aria-label": "歌词字体", maxLength: 200,
						placeholder: "例如：Microsoft YaHei, Noto Sans CJK SC", value: prefs.font || "",
						onChange: event => saveDisplay({ ...readDisplay(), font: event.target.value }) })),
				h("p", null, "留空跟随 DSH 字体；字体需已安装在当前设备，未安装时由浏览器回退。"),
				h("button", { type: "button", onClick: () => saveDisplay({ ...readDisplay(), font: "" }) }, "恢复默认字体"),
				h("p", null, "拖动胶囊上的 ⠿ 手柄即可移动，位置会自动记住；默认位于顶部偏右。"),
				h("button", { type: "button", onClick: () => { const next = { ...readDisplay() }; delete next.x; delete next.y; saveDisplay(next); } }, "重置浮层位置"),
				error ? h("p", { role: "alert" }, error) : null);
		}

		function apply(ctx) {
			/** Decorative only: a missing React or slots seat must never
			 *  break the boot batch. */
			try {
				if (ReactApi === undefined) return;
				if (ctx.slots === null || typeof ctx.slots !== "object") return;
				ctx.slots.inject("shell.overlay", () => ctx.slots.register(
					{
						name: "shell.overlay",
						id: "dsh-netease-lyrics-island",
						order: 500,
						label: "歌词胶囊",
					},
					LyricIsland,
				));
				ctx.slots.inject("shell.overlay", () => ctx.slots.register(
					{
						name: "shell.overlay",
						id: "dsh-netease-lyrics-layer",
						order: 501,
						label: "环境悬浮歌词",
					},
					AmbientLyrics,
				));
				ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register(
					{ name: "plugins.bundle.config", key: "dsh-netease-lyrics" }, BundleSettings));
			} catch {
				// Overlay unavailable: nothing renders, nothing breaks.
			}
		}

		const CSS = [
			/* ---- ambient layer ---- */
			".dnla-layer{position:fixed;inset:0;z-index:999;pointer-events:none;overflow:hidden;user-select:none;font-family:var(--dnla-font,var(--dnl-font,inherit))}",
			".dnla-line{position:absolute;transform:translate(-50%,-50%) rotate(var(--dnla-rot,0deg));max-width:18vw;text-align:center;line-height:1.5;will-change:transform,opacity}",
			".dnla-line-main{display:flex;flex-wrap:wrap;justify-content:center;font-size:var(--dnla-size,18px);font-weight:600;color:var(--dnla-color,var(--dsw-alias-label-primary));text-shadow:0 0 10px var(--dnla-glow,var(--dsw-alias-brand-primary)),0 1px 2px rgba(0,0,0,.35)}",
			".dnla-line-trans{display:flex;flex-wrap:wrap;justify-content:center;margin-top:2px;font-size:calc(var(--dnla-size,18px) * .72);font-weight:400;color:var(--dnla-trans-color,var(--dnla-color,var(--dsw-alias-label-secondary)));opacity:.9;text-shadow:0 1px 2px rgba(0,0,0,.35)}",
			/* text styles (limpbus-lyrics inspired) */
			".dnla-style-classic .dnla-line-main{text-shadow:0 1px 2px rgba(0,0,0,.5)}.dnla-style-classic .dnla-line-trans{text-shadow:0 1px 2px rgba(0,0,0,.5)}",
			".dnla-style-gradient .dnla-line-main{background:linear-gradient(90deg,var(--dnla-ga,#7aa2ff),var(--dnla-gb,#e879f9));-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent;text-shadow:none}",
			".dnla-style-gradient .dnla-line-trans{background:linear-gradient(90deg,var(--dnla-ga,#7aa2ff),var(--dnla-gb,#e879f9));-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent;text-shadow:none;opacity:.85}",
			".dnla-style-carmen .dnla-line-main{color:#fff6e0;text-shadow:0 0 12px #ffb84d,0 0 4px rgba(255,180,77,.8),0 1px 2px rgba(0,0,0,.35)}",
			".dnla-style-carmen .dnla-line-trans{color:var(--dnla-trans-color,#f7ead2);text-shadow:0 0 8px rgba(255,184,77,.7),0 1px 2px rgba(0,0,0,.35)}",
			/* explicit translation colour wins over the gradient fill */
			".dnla-trans-custom .dnla-line-trans{background:none;-webkit-background-clip:border-box;background-clip:border-box;-webkit-text-fill-color:var(--dnla-trans-color);color:var(--dnla-trans-color)}",
			/* Per-glyph opacity/transform are written every frame by JS
			 * (requestAnimationFrame), which is what the reference does with
			 * its position-driven glyph loop; no CSS animation is involved,
			 * so entrance, wave, jitter and accelerated fall share one clock
			 * and pause is a pure clock freeze. */
			".dnla-ch{display:inline-block;white-space:pre;opacity:0;will-change:transform,opacity}",
			/* ---- single-line mode: no wrapping, line may span the window ---- */
			".dnla-single .dnla-line{max-width:none}",
			".dnla-single .dnla-line-main,.dnla-single .dnla-line-trans{flex-wrap:nowrap;white-space:nowrap}",
			/* ---- appearance direction: tilt (default) / horizontal / vertical ---- */
			/* Vertical: the line itself stays upright (no rotation); writing-mode
			 * makes the glyphs run top-to-bottom while staying readable. The
			 * translation becomes its own column beside the original. */
			".dnla-orient-vertical .dnla-line{max-width:none;max-height:76vh;display:flex;flex-direction:row;align-items:flex-start;justify-content:center;gap:10px}",
			".dnla-orient-vertical .dnla-line-main,.dnla-orient-vertical .dnla-line-trans{writing-mode:vertical-rl;text-orientation:upright;flex-wrap:wrap;max-height:74vh;margin-top:0}",
			".dnla-orient-vertical .dnla-line-main{justify-content:flex-start}",
			/* ---- settings ---- */
			".dnla-settings{color:var(--dsw-alias-label-primary);padding:12px 0}.dnla-settings p{color:var(--dsw-alias-label-secondary);font-size:12px}",
			".dnla-row{display:flex;align-items:center;gap:12px;padding:10px 0;flex-wrap:wrap;color:var(--dsw-alias-label-primary)}.dnla-row input[type=color]{width:40px;height:28px;cursor:pointer}.dnla-row input[type=number]{width:72px}.dnla-row select{font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:4px 8px}",
			".dnla-settings button{font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:4px 10px;cursor:pointer}.dnla-settings button:disabled{opacity:.5}",
			".dnl-color-row{display:flex;align-items:center;gap:12px;padding:10px 0;flex-wrap:wrap}.dnl-color-row input{width:40px;height:28px;cursor:pointer}",
			".dnl-font-row{display:flex;flex-direction:column;gap:8px;margin-top:16px}.dnl-font-row input,.dnl-font-row textarea{font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:6px 8px;width:min(100%,420px);resize:vertical}",
			/* ---- island (original) ---- */
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
			".dnl-drag{position:absolute;left:6px;top:50%;transform:translateY(-50%);width:20px;height:28px;padding:0;border:0;border-radius:4px;cursor:grab;touch-action:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:16px}.dnl-drag:active{cursor:grabbing}.dnl-drag:focus-visible{outline:2px solid var(--dsw-alias-brand-primary)}",
			".dnl-crossfade{display:grid;min-width:0}.dnl-fade-layer{grid-area:1/1;min-width:0}.dnl-fade-out{pointer-events:none;animation:dnl-lyric-out 220ms ease-out both}.dnl-fade-in{animation:dnl-lyric-in 220ms ease-out both}@keyframes dnl-lyric-out{from{opacity:1;transform:translateY(0)}to{opacity:0;transform:translateY(-3px)}}@keyframes dnl-lyric-in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:translateY(0)}}@media(prefers-reduced-motion:reduce){.dnl-fade-in{animation:none}.dnl-fade-out{display:none;animation:none}.dnl-island,.dnl-line-main{transition:none}}",
		].join("");
		const cssTag = "dsh-netease-lyrics/ambient.css";
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
		/** Test hook only: the pure choreography math (no runtime caller). */
		exports.__motion = { smooth, noiseValue, noise, revealPhase, staggerPhase, AMPLITUDE };
		/** Test hook only: drive one float line against fake DOM elements. */
		exports.__test = { FloatLine, selectFloats, nextPlacement };
		return module.exports;
	}
});

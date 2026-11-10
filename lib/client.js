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
		const CONTROL_ROUTE = "/dsh-netease-lyrics/control";
		const NOTICE_ACK_ROUTE = "/dsh-netease-lyrics/notice/ack";
		// How long a notice arriving during playback INSERTS itself into the
		// collapsed row before handing off to the red dot (user: 3~5 s; 4 s is
		// the midpoint). Long enough that a hover during the window genuinely
		// shows the headline.
		const NOTICE_INSERT_MS = 4000;
		// Fade duration for the disappearing pill / red dot.
		const NOTICE_FADE_MS = 260;

		const inject = ["slots"];

		/* ---- the client runtime's sessions service (optional lookup) ----
		 * The runner's dynamic facade allows ctx.get('sessions') on the browser
		 * side: DSH's own session UI keeps `retainedBy.mainView > 0` on the
		 * session the user is currently LOOKING at (its unread marker exempts
		 * the main view the same way). We mirror that: notices of the main
		 * session stay hidden while the user is in that conversation — the
		 * question card / round summary is right in front of them there.
		 * Null when the service is unavailable (bare test harnesses): no
		 * filtering, every notice shows. */
		/** owning ctx captured at apply time (used by the notice jump fallback). */
		let jumpCtx = null;
		let clientSessions = null;
		let clientWorkspaces = null;
		/* Snapshot-identity memoization: the island re-renders every 250ms
		 * while media plays (the interpolation tick), and these scans ran on
		 * EVERY render. The stores hand back the same snapshot object until
		 * data changes, so one-entry caches kill the repeat work with no
		 * invalidation bookkeeping. */
		let mainSessionCache = null;
		function mainSessionIdOf(sessions) {
			try {
				const snapshot = sessions && typeof sessions.list === "object" && sessions.list !== null
					&& typeof sessions.list.getSnapshot === "function" ? sessions.list.getSnapshot() : null;
				if (snapshot === null || typeof snapshot !== "object") return null;
				if (mainSessionCache !== null && mainSessionCache.snapshot === snapshot) return mainSessionCache.result;
				const byId = snapshot.byId !== null && typeof snapshot.byId === "object" ? snapshot.byId : null;
				let result = null;
				if (byId !== null) {
					for (const id of Object.keys(byId)) {
						const row = byId[id];
						if (row !== null && typeof row === "object" && row.retainedBy !== null && typeof row.retainedBy === "object"
							&& (Number(row.retainedBy.mainView) || 0) > 0) { result = String(id); break; }
					}
				}
				mainSessionCache = { snapshot, result };
				return result;
			} catch { mainSessionCache = null; return null; }
		}
		const groupCache = new WeakMap(); // snapshot -> Map(sessionId -> Set|null)
		/** The session ids sharing `sessionId`'s WORKSPACE, or null when the
		 *  workspaces service is unavailable / the session is unattached.
		 *  Notices are per-session, but the user switches WORKSPACES: landing
		 *  on a different conversation of the same workspace (a fresh blank
		 *  session included) must still count as "being there" — session-id
		 *  equality alone left the dot standing (the v0.4.4 report). */
		function workspaceGroupOf(workspaces, sessionId) {
			try {
				const snapshot = workspaces !== null && typeof workspaces === "object"
					&& typeof workspaces.list === "object" && workspaces.list !== null
					&& typeof workspaces.list.getSnapshot === "function" ? workspaces.list.getSnapshot() : null;
				if (snapshot === null || typeof snapshot !== "object") return null;
				let bySession = groupCache.get(snapshot);
				if (bySession === undefined) { bySession = new Map(); groupCache.set(snapshot, bySession); }
				if (bySession.has(sessionId)) return bySession.get(sessionId);
				const items = Array.isArray(snapshot.items) ? snapshot.items : null;
				let result = null;
				if (items !== null && typeof sessionId === "string" && sessionId !== "") {
					for (const item of items) {
						if (item === null || typeof item !== "object" || !Array.isArray(item.sessionIds)) continue;
						if (item.sessionIds.some((id) => String(id) === sessionId)) {
							result = new Set(item.sessionIds.map((id) => String(id)));
							break;
						}
					}
				}
				bySession.set(sessionId, result);
				return result;
			} catch { return null; }
		}
		/** POST one ack. Body `{}` = the unscoped list-read ack (consume every
		 *  wire-visible round ending); `{ sessionIds }` = the scoped ack
		 *  (consume exactly those sessions' round endings). Fire-and-forget. */
		function postNoticeAck(body) {
			try {
				void fetch(NOTICE_ACK_ROUTE, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body || {}),
					signal: AbortSignal.timeout(4000),
				}).catch(() => {});
			} catch { /* the next poll still carries the notices */ }
		}

		/** Jump to one session from a notice row.
		 *  Prefers `window.__dshSessionsManager` — the dsh-lyin-sessions-manager
		 *  capability, which bridges the old (`sessions.open`) and new
		 *  (`uiWorkspace.openSession`) cores — and falls back to the core's own
		 *  `uiWorkspace.openSession`. Returns whether a navigation was issued. */
		function jumpToSession(sessionId) {
			const id = typeof sessionId === "string" ? sessionId : "";
			if (id === "") return false;
			try {
				const cap = typeof window !== "undefined" ? window.__dshSessionsManager : null;
				if (cap && typeof cap.openSession === "function" && cap.openSession(id)) return true;
			} catch { /* fall through to the core API */ }
			try {
				const ui = jumpCtx && typeof jumpCtx.get === "function" ? jumpCtx.get("uiWorkspace") : null;
				if (ui && typeof ui.openSession === "function") {
					ui.openSession(id);
					return true;
				}
			} catch { /* nothing else to try */ }
			return false;
		}

		/* ---- capsule skins (v0.4.8): five styles; the gradient glass's four
		 * knobs (grain / tint strength, companion colour, ring brightness)
		 * live in the notice prefs store next to the other tuning. ---- */
		const SKIN_IDS = new Set(["frosted", "solid", "wishes", "ember", "arknights", "persona"]);
		const GLASS_ACCENTS = [
			["#8b7cff", "紫罗兰（默认）"],
			["#6ea8ff", "长春花蓝"],
			["#4fd1c5", "青碧"],
			["#ff9e8b", "暖珊瑚"],
			["#ffd76b", "琥珀"],
			["#b0ff8b", "苔绿"],
		];
		/* 方舟观测 accent: theme-following, the signature Arknights orange, a
		 * fixed hue, or a full seven-colour hue-wheel rotation. */
		const AK_ACCENTS = [
			["theme", "跟随主题色（默认）"],
			["#ff8a00", "方舟橙"],
			["#00c8ff", "观测青"],
			["#b6ff00", "荧黄绿"],
			["rainbow", "七彩轮换"],
		];
		/* Decorative overlay layer (装饰层): rain streaks / petals / motes,
		 * stackable on the GLASS skins (default/frosted/wishes/persona —
		 * arknights has its own framing, ember/solid are opaque). */
		const DECOR_STYLES = [
			["none", "无"],
			["rain", "雨痕水珠"],
			["rainv2", "雨后玻璃（可调参数）"],
			["petals", "花瓣飘落"],
			["motes", "光点浮尘"],
		];
		const DECOR_GLASS = new Set(["default", "frosted", "wishes", "persona", "arknights"]);

		/* 雨后玻璃 (rainv2) structure + knobs (v0.4.19). Density is STRUCTURAL —
		 * it is how many hanging-bead spans are rendered. RV2_BEAD_ORDER is
		 * spread-first (8/62/48/84/30/16… top%) so even density 4 covers the
		 * whole pane instead of clumping at the top. The other three knobs are
		 * custom properties and must be set on the decor element itself: its
		 * own .dnl-decor-rainv2 rule carries the defaults, and an element's own
		 * declarations beat anything inherited from the host. */
		const RV2_BEAD_ORDER = ["b2", "b5", "b4", "b7", "b3", "b1", "b9", "b6", "b10", "b8", "b11", "b12"];
		function rainv2StyleVars(np) {
			const pace = Number(np.rv2Pace);
			const hi = Number(np.rv2Hi);
			const trail = Number(np.rv2Trail);
			return {
				"--dnl-rv2-pace": String((Number.isFinite(pace) ? pace : 100) / 100),
				"--dnl-rv2-hi": String((Number.isFinite(hi) ? hi : 70) / 100),
				"--dnl-rv2-trail": String(((Number.isFinite(trail) ? trail : 100) / 100) * 0.34),
			};
		}
		function rainv2DecorChildren(np) {
			const raw = Number(np.rv2Density);
			const density = Number.isFinite(raw) ? Math.min(12, Math.max(4, Math.round(raw))) : 7;
			return [
				h("span", { key: "s1", className: "dnl-decor-streak s1" }),
				h("span", { key: "s2", className: "dnl-decor-streak s2" }),
				h("span", { key: "s3", className: "dnl-decor-streak s3" }),
				...RV2_BEAD_ORDER.slice(0, density).map((slot) =>
					h("span", { key: slot, className: "dnl-decor-drop " + slot })),
				h("span", { key: "sl1", className: "dnl-decor-drop sl1" }),
				h("span", { key: "sl2", className: "dnl-decor-drop sl2" }),
				h("span", { key: "sl3", className: "dnl-decor-drop sl3" }),
				h("span", { key: "sl4", className: "dnl-decor-drop sl4" }),
				h("span", { key: "ra1", className: "dnl-decor-remnant ra1" }),
				h("span", { key: "ra2", className: "dnl-decor-remnant ra2" }),
				h("span", { key: "rb1", className: "dnl-decor-remnant rb1" }),
				h("span", { key: "rb2", className: "dnl-decor-remnant rb2" }),
				h("span", { key: "rc1", className: "dnl-decor-remnant rc1" }),
				h("span", { key: "rc2", className: "dnl-decor-remnant rc2" }),
				h("span", { key: "rd1", className: "dnl-decor-remnant rd1" }),
				h("span", { key: "rd2", className: "dnl-decor-remnant rd2" }),
			];
		}

		/* ---- workspace notice preferences (v0.4.5/v0.4.6): master switch,
		 * round-ending retention, arrival sound (+ style/repeats/volume).
		 * The settings page edits the same storage. */
		const NOTICE_PREFS_KEY = "dsh.netease-lyrics.notice.v1";
		const NOTICE_PREFS_EVENT = "dsh-netease-lyrics-notice";
		const NOTICE_TTL_DEFAULT_MIN = 10;
		const NOTICE_SOUND_COOLDOWN_MS = 2500;
		const NO_NOTICES = [];
		const NOTICE_SOUNDS = [
			["ding", "清脆双音（默认）"],
			["bell", "钟声"],
			["chord", "三音琶音"],
			["pulse", "三连脉冲"],
		];
		function readNoticePrefs() {
			const fallback = { enabled: true, ttlMinutes: NOTICE_TTL_DEFAULT_MIN, sound: true,
				soundStyle: "ding", soundRepeats: 1, soundVolume: 5,
				glassGrain: 30, glassTint: 35, glassAccent: "#8b7cff", glassRing: 70,
				akAccent: "theme", decor: "none",
				rv2Density: 7, rv2Pace: 100, rv2Trail: 100, rv2Hi: 70 };
			try {
				const raw = JSON.parse(localStorage.getItem(NOTICE_PREFS_KEY) || "{}");
				if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return fallback;
				const out = { ...fallback };
				if (raw.enabled === false) out.enabled = false;
				if (raw.sound === false) out.sound = false;
				const ttl = Number(raw.ttlMinutes);
				if (Number.isFinite(ttl)) out.ttlMinutes = Math.min(60, Math.max(1, Math.round(ttl)));
				if (NOTICE_SOUNDS.some(([id]) => id === raw.soundStyle)) out.soundStyle = raw.soundStyle;
				const repeats = Number(raw.soundRepeats);
				if (Number.isFinite(repeats)) out.soundRepeats = Math.min(3, Math.max(1, Math.round(repeats)));
				const volume = Number(raw.soundVolume);
				if (Number.isFinite(volume)) out.soundVolume = Math.min(10, Math.max(1, Math.round(volume)));
				// Gradient-glass knobs (0–100 strengths, a hex companion colour,
				// a 0–200 ring brightness multiplier).
				const grain = Number(raw.glassGrain);
				if (Number.isFinite(grain)) out.glassGrain = Math.min(100, Math.max(0, Math.round(grain)));
				const tint = Number(raw.glassTint);
				if (Number.isFinite(tint)) out.glassTint = Math.min(100, Math.max(0, Math.round(tint)));
				const ring = Number(raw.glassRing);
				if (Number.isFinite(ring)) out.glassRing = Math.min(200, Math.max(0, Math.round(ring)));
				if (typeof raw.glassAccent === "string" && /^#[0-9a-fA-F]{6}$/.test(raw.glassAccent)) {
					out.glassAccent = raw.glassAccent;
				}
				// v0.4.9: the arknights accent + the decorative overlay style.
				if (AK_ACCENTS.some(([id]) => id === raw.akAccent)) out.akAccent = raw.akAccent;
				if (DECOR_STYLES.some(([id]) => id === raw.decor)) out.decor = raw.decor;
				// v0.4.19: 雨后玻璃 (rainv2) knobs — density is the hanging-bead
				// count (4–12), pace a tempo multiplier (50–200%), trail the
				// remnant strength (0–200%), hi the specular highlight (0–100%).
				const rv2Density = Number(raw.rv2Density);
				if (Number.isFinite(rv2Density)) out.rv2Density = Math.min(12, Math.max(4, Math.round(rv2Density)));
				const rv2Pace = Number(raw.rv2Pace);
				if (Number.isFinite(rv2Pace)) out.rv2Pace = Math.min(200, Math.max(50, Math.round(rv2Pace)));
				const rv2Trail = Number(raw.rv2Trail);
				if (Number.isFinite(rv2Trail)) out.rv2Trail = Math.min(200, Math.max(0, Math.round(rv2Trail)));
				const rv2Hi = Number(raw.rv2Hi);
				if (Number.isFinite(rv2Hi)) out.rv2Hi = Math.min(100, Math.max(0, Math.round(rv2Hi)));
				return out;
			} catch { return fallback; }
		}
		function writeNoticePrefs(next) {
			try { localStorage.setItem(NOTICE_PREFS_KEY, JSON.stringify(next)); } catch { return false; }
			window.dispatchEvent(new Event(NOTICE_PREFS_EVENT));
			return true;
		}
		function useNoticePrefs() {
			const [prefs, setPrefs] = useState(readNoticePrefs);
			useEffect(() => {
				const refresh = () => setPrefs(readNoticePrefs());
				window.addEventListener(NOTICE_PREFS_EVENT, refresh);
				window.addEventListener("storage", refresh);
				return () => {
					window.removeEventListener(NOTICE_PREFS_EVENT, refresh);
					window.removeEventListener("storage", refresh);
				};
			}, []);
			return prefs;
		}
		/* Drop expired round endings client-side (the user's retention
		 * setting). The host ALSO caps retention at its noticeTurnTtlMs
		 * config, so the effective lifetime is the MIN of the two. Questions
		 * are never expired. `at` values are host wall-clock timestamps. */
		function expireTurnEnds(items, ttlMinutes, now) {
			const ttl = Math.max(60000, Math.min(3600000, (Number(ttlMinutes) || NOTICE_TTL_DEFAULT_MIN) * 60000));
			const cutoff = now - ttl;
			const out = [];
			for (const item of items) {
				if (item.turnEnd === null) { out.push(item); continue; }
				const at = Number(item.turnEnd.at) || 0;
				if (at > 0 && at <= cutoff) {
					if (item.question !== null) out.push({ ...item, turnEnd: null });
					continue;
				}
				out.push(item);
			}
			return out;
		}
		/* Synthesized arrival sound — no asset files, Web Audio only.
		 * v0.4.6 makes it user-configurable: four presets (ding / bell /
		 * chord / pulse), a repeat count (1–3) and a volume level (1–10,
		 * master gain = level × 0.06 so the default 5 ≈ 0.30, louder than
		 * the old fixed 0.18 — the user found a single soft ding too easy
		 * to miss behind other audio). Autoplay policy may leave the context
		 * suspended: the resume attempt plus a one-time pointerdown hook
		 * makes the NEXT arrival audible after any interaction. Audio
		 * failures must never break the island. */
		let noticeAudioCtx = null;
		/** One oscillator tone with an exponential decay. Returns its stop time. */
		function tone(ctx, dest, freq, at, gain, duration, type) {
			const osc = ctx.createOscillator();
			osc.type = type || "sine";
			osc.frequency.setValueAtTime(freq, at);
			const env = ctx.createGain();
			env.gain.setValueAtTime(0.0001, at);
			env.gain.linearRampToValueAtTime(gain, at + 0.015);
			env.gain.exponentialRampToValueAtTime(0.0001, at + duration);
			osc.connect(env);
			env.connect(dest);
			osc.start(at);
			osc.stop(at + duration + 0.05);
			return at + duration;
		}
		/** Schedule one pattern at `at`; returns its total duration in seconds. */
		function scheduleNoticePattern(ctx, dest, style, at, volume) {
			const g = Math.max(0.02, Math.min(1, volume * 0.06));
			if (style === "pulse") {
				// Three short rhythmic pings — the attention-getter.
				for (let i = 0; i < 3; i += 1) tone(ctx, dest, 987.77, at + i * 0.22, g, 0.14, "triangle");
				return 0.22 * 2 + 0.2;
			}
			if (style === "chord") {
				// Rising arpeggio C6 → E6 → G6 with a sustained top.
				tone(ctx, dest, 1046.5, at, g * 0.9, 0.5);
				tone(ctx, dest, 1318.51, at + 0.12, g * 0.95, 0.55);
				tone(ctx, dest, 1567.98, at + 0.24, g, 0.9);
				return 1.15;
			}
			if (style === "bell") {
				// Struck-bell partials: fundamental + inharmonic overtones.
				tone(ctx, dest, 587.33, at, g, 1.3);
				tone(ctx, dest, 587.33 * 2.76, at, g * 0.35, 0.6);
				tone(ctx, dest, 587.33 * 5.4, at, g * 0.12, 0.25);
				return 1.35;
			}
			// 'ding' — the original two-tone.
			tone(ctx, dest, 880, at, g, 0.55);
			tone(ctx, dest, 1318.51, at + 0.12, g, 0.8);
			return 0.95;
		}
		function playNoticeSound(style, repeats, volume) {
			try {
				const AC = typeof window !== "undefined" ? (window.AudioContext || window.webkitAudioContext) : undefined;
				if (typeof AC !== "function") return;
				if (noticeAudioCtx === null) noticeAudioCtx = new AC();
				if (noticeAudioCtx.state === "suspended") {
					const resume = () => { try { void noticeAudioCtx.resume(); } catch {} };
					try { window.addEventListener?.("pointerdown", resume, { once: true }); } catch {}
					void noticeAudioCtx.resume();
				}
				const ctx = noticeAudioCtx;
				const master = ctx.createGain();
				master.gain.setValueAtTime(1, ctx.currentTime);
				master.connect(ctx.destination);
				const count = Math.max(1, Math.min(3, Math.round(Number(repeats) || 1)));
				const vol = Math.max(1, Math.min(10, Math.round(Number(volume) || 5)));
				const kind = NOTICE_SOUNDS.some(([id]) => id === style) ? style : "ding";
				/* Replays are pre-scheduled on the audio clock (gap 0.35s) —
				 * one effect call, no timers, immune to tab throttling. */
				let at = ctx.currentTime + 0.01;
				for (let i = 0; i < count; i += 1) {
					at += scheduleNoticePattern(ctx, master, kind, at, vol) + 0.35;
				}
			} catch { /* audio must never break the island */ }
		}
		/** Legacy single-chime entry point (tests + internal callers). */
		function playNoticeChime() {
			playNoticeSound("ding", 1, 5);
		}

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
				// v0.4.9 capsule skin: absent = default pill. The whitelist IS
				// SKIN_IDS - the SAME constant the style select writes with, so
				// a new skin can never be forgotten here again (this asymmetry
				// shipped TWICE: v0.4.8 forgot wishes/ember, v0.4.9 forgot
				// arknights/persona - the user hit the snap-back both times).
				if (SKIN_IDS.has(raw?.capsuleStyle)) out.capsuleStyle = raw.capsuleStyle;
				if (Number.isFinite(raw?.x) && Number.isFinite(raw?.y)) {
					out.x = Math.min(1, Math.max(0, raw.x)); out.y = Math.min(1, Math.max(0, raw.y));
				}
				// "theme" is the default, so only the three explicit modes are kept.
				if (raw?.glow === "off" || raw?.glow === "cover" || raw?.glow === "notice") out.glow = raw.glow;
				// "normal" is the default pace, so only the two extremes are kept.
				if (raw?.glowPace === "calm" || raw?.glowPace === "lively") out.glowPace = raw.glowPace;
				// 1 = the theme's overlay token as-is (the original look); lower
				// values let more wallpaper through. Stored as a percentage integer
				// so the slider round-trips exactly.
				if (Number.isFinite(raw?.panelOpacity)) {
					out.panelOpacity = Math.min(100, Math.max(20, Math.round(raw.panelOpacity)));
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
				let raw = JSON.parse(localStorage.getItem(AMBIENT_KEY) || "{}");
				// One-time migration: this bundle absorbed the ambient branch
				// (dsh-netease-lyrics-ambient). Carry the tuning the user made
				// under that bundle's storage key over to this one.
				if (raw && Object.keys(raw).length === 0) {
					const legacy = localStorage.getItem("dsh.netease-lyrics-ambient.prefs.v1");
					if (legacy) {
						try {
							const parsed = JSON.parse(legacy);
							if (parsed && typeof parsed === "object") {
								localStorage.setItem(AMBIENT_KEY, JSON.stringify(parsed));
								raw = parsed;
							}
						} catch { /* corrupted legacy value: keep defaults */ }
					}
				}
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
			} catch { return { enabled: true, style: "glow", anim: "ripple-wave", orientation: "tilt", jump: 10, fall: 48, maxLines: 2, colorMode: "theme" }; }
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
		/** Keep only usable lyric rows and normalise their fields. The payload comes
		 *  from third-party APIs via a cache file, so a single null or half-formed
		 *  entry must not be able to throw and take the overlay down with it. */
		const normalizedLines = new WeakMap();
		function sanitizeLines(raw) {
			if (!Array.isArray(raw)) return [];
			if (normalizedLines.has(raw)) return normalizedLines.get(raw);
			const out = [];
			for (const row of raw) {
				if (row === null || typeof row !== "object" || !Number.isFinite(row.t)) continue;
				out.push({
					t: row.t,
					text: typeof row.text === "string" ? row.text : "",
					trans: typeof row.trans === "string" && row.trans !== "" ? row.trans : undefined,
				});
			}
			out.sort((a, b) => a.t - b.t);
			normalizedLines.set(raw, out);
			return out;
		}

		function currentLineIndex(lines, pos) {
			if (!Array.isArray(lines) || lines.length === 0) return -1;
			let lo = 0;
			let hi = lines.length - 1;
			let ans = -1;
			while (lo <= hi) {
				const mid = (lo + hi) >> 1;
				// sanitizeLines() already guarantees the shape, but this is the hot
				// path for every poll - stay defensive rather than throw here.
				const row = lines[mid];
				const t = row !== null && typeof row === "object" && Number.isFinite(row.t) ? row.t : -Infinity;
				if (t <= pos) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
			}
			return ans;
		}

		/** How far past a line's start `pos` must be before the line becomes
		 *  active. Real players report `positionSec` with dither: SMTC snapshots
		 *  routinely wobble ±0.2s, and the clock interpolates over them. With a
		 *  plain `t <= pos` test that wobble straddles a line boundary - the lyric
		 *  index flips back and forth and the cross-fade renders the previous
		 *  line again, so a line change "flashes the wrong line" before settling.
		 *  v0.4.10 makes the band ADAPTIVE (HANDOFF-lyrics-pending-fixes.md §7):
		 *  a fixed 0.35s delayed EVERY line change by that full amount, which on
		 *  fast songs (0.5s gaps) ate 70% of the interval and on ≤0.35s gaps
		 *  meant the line NEVER advanced. `hysteresisFor(lines)` takes the
		 *  median forward gap of the CURRENT track and clamps the band to
		 *  0.08–0.35s: slow songs keep the full anti-flicker width, fast songs
		 *  tighten to just above the observed ±0.2s jitter. The median (not the
		 *  minimum) keeps one short spoken line in a slow song from collapsing
		 *  the whole band. */
		const LINE_HYSTERESIS_MIN_SEC = 0.08;
		const LINE_HYSTERESIS_MAX_SEC = 0.35;
		const LINE_HYSTERESIS_FALLBACK_SEC = 0.35;
		function hysteresisFor(lines) {
			if (!Array.isArray(lines) || lines.length < 2) return LINE_HYSTERESIS_FALLBACK_SEC;
			const gaps = [];
			for (let i = 1; i < lines.length; i += 1) {
				const gap = Number(lines[i]?.t) - Number(lines[i - 1]?.t);
				if (Number.isFinite(gap) && gap > 0) gaps.push(gap);
			}
			if (gaps.length === 0) return LINE_HYSTERESIS_FALLBACK_SEC;
			gaps.sort((a, b) => a - b);
			const median = gaps[Math.floor(gaps.length / 2)];
			return Math.min(LINE_HYSTERESIS_MAX_SEC,
				Math.max(LINE_HYSTERESIS_MIN_SEC, median * 0.25));
		}

		/** Sticky variant of currentLineIndex: `previous` is the index shown on the
		 *  last render. Both directions need to clear the boundary by the whole
		 *  hysteresis band:
		 *    - advance to `previous + 1` only when pos >= t(previous+1) + HYST
		 *    - retreat to `previous - 1` only when pos <  t(previous)   - HYST
		 *  A dither that merely crosses the boundary therefore keeps the line that
		 *  is already on screen, while a real change (or a seek) still goes
		 *  through immediately. */
		function stickyLineIndex(lines, pos, previous) {
			const hyst = hysteresisFor(lines);
			const raw = currentLineIndex(lines, pos);
			if (raw < 0) return -1;
			if (!Number.isInteger(previous) || previous < 0) return raw;
			if (previous >= lines.length) return raw;
			const t = (i) => (Number.isFinite(lines[i]?.t) ? lines[i].t : -Infinity);
			if (raw === previous) return previous;
			if (raw > previous) {
				// Advance only once pos is clearly past the next line's start.
				return pos >= t(previous + 1) + hyst ? raw : previous;
			}
			// raw < previous: retreat only when pos is clearly BELOW the start of
			// the line currently shown. A bare `pos < t(previous)` would keep the
			// flicker alive, because that is exactly what dither does at the edge.
			return pos < t(previous) - hyst ? raw : previous;
		}

		/** Backward index changes need confirming. A single stale poll (the player
		 *  momentarily re-reporting an older positionSec, e.g. right after a track
		 *  or session update) makes the raw index drop for exactly one poll cycle.
		 *  The confirmation window therefore has to be LONGER than one poll, or the
		 *  stale reading outlives it and still flashes the earlier line - measured
		 *  with a 500ms poll and a 450ms window: C3 -> (A1 flashes) -> C3.
		 *  Real backward seeks still land, one poll later. Forward changes are
		 *  instant (hysteresis already vetted them). */
		const BACKWARD_SETTLE_MS = 750;
		/** Poll interval bounds used by the host; mirrored here only to size the
		 *  confirmation window. */
		function backwardSettleMs(pollMs) {
			const poll = Number(pollMs);
			const base = Number.isFinite(poll) && poll > 0 ? Math.min(Math.max(poll, 250), 5000) : 1000;
			return Math.max(BACKWARD_SETTLE_MS, Math.round(base * 1.5));
		}

		/** Stateful wrapper around stickyLineIndex. `state` is a plain object the
		 *  caller keeps in a ref: { shown, pending, pendingSince }.
		 *  - forward: stickyLineIndex already delays until clear of the band, so a
		 *    genuine advance is applied at once;
		 *  - backward: held until the lower index has survived `settleMs`.
		 *  Mutates `state` and returns the index that should be on screen. */
		function settleLineIndex(lines, pos, state, nowMs, settleMs) {
			const window = Number.isFinite(settleMs) && settleMs > 0 ? settleMs : BACKWARD_SETTLE_MS;
			const target = stickyLineIndex(lines, pos, state.shown);
			if (target === state.shown) { state.pending = -1; state.pendingSince = 0; return state.shown; }
			if (target > state.shown) { state.pending = -1; state.pendingSince = 0; state.shown = target; return target; }
			// target < shown: confirm before retreating.
			if (target !== state.pending) { state.pending = target; state.pendingSince = nowMs; return state.shown; }
			if (nowMs - state.pendingSince >= window) { state.shown = target; state.pending = -1; state.pendingSince = 0; return target; }
			return state.shown;
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

		/** Target position for a ±N second step: clamped to [0, duration] so the
		 *  widget never asks a player for an impossible position. Returns null when
		 *  the step would not actually move (already at the end, or no duration). */
		function seekTarget(pos, delta, duration) {
			const from = Number.isFinite(Number(pos)) ? Number(pos) : 0;
			const span = Number.isFinite(Number(duration)) && Number(duration) > 0 ? Number(duration) : 0;
			let target = from + Number(delta);
			if (target < 0) target = 0;
			if (span > 0 && target > span) target = span;
			if (Math.abs(target - from) < 0.05) return null;
			return Number(target.toFixed(2));
		}

		/** Chrome hands the SMTC title straight from the tab, and bilibili
		 *  appends "_哔哩哔哩_bilibili" to document.title — pure noise in the
		 *  pill (and in the width probe). Stripped for DISPLAY only: matching
		 *  and fingerprints keep using the raw title. */
		function displayTitle(value) {
			return String(value || "").replace(/\s*[-_]\s*哔哩哔哩(_bilibili)?\s*$/i, "").trim();
		}

		/** Indices for the expanded lyric window: a fixed number of slots before
		 *  and after the active line, with -1 standing for an out-of-range slot
		 *  (rendered as a hidden spacer). Padding instead of clamping is what keeps
		 *  the active line vertically centred on the first and last lyric, where
		 *  clamping would leave it pinned to an edge. Before the first timed line
		 *  (index < 0 — a video whose subtitles have not started yet) the window
		 *  anchors on the first line instead of collapsing to zero rows, which is
		 *  what made the expanded panel claim "暂无歌词" while the pill showed the
		 *  title. Nothing highlights until playback reaches the first line. */
		function lyricWindow(total, index, before, after) {
			const out = [];
			if (!(total > 0)) return out;
			const anchor = index >= 0 ? index : 0;
			for (let i = anchor - before; i <= anchor + after; i += 1) {
				out.push(i >= 0 && i < total ? i : -1);
			}
			return out;
		}

		/* ---------------- workspace notices (host → island) ---------------- */

		/** Normalize the wire notice payload. Like sanitizeLines, this defends
		 *  against a hostile half-formed payload: one bad row must never take
		 *  the overlay down with it. Questions outrank turn-endings; newest
		 *  first; hard cap 12. Memoized by payload identity (WeakMap): the
		 *  island re-renders every 250ms while media plays, and each poll
		 *  brings a fresh payload, so within one tick the repeat renders now
		 *  reuse one array instead of rebuilding it. Callers must not mutate
		 *  the result — every consumer filters/copies, never writes. */
		const noticeSanitizeCache = new WeakMap();
		function sanitizeNotices(raw) {
			if (raw === null || typeof raw !== "object" || !Array.isArray(raw.items)) return NO_NOTICES;
			const cached = noticeSanitizeCache.get(raw);
			if (cached !== undefined) return cached;
			const out = [];
			for (const item of raw.items) {
				if (item === null || typeof item !== "object") continue;
				const workspace = typeof item.workspace === "string" && item.workspace !== ""
					? item.workspace : "工作区";
				let question = null;
				if (item.question !== null && typeof item.question === "object") {
					question = {
						kind: item.question.kind === "approval" ? "approval" : "user-question",
						preview: typeof item.question.preview === "string" ? item.question.preview.slice(0, 200) : "",
						toolName: typeof item.question.toolName === "string" ? item.question.toolName : "",
						continued: item.question.continued === true,
						at: Number(item.question.at) > 0 ? item.question.at : 0,
					};
				}
				let turnEnd = null;
				if (item.turnEnd !== null && typeof item.turnEnd === "object" && Number.isFinite(Number(item.turnEnd.turn))) {
					turnEnd = {
						turn: Math.max(1, Math.round(Number(item.turnEnd.turn))),
						outcome: typeof item.turnEnd.outcome === "string" ? item.turnEnd.outcome : "",
						at: Number(item.turnEnd.at) > 0 ? item.turnEnd.at : 0,
					};
				}
				if (question === null && turnEnd === null) continue;
				out.push({
					// Kept for the main-view filter (see mainSessionIdOf): the
					// workspace the user is currently in does not need reminding.
					sessionId: typeof item.sessionId === "string" ? item.sessionId : "",
					workspace, question, turnEnd,
					at: question ? Math.max(question.at, turnEnd ? turnEnd.at : 0) : turnEnd.at,
				});
			}
			out.sort((a, b) => {
				const gap = (b.question ? 1 : 0) - (a.question ? 1 : 0);
				if (gap !== 0) return gap;
				return b.at - a.at;
			});
			const result = out.slice(0, 12);
			noticeSanitizeCache.set(raw, result);
			return result;
		}

		/** The collapsed-pill headline, in the wording the user asked for:
		 *  "xx会话区有提问" / "xx会话区第x轮对话结束". */
		function noticeHeadline(item) {
			if (item.question) return item.workspace + "会话区有提问";
			if (item.turnEnd) return item.workspace + "会话区第" + String(item.turnEnd.turn) + "轮对话结束";
			return item.workspace + "会话区提示";
		}

		/** Turn-end reason → human label ('' for the plain completed case). */
		function noticeOutcomeLabel(outcome) {
			if (outcome === "completed") return "已完成";
			if (outcome === "blocked") return "被阻塞";
			if (outcome === "aborted") return "已中止";
			if (outcome === "error") return "出错";
			return "";
		}

		/** hh:mm for the notice list (local browser time). */
		function noticeClockLabel(at) {
			if (!Number.isFinite(at) || at <= 0) return "";
			const date = new Date(at);
			const pad = (value) => String(value).padStart(2, "0");
			return pad(date.getHours()) + ":" + pad(date.getMinutes());
		}

		/** The full notice list for the expanded panel and the red-dot view.
		 *  A plain builder (like settingsGroup) so the test harness only ever
		 *  sees plain elements. */
		function noticeList(items) {
			return h("div", { className: "dnl-notices" },
				h("div", { className: "dnl-notice-head" }, "会话区提示"),
				items.length === 0
					? h("div", { className: "dnl-notice-empty" }, "当前没有会话区提示。")
					: items.map((item, index) => {
						const headline = noticeHeadline(item);
						const rows = [];
						if (item.question) {
							rows.push(h("div", { key: "q", className: "dnl-notice-detail" },
								item.question.kind === "approval"
									? (item.question.toolName !== "" ? "请求确认：" + item.question.toolName
										: "请求确认一项操作" + (item.question.preview !== "" ? "：" + item.question.preview : ""))
									: (item.question.preview !== "" ? item.question.preview : "会话里有待回答的问题")));
						}
						if (item.turnEnd) {
							const label = noticeOutcomeLabel(item.turnEnd.outcome);
							rows.push(h("div", { key: "t", className: "dnl-notice-detail" }, label !== "" ? "本轮对话" + label : ""));
						}
						const clock = noticeClockLabel(item.at);
						if (clock !== "") rows.push(h("div", { key: "time", className: "dnl-notice-time" }, clock));
						const sid = typeof item.sessionId === "string" ? item.sessionId : "";
						const canJump = sid !== "";
						return h("div", {
							key: "n" + String(index) + "|" + headline,
							className: "dnl-notice-row" + (item.question ? " dnl-notice-row-q" : "")
								+ (canJump ? " dnl-notice-row-jump" : ""),
							title: canJump ? "点击跳转到该会话" : undefined,
							onClick: canJump ? (event) => {
								try { event.stopPropagation(); } catch { /* ignore */ }
								// 跳过去之后顺手确认这条提示（消费该会话的轮次结束标记），
								// 否则用户看过之后红点还会挂着。
								if (jumpToSession(sid)) { try { postNoticeAck({ sessionIds: [sid] }); } catch { /* ignore */ } }
							} : undefined,
						},
							h("div", { className: "dnl-notice-title" }, headline),
							rows.length > 0 ? rows : null);
					}));
		}

		/** One request loop and clock for both overlay consumers. The last subscriber
		 * aborts the request and removes the timer; a generation fences late replies. */
		function createTrackSource(options = {}) {
			const request = options.request || ((...args) => fetch(...args));
			const schedule = options.schedule || ((fn, ms) => setTimeout(fn, ms));
			const cancel = options.cancel || (id => clearTimeout(id));
			const now = options.now || (() => Date.now());
			const clock = createPlaybackClock();
			const listeners = new Set();
			let latest = null, timer = null, controller = null, requestDeadline = null, generation = 0;
			const run = async epoch => {
				const current = new AbortController();
				controller = current;
				const deadline = schedule(() => current.abort(), 4000);
				requestDeadline = deadline;
				try {
					const response = await request(STATE_ROUTE, {
						headers: { accept: "application/json" }, signal: current.signal,
					});
					if (response.ok) {
						const payload = await response.json();
						if (epoch === generation && listeners.size && payload && typeof payload === "object") {
							latest = payload;
							clock.update(payload, now());
							for (const listener of listeners) listener(payload);
						}
					}
				} catch { /* Host unavailable or subscription cancelled: retry while mounted. */ }
				finally {
					cancel(deadline);
					if (requestDeadline === deadline) requestDeadline = null;
					if (controller === current) controller = null;
				}
				if (epoch === generation && listeners.size) {
					const delay = Math.min(Math.max(Number(latest?.pollMs) || 1000, 250), 5000);
					timer = schedule(() => { timer = null; void run(epoch); }, delay);
				}
			};
			return {
				clock,
				subscribe(listener) {
					listeners.add(listener);
					if (latest !== null) listener(latest);
					if (listeners.size === 1) void run(++generation);
					return () => {
						listeners.delete(listener);
						if (listeners.size) return;
						generation += 1;
						if (timer !== null) cancel(timer);
						timer = null;
						if (requestDeadline !== null) cancel(requestDeadline);
						requestDeadline = null;
						controller?.abort();
						controller = null;
						latest = null;
					};
				},
			};
		}
		const trackSource = createTrackSource();

		function useTrackState() {
			const [st, setSt] = useState(null);
			const [tick, setTick] = useState(0);
			useEffect(() => trackSource.subscribe(setSt), []);
			// Only playing media needs interpolation between host snapshots.
			useEffect(() => {
				if (st?.active !== true || st?.playing !== true) return undefined;
				const timer = setInterval(() => setTick(value => value + 1), 250);
				return () => clearInterval(timer);
			}, [st?.active, st?.playing]);
			void tick;
			return { st, clock: trackSource.clock };
		}

		// At most two layers: outgoing lyric fades out while the current one fades in.
		/** Compute the next cross-fade frame from the previous one.
		 *
		 *  The outgoing (`previous`) layer must be established SYNCHRONOUSLY with the
		 *  identity change, i.e. during the same render. If it is only filled in from
		 *  a useEffect it happens after the browser has already painted, and that
		 *  first painted frame holds the new line at full opacity with no fade-in
		 *  class. The effect then inserts the outgoing line at opacity 1 on top of it
		 *  while the new line restarts from opacity 0 - so the line that just left
		 *  re-appears for a moment. On the collapsed capsule that reads exactly as
		 *  "it flashes another line before switching to the next one".
		 *
		 *  NOTE: this is only observable in the real GPU-composited window. A headless
		 *  run (no GPU, effects flushed within the same frame) paints both variants
		 *  identically, so a browser probe can NOT tell them apart - the guard is this
		 *  function plus the assertions in test/line-crossfade.test.mjs.
		 *
		 *  Returns the SAME object when nothing changed, so callers can skip setState. */
		function nextTransitionFrame(frame, identity, children) {
			if (frame && frame.identity === identity) return frame;
			return {
				identity,
				content: children,
				previous: frame ? { identity: frame.identity, content: frame.content } : null,
			};
		}

		/* Cross-fade timing (v0.4.10, HANDOFF-lyrics-pending-fixes.md §8):
		 * 340ms with a Material-style cubic-bezier (both ends soft — the old
		 * ease-out front-loaded ~60% of the motion into the first third and
		 * then froze, reading as a flash). The outgoing layer is cleared
		 * AFTER the animation plus a 60ms safety margin — the old 240ms
		 * clear vs 220ms animation left 20ms of slack, so a single dropped
		 * frame truncated the fade-out. ONE shared constant: the CSS
		 * duration and this timer must never drift apart again. */
		const CROSSFADE_MS = 340;
		const CROSSFADE_CLEAR_MS = CROSSFADE_MS + 60;

		function LyricTransition(props) {
			const [frame, setFrame] = useState(() => nextTransitionFrame(null, props.identity, props.children));
			/* Derive during render (React's "adjust state when props change" pattern).
			 * setFrame during render makes React discard this pass and re-render with
			 * the new state; the condition then stops being true, so it converges at
			 * once and frame 1 already carries both layers. */
			const derived = nextTransitionFrame(frame, props.identity, props.children);
			if (derived !== frame) setFrame(derived);
			useEffect(() => {
				// Only the CLEARING of the outgoing layer belongs in an effect; it must
				// never be the thing that creates it.
				const timer = setTimeout(() => setFrame(old => ({ ...old, previous: null })), CROSSFADE_CLEAR_MS);
				return () => clearTimeout(timer);
			}, [props.identity]);
			return h("div", { className: "dnl-crossfade" },
				derived.previous ? h("div", { key: "old:" + derived.previous.identity,
					className: "dnl-fade-layer dnl-fade-out", "aria-hidden": true }, derived.previous.content) : null,
				h("div", { key: "new:" + props.identity,
					className: "dnl-fade-layer" + (derived.previous ? " dnl-fade-in" : "") }, props.children));
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
				const nativeRaf = typeof window !== "undefined" && typeof window.requestAnimationFrame === "function";
				const raf = nativeRaf ? window.requestAnimationFrame.bind(window)
					: (fn) => setTimeout(() => fn(Date.now()), 16);
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
					if (nativeRaf && typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(rafId);
					else clearTimeout(rafId);
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
				if (!serial) { setCoverColor(null); return; }
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
				const lines = sanitizeLines(lyric.lines);
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
			const noticePrefs = useNoticePrefs();
			const [dragPosition, setDragPosition] = useState(null);
			const hostRef = useRef(null);
			const dragRef = useRef(null);
			const suppressClick = useRef(false);
			const [expanded, setExpanded] = useState(false);
			const [pinned, setPinned] = useState(false);
			// Collapsing waits a beat, so a pointer that grazes the edge - or any
			// layout change that momentarily moves the box - cannot start a
			// leave/enter oscillation. Re-entering cancels the pending collapse.
			const collapseTimer = useRef(0);
			// Hover expansion is suppressed until this timestamp, right after a drag.
			const hoverGuard = useRef(0);
			useEffect(() => () => { if (collapseTimer.current) clearTimeout(collapseTimer.current); }, []);
			const [rematching, setRematching] = useState(false);
			// Which transport command is in flight, so the button can show it and
			// a second click cannot queue a duplicate.
			const [pendingCmd, setPendingCmd] = useState("");
			const [controlNote, setControlNote] = useState("");
			// Expanded panel either shows the lyrics or the capsule's own settings.
			const [panelView, setPanelView] = useState("lyrics");
			const activeRowRef = useRef(null);
			const linesRef = useRef(null);
			// Same storage writes the settings page uses, plus a failure note.
			const [settingsError, setSettingsError] = useState("");
			const saveDisplay = (next) => setSettingsError(writeDisplay(next) ? "" : "无法保存设置，请检查存储权限。");
			const saveColors = (next) => setSettingsError(writeColors(next) ? "" : "无法保存设置，请检查存储权限。");

			// Breathing halo around the capsule: colour follows the theme accent,
			// or the album cover's dominant colour (sampled once per cover, with
			// the theme accent as the fallback when sampling is unavailable).
			const glowMode = prefs.glow === "off" ? "off" : prefs.glow === "cover" ? "cover" : prefs.glow === "notice" ? "notice" : "theme";
			// Pace presets: one breath period, plus a gentle overall dimming for
			// "calm". Delays are fractions of the period so they scale with it.
			const glowPace = prefs.glowPace === "calm" ? "calm" : prefs.glowPace === "lively" ? "lively" : "normal";
			const glowDur = glowPace === "calm" ? "8.4s" : glowPace === "lively" ? "3.9s" : "5.6s";
			const glowAmp = glowPace === "calm" ? ".8" : "1";
			const [coverHalo, setCoverHalo] = useState("");
			const glowSerial = Number(st?.coverSerial) || 0;
			useEffect(() => {
				if (glowMode !== "cover" || glowSerial <= 0) {
					setCoverHalo("");
					return undefined;
				}
				let alive = true;
				sampleCoverColor(COVER_ROUTE + "?v=" + String(glowSerial))
					.then(color => { if (alive) setCoverHalo(color); })
					.catch(() => { if (alive) setCoverHalo(""); });
				return () => { alive = false; };
			}, [glowMode, glowSerial]);

			// Re-clamp when the capsule's shape changes (expand/collapse, font,
			// viewport) so a saved position stays reachable. Deliberately NOT keyed on
			// dragPosition: doing that re-clamped on every pointermove, and because the
			// clamp is computed from the host's own box, a width change (long foreign
			// lyric lines) fed back into the position and made the window appear to
			// resize while dragging. The drag path owns the position while it runs.
			useEffect(() => {
				const el = hostRef.current;
				if (!el) return undefined;
				const fit = () => {
					if (dragRef.current) return;   // mid-drag: the drag owns the position
					const box = el.getBoundingClientRect();
					const vw = window.innerWidth, vh = window.innerHeight;
					const location = dragPosition || { x: (prefs.x ?? 0.70) * vw, y: prefs.y === undefined ? 12 : prefs.y * vh };
					const clamped = clampPlacement(location.x, location.y, box.width, box.height, vw, vh);
					el.style.left = clamped.x + "px"; el.style.top = clamped.y + "px";
				};
				fit(); window.addEventListener("resize", fit);
				const observer = typeof ResizeObserver === "function" ? new ResizeObserver(fit) : null;
				observer?.observe(el);
				return () => { window.removeEventListener("resize", fit); observer?.disconnect(); };
			}, [expanded, prefs.x, prefs.y, prefs.font, st?.active]);

			// Values the effects below need. Computed unconditionally so the hook
			// order is identical whether or not a track is active.
			const clockPos = clock.read(Date.now());
			const lyricForHooks = st !== null && st.active === true && st.lyric !== null && typeof st.lyric === "object"
				? st.lyric : { status: "idle" };
			const linesForHooks = sanitizeLines(lyricForHooks.lines);
			// ONE settled index drives both the render and the scroll effect. Two
			// separate clock reads used to be able to disagree for a frame, and the
			// stateful guards below must advance exactly once per render.
			//
			// Guards, in order, against a line change "flashing another line":
			//   1. stickyLineIndex - a dithering positionSec cannot flip the index
			//      back and forth across a line boundary;
			//   2. settleLineIndex - a single stale backward reading is swallowed
			//      instead of briefly showing an earlier line.
			const lineStateRef = useRef(null);
			// Lazily initialised: some test harnesses implement useRef() without
			// honouring its initial value, so never assume `current` is set.
			if (lineStateRef.current === null || lineStateRef.current === undefined) {
				lineStateRef.current = { shown: -1, pending: -1, pendingSince: 0 };
			}
			const indexForHooks = linesForHooks.length > 0
				? settleLineIndex(linesForHooks, clockPos, lineStateRef.current, Date.now(), backwardSettleMs(st?.pollMs))
				: -1;
			if (linesForHooks.length === 0) lineStateRef.current.shown = -1;

			// The collapsed pill is content-sized and the host centres it with
			// translateX(-50%), so any width change also slides the capsule. Size it
			// to the CURRENT line (the user rejected a fixed width: it looked worse
			// than the jump) but write the value as an explicit px so the CSS width
			// transition interpolates instead of snapping.
			//
			// NOTE: height is the other half of the same problem and is handled in
			// CSS - a line WITH a translation is ~39px tall vs ~22px without, and
			// that 17px height jump is what moves the text vertically on a line
			// change. .dnl-now heights are equalised there instead.
			// Declared BEFORE the early return: hooks must keep a constant order.
			const nowWrapRef = useRef(null);
			const lastLineWidth = useRef(0);
			/* v0.4.10 (HANDOFF-lyrics-pending-fixes.md §9): the measured text is
			 * now the SAME expression as collapsedText below (lyric line, with
			 * the title/artist fallback for no-lyric songs). It used to measure
			 * "" when no lyric line was active, the width effect early-returned,
			 * and the pill kept the last line's width — the title got truncated.
			 * The two expressions MUST stay in sync; both carry the marker
			 * comment `WIDTH SOURCE — keep in sync with collapsedText`.
			 * v0.4.12d: both now run the title through displayTitle(), which
			 * strips bilibili's "_哔哩哔哩_bilibili" tab suffix. */
			const currentLineForHooks = indexForHooks >= 0 && linesForHooks[indexForHooks]
				? linesForHooks[indexForHooks] : null;
			const fallbackLabelForHooks = (displayTitle(st?.title) + (String(st?.artist || "") !== "" ? " — " + String(st?.artist || "") : "")).trim();
			const lineTextForHooks = currentLineForHooks !== null
				? String(currentLineForHooks.text || "")
				: (fallbackLabelForHooks !== "" ? fallbackLabelForHooks : "…");
			// Empty text still needs a width pass (the pill shrinks to the "…"),
			// so unlike before there is no early-return for empty text below.
			// Workspace notices ride the same shared poll. Derived unconditionally
			// so the hook order below is identical in every mode. The MAIN-VIEW
			// filter runs here: the session the user is currently in does not
			// need its own pill/dot (the question card is right in front of
			// them); switching away naturally re-shows it. Reading the client
			// runtime's snapshot every render is cheap and needs no wiring; the
			// poll tick (≤500 ms) is the refresh cadence.
			const mainSessionId = mainSessionIdOf(clientSessions);
			// Workspace-level grouping: "being in the workspace" covers every
			// conversation in it — including a different/blank session the
			// workspace switch may land on (session-id equality alone left the
			// dot standing when DSH opened another conversation of the same
			// workspace). Falls back to the bare session when the workspaces
			// service is unavailable.
			const mainGroup = mainSessionId === null ? null
				: (workspaceGroupOf(clientWorkspaces, mainSessionId) ?? new Set([mainSessionId]));
			/* The master switch (settings → 会话区提示) turns EVERY notice
			 * surface off at the source: no pill, no insert, no dot, no panel,
			 * no chime — the island behaves exactly like the pre-notice build.
			 * With it on, the user's retention setting expires round endings
			 * client-side (the host ALSO caps at its noticeTurnTtlMs config;
			 * effective lifetime = the min of the two). */
			const noticeOn = noticePrefs.enabled !== false;
			const rawNotices = noticeOn ? sanitizeNotices(st === null ? null : st.notice) : NO_NOTICES;
			const freshNotices = noticeOn ? expireTurnEnds(rawNotices, noticePrefs.ttlMinutes, Date.now()) : NO_NOTICES;
			const notices = mainGroup === null ? freshNotices
				: freshNotices.filter((item) => !mainGroup.has(item.sessionId));
			// Round endings of the viewed workspace, waiting to be consumed.
			const scopedRoundEnd = mainGroup !== null && freshNotices.some(
				(item) => item.turnEnd !== null && item.turnEnd !== undefined && mainGroup.has(item.sessionId));
			// Decorative overlay style (v0.4.9 装饰层) — rain / petals / motes.
			const decor = noticePrefs.decor || "none";
			const smtcRawActive = st !== null && st.active === true;
			// Media grace (v0.4.10b): a track change can flip SMTC's session
			// briefly to active:false (players tear down and re-register the
			// session, or report Closed for a poll or two). One such tick used
			// to unmount the whole island (the early return below) and it came
			// back only after the next positive poll — the user's "the capsule
			// disappears when switching tracks". Hold the LAST PLAYING
			// snapshot for a short grace window before agreeing that the
			// media really stopped. Real stops (player closed) still retire
			// after the grace; real pauses do not reach this path (active
			// stays true when merely paused).
			const SMTC_GRACE_MS = 3000;
			// Plain number in the ref (NOT an object): some test harnesses
			// implement useRef() without honouring its initial value, so
			// `current` can be null/undefined on the first read.
			const smtcGraceRef = useRef(0);
			const smtcGraceUntil = Number(smtcGraceRef.current) || 0;
			// The grace needs its own re-render trigger when it expires (the
			// poll clock's setTick lives inside useTrackState, out of scope
			// here). A dedicated boolean renders identically but flips the
			// committed state once the window closes.
			const [smtcGraceExpired, setSmtcGraceExpired] = useState(false);
			useEffect(() => {
				if (smtcRawActive) {
					smtcGraceRef.current = Date.now() + SMTC_GRACE_MS;
					if (smtcGraceExpired) setSmtcGraceExpired(false);
					return undefined;
				}
				// Raw-inactive: schedule the grace expiry so the island retires
				// after a real stop, and only if it is still inactive then.
				const timer = setTimeout(() => setSmtcGraceExpired(true), SMTC_GRACE_MS);
				return () => clearTimeout(timer);
			}, [smtcRawActive]);
			const smtcInGrace = !smtcRawActive && st !== null && !smtcGraceExpired
				&& Date.now() < smtcGraceUntil;
			const smtcActive = smtcRawActive || smtcInGrace;
			// While inside the grace window, keep the clock frozen at the last
			// real snapshot instead of extrapolating (the payload's own fields
			// are what the island renders below).
			// Notice mode = no SMTC media session, but a workspace needs attention.
			// The pill then shows the notice text itself; with media playing the
			// notice first INSERTS itself into the collapsed row for a moment and
			// then hands off to the red dot (bottom-right).
			const noticeMode = !smtcActive && notices.length > 0;
			const noticeSerial = st !== null && st.notice !== null && typeof st.notice === "object"
				? Number(st.notice.serial) || 0 : 0;
			const noticeTop = notices.length > 0 ? notices[0] : null;
			const noticeHead = noticeTop !== null ? noticeHeadline(noticeTop) : "";
			// Last NON-EMPTY notice snapshot. Two consumers: the notice panel keeps
			// its content while the user reads it (the host may already have cleared
			// the state after an ack), and the ghost pill renders it while fading
			// out. Plain render-time cache, same pattern as lineStateRef.
			const lastNoticeRef = useRef(null);
			if (notices.length > 0) {
				lastNoticeRef.current = { serial: noticeSerial, head: noticeHead, count: notices.length, top: noticeTop, list: notices };
			}

			/* ---- insert window: a notice arriving WHILE media plays interrupts
			 * the lyric row for NOTICE_INSERT_MS, then reverts to the red dot.
			 * Render-phase state adjust (the LyricTransition pattern): the insert
			 * must be in the FIRST painted frame, so it cannot wait for an effect.
			 * noticeKeyRef dedupes: only a changed serial/headline re-inserts.
			 * everPolledRef SUPPRESSES the cold-mount replay: the very first poll
			 * after a page refresh / hot reload carries both "media playing" and
			 * any standing notice — replaying the insert for an already-seen
			 * notice on every remount read as noise, so the window only arms for
			 * notices that ARRIVE while the island is live (or a genuine media
			 * start observed across two polls). */
			const [insertDeadline, setInsertDeadline] = useState(0);
			const everPolledRef = useRef(false);
			const polledBefore = everPolledRef.current;
			const noticeKeyRef = useRef("");
			const noticeKey = notices.length > 0 ? String(noticeSerial) + "|" + noticeHead : "";
			if (noticeKey !== "" && noticeKey !== noticeKeyRef.current) {
				noticeKeyRef.current = noticeKey;
				if (smtcActive && polledBefore) setInsertDeadline(Date.now() + NOTICE_INSERT_MS);
			}
			/* Continuity: media STARTING while an unacknowledged pill is visible
			 * keeps the headline up for one insert window before the dot takes
			 * over. The same polledBefore guard skips the cold mount. */
			const prevSmtcRef = useRef(null);
			const smtcTransition = prevSmtcRef.current !== null && prevSmtcRef.current.active !== smtcActive
				? prevSmtcRef.current.seen === true : null;
			if (smtcTransition === true && smtcActive && notices.length > 0) {
				setInsertDeadline(Date.now() + NOTICE_INSERT_MS);
			}
			/* Commit-time bookkeeping for the two refs above. Render-phase writes
			 * are UNSAFE here: a render that queues a render-phase setState (the
			 * ghost arm below, a transition arm above) is DISCARDED by React, but
			 * its ref mutation already happened — the re-render then reads the
			 * poisoned value (this made the cold-mount poll play the arrival
			 * chime; the same hazard silently broke the media-start continuity
			 * insert). Recording the COMMITTED values in an effect keeps every
			 * render-phase read honest. */
			useEffect(() => {
				everPolledRef.current = st !== null;
				prevSmtcRef.current = { seen: st !== null, active: smtcActive };
			});
			const inserting = smtcActive && insertDeadline > Date.now() && notices.length > 0;
			useEffect(() => {
				if (!(insertDeadline > 0)) return undefined;
				const timer = setTimeout(() => setInsertDeadline(0), Math.max(0, insertDeadline - Date.now()));
				return () => clearTimeout(timer);
			}, [insertDeadline]);

			/* ---- arrival sound (settings → 会话区提示): plays ONCE per notice
			 * arrival, never on repeats/clears, and never on the cold mount
			 * (polledBefore — the same philosophy as the insert replay
			 * suppression: a remount is not a new arrival). A short cooldown
			 * stops machine-gunning when several events land together (a turn
			 * end plus an approval flash arriving in the same tick). The
			 * style/repeats/volume all come from the notice prefs. */
			const soundOn = noticeOn && noticePrefs.sound !== false;
			const soundAtRef = useRef(0);
			useEffect(() => {
				if (!soundOn || noticeKey === "" || !polledBefore) return undefined;
				const now = Date.now();
				if (now - soundAtRef.current < NOTICE_SOUND_COOLDOWN_MS) return undefined;
				soundAtRef.current = now;
				playNoticeSound(noticePrefs.soundStyle, noticePrefs.soundRepeats, noticePrefs.soundVolume);
				return undefined;
			}, [noticeKey, soundOn]);

			/* ---- ghost pill: after an ack clears the notices (or the last turn
			 * ending expires) the idle pill must FADE out, not blink away. The flag
			 * is armed during notice mode and cleared one fade cycle after the mode
			 * drops — unless the user is still reading the expanded panel, which
			 * holds it until they leave. */
			const [noticeGhost, setNoticeGhost] = useState(false);
			if (noticeMode && !noticeGhost) setNoticeGhost(true);
			useEffect(() => {
				if (noticeMode || !noticeGhost) return undefined;
				if (smtcActive || expanded) {
					// Nothing is fading (island is in lyric mode or held open):
					// retire the flag so a later media stop cannot replay a stale
					// notice row.
					setNoticeGhost(false);
					return undefined;
				}
				const timer = setTimeout(() => setNoticeGhost(false), NOTICE_FADE_MS);
				return () => clearTimeout(timer);
			}, [noticeMode, noticeGhost, smtcActive, expanded]);
			const ghostAny = noticeGhost && !noticeMode && !smtcActive;

			/* ---- red-dot delayed hide: keep the button mounted one fade cycle
			 * after its condition clears (ack / notices settled), tagged with the
			 * fade-out class; a re-appearing notice cancels the removal. The arm
			 * happens in an EFFECT on purpose: dotPresent itself depends on the
			 * insert window, whose deadline is set during render — a render-phase
			 * arm here would see the PRE-insert snapshot (dotPresent momentarily
			 * true) and queue a phantom dot for the insert frame. */
			const dotPresent = smtcActive && notices.length > 0 && panelView !== "notices" && !inserting;
			const [dotHold, setDotHold] = useState(false);
			useEffect(() => {
				if (!dotPresent) return;
				setDotHold(true);
				return undefined;
			}, [dotPresent]);
			useEffect(() => {
				if (dotPresent || !dotHold) return undefined;
				const timer = setTimeout(() => setDotHold(false), NOTICE_FADE_MS);
				return () => clearTimeout(timer);
			}, [dotPresent, dotHold]);

			/* ---- visiting a workspace consumes its ROUND ENDINGS (v0.4.4).
			 * The main-session transition IS the viewing — the round summary is
			 * the conversation the user just opened — so a scoped ack retires
			 * the whole workspace's round endings for real (no resurrection
			 * after switching away, which display filtering alone caused).
			 * Questions are never consumed: the agent still waits; they merely
			 * stay hidden while in the workspace. Effect-based (no render-phase
			 * POST); the poll render re-evaluates the main session, so the
			 * switch lands within one tick. The serial rides along in the deps
			 * so a round that ENDS while the user is watching is consumed too. */
			useEffect(() => {
				if (!scopedRoundEnd || mainGroup === null) return undefined;
				postNoticeAck({ sessionIds: Array.from(mainGroup) });
				return undefined;
			}, [mainSessionId, scopedRoundEnd ? noticeSerial : 0]);

			// One collapsed row for every mode: notice (no media) / insert
			// (transient) / ghost (fading) all render the notice content; the
			// unified LyricTransition cross-fades notice <-> lyric switches.
			const noticeRowShown = noticeMode || inserting || ghostAny;
			useEffect(() => {
				const wrap = nowWrapRef.current;
				if (!wrap || typeof document === "undefined") return;
				/* This measured width exists ONLY to keep the COLLAPSED pill stable.
				 * While expanded the panel owns the width, and leaving an explicit
				 * width on the collapsed row is harmful: `.dnl-now-wrap` is collapsed
				 * by `grid-template-rows:0fr`, which zeroes its HEIGHT but not its
				 * width, so a long lyric line widened the whole expanded capsule
				 * (measured 362 -> 598px). During a drag the song keeps playing, so
				 * each long line stretched the window - the reported "the capsule is
				 * stretched while dragging in the expanded view".
				 * Clear it on expand and re-measure on collapse. */
				if (expanded) {
					if (wrap.style.width !== "") wrap.style.width = "";
					lastLineWidth.current = 0;
					return;
				}
				/* Notice rows (notice mode / insert / ghost) have no lyric line to
				 * measure; clear any pinned width so the pill sizes to the notice
				 * text, and forget the last measurement so the resumed lyric row
				 * pins fresh instead of skipping the width write for an
				 * identical line. */
				if (noticeRowShown) {
					if (wrap.style.width !== "") wrap.style.width = "";
					lastLineWidth.current = 0;
					return;
				}
				/* No empty-text early return any more (v0.4.10): the measured text
				 * now always equals the displayed text (lyric line OR title
				 * fallback OR "…"), so every state gets a width pass. */
				// Measure with a hidden span inheriting the same font, so the value
				// matches the real .dnl-now-text metrics exactly.
				const probe = document.createElement("span");
				probe.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;"
					+ "font-size:13px;line-height:22px;max-width:none;"
					+ "font-family:var(--dnl-font,inherit)";
				probe.textContent = lineTextForHooks;
				document.body.appendChild(probe);
				const measured = Math.ceil(probe.getBoundingClientRect().width) + 2;
				probe.remove();
				if (!Number.isFinite(measured) || measured <= 0) return;
				/* `.dnl-now-text` caps itself at 48vw. A longer label — a bilibili
				 * video title, say — would otherwise size the pill far beyond its
				 * own text and leave a wide empty gap after the ellipsis (reported
				 * live 2026-11-09: a pre-subtitle capsule stretched to the cap with
				 * the title cut off mid-word). Clamp the WRITTEN width to the same
				 * cap; the constant here and the CSS rule MUST stay in sync. */
				const viewport = typeof window !== "undefined" && Number(window.innerWidth) > 0
					? Number(window.innerWidth) : 0;
				const width = viewport > 0 ? Math.min(measured, Math.ceil(viewport * 0.48)) : measured;
				if (width === lastLineWidth.current) return;
				// First measurement: pin without animating (no entrance animation
				// from 0). Later changes interpolate via CSS.
				if (lastLineWidth.current === 0) {
					wrap.style.transition = "none";
					wrap.style.width = width + "px";
					void wrap.offsetWidth;
					wrap.style.transition = "";
				} else {
					wrap.style.width = width + "px";
				}
				lastLineWidth.current = width;
			}, [lineTextForHooks, prefs.font, st?.active, expanded, noticeRowShown]);

			// Keep the active row in the middle of the scrolling list. Declared BEFORE
			// the early return below: a hook placed after it changes the hook count
			// between renders and React unmounts the whole island.
			useEffect(() => {
				const row = activeRowRef.current;
				const list = linesRef.current;
				if (!row || !list) return;
				const rowTop = row.offsetTop - list.offsetTop;
				const target = rowTop - (list.clientHeight - row.offsetHeight) / 2;
				const max = list.scrollHeight - list.clientHeight;
				const top = Math.max(0, Math.min(max, target));
				// A jump on the same frame as the cross-fade reads as "sticks, then
				// snaps". Scroll smoothly, but only when it actually moves: the
				// reduced-motion preference (and browsers without smooth support) fall
				// back to the instant assignment.
				const reduced = typeof window !== "undefined" && typeof window.matchMedia === "function"
					&& window.matchMedia("(prefers-reduced-motion: reduce)").matches;
				const distance = Math.abs(top - list.scrollTop);
				if (reduced || distance < 1) { list.scrollTop = top; return; }
				if (typeof list.scrollTo === "function") {
					try { list.scrollTo({ top, behavior: "smooth" }); return; } catch { /* fall through */ }
				}
				list.scrollTop = top;
			}, [indexForHooks, expanded, panelView, lyricForHooks.songId, linesForHooks.length]);

			// Hidden only when there is neither a media session, nor a notice to
			// show, nor a ghost still fading: notice mode keeps the pill alive
			// without SMTC, and the ghost holds it one fade cycle after an ack.
			if (!smtcActive && !noticeMode && !noticeGhost) return null;

			const pos = clock.read(Date.now());
			const duration = Number(st.durationSec) || 0;

			const lyric = st.lyric !== null && typeof st.lyric === "object" ? st.lyric : { status: "idle" };
			const lines = linesForHooks;
			// Sticky, same as indexForHooks: a dithering positionSec must not flip
			// the rendered line back and forth across a boundary.
			// Same settled index as indexForHooks: using a second, independent clock
			// read here let the rendered line and the scroll/highlight disagree for a
			// frame, and it advanced the stateful guards twice per render.
			const index = indexForHooks;
			const currentLine = index >= 0 ? lines[index] : null;



			const title = typeof st.title === "string" ? st.title : "";
			const artist = typeof st.artist === "string" ? st.artist : "";
			// WIDTH SOURCE — display twin of fallbackLabelForHooks (same expression).
			const fallbackLabel = (displayTitle(title) + (artist !== "" ? " — " + artist : "")).trim();

			// Acknowledge the current notices: the host clears its state, so both
			// the pill and the red dot retire (fading here). Fire-and-forget —
			// the next poll reflects the cleared state either way. This is the
			// UNSCOPED list-read ack; the scoped per-workspace ack lives in the
			// effect above.
			const ackNotices = () => {
				if (notices.length === 0) return;
				postNoticeAck({});
			};
			// The panel keeps showing the LAST non-empty list after an ack (the
			// user is mid-read), so it falls back to the snapshot.
			const viewNotices = notices.length > 0 ? notices
				: (lastNoticeRef.current !== null && lastNoticeRef.current !== undefined
					&& Array.isArray(lastNoticeRef.current.list) ? lastNoticeRef.current.list : []);

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

			// Ask the host to drive the player. The host forwards to the SMTC bridge
			// and answers with the ack, so `ok:false` here is a real refusal (no
			// session, unsupported player) rather than a transport failure.
			const control = async (cmd, extra) => {
				if (pendingCmd !== "") return;
				setPendingCmd(cmd);
				setControlNote("");
				try {
					const response = await fetch(CONTROL_ROUTE, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(Object.assign({ cmd }, extra || {})),
						signal: AbortSignal.timeout(5000),
					});
					const data = await response.json().catch(() => null);
					if (!data || data.ok !== true) {
						const reason = data && typeof data.reason === "string" ? data.reason : "";
						setControlNote(reason === "no-session" ? "没有可控制的播放器"
							: reason === "no-seek" || reason === "seek-failed" ? "该播放器不支持跳转"
							: "播放器未响应");
					}
				} catch {
					setControlNote("控制请求失败");
				} finally {
					setPendingCmd("");
				}
			};

			/* ±5 s. Clamped to the track so the ends do not ask for an impossible
			 * position; the bridge re-checks the player's own seek capability. */
			const seekBy = (delta) => {
				const target = seekTarget(pos, delta, duration);
				if (target === null) return;
				void control("seek", { pos: target });
			};

			// WIDTH SOURCE — keep in sync with lineTextForHooks (hooks区同表达式).
			const collapsedText =
				currentLine !== null
					? currentLine.text
					: lyric.status === "matched" || lyric.status === "loading"
						? fallbackLabel !== "" ? fallbackLabel : "…"
						: fallbackLabel !== "" ? fallbackLabel : "…";

			const collapsedStatus =
				lyric.status === "unmatched" || lyric.status === "error" ? " · 未匹配" : "";

			/* v0.4.1: the translation row is no longer track-wide reserved. Each
			 * line renders it collapsed (grid 0fr, see .dnl-now-trans-empty) when
			 * it has no translation of its own, so the pill centres its content
			 * instead of sitting high with a permanently reserved blank row. */

					/* ---------- expanded lyric window ---------- */
			/* Always render a fixed-size window around the active line and pad the
			 * out-of-range slots with invisible rows. Clamping the range instead (the
			 * old behaviour) pushed the last lines down to the bottom of the box,
			 * because there was nothing left to scroll up past them. */
			const ROWS_BEFORE = 4;
			const ROWS_AFTER = 4;
			// Any line carrying a translation makes every row two text lines tall, so
			// the spacer rows have to reserve the same height.
			const hasTranslation = lines.some(row => typeof row.trans === "string" && row.trans !== "");
			const rows = [];
			if (lines.length > 0) {
				const slots = lyricWindow(lines.length, index, ROWS_BEFORE, ROWS_AFTER);
				for (let slot = 0; slot < slots.length; slot += 1) {
					const i = slots[slot];
					if (i < 0) {
						// The spacer must match a real row's height. A translated row is
						// taller (two text lines), so a single-line spacer made the pads
						// shorter than the rows they stand in for and pulled the active
						// line off centre near the start/end of a song.
						rows.push(h("div", {
							key: "pad" + String(slot),
							className: "dnl-line dnl-line-pad",
							"aria-hidden": "true",
						},
							h("div", { className: "dnl-line-main" }, "\u00a0"),
							hasTranslation ? h("div", { className: "dnl-line-trans" }, "\u00a0") : null));
						continue;
					}
					const active = i === index;
					rows.push(
						h("div", {
							key: "l" + String(i),
							className: "dnl-line" + (active ? " dnl-line-active" : ""),
							ref: active ? activeRowRef : undefined,
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
				// Suppress the click that follows this gesture from the very start.
				// It used to be set only after 4px of movement, so a short drag (or a
				// slightly shaky press) let the click through and the island's
				// onClick expanded + pinned the capsule - the "dragging easily opens
				// the panel" complaint.
				suppressClick.current = true;
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
				// Keep the hover expansion off for a moment after the gesture: the
				// pointer is still sitting on the capsule, and expanding right then
				// is exactly the accidental open the user reported.
				hoverGuard.current = Date.now() + 400;
				if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
			};
			const style = Object.fromEntries(COLOR_FIELDS.filter(([key]) => colors[key]).map(([key, , variable]) => [variable, colors[key]]));
			if (prefs.font) style["--dnl-font"] = fontStack(prefs.font);
			if (glowMode !== "off") {
				// Theme accent is the default and the fallback; cover mode samples
				// the artwork and falls back to the same accent until it resolves.
				style["--dnl-halo"] = glowMode === "cover" && coverHalo ? coverHalo : "var(--dsw-alias-brand-primary)";
			}
			// Panel backing opacity: 1 keeps the theme token exactly as it is.
			style["--dnl-panel-alpha"] = String((Number.isFinite(prefs.panelOpacity) ? prefs.panelOpacity : 100) / 100);
			// Gradient-glass knobs (设置 → 胶囊样式 → 渐变玻璃调整): grain/tint
			// strengths and the companion colour drive the ::before/::after
			// overlays, the ring brightness scales the duotone border. Only
			// emitted while the skin is selected (harmless otherwise).
			if (prefs.capsuleStyle === "frosted") {
				style["--dnl-gg-grain"] = String((Number(noticePrefs.glassGrain) || 0) / 100);
				style["--dnl-gg-tint"] = String((Number(noticePrefs.glassTint) || 0) / 100);
				style["--dnl-gg-accent"] = /^#[0-9a-fA-F]{6}$/.test(String(noticePrefs.glassAccent)) ? noticePrefs.glassAccent : "#8b7cff";
				style["--dnl-gg-ring"] = String(Number(noticePrefs.glassRing) || 0);
			}
			// 方舟观测 accent (v0.4.9): theme-following, a fixed signature
			// colour, or the seven-colour hue-wheel rotation (the island then
			// carries the dnl-ak-rainbow class whose @property animation
			// cycles --dnl-ak-hue through the full wheel).
			if (prefs.capsuleStyle === "arknights") {
				const ak = noticePrefs.akAccent || "theme";
				style["--dnl-ak-accent"] = ak === "theme" ? "var(--dsw-alias-brand-primary)" : ak;
			}
			// Position is the capsule's CENTRE (that is what clampPlacement works in).
			// The host is centred on it with translateX(-50%) in CSS, so the value here
			// stays a centre even when the width changes.
			style.left = dragPosition ? dragPosition.x + "px" : ((prefs.x ?? 0.70) * 100) + "vw";
			style.top = dragPosition ? dragPosition.y + "px" : prefs.y === undefined ? "12px" : (prefs.y * 100) + "vh";
			// Ghost fade: the whole host (shell included) fades before unmount;
			// while the user is still reading the expanded panel it is held.
			return h("div", { className: "dnl-host" + (ghostAny && !expanded ? " dnl-host-fade" : ""), ref: hostRef, style },
				h("div", { className: "dnl-shell" + (expanded ? " dnl-shell-expanded" : "") },
				/* The breathing halo. Normal modes (theme/cover) advertise PLAYING
				 * media, so it stays off for a notice pill. v0.4.6 adds the
				 * 'notice' mode (呼吸灯 → 仅通知到达时): the halo is dark in normal
				 * play and lights up — ENLARGED (scale 1.45), brighter and at a
				 * faster cadence (dnl-halo-burst) — exactly while a notice row is
				 * on screen (idle pill / insert window / ghost fade), pairing the
				 * arrival chime with a visual beat. */
				!(glowMode !== "off" && (glowMode === "notice" ? noticeRowShown : !noticeMode)) ? null : h("span", {
					className: "dnl-halo"
						+ (glowMode === "notice" ? " dnl-halo-burst" : "")
						+ (st.playing === true || glowMode === "notice" ? "" : " dnl-halo-hold"),
					style: { "--dnl-glow-dur": glowMode === "notice" ? "1.15s" : glowDur, "--dnl-glow-amp": glowAmp },
					"aria-hidden": "true",
				},
					h("span", { className: "h1" }),
					h("span", { className: "h2" }),
					h("span", { className: "h3" }),
					/* Drift layer: same shape as the mid halo, hue-shifted, faded in
					 * behind the peak so the colour warms/cools within one breath. */
					h("span", { className: "h4" }),
					/* One-shot ripple when a song starts, NOT on every lyric line.
					 * The key used to include `index`, so React remounted this span
					 * and replayed the blur+scale animation on EVERY line change.
					 * Measured (real Chrome screenshot bursts): that repaint landed
					 * on the same frame as the lyric cross-fade and made line changes
					 * visibly jump whenever the halo was on - turning the halo off
					 * removed exactly that extra repaint. Keep the pulse as a
					 * per-track accent; the four breathing layers are unchanged. */
					glowMode !== "notice" && st.playing === true && index >= 0
						? h("span", { key: "kick:" + String(lyric.songId || ""), className: "dnl-kick" })
						: null),
				h("div", {
				className: "dnl-island" + (expanded ? " dnl-expanded" : "") + (noticeRowShown ? " dnl-notice" : "")
					+ (SKIN_IDS.has(prefs.capsuleStyle) ? " dnl-style-" + prefs.capsuleStyle : "")
					+ (prefs.capsuleStyle === "arknights" && noticePrefs.akAccent === "rainbow" ? " dnl-ak-rainbow" : ""),
					onMouseEnter: (event) => {
						if (collapseTimer.current) { clearTimeout(collapseTimer.current); collapseTimer.current = 0; }
						/* A drag must not be swallowed by the hover expansion, and the
						 * hover must not fire as a side effect of dragging.
						 *
						 * Three separate guards, because they cover different moments:
						 *   1. mid-gesture (dragRef set): never expand;
						 *   2. just after a gesture (hoverGuard): the pointer is parked
						 *      on the capsule, and expanding right then is what made the
						 *      left gutter "very easily open the panel";
						 *   3. entering THROUGH the gutter: expanding changes the
						 *      capsule's size and the handle's box mid-gesture, which is
						 *      what made the drag feel dead in the first place.
						 * The rest of the capsule still expands on hover as before. */
						if (dragRef.current) return;
						if (Date.now() < hoverGuard.current) return;
						if (typeof event?.clientX === "number") {
							const handle = hostRef.current?.querySelector?.(".dnl-drag");
							if (handle) {
								const box = handle.getBoundingClientRect();
								if (event.clientX >= box.left && event.clientX <= box.right) return;
							}
						}
						setExpanded(true);
						/* Hovering counts as VIEWING only when the collapsed row is
						 * actually showing the notice (notice pill / insert window),
						 * and only while it is on screen (not after expanding the
						 * lyrics panel). Hovering the LYRIC capsule must never
						 * consume unseen notices — that was the v0.4.2 flaw where
						 * hovering to read lyrics silently faded the dot away. */
						if (noticeRowShown && !expanded) ackNotices();
					},
					onMouseLeave: () => {
						if (collapseTimer.current) clearTimeout(collapseTimer.current);
						/* Leaving an OPEN notice view = done reading: acknowledge so
						 * the dot/pill retire (fading) after the collapse. No-op when
						 * the notices are already cleared. */
						if (expanded && panelView === "notices") ackNotices();
						/* Leaving the capsule also ends the pin. The pin exists so the
						 * capsule survives a momentary leave while working inside the
						 * panel - not to hold it open forever. Without this reset a stray
						 * pin (a click that bubbled out of the settings view) left the
						 * capsule expanded with no way to close it by moving away. */
						collapseTimer.current = setTimeout(() => {
							collapseTimer.current = 0;
							setPinned(false);
							setExpanded(false);
						}, 420);
					},
					onClick: () => {
						if (suppressClick.current) { suppressClick.current = false; return; }
						/* Opening by click pins (so it survives the pointer leaving);
						 * clicking an ALREADY-open capsule toggles the pin, but only via
						 * the island's own body - the panel and its controls stop their
						 * clicks, so knob changes can never reach this handler. */
						if (!expanded) { setExpanded(true); setPinned(true); }
						else setPinned((value) => !value);
					},
					role: "status",
					"aria-label": noticeRowShown ? "会话区提示：" + noticeHead : "当前歌词：" + collapsedText,
				},
					h("button", { type: "button", className: "dnl-drag", "aria-label": "拖动歌词浮层", title: "拖动以移动歌词浮层",
						onPointerDown: startDrag, onPointerMove: moveDrag, onPointerUp: endDrag, onPointerCancel: endDrag,
						onClick: event => { event.stopPropagation(); suppressClick.current = false; } }, "⠿"),
					/* Decorative overlay (v0.4.9 装饰层): rain streaks + droplets /
					 * falling petals / drifting motes, drawn entirely in CSS (no
					 * assets), stackable on the GLASS skins. Painted UNDER the text
					 * and aria-hidden - it is pure atmosphere. */
					decor !== "none" && DECOR_GLASS.has(prefs.capsuleStyle || "default")
						? h("div", Object.assign(
							{ className: "dnl-decor dnl-decor-" + decor, "aria-hidden": "true" },
							decor === "rainv2" ? { style: rainv2StyleVars(noticePrefs) } : null),
							/* 雨后玻璃 preset (v0.4.19): beads/sliders/remnants span
							 * the whole pane; density/pace/trail/highlight are user
							 * knobs (设置 → 胶囊样式 → 装饰层 → 雨后玻璃参数). */
							decor === "rainv2" ? rainv2DecorChildren(noticePrefs) : decor === "rain" ? [
								h("span", { key: "r1", className: "dnl-decor-streak s1" }),
								h("span", { key: "r2", className: "dnl-decor-streak s2" }),
								h("span", { key: "r3", className: "dnl-decor-streak s3" }),
								h("span", { key: "r4", className: "dnl-decor-streak s4" }),
								h("span", { key: "d1", className: "dnl-decor-drop d1" }),
								h("span", { key: "d2", className: "dnl-decor-drop d2" }),
								h("span", { key: "d3", className: "dnl-decor-drop d3" }),
								h("span", { key: "d4", className: "dnl-decor-drop d4" }),
							] : decor === "petals" ? [
								h("span", { key: "p1", className: "dnl-decor-petal p1" }),
								h("span", { key: "p2", className: "dnl-decor-petal p2" }),
								h("span", { key: "p3", className: "dnl-decor-petal p3" }),
								h("span", { key: "p4", className: "dnl-decor-petal p4" }),
							] : [
								h("span", { key: "m1", className: "dnl-decor-mote m1" }),
								h("span", { key: "m2", className: "dnl-decor-mote m2" }),
								h("span", { key: "m3", className: "dnl-decor-mote m3" }),
								h("span", { key: "m4", className: "dnl-decor-mote m4" }),
								h("span", { key: "m5", className: "dnl-decor-mote m5" }),
								h("span", { key: "m6", className: "dnl-decor-mote m6" }),
							])
						: null,
					/* The lyric line is the collapsed body. The panel lives in a grid
					 * wrapper that is always mounted: animating grid-template-rows
					 * 0fr -> 1fr interpolates the panel's *intrinsic* height, which a
					 * max-height bound cannot do (content shorter than the bound simply
					 * appears at full size in one frame - that was the jump).
					 * While collapsed the wrapper is width:0 as well, so the panel's
					 * natural width cannot widen the capsule: the collapsed pill stays
					 * as narrow as the lyric text. */
					/* The collapsed row shrinks on the SAME clock as the panel grows
					 * (1fr -> 0fr against the panel's 0fr -> 1fr). Collapsing it
					 * instantly instead would make the capsule's total height dip
					 * below the pointer for a frame, which fires mouseleave while the
					 * pointer is still: that was the expand/collapse loop. With both
					 * tracks transitioning, total height is monotonic. */
					/* The collapsed row: notice content (notice mode / insert window /
					 * ghost fade) or the lyric line - ONE LyricTransition so every
					 * switch between them cross-fades (lyric->notice on arrival,
					 * notice->lyric on hand-off / retire, notice->notice on updates).
					 * The ghost fade is handled at the host level (.dnl-host-fade). */
					h("div", { className: "dnl-now-wrap", ref: noticeRowShown ? undefined : nowWrapRef },
						h(LyricTransition, {
							identity: noticeRowShown
								? "notice|" + String(noticeSerial) + "|" + noticeHead
								: [st.app, st.title, st.artist, lyric.songId, index, collapsedText, currentLine?.trans].join("|"),
							},
							noticeRowShown
								? h("div", { className: "dnl-now dnl-notice-now" },
									h("span", { className: "dnl-notice-icon", "aria-hidden": "true" },
										noticeTop && noticeTop.question ? "🔔" : "✔"),
									h("span", { className: "dnl-now-text dnl-notice-text" }, noticeHead),
									notices.length > 1
										? h("span", { className: "dnl-notice-count" }, "+" + String(notices.length - 1))
										: null)
								: h("div", { className: "dnl-now" },
									h("span", { className: "dnl-now-text" }, collapsedText),
									/* Only a line that ACTUALLY has a translation renders a visible
									 * second row. Lines without one (and the title/fallback label
									 * while the lyric resolves) render the same span collapsed to
									 * zero height via grid-template-rows, transitioning with the
									 * row: the pill stays centred instead of "text high up with the
									 * translation row permanently reserved". The old track-wide
									 * reservation (a hidden 16px spacer on every line) did that. */
									h("span", {
										className: "dnl-now-trans" + (currentLine && typeof currentLine.trans === "string" && currentLine.trans.trim() ? "" : " dnl-now-trans-empty"),
										"aria-hidden": currentLine && typeof currentLine.trans === "string" && currentLine.trans.trim() ? undefined : "true",
									}, currentLine && typeof currentLine.trans === "string" && currentLine.trans.trim() ? currentLine.trans : ""),
									collapsedStatus !== ""
										? h("span", { className: "dnl-now-sub" }, collapsedStatus) : null))),
				/* The panel: notice content without media (or while the ghost is
				 * held open), the lyric/settings machinery otherwise. */
				!smtcActive && (noticeMode || (noticeGhost && !inserting))
					? h("div", { className: "dnl-grow", "aria-hidden": expanded ? undefined : "true",
						inert: expanded ? undefined : "" },
						h("div", { className: "dnl-grow-inner" },
							h("div", { className: "dnl-panel dnl-notice-panel" },
								/* Notice mode has no gear and no lyric machinery - the
								 * full notice list is the panel body itself; viewNotices
								 * keeps the list readable after an ack. */
								noticeList(viewNotices))))
					: h("div", { className: "dnl-grow", "aria-hidden": expanded ? undefined : "true",
						inert: expanded ? undefined : "" },
						h("div", { className: "dnl-grow-inner" },
							h("div", { className: "dnl-panel" },
							/* A direct child of .dnl-panel, so it exists in BOTH views and is
							 * positioned against the panel (not against a view-specific box). */
							h("button", {
								type: "button",
								className: "dnl-gear" + (panelView !== "lyrics" ? " dnl-gear-on" : ""),
								title: panelView === "lyrics" ? "歌词胶囊设置" : "返回歌词",
								"aria-label": panelView === "lyrics" ? "歌词胶囊设置" : "返回歌词",
								"aria-pressed": panelView === "lyrics" ? "false" : "true",
								onClick: (event) => {
									event.stopPropagation();
									setPanelView(panelView === "lyrics" ? "settings" : "lyrics");
								},
							}, panelView === "lyrics" ? "⚙" : "✕"),
							/* Three views now: settings / the red-dot notice list /
							 * the lyrics body. The notice view reuses noticeList so it
							 * cannot drift from the notice-mode panel. */
							panelView === "settings"
								? h("div", {
									className: "dnl-settings",
									/* Clicks inside the settings view must not reach the island's
									 * pin toggle: changing a knob used to pin the capsule open. */
									onClick: (event) => event.stopPropagation(),
								},
									h("div", { className: "dnl-set-head-row" },
										h("span", { className: "dnl-set-head" }, "歌词胶囊设置")),
									settingsError !== "" ? h("p", { className: "dnl-set-note", role: "alert" }, settingsError) : null,
									capsuleSettings({ colors, prefs, compact: true, saveColors, saveDisplay,
										notice: noticePrefs, saveNotice: (next) => setSettingsError(writeNoticePrefs(next) ? "" : "无法保存设置，请检查存储权限。") }))
								: panelView === "notices"
									? h("div", { className: "dnl-panel-body dnl-notice-body" }, noticeList(viewNotices))
									: h("div", { className: "dnl-panel-body" },
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
								/* Inside the header row: fully within the clipped box, and
								 * a normal 24x24 target instead of a corner sliver. */
							),
							/* No LyricTransition here on purpose: wrapping the whole list
							 * made every line change render a SECOND nine-row list and
							 * cross-fade the two against each other, which is what looked
							 * like "sticks, then jumps". The list already communicates the
							 * change through the active-row highlight and the scroll. */
							rows.length > 0
								? h("div", { className: "dnl-lines", ref: linesRef }, rows)
								: h("div", { className: "dnl-lines dnl-lines-empty" }, "暂无歌词"),
							h("div", { className: "dnl-progress" },
								h("span", { className: "dnl-time" }, formatTime(pos)),
								h("div", { className: "dnl-bar" },
									h("div", { className: "dnl-bar-fill", style: { width: progressPct.toFixed(1) + "%" } }),
								),
								h("span", { className: "dnl-time" }, formatTime(duration)),
							),
							/* Transport controls. Stop propagation so a click here never
							 * toggles the pin state underneath. */
							h("div", { className: "dnl-controls" },
								h("button", {
									type: "button", className: "dnl-ctl dnl-ctl-sm", title: "后退 5 秒", "aria-label": "后退 5 秒",
									disabled: !expanded || pendingCmd !== "" || st.canSeek === false,
									onClick: (event) => { event.stopPropagation(); seekBy(-5); },
								}, pendingCmd === "seek" ? "…" : "−5s"),
								h("button", {
									type: "button", className: "dnl-ctl", title: "上一首", "aria-label": "上一首",
									disabled: !expanded || pendingCmd !== "" || st.canPrev === false,
									onClick: (event) => { event.stopPropagation(); void control("prev"); },
								}, pendingCmd === "prev" ? "…" : "⏮"),
								h("button", {
									type: "button", className: "dnl-ctl dnl-ctl-main",
									title: st.playing === true ? "暂停" : "播放",
									"aria-label": st.playing === true ? "暂停" : "播放",
									disabled: !expanded || pendingCmd !== "" || st.canToggle === false,
									onClick: (event) => { event.stopPropagation(); void control("toggle"); },
								}, pendingCmd === "toggle" ? "…" : (st.playing === true ? "⏸" : "▶")),
								h("button", {
									type: "button", className: "dnl-ctl", title: "下一首", "aria-label": "下一首",
									disabled: !expanded || pendingCmd !== "" || st.canNext === false,
									onClick: (event) => { event.stopPropagation(); void control("next"); },
								}, pendingCmd === "next" ? "…" : "⏭"),
								h("button", {
									type: "button", className: "dnl-ctl dnl-ctl-sm", title: "前进 5 秒", "aria-label": "前进 5 秒",
									disabled: !expanded || pendingCmd !== "" || st.canSeek === false,
									onClick: (event) => { event.stopPropagation(); seekBy(5); },
								}, pendingCmd === "seek" ? "…" : "+5s"),
								controlNote !== "" ? h("span", { className: "dnl-ctl-note" }, controlNote) : null,
							),
							),
						),
						),
				),
				/* Red dot (bottom-right) while media is playing and unviewed
				 * notices wait. The requirement: with the island up, ONLY the dot
				 * shows - the full text appears after the user clicks it. Hidden
				 * while the insert window runs (the row itself announces) and
				 * while the notice view is open (the gear ✕ returns to lyrics);
				 * in notice mode the pill itself is the notice, so no dot either.
				 * dotHold keeps the button mounted one fade cycle after the
				 * notices clear (ack / settled), tagged .dnl-dot-out. */
				dotPresent || (dotHold && smtcActive)
					? h("button", {
						type: "button",
						className: "dnl-dot" + (dotPresent ? "" : " dnl-dot-out"),
						title: dotPresent ? "会话区提示（" + String(notices.length) + " 条）" : "",
						"aria-hidden": dotPresent ? undefined : "true",
						tabIndex: dotPresent ? undefined : -1,
						"aria-label": dotPresent ? "查看会话区提示，共 " + String(notices.length) + " 条" : "",
						onClick: (event) => {
							event.stopPropagation();
							if (!dotPresent) return;
							setPanelView("notices");
							setExpanded(true);
							setPinned(true);
							/* The dot then FADES OUT under the opening panel
							 * (dotPresent flips with the notices view, and
							 * dotHold keeps it mounted one fade cycle) — a
							 * click is still a transition, not a removal. */
						},
					}, h("span", { className: "dnl-dot-core", "aria-hidden": "true" }))
					: null,
				),
						),
			);
		}

		/* ================= settings (island + ambient) ================= */

		/** Build one collapsible settings block. A plain builder rather than a
		 *  React component: the block is static markup, and keeping it out of the
		 *  element tree means the test harness - which invokes function
		 *  components to walk the tree - only ever sees plain elements.
		 *  `open` is an initial attribute; the prop never changes afterwards, so
		 *  a user toggle survives the re-render caused by saving a preference. */
		function settingsGroup(title, hint, open, children) {
			return h("details", { className: "dnls-group", open: open === true ? true : undefined },
				h("summary", { className: "dnls-summary" },
					h("span", { className: "dnls-caret", "aria-hidden": "true" }, "\u25b8"),
					h("span", { className: "dnls-title" }, title),
					hint ? h("span", { className: "dnls-hint" }, hint) : null),
				h("div", { className: "dnls-body" }, children));
		}

		/** Sub-heading inside a group: keeps a block that holds several kinds of
		 *  knob scannable without turning each kind into its own accordion. */
		function settingsSub(title) {
			return h("div", { className: "dnls-sub" }, title);
		}

		/** The capsule's own knobs, rendered inside the expanded capsule when the
		 *  gear is pressed. Built from the same helpers as the plugin settings page
		 *  so the two cannot drift apart visually; `compact` drops the prose that
		 *  would not fit a 300px panel. */
		function capsuleSettings(props) {
			const colors = props.colors;
			const prefs = props.prefs;
			const compact = props.compact === true;
			// Injected so this builder works from inside the capsule, which has no
			// access to BundleSettings' closures.
			const saveColors = props.saveColors;
			const saveDisplay = props.saveDisplay;
			const saveNotice = props.saveNotice;
			const notice = props.notice;
			return [
				h("label", { key: "panel-opacity", className: "dnl-set-row" }, "面板不透明度",
					h("input", { type: "range", min: 20, max: 100, step: 5, "aria-label": "面板不透明度",
						value: Number.isFinite(prefs.panelOpacity) ? prefs.panelOpacity : 100,
						onChange: (event) => saveDisplay({ ...readDisplay(), panelOpacity: Number(event.target.value) }) }),
					h("span", { className: "dnl-set-value" }, (Number.isFinite(prefs.panelOpacity) ? prefs.panelOpacity : 100) + "%")),
				h("p", { key: "opacity-help", className: "dnl-set-note" }, "100% 即主题原本的叠加层颜色；越低越透出壁纸。比主题更不透明反而会让浅色字更糊，所以上限就是主题值。"),
				...COLOR_FIELDS.map(([key, label]) => h("label", { key, className: "dnl-set-row" }, label,
					h("input", { type: "color", "aria-label": label, value: colors[key] || "#808080",
						onChange: (event) => saveColors({ ...readColors(), [key]: event.target.value }) }),
					h("span", { className: "dnl-set-value" }, colors[key] || "跟随主题"),
					h("button", { type: "button", className: "dnl-set-btn", disabled: !colors[key],
						onClick: () => { const next = { ...readColors() }; delete next[key]; saveColors(next); } }, "默认"))),
				h("button", { key: "reset-colors", type: "button", className: "dnl-set-btn", onClick: () => saveColors({}) }, "恢复全部主题默认"),
				h("label", { key: "capsule-style", className: "dnl-set-row" }, "胶囊样式",
					h("select", { "aria-label": "胶囊样式",
						value: SKIN_IDS.has(prefs.capsuleStyle) ? prefs.capsuleStyle : "default",
						onChange: (event) => saveDisplay({ ...readDisplay(),
							capsuleStyle: event.target.value === "default" ? "" : event.target.value }) },
						[["default", "默认（毛玻璃圆角）"], ["frosted", "渐变玻璃（可调参数）"], ["wishes", "静谧祝愿（紫蓝柔光）"],
							["ember", "暗夜余烬（暖光炭色）"], ["arknights", "方舟观测（HUD 切角）"], ["persona", "月相引路（蓝调光点）"],
							["solid", "实底卡片"]].map(([id, label]) => h("option", { key: id, value: id }, label)))),
				prefs.capsuleStyle === "arknights"
					? h("div", { key: "ak-block" },
						h("p", { className: "dnl-set-note" }, "方舟观测强调色（描边 / 框角 / 扫描线）："),
						h("label", { className: "dnl-set-row" }, "强调色",
							h("select", { "aria-label": "方舟观测强调色",
								value: notice.akAccent || "theme",
								onChange: (event) => saveNotice({ ...readNoticePrefs(), akAccent: event.target.value }) },
								AK_ACCENTS.map(([id, label]) => h("option", { key: id, value: id }, label)))))
					: null,
				DECOR_GLASS.has(SKIN_IDS.has(prefs.capsuleStyle) ? prefs.capsuleStyle : "default")
					? h("div", { key: "decor-block" },
						h("label", { className: "dnl-set-row" }, "装饰层",
							h("select", { "aria-label": "装饰层样式",
								value: notice.decor || "none",
								onChange: (event) => saveNotice({ ...readNoticePrefs(), decor: event.target.value }) },
								DECOR_STYLES.map(([id, label]) => h("option", { key: id, value: id }, label)))),
						h("p", { className: "dnl-set-note" }, "装饰层：雨痕水珠 / 雨后玻璃 / 花瓣飘落 / 光点浮尘——纯 CSS 绘制，仅玻璃类皮肤可用；开启后位于文字下层，不影响阅读与操作。"))
					: null,
				notice.decor === "rainv2" ? [
					h("p", { key: "rv2-lede", className: "dnl-set-note" }, "雨后玻璃参数（改动即时生效）：密度是悬挂水珠的数量，速度是整体节奏倍率，残痕控制滑珠留下的水痕与子水珠，高光是珠面反光亮斑。"),
					h("label", { key: "rv2-density", className: "dnl-set-row" }, "水珠密度",
						h("input", { type: "range", min: 4, max: 12, step: 1, "aria-label": "雨后玻璃水珠密度",
							value: notice.rv2Density,
							onChange: (event) => saveNotice({ ...readNoticePrefs(), rv2Density: Number(event.target.value) }) }),
						h("span", { className: "dnl-set-value" }, notice.rv2Density + " 颗")),
					h("label", { key: "rv2-pace", className: "dnl-set-row" }, "下滑速度",
						h("input", { type: "range", min: 50, max: 200, step: 10, "aria-label": "雨后玻璃下滑速度",
							value: notice.rv2Pace,
							onChange: (event) => saveNotice({ ...readNoticePrefs(), rv2Pace: Number(event.target.value) }) }),
						h("span", { className: "dnl-set-value" }, notice.rv2Pace + "%")),
					h("label", { key: "rv2-trail", className: "dnl-set-row" }, "残痕强度",
						h("input", { type: "range", min: 0, max: 200, step: 10, "aria-label": "雨后玻璃残痕强度",
							value: notice.rv2Trail,
							onChange: (event) => saveNotice({ ...readNoticePrefs(), rv2Trail: Number(event.target.value) }) }),
						h("span", { className: "dnl-set-value" }, notice.rv2Trail + "%")),
					h("label", { key: "rv2-hi", className: "dnl-set-row" }, "高光强度",
						h("input", { type: "range", min: 0, max: 100, step: 5, "aria-label": "雨后玻璃高光强度",
							value: notice.rv2Hi,
							onChange: (event) => saveNotice({ ...readNoticePrefs(), rv2Hi: Number(event.target.value) }) }),
						h("span", { className: "dnl-set-value" }, notice.rv2Hi + "%")),
					h("button", { key: "rv2-reset", type: "button", className: "dnl-set-btn",
						onClick: () => saveNotice({ ...readNoticePrefs(), rv2Density: 7, rv2Pace: 100, rv2Trail: 100, rv2Hi: 70 }) }, "恢复雨后玻璃默认参数"),
				] : null,
				prefs.capsuleStyle === "frosted" ? [
					h("p", { key: "gg-lede", className: "dnl-set-note" }, "渐变玻璃调整（改动即时生效）："),
					h("label", { key: "gg-grain", className: "dnl-set-row" }, "颗粒强度",
						h("input", { type: "range", min: 0, max: 100, step: 5, "aria-label": "渐变玻璃颗粒强度",
							value: notice.glassGrain,
							onChange: (event) => saveNotice({ ...readNoticePrefs(), glassGrain: Number(event.target.value) }) }),
						h("span", { className: "dnl-set-value" }, notice.glassGrain + "%")),
					h("label", { key: "gg-tint", className: "dnl-set-row" }, "罩染强度",
						h("input", { type: "range", min: 0, max: 100, step: 5, "aria-label": "渐变玻璃罩染强度",
							value: notice.glassTint,
							onChange: (event) => saveNotice({ ...readNoticePrefs(), glassTint: Number(event.target.value) }) }),
						h("span", { className: "dnl-set-value" }, notice.glassTint + "%")),
					h("label", { key: "gg-ring", className: "dnl-set-row" }, "描边亮度",
						h("input", { type: "range", min: 0, max: 200, step: 10, "aria-label": "渐变玻璃描边亮度",
							value: notice.glassRing,
							onChange: (event) => saveNotice({ ...readNoticePrefs(), glassRing: Number(event.target.value) }) }),
						h("span", { className: "dnl-set-value" }, notice.glassRing + "%")),
					h("label", { key: "gg-accent", className: "dnl-set-row" }, "伴侣色",
						h("select", { "aria-label": "渐变玻璃伴侣色",
							value: notice.glassAccent || "#8b7cff",
							onChange: (event) => saveNotice({ ...readNoticePrefs(), glassAccent: event.target.value }) },
							GLASS_ACCENTS.map(([hex, label]) => h("option", { key: hex, value: hex }, label)))),
				] : null,
				h("label", { key: "glow", className: "dnl-set-row" }, "呼吸灯",
					h("select", { "aria-label": "呼吸灯模式",
						value: prefs.glow === "off" ? "off" : prefs.glow === "cover" ? "cover" : prefs.glow === "notice" ? "notice" : "theme",
						onChange: (event) => saveDisplay({ ...readDisplay(), glow: event.target.value }) },
						[["theme", "跟随主题"], ["cover", "跟随封面"], ["notice", "仅通知到达时"], ["off", "关闭"]].map(([id, label]) => h("option", { key: id, value: id }, label)))),
				prefs.glow !== "off" && prefs.glow !== "notice" ? h("label", { key: "glow-pace", className: "dnl-set-row" }, "呼吸节奏",
					h("select", { "aria-label": "呼吸节奏", value: prefs.glowPace === "calm" ? "calm" : prefs.glowPace === "lively" ? "lively" : "normal",
						onChange: (event) => saveDisplay({ ...readDisplay(), glowPace: event.target.value }) },
						[["calm", "舒缓 8.4s"], ["normal", "标准 5.6s"], ["lively", "活跃 3.9s"]].map(([id, label]) => h("option", { key: id, value: id }, label))))
					: null,
				prefs.glow === "notice" ? h("p", { key: "glow-notice-help", className: "dnl-set-note" }, "「仅通知到达时」：平时无光，通知显示期间亮起放大加亮的提示光晕（与到达音效同步）。") : null,
				h("label", { key: "font", className: "dnl-set-row" }, "字体",
					h("input", { type: "text", "aria-label": "歌词字体", maxLength: 200, className: "dnl-set-text",
						placeholder: "跟随 DSH 字体", value: prefs.font || "",
						onChange: (event) => saveDisplay({ ...readDisplay(), font: event.target.value }) })),
				h("button", { key: "reset-font", type: "button", className: "dnl-set-btn", onClick: () => saveDisplay({ ...readDisplay(), font: "" }) }, "恢复默认字体"),
				compact ? null : h("p", { key: "drag-help", className: "dnl-set-note" }, "拖动胶囊左侧的 ⠿ 手柄移动，位置自动记住。"),
				h("button", { key: "reset-position", type: "button", className: "dnl-set-btn", onClick: () => {
					const next = { ...readDisplay() }; delete next.x; delete next.y; saveDisplay(next);
				} }, "重置浮层位置"),
			];
		}

		function BundleSettings(props) {
			const colors = useColors();
			const prefs = useDisplay();
			const ambient = useAmbient();
			const notice = useNoticePrefs();
			const [error, setError] = useState("");
			if (props.view === "summary") return "歌词胶囊与环境悬浮歌词：颜色、字体、位置与开关";
			const saveDisplay = (next) => setError(writeDisplay(next) ? "" : "浏览器无法保存设置，请检查存储权限。");
			const saveColors = (next) => setError(writeColors(next) ? "" : "浏览器无法保存设置，请检查存储权限。");
			const saveAmbient = (next) => setError(writeAmbient(next) ? "" : "浏览器无法保存设置，请检查存储权限。");
			const saveNotice = (next) => setError(writeNoticePrefs(next) ? "" : "浏览器无法保存设置，请检查存储权限。");
			const clearAmbient = (key) => {
				const next = { ...readAmbient() };
				delete next[key];
				saveAmbient(next);
			};
			return h("section", { className: "dnla-settings" },
				h("p", { className: "dnls-lede" }, "改动即时生效，只保存在当前浏览器；未自定义的颜色跟随明暗主题。"),
				error ? h("p", { role: "alert" }, error) : null,

				/* ---- ambient: content, colour, type in one block ---- */
				settingsGroup("环境悬浮歌词", "开关 · 内容 · 颜色 · 字体", true, [
					h("label", { className: "dnla-row" },
						h("input", { type: "checkbox", checked: ambient.enabled !== false,
							onChange: (event) => saveAmbient({ ...readAmbient(), enabled: event.target.checked }) }),
						h("span", null, "启用环境悬浮歌词")),
					h("p", { className: "dnls-note" }, "歌词句随机浮现在面板左右两侧，逐字浮现并随播放轻轻起伏（译文与原文同步）；暂停时冻结。关掉只收起悬浮层，下方胶囊不受影响。"),

					settingsSub("内容"),
					h("label", { className: "dnla-row" },
						h("input", { type: "checkbox", checked: ambient.customEnabled === true,
							"aria-label": "启用自定义文本",
							onChange: (event) => saveAmbient({ ...readAmbient(), customEnabled: event.target.checked }) }),
						h("span", null, "启用自定义文本悬浮（暂时代替播放器歌词）")),
					h("label", { className: "dnla-font-row" }, "悬浮内容（每行一句，最多 30 句）",
						h("textarea", { "aria-label": "自定义悬浮文本", rows: 4, maxLength: 4000,
							placeholder: "例如：\n今晚的月色真美\n风也温柔",
							value: ambient.customText || "",
							onChange: event => saveAmbient({ ...readAmbient(), customText: event.target.value }) })),
					h("label", { className: "dnla-row" }, "每句停留",
						h("input", { type: "number", min: 1, max: 30, title: "1–30 秒，默认 4", "aria-label": "自定义文本停留秒数",
							value: ambient.customHold ?? 4,
							onChange: (event) => {
								const v = Number(event.target.value);
								if (Number.isFinite(v)) saveAmbient({ ...readAmbient(), customHold: Math.min(30, Math.max(1, Math.round(v))) });
							} }),
						h("span", { className: "dnls-unit" }, "秒")),
					h("p", { className: "dnls-note" }, "开启后不再跟随网易云 / QQ 歌词。"),

					settingsSub("颜色与文字"),
					h("label", { className: "dnla-row" }, "文字样式",
						h("select", { "aria-label": "悬浮文字样式", value: ambient.style || "glow",
							onChange: (event) => saveAmbient({ ...readAmbient(), style: event.target.value }) },
							AMBIENT_STYLES.map(([id, label]) => h("option", { key: id, value: id }, label)))),
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
						? h("p", { className: "dnls-note" }, "跟随封面：读取当前专辑封面主色并自动提升可读性；无封面或采样失败时回退主题色。")
						: null,
					(ambient.colorMode === "theme")
						? h("p", { className: "dnls-note" }, "跟随主题：原文取主题主文字色、光晕取主题强调色，明暗主题自动适配。")
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
						? h("label", { className: "dnla-row" }, "悬浮文字颜色",
							h("input", { type: "color", "aria-label": "悬浮文字颜色", value: ambient.color || "#e8e8ec",
								onChange: (event) => saveAmbient({ ...readAmbient(), color: event.target.value }) }),
							h("button", { type: "button", disabled: !ambient.color, onClick: () => clearAmbient("color") }, "跟随主题"))
						: null,
					(ambient.colorMode === "manual" && ambient.style === "glow")
						? h("label", { className: "dnla-row" }, "悬浮光晕颜色",
							h("input", { type: "color", "aria-label": "悬浮光晕颜色", value: ambient.glow || "#7aa2ff",
								onChange: (event) => saveAmbient({ ...readAmbient(), glow: event.target.value }) }),
							h("button", { type: "button", disabled: !ambient.glow, onClick: () => clearAmbient("glow") }, "跟随主题"))
						: null,
					h("label", { className: "dnla-row" }, "译文颜色",
						h("input", { type: "color", "aria-label": "悬浮译文颜色", value: ambient.transColor || "#a9b4c8",
							onChange: (event) => saveAmbient({ ...readAmbient(), transColor: event.target.value }) }),
						h("button", { type: "button", disabled: !ambient.transColor, onClick: () => clearAmbient("transColor") }, "跟随原文")),
					h("p", { className: "dnls-note" }, "白芯发光＝白字芯 + 彩色光晕；经典纯色＝纯色加深影；渐变字芯＝双色渐变文字；卡门的声音＝暖白字芯 + 琥珀光晕。译文色仅翻译句生效。"),

					settingsSub("字体与字号"),
					h("label", { className: "dnla-row" }, "悬浮字号",
						h("input", { type: "number", min: 12, max: 32, title: "12–32px，默认 18", "aria-label": "悬浮字号",
							value: ambient.fontSize ?? 18,
							onChange: (event) => {
								const v = Number(event.target.value);
								if (Number.isFinite(v)) saveAmbient({ ...readAmbient(), fontSize: Math.min(32, Math.max(12, Math.round(v))) });
							} }),
						h("span", { className: "dnls-unit" }, "px")),
					h("label", { className: "dnla-font-row" }, "悬浮歌词字体（留空跟随胶囊字体）",
						h("input", { type: "text", "aria-label": "悬浮歌词字体", maxLength: 200,
							placeholder: "例如：Microsoft YaHei, Noto Sans CJK SC", value: ambient.font || "",
							onChange: event => saveAmbient({ ...readAmbient(), font: event.target.value }) })),
					h("button", { type: "button", onClick: () => clearAmbient("font") }, "恢复默认悬浮字体"),
					h("p", { className: "dnls-note" }, "字体名需已安装在当前设备，可用逗号分隔多个；未安装时由浏览器回退。"),
				]),

				/* ---- workspace notices: master switch, retention, sound ---- */
				settingsGroup("会话区提示", "总开关 · 停留时长 · 音效", false, [
					h("label", { className: "dnla-row" },
						h("input", { type: "checkbox", checked: notice.enabled !== false,
							"aria-label": "启用会话区提示",
							onChange: (event) => saveNotice({ ...readNoticePrefs(), enabled: event.target.checked }) }),
						h("span", null, "启用会话区提示（红点 / 通知胶囊 / 到达音效）")),
					h("label", { className: "dnla-row" }, "轮次结束提示保留",
						h("input", { type: "number", min: 1, max: 60, title: "1–60 分钟，默认 10",
							"aria-label": "轮次结束提示保留分钟数", value: notice.ttlMinutes,
							onChange: (event) => {
								const v = Number(event.target.value);
								if (Number.isFinite(v)) saveNotice({ ...readNoticePrefs(), ttlMinutes: Math.min(60, Math.max(1, Math.round(v))) });
							} }),
						h("span", { className: "dnls-unit" }, "分钟")),
					h("label", { className: "dnla-row" },
						h("input", { type: "checkbox", checked: notice.sound !== false,
							"aria-label": "通知到达音效",
							onChange: (event) => saveNotice({ ...readNoticePrefs(), sound: event.target.checked }) }),
						h("span", null, "通知到达音效（仅到达时播放）")),
					h("label", { className: "dnla-row" }, "音效样式",
						h("select", { "aria-label": "到达音效样式", value: notice.soundStyle || "ding",
							disabled: notice.sound === false,
							onChange: (event) => saveNotice({ ...readNoticePrefs(), soundStyle: event.target.value }) },
							NOTICE_SOUNDS.map(([id, label]) => h("option", { key: id, value: id }, label)))),
					h("label", { className: "dnla-row" }, "重放次数",
						h("input", { type: "number", min: 1, max: 3, title: "1–3 次，默认 1", "aria-label": "音效重放次数",
							disabled: notice.sound === false, value: notice.soundRepeats || 1,
							onChange: (event) => {
								const v = Number(event.target.value);
								if (Number.isFinite(v)) saveNotice({ ...readNoticePrefs(), soundRepeats: Math.min(3, Math.max(1, Math.round(v))) });
							} }),
						h("span", { className: "dnls-unit" }, "次")),
					h("label", { className: "dnla-row" }, "音效音量",
						h("input", { type: "number", min: 1, max: 10, title: "1–10，默认 5；背景音量大时可调高", "aria-label": "音效音量等级",
							disabled: notice.sound === false, value: notice.soundVolume || 5,
							onChange: (event) => {
								const v = Number(event.target.value);
								if (Number.isFinite(v)) saveNotice({ ...readNoticePrefs(), soundVolume: Math.min(10, Math.max(1, Math.round(v))) });
							} }),
						h("span", { className: "dnls-unit" }, "级")),
					h("p", { className: "dnls-note" }, "提问类通知不受保留时长限制，回答后自然消失；保留时长受宿主配置上限（noticeTurnTtlMs）约束。总开关关闭时插件完全不产生任何提示面。音效由 Web Audio 现场合成，重放预排在音频时钟上（不受页面节流影响）。"),
				]),

				/* ---- ambient style: layout + motion ---- */
				settingsGroup("样式", "排版 · 动效", true, [
					settingsSub("排版"),
					h("label", { className: "dnla-row" }, "出现方向",
						h("select", { "aria-label": "悬浮出现方向", value: ambient.orientation || "tilt",
							onChange: (event) => saveAmbient({ ...readAmbient(), orientation: event.target.value }) },
							AMBIENT_ORIENTS.map(([id, label]) => h("option", { key: id, value: id }, label)))),
					(ambient.orientation === "tilt" || ambient.orientation === undefined)
						? h("label", { className: "dnla-row" }, "倾斜角度",
							h("input", { type: "number", min: 0, max: 25, step: 1, title: "0–25°，默认 12°；仅“倾斜出现”生效", "aria-label": "悬浮倾斜角度",
								value: ambient.angle ?? 12,
								onChange: (event) => {
									const v = Number(event.target.value);
									if (Number.isFinite(v)) saveAmbient({ ...readAmbient(), angle: Math.min(25, Math.max(0, v)) });
								} }),
							h("span", { className: "dnls-unit" }, "°"))
						: null,
					h("label", { className: "dnla-row" }, "同屏句数",
						h("input", { type: "number", min: 1, max: 4, title: "1–4，默认 2；超出后最旧的先退场", "aria-label": "悬浮同屏句数",
							value: ambient.maxLines ?? 2,
							onChange: (event) => {
								const v = Number(event.target.value);
								if (Number.isFinite(v)) saveAmbient({ ...readAmbient(), maxLines: Math.min(4, Math.max(1, Math.round(v))) });
							} }),
						h("span", { className: "dnls-unit" }, "句")),
					h("label", { className: "dnla-row" },
						h("input", { type: "checkbox", checked: ambient.singleLine === true,
							onChange: (event) => saveAmbient({ ...readAmbient(), singleLine: event.target.checked }) }),
						h("span", null, "允许单行显示（长句不自动换行）")),
					h("p", { className: "dnls-note" }, "倾斜＝每句随机角度出现（原版观感）；横向 / 竖向＝严格水平或垂直，不带倾斜。单行显示可能横跨窗口中部。"),

					settingsSub("动效"),
					h("label", { className: "dnla-row" }, "动效样式",
						h("select", { "aria-label": "悬浮动效样式", value: ambient.anim || "ripple-wave",
							onChange: (event) => saveAmbient({ ...readAmbient(), anim: event.target.value }) },
							AMBIENT_ANIMS.map(([id, label]) => h("option", { key: id, value: id }, label)))),
					h("label", { className: "dnla-row" }, "律动幅度",
						h("input", { type: "number", min: 0, max: 30, title: "0–30，默认 10；调小更稳、调大更活跃", "aria-label": "悬浮律动幅度",
							value: ambient.jump ?? 10,
							onChange: (event) => {
								const v = Number(event.target.value);
								if (Number.isFinite(v)) saveAmbient({ ...readAmbient(), jump: Math.min(30, Math.max(0, v)) });
							} })),
					h("label", { className: "dnla-row" }, "跌落距离",
						h("input", { type: "number", min: 0, max: 128, title: "0–128，默认 48；仅“跌落”类动效生效", "aria-label": "悬浮跌落距离",
							value: ambient.fall ?? 48,
							onChange: (event) => {
								const v = Number(event.target.value);
								if (Number.isFinite(v)) saveAmbient({ ...readAmbient(), fall: Math.min(128, Math.max(0, v)) });
							} })),
					h("p", { className: "dnls-note" }, "逐字入场为淡入 + 轻微阻尼颤动；波纹＝退场原地逐字淡出，跌落＝退场逐字加速下坠并轻微旋转；波动＝正弦行进波，抖动＝平滑噪声颤动。入场 / 退场节奏固定，律动幅度与跌落距离互不影响。"),
				]));
		}

		function apply(ctx) {
			/** Decorative only: a missing React or slots seat must never
			 *  break the boot batch. */
			try {
				if (ReactApi === undefined) return;
				if (ctx.slots === null || typeof ctx.slots !== "object") return;
				jumpCtx = ctx;
				// Optional lookups (the facade's ctx.get): DSH's own sessions
				// service exposes retainedBy.mainView (the signal the official
				// unread marker uses) and the workspaces service maps sessions
				// to their workspace groups. Missing/unavailable → null → no
				// main-view filtering.
				try { clientSessions = ctx.get("sessions") || null; } catch { clientSessions = null; }
				try { clientWorkspaces = ctx.get("workspaces") || null; } catch { clientWorkspaces = null; }
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
			/* -webkit-app-region:initial is REQUIRED for a body-level overlay in
			 * this Electron shell. The window keeps a drag strip at the top, and
			 * the capsule sits at top:12px - inside it. Without opting out, a
			 * pointerdown on the capsule's left side is consumed by the window
			 * drag region ("the click goes to the DSH window"), so the capsule
			 * could not be dragged from there at all. Same rule dsh-audio-pulse
			 * documents as a hard requirement for full-screen overlays. */
			".dnl-host{position:fixed;top:12px;left:70%;transform:translateX(-50%);z-index:1000;pointer-events:none;-webkit-app-region:initial;display:flex;justify-content:center}",
			/* Breathing halo: stacked rings so the light *falls off* from the capsule
			 * rim instead of ending in one thick band. Every layer is a border with
			 * a transparent interior - the capsule background is translucent, so
			 * anything painted behind it would bleed into the lyric text.
			 *
			 * Motion has three independent parts:
			 *   1. the breath itself: asymmetric curve (fast in / hold / slow out),
			 *      relayed outward by phase offsets, so the glow swells instead of
			 *      blinking as a block;
			 *   2. a hue drift layer (h4) that cross-fades in behind the peak - a
			 *      static hue-rotate filter, so nothing re-rasterises per frame;
			 *   3. a one-shot ripple (dnl-kick) per TRACK (not per line: replaying
			 *      it on every line change made the lyric transition jump).
			 * --dnl-glow-dur comes from the pace preset, and delays are fractions
			 * of it so the relay keeps its proportions. */
			".dnl-shell{position:relative;display:flex;justify-content:center;max-width:100%}",
			".dnl-halo{position:absolute;inset:0;z-index:0;pointer-events:none;opacity:var(--dnl-glow-amp,1)}",
			".dnl-halo>span{position:absolute;border-style:solid;border-color:var(--dnl-halo,var(--dsw-alias-brand-primary));border-radius:999px;will-change:opacity}",
			/* A 2px hairline hugging the rim, then progressively wider/fainter halos. */
			".dnl-halo>.h1{inset:-2px;border-width:2px;filter:blur(3px);animation:dnl-glow-rim var(--dnl-glow-dur,5.6s) cubic-bezier(.37,0,.28,1) infinite backwards;animation-delay:0s}",
			".dnl-halo>.h2{inset:-7px;border-width:5px;filter:blur(9px);animation:dnl-glow-mid var(--dnl-glow-dur,5.6s) cubic-bezier(.37,0,.28,1) infinite backwards;animation-delay:calc(var(--dnl-glow-dur,5.6s) * .05)}",
			".dnl-halo>.h3{inset:-16px;border-width:9px;filter:blur(18px);animation:dnl-glow-out var(--dnl-glow-dur,5.6s) cubic-bezier(.37,0,.28,1) infinite backwards;animation-delay:calc(var(--dnl-glow-dur,5.6s) * .1)}",
			/* Colour drift: mid-halo geometry, hue-rotated once, faded in after the peak. */
			".dnl-halo>.h4{inset:-7px;border-width:5px;filter:blur(9px) hue-rotate(18deg);animation:dnl-glow-drift var(--dnl-glow-dur,5.6s) cubic-bezier(.37,0,.28,1) infinite backwards;animation-delay:calc(var(--dnl-glow-dur,5.6s) * .075)}",
			/* Per-track ripple (was per-line): no fill-mode forwards, so it ends invisible. */
			".dnl-halo>.dnl-kick{inset:-2px;border-width:2px;filter:blur(1px);opacity:0;animation:dnl-kick .9s cubic-bezier(.2,.6,.3,1) 1 both}",
			".dnl-shell-expanded .dnl-halo>span{border-radius:20px}",
			/* Paused: the lamp settles to a faint, steady rim (mirrors frozen lyrics). */
			".dnl-halo-hold>span{animation:none}",
			".dnl-halo-hold>.h1{opacity:.42}",
			".dnl-halo-hold>.h2{opacity:.14}",
			".dnl-halo-hold>.h3{opacity:.05}",
			".dnl-halo-hold>.h4{opacity:.02}",
			".dnl-halo-hold>.dnl-kick{display:none}",
			/* Fast inhale, short hold, long exhale: a plain sine reads as a metronome. */
			"@keyframes dnl-glow-rim{0%,100%{opacity:.45}26%{opacity:.95}44%{opacity:.85}}",
			"@keyframes dnl-glow-mid{0%,100%{opacity:.12}34%{opacity:.6}56%{opacity:.48}}",
			"@keyframes dnl-glow-out{0%,100%{opacity:.04}46%{opacity:.3}68%{opacity:.22}}",
			"@keyframes dnl-glow-drift{0%,100%{opacity:.02}30%{opacity:.1}55%{opacity:.3}74%{opacity:.22}}",
			"@keyframes dnl-kick{0%{opacity:.5;transform:scale(1)}55%{opacity:.14;transform:scale(1.02)}100%{opacity:0;transform:scale(1.045)}}",
			"@keyframes dnl-glow-soft{0%,100%{opacity:.5}50%{opacity:.9}}",
			/* ---- v0.4.6 notice-burst halo: the '仅通知到达时' mode. Dark in
			 * normal play; while a notice row is on screen the halo lights up
			 * ENLARGED (scale 1.45, own transform — the blurred borders raster
			 * once and the compositor scales them, no repaint), BRIGHTER (peaks
			 * far above the ambient breath) and at a FAST 1.15s cadence, so the
			 * arrival reads as one unmistakable beat paired with the chime. */
			".dnl-halo-burst{transform:scale(1.45);opacity:1}",
			".dnl-halo-burst>.h1{animation:dnl-burst-rim 1.15s cubic-bezier(.37,0,.28,1) infinite backwards;animation-delay:0s;opacity:1}",
			".dnl-halo-burst>.h2{animation:dnl-burst-mid 1.15s cubic-bezier(.37,0,.28,1) infinite backwards;animation-delay:calc(1.15s * .04);opacity:.7}",
			".dnl-halo-burst>.h3{animation:dnl-burst-out 1.15s cubic-bezier(.37,0,.28,1) infinite backwards;animation-delay:calc(1.15s * .08);opacity:.4}",
			".dnl-halo-burst>.h4{animation:dnl-burst-drift 1.15s cubic-bezier(.37,0,.28,1) infinite backwards;animation-delay:calc(1.15s * .06);opacity:.3}",
			".dnl-shell-expanded .dnl-halo-burst{transform:scale(1.2)}",
			"@keyframes dnl-burst-rim{0%,100%{opacity:.6}26%{opacity:1}}",
			"@keyframes dnl-burst-mid{0%,100%{opacity:.25}30%{opacity:.85}52%{opacity:.6}}",
			"@keyframes dnl-burst-out{0%,100%{opacity:.1}38%{opacity:.5}62%{opacity:.35}}",
			"@keyframes dnl-burst-drift{0%,100%{opacity:.06}32%{opacity:.3}58%{opacity:.2}}",
			/* The capsule itself only has to change shape (radius + horizontal room);
			 * the growth comes from the grid wrapper below. */
			".dnl-island{position:relative;z-index:1;pointer-events:auto;-webkit-app-region:no-drag;cursor:default;display:flex;flex-direction:column;align-items:stretch;max-width:min(560px,70vw);border-radius:999px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);box-shadow:0 6px 24px rgba(0,0,0,.18);padding:6px 16px 6px 30px;transition:max-width .28s cubic-bezier(.2,.7,.3,1),padding .28s cubic-bezier(.2,.7,.3,1),border-radius .28s cubic-bezier(.2,.7,.3,1);font-family:var(--dnl-font,inherit);user-select:none}",
			/* The expanded backing is the theme's overlay token with its alpha scaled
			 * by a preference (1 = exactly the token, the original look; lower lets
			 * more wallpaper through). color-mix against `transparent` multiplies the
			 * token's own alpha, so no colour value is hard-coded and the theme still
			 * decides the hue. Making it MORE opaque than the token is deliberately
			 * not offered: with a light token and light text, denser reads worse. */
			".dnl-expanded{border-radius:14px;max-width:min(640px,86vw);padding:12px 20px 12px 30px;cursor:pointer;background-color:color-mix(in srgb,var(--dsw-alias-bg-overlay) calc(var(--dnl-panel-alpha,1) * 100%),transparent)}",
			/* ---- v0.4.6/v0.4.8 capsule skins (设置 → 胶囊样式) ---- */
			/* Gradient glass (渐变玻璃) — v0.4.8 makes its three layers
			 * USER-TUNABLE via CSS variables (设置 exposes 颗粒强度 / 罩染强度 /
			 * 伴侣色 / 描边亮度). The ring rides a border-box gradient layer
			 * (brand → white / brand → deep indigo, brightness scaled by
			 * --dnl-gg-ring); the film grain and the diagonal brand/violet tint
			 * moved to ::before / ::after overlays (island is a stacking
			 * context, so z-index:-1 paints them above its background and
			 * below its content) because a data-URI SVG cannot see outer CSS
			 * variables — element opacity is the tunable path. */
			".dnl-style-frosted,.dnl-style-frosted.dnl-expanded{border-width:1px;border-color:transparent;backdrop-filter:blur(20px) saturate(1.3);-webkit-backdrop-filter:blur(20px) saturate(1.3);background-image:linear-gradient(135deg,color-mix(in srgb,color-mix(in srgb,var(--dsw-alias-brand-primary) calc(var(--dnl-gg-ring,70) * 0.45%),#ffffff) 70%,transparent),color-mix(in srgb,color-mix(in srgb,var(--dsw-alias-brand-primary) calc(var(--dnl-gg-ring,70) * 0.75%),#0b0b2a) 70%,transparent));background-clip:border-box;background-origin:border-box;background-color:color-mix(in srgb,var(--dsw-alias-bg-overlay) calc(var(--dnl-panel-alpha,1) * 100%),transparent);box-shadow:0 6px 24px rgba(0,0,0,.18),0 4px 18px color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent)}",
			".dnl-style-frosted::before,.dnl-style-frosted::after{content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:-1}",
			".dnl-style-frosted::before{background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E\");opacity:var(--dnl-gg-grain,.3)}",
			".dnl-style-frosted::after{background-image:linear-gradient(135deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent),transparent 45%,color-mix(in srgb,var(--dnl-gg-accent,#8b7cff) 16%,transparent));opacity:var(--dnl-gg-tint,.35)}",
			".dnl-style-frosted.dnl-expanded{border-radius:18px}",
			/* 静谧祝愿 (wishes, v0.4.8 — from the user's purple-blue wallpaper):
			 * lavender→periwinkle ring, a soft violet-blue wash, heavy blur,
			 * light grain. Fixed palette (the wallpaper IS the reference). */
			".dnl-style-wishes,.dnl-style-wishes.dnl-expanded{border-width:1px;border-color:transparent;backdrop-filter:blur(26px) saturate(1.25);-webkit-backdrop-filter:blur(26px) saturate(1.25);background-image:linear-gradient(135deg,color-mix(in srgb,#cfd4ff 65%,transparent),color-mix(in srgb,#5b67d8 65%,transparent));background-clip:border-box;background-origin:border-box;background-color:color-mix(in srgb,var(--dsw-alias-bg-overlay) calc(var(--dnl-panel-alpha,1) * 100%),transparent);box-shadow:0 8px 26px rgba(40,50,120,.25)}",
			".dnl-style-wishes::before,.dnl-style-wishes::after{content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:-1}",
			".dnl-style-wishes::before{background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E\");opacity:.22}",
			".dnl-style-wishes::after{background-image:linear-gradient(135deg,color-mix(in srgb,#a89aff 16%,transparent),transparent 40%,color-mix(in srgb,#6ea8ff 14%,transparent))}",
			".dnl-style-wishes.dnl-expanded{border-radius:18px}",
			/* 暗夜余烬 (ember, v0.4.8 — from the dark warm-accent wallpaper):
			 * deep smoked glass, an ember-orange→charred-brown ring, warm
			 * amber wash, heavier grain — built to glow against dark scenes. */
			/* 暗夜余烬 v2 (ember, rewritten after the user reported v1 read as
			 * a harsh orange wedge): v1's ring ran bright-orange -> near-black
			 * (a 73-point lightness cliff — one glaring corner, an invisible
			 * diagonal), and orange piled up in THREE places (ring, tint,
			 * shadow) reading as a glowing orange blob, plus a light-theme
			 * bg-layer-1 base fighting dark wallpapers. v2 keeps the ember
			 * language but calms it: the ring stays within the mid-dark range
			 * (#e8955c -> #3a2214, hue-led like wishes'), ONE wash layer at
			 * half strength, a SELF-CARRIED translucent charcoal base (#14100c
			 * at 62% — an ember is a dark object on ANY wallpaper, it must not
			 * borrow the theme's light layer), lighter grain, no orange shadow
			 * (the ring IS the accent). */
			".dnl-style-ember,.dnl-style-ember.dnl-expanded{border-width:1px;border-color:transparent;backdrop-filter:blur(14px) saturate(1.05);-webkit-backdrop-filter:blur(14px) saturate(1.05);background-image:linear-gradient(135deg,color-mix(in srgb,#e8955c 72%,transparent),color-mix(in srgb,#3a2214 80%,transparent));background-clip:border-box;background-origin:border-box;background-color:color-mix(in srgb,#14100c calc(var(--dnl-panel-alpha,1) * 62%),transparent);box-shadow:0 8px 28px rgba(0,0,0,.4)}",
			".dnl-style-ember::before,.dnl-style-ember::after{content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:-1}",
			".dnl-style-ember::before{background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E\");opacity:.25}",
			".dnl-style-ember::after{background-image:linear-gradient(135deg,color-mix(in srgb,#ffb36b 8%,transparent),transparent 55%,color-mix(in srgb,#ff7a45 5%,transparent))}",
			".dnl-style-ember.dnl-expanded{border-radius:12px}",
			/* Solid: opaque theme card — readable over any wallpaper, stronger
			 * drop shadow, squarer corners. Two classes beat the one-class
			 * .dnl-expanded color-mix, so the panel-opacity knob no longer
			 * applies (an opaque card has nothing to blend). */
			".dnl-style-solid{background:var(--dsw-alias-bg-layer-1);backdrop-filter:none;-webkit-backdrop-filter:none;border-color:var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.28)}",
			".dnl-style-solid.dnl-expanded{border-radius:14px;background:var(--dsw-alias-bg-layer-1)}",
			/* ---- 方舟观测 (arknights, v0.4.9 — from the Arknights UI language:
			 * diegetic HUD framing, non-symmetric cut corners, fine line-work,
			 * charcoal + one accent (theme-following or the signature orange,
			 * user-set). Topographic contour lines (the technique read out of
			 * the user's WE topographic wallpaper shader: Perlin noise sliced
			 * into contour bands) are baked ONCE into a data-URI SVG underlay;
			 * scanlines ride ::after; the four HUD corner brackets ride
			 * ::before (four corner-anchored linear-gradients). clip-path cuts
			 * the silhouette itself. The accent drives the ring, brackets and
			 * scanlines via --dnl-ak-accent. */
			".dnl-style-arknights,.dnl-style-arknights.dnl-expanded{border-width:1px;border-color:color-mix(in srgb,var(--dnl-ak-accent,var(--dsw-alias-brand-primary)) 38%,transparent);backdrop-filter:blur(18px) saturate(1.1);-webkit-backdrop-filter:blur(18px) saturate(1.1);background-image:repeating-linear-gradient(0deg,color-mix(in srgb,var(--dnl-ak-accent,var(--dsw-alias-brand-primary)) 4%,transparent) 0 1px,transparent 1px 4px),linear-gradient(180deg,color-mix(in srgb,#0d1117 calc(var(--dnl-panel-alpha,1) * 88%),transparent),color-mix(in srgb,#141b24 calc(var(--dnl-panel-alpha,1) * 92%),transparent));background-clip:border-box;background-origin:border-box;clip-path:polygon(10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%,0 10px);border-radius:0;box-shadow:0 6px 24px rgba(0,0,0,.45)}",
			/* v0.4.10a: the HUD framing needs the pill TALLER on short lyrics —
			 * the user's original request was vertical breathing room (my first
			 * attempt misread it as horizontal, then a min-width attempt made
			 * lines wrap and grow downward instead). padding-block only: the
			 * framing clears the cut corners vertically, text layout is
			 * untouched. */
			".dnl-style-arknights{padding-block:12px}",
			".dnl-style-arknights.dnl-expanded{padding-block:12px}",
			".dnl-style-arknights::before,.dnl-style-arknights::after{content:'';position:absolute;inset:0;pointer-events:none}",
			".dnl-style-arknights::before{background-image:linear-gradient(var(--dnl-ak-accent,var(--dsw-alias-brand-primary)),var(--dnl-ak-accent,var(--dsw-alias-brand-primary))),linear-gradient(var(--dnl-ak-accent,var(--dsw-alias-brand-primary)),var(--dnl-ak-accent,var(--dsw-alias-brand-primary))),linear-gradient(var(--dnl-ak-accent,var(--dsw-alias-brand-primary)),var(--dnl-ak-accent,var(--dsw-alias-brand-primary))),linear-gradient(var(--dnl-ak-accent,var(--dsw-alias-brand-primary)),var(--dnl-ak-accent,var(--dsw-alias-brand-primary)));background-size:14px 2px,2px 14px,14px 2px,2px 14px;background-position:6px 5px,5px 6px,calc(100% - 20px) calc(100% - 7px),calc(100% - 7px) calc(100% - 20px);background-repeat:no-repeat;opacity:.9;animation:dnl-ak-bracket-breathe 4.6s ease-in-out infinite}",
			/* HUD corner brackets breathe (user request 2026-11-09): opacity and a
			 * soft glow pulse on the same accent they are painted with, so the
			 * corners are alive without drawing the eye away from the lyrics. */
			"@keyframes dnl-ak-bracket-breathe{0%,100%{opacity:.62;filter:drop-shadow(0 0 0 transparent)}50%{opacity:1;filter:drop-shadow(0 0 3px color-mix(in srgb,var(--dnl-ak-accent,var(--dsw-alias-brand-primary)) 65%,transparent))}}",
			/* The red dot pulls INSIDE the cut corners: at right:4px/bottom:4px
			 * its 18px box straddles the 10px diagonal clip, which read as the
			 * frame "cracking" at the bottom-right (user screenshot). 16px
			 * clears the diagonal on both sides. */
			".dnl-style-arknights .dnl-dot{right:16px;bottom:16px}",
			/* Seven-colour rotation (七彩轮换, v0.4.9a): a registered custom
			 * property animates through the FULL hue wheel in oklch (perceptual
			 * colour space — no muddy middle), looping forever. Only the ring /
			 * brackets / scanlines consume --dnl-ak-accent, so the capsule
			 * base stays calm while the framing cycles. The animation runs on
			 * the custom property itself (compositor-friendly interpolation,
			 * no per-frame JS). */
			"@property --dnl-ak-hue{syntax:'<number>';inherits:false;initial-value:0}",
			/* The animation lives on the ISLAND element (where --dnl-ak-accent
			 * is consumed via var()), NOT on the pseudo-elements — a keyframe
			 * animating a custom property only affects descendants of the
			 * element it animates, so brackets/scanlines see it transitively. */
			".dnl-style-arknights.dnl-ak-rainbow{--dnl-ak-accent:oklch(0.75 0.14 var(--dnl-ak-hue));animation:dnl-ak-hue-cycle 14s linear infinite}",
			"@keyframes dnl-ak-hue-cycle{from{--dnl-ak-hue:0}to{--dnl-ak-hue:360}}",
			"@media(prefers-reduced-motion:reduce){.dnl-style-arknights.dnl-ak-rainbow{--dnl-ak-accent:oklch(0.75 0.14 130)}}",
			".dnl-style-arknights::after{background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='420' height='200'%3E%3Cfilter id='c'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.012 0.028' numOctaves='4' seed='11'/%3E%3CfeColorMatrix values='0 0 0 0 0.55 0 0 0 0 0.75 0 0 0 0 0.8 0 0 0 0.5 0'/%3E%3C/filter%3E%3Crect width='420' height='200' filter='url(%23c)'/%3E%3C/svg%3E\");opacity:.3;animation:dnl-ak-scan 7s linear infinite}",
			"@keyframes dnl-ak-scan{from{background-position-y:0}to{background-position-y:200px}}",
			"@media(prefers-reduced-motion:reduce){.dnl-style-arknights::after{animation:none}}",
			".dnl-style-arknights.dnl-expanded{clip-path:polygon(14px 0,100% 0,100% calc(100% - 14px),calc(100% - 14px) 100%,0 100%,0 14px)}",
			/* ---- 月相引路 (persona, v0.4.9 — from the Persona 3 Reload UI):
			 * deep-blue gradient glass (indigo -> midnight) with a soft INNER
			 * glow (the inset shadow), a crescent-moon arc light and five
			 * slowly drifting light motes. The arc + motes are a tiny inline
			 * SVG (radial gradients); the drift is a single compositor-only
			 * transform keyframe — the whole thing rasterises once. */
			".dnl-style-persona,.dnl-style-persona.dnl-expanded{border-width:1px;border-color:transparent;backdrop-filter:blur(22px) saturate(1.2);-webkit-backdrop-filter:blur(22px) saturate(1.2);background-image:linear-gradient(160deg,color-mix(in srgb,#7fa8ff 26%,transparent),transparent 55%),linear-gradient(135deg,color-mix(in srgb,#9db8ff 55%,transparent),color-mix(in srgb,#101c3f 88%,transparent));background-clip:border-box;background-origin:border-box;background-color:color-mix(in srgb,#0b1330 calc(var(--dnl-panel-alpha,1) * 72%),transparent);box-shadow:0 8px 26px rgba(5,10,40,.5),inset 0 0 22px color-mix(in srgb,#bcd0ff 16%,transparent)}",
			".dnl-style-persona::before,.dnl-style-persona::after{content:'';position:absolute;pointer-events:none}",
			".dnl-style-persona::before{right:-14px;top:-34px;width:74px;height:74px;border-radius:50%;background:radial-gradient(circle at 32% 32%,#eaf1ff 0%,#cfe0ff 28%,transparent 62%);box-shadow:0 0 18px color-mix(in srgb,#cfe0ff 40%,transparent);opacity:.85}",
			".dnl-style-persona::after{inset:0;background-image:radial-gradient(2.5px 2.5px at 12% 30%,#dfe9ff 45%,transparent 55%),radial-gradient(2px 2px at 34% 72%,#bcd0ff 45%,transparent 60%),radial-gradient(3px 3px at 58% 24%,#dfe9ff 40%,transparent 55%),radial-gradient(2px 2px at 78% 60%,#bcd0ff 45%,transparent 60%),radial-gradient(2.5px 2.5px at 90% 30%,#eaf1ff 40%,transparent 55%);animation:dnl-persona-drift 9s ease-in-out infinite alternate}",
			".dnl-style-persona.dnl-expanded{border-radius:18px}",
			"@keyframes dnl-persona-drift{from{transform:translate3d(0,0,0)}to{transform:translate3d(-7px,6px,0)}}",
			"@media(prefers-reduced-motion:reduce){.dnl-style-persona::after{animation:none}}",
			/* ---- v0.4.9 decorative overlay (装饰层): rain streaks + droplets /
			 * petals / motes, all programmatic CSS (no assets). The layer sits
			 * under the text rows (z-index 0 vs the island's stacking order),
			 * pointer-events:none, and its animations are transform/opacity
			 * only (compositor-driven). Reduced motion stills everything. */
			".dnl-decor{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:-1;border-radius:inherit}",
			".dnl-decor span{position:absolute;display:block;will-change:transform,opacity}",
			/* Rain: four slanted streaks falling in a loop + the four droplets that
			 * actually run down the pane. */
			".dnl-decor-rain .dnl-decor-streak{width:1.5px;height:26px;border-radius:1px;background:linear-gradient(180deg,transparent,color-mix(in srgb,#cfe0ff 45%,transparent));opacity:0;animation:dnl-rain-fall 1.9s linear infinite}",
			".dnl-decor-rain .s1{left:12%;top:-30px;animation-delay:0s}",
			".dnl-decor-rain .s2{left:38%;top:-30px;animation-delay:.7s;animation-duration:2.4s}",
			".dnl-decor-rain .s3{left:64%;top:-30px;animation-delay:1.2s}",
			".dnl-decor-rain .s4{left:86%;top:-30px;animation-delay:.3s;animation-duration:2.2s}",
			"@keyframes dnl-rain-fall{0%{transform:translate3d(0,0,0) scaleY(.4);opacity:0}10%{opacity:.7}55%{opacity:.55;transform:translate3d(-6px,60%,0) scaleY(1)}96%{opacity:.18}100%{transform:translate3d(-11px,120%,0) scaleY(1.35);opacity:0}}",
			/* A droplet must BEAD, GROW and then SLIDE DOWN the pane with a wet
			 * trail — the old dnl-drop-hold only faded in place, which read as a
			 * bead blinking out (the reported "disappears instead of running
			 * down"). The travel is a translateY over the capsule's own height
			 * (100% of the decor layer), the bead stretches while moving, and the
			 * ::after holds a vertical smear of water behind it. */
			".dnl-decor-rain .dnl-decor-drop{width:7px;height:9px;border-radius:50% 50% 55% 55%;background:radial-gradient(circle at 32% 28%,rgba(255,255,255,.92) 0%,rgba(210,225,255,.34) 42%,rgba(180,200,255,.16) 100%);box-shadow:inset 0 -1px 2px rgba(255,255,255,.4),0 1px 3px rgba(120,150,210,.22);opacity:0;animation:dnl-drop-slide 7s cubic-bezier(.45,.05,.55,.95) infinite;transform-origin:50% 20%}",
			".dnl-decor-rain .dnl-decor-drop::after{content:'';position:absolute;left:50%;top:-2px;width:1.5px;height:0;margin-left:-.75px;border-radius:1px;background:linear-gradient(180deg,transparent,rgba(205,222,255,.5));opacity:0}",
			".dnl-decor-rain .d1{left:20%;top:12%;animation-delay:.4s}",
			".dnl-decor-rain .d2{left:56%;top:6%;animation-delay:3.1s;animation-duration:8.2s}",
			".dnl-decor-rain .d3{left:80%;top:18%;animation-delay:5.4s;animation-duration:6.4s}",
			".dnl-decor-rain .d4{left:36%;top:26%;animation-delay:1.8s;animation-duration:7.7s;width:5px;height:7px}",
			/* 0-22%: bead forms and gathers (grows, brightens);
			 * 22-100%: slides down ~78% of the layer, stretching slightly and
			 * thinning the trail at the very end so it never cuts out abruptly. */
			"@keyframes dnl-drop-slide{0%{opacity:0;transform:translate3d(0,0,0) scale(.35)}14%{opacity:.55;transform:translate3d(0,1px,0) scale(.85)}22%{opacity:.95;transform:translate3d(0,2px,0) scale(1.06)}38%{opacity:.9;transform:translate3d(-2px,14%,0) scale(1.02,1.18)}62%{opacity:.82;transform:translate3d(-4px,42%,0) scale(.98,1.26)}84%{opacity:.62;transform:translate3d(-6px,68%,0) scale(.92,1.14)}96%{opacity:.22;transform:translate3d(-7px,80%,0) scale(.8,.9)}100%{opacity:0;transform:translate3d(-7px,84%,0) scale(.7,.8)}}",
			"@keyframes dnl-drop-trail{0%,20%{height:0;opacity:0}34%{height:16px;opacity:.5}70%{height:30px;opacity:.38}96%{height:38px;opacity:.12}100%{height:38px;opacity:0}}",
			".dnl-decor-rain .dnl-decor-drop::after{animation:dnl-drop-trail 7s cubic-bezier(.45,.05,.55,.95) infinite}",
			".dnl-decor-rain .d1::after{animation-delay:.4s}",
			".dnl-decor-rain .d2::after{animation-delay:3.1s;animation-duration:8.2s}",
			".dnl-decor-rain .d3::after{animation-delay:5.4s;animation-duration:6.4s}",
			".dnl-decor-rain .d4::after{animation-delay:1.8s;animation-duration:7.7s}",
			/* ---- v0.4.19 雨后玻璃 (rainv2 preset): a separate, self-contained
			 * block — the original .dnl-decor-rain rules above are untouched, so
			 * flipping the select back to 雨痕水珠 restores the old look exactly.
			 * Visual model (raindrops.js + RaindropFX + the WE scene presets in
			 * the user's library): on dark glass a droplet is a dark refracted
			 * body with a narrow specular arc, not a white blob; most beads HANG
			 * (condensation), a few big ones depart late and slide the WHOLE pane,
			 * spending water as they go — the remnant behind them is stepped
			 * (holds, then extends) and each slider sheds two daughter beads
			 * (the engines' 0.2–0.5 trailScale). Positions span the whole pane so
			 * the layer reads the same collapsed and expanded.
			 * Tunables: --dnl-rv2-pace (tempo), --dnl-rv2-hi (specular strength),
			 * --dnl-rv2-trail (remnant strength). Density is structural (how many
			 * spans are rendered), so it is NOT a CSS variable. */
			".dnl-decor-rainv2{--dnl-rv2-pace:1;--dnl-rv2-hi:.7;--dnl-rv2-trail:.34}",
			/* rain silk: SHORT segments (52px) falling the full pane height with a
			 * slight sideways drift (the WE raindownpour preset's -40~-50 X drift).
			 * Travel is animated via `top` (pane-relative %), never translateY % —
			 * a transform % resolves against the element's OWN ~9px height. */
			".dnl-decor-rainv2 .dnl-decor-streak{width:1.2px;height:52px;top:-14%;border-radius:1px;background:linear-gradient(180deg,transparent,color-mix(in srgb,#cfe0ff 32%,transparent) 55%,color-mix(in srgb,#cfe0ff 18%,transparent));opacity:0;animation:dnl-rainv2-fall calc(2.8s / var(--dnl-rv2-pace)) linear infinite}",
			".dnl-decor-rainv2 .s1{left:16%;animation-delay:0s}",
			".dnl-decor-rainv2 .s2{left:52%;animation-delay:calc(-1.6s / var(--dnl-rv2-pace));animation-duration:calc(3.4s / var(--dnl-rv2-pace))}",
			".dnl-decor-rainv2 .s3{left:84%;animation-delay:calc(-0.7s / var(--dnl-rv2-pace));animation-duration:calc(3.1s / var(--dnl-rv2-pace))}",
			"@keyframes dnl-rainv2-fall{0%{top:-14%;opacity:0;transform:translate3d(0,0,0)}12%{opacity:.32}80%{opacity:.22}100%{top:114%;opacity:0;transform:translate3d(-8px,0,0)}}",
			/* droplet body: dark refraction + top light line + narrow specular arc;
			 * the ::before is the highlight, ::after is the remnant trail */
			".dnl-decor-rainv2 .dnl-decor-drop{width:7px;height:9px;border-radius:50% 50% 56% 56%;background:radial-gradient(circle at 36% 32%,rgba(255,255,255,.16) 0%,rgba(160,185,228,.07) 42%,rgba(7,13,28,.42) 100%);box-shadow:inset 0 1px 1px rgba(255,255,255,.34),inset 0 -1px 2px rgba(3,8,20,.6),0 1px 2px rgba(2,6,16,.45)}",
			".dnl-decor-rainv2 .dnl-decor-drop::before{content:'';position:absolute;left:16%;top:7%;width:40%;height:26%;border-radius:50%;background:radial-gradient(ellipse at center,rgba(255,255,255,.9) 0%,transparent 72%);opacity:calc(var(--dnl-rv2-hi) * .95)}",
			".dnl-decor-rainv2 .dnl-decor-drop::after{content:'';position:absolute;left:50%;bottom:100%;width:1.2px;height:0;margin-left:-.6px;border-radius:1px;background:linear-gradient(0deg,rgba(205,222,255,.5),transparent);opacity:0}",
			/* twelve condensation bead slots spread over the WHOLE pane (8%–88%):
			 * bead up, hang ~75% of the cycle, evaporate. Small r / big r mix.
			 * Density renders the first N slots (default 7, range 4–12). */
			".dnl-decor-rainv2 .b1{left:14%;top:16%;animation:dnl-rv2-bead calc(11s / var(--dnl-rv2-pace)) ease-in-out infinite;animation-delay:.6s}",
			".dnl-decor-rainv2 .b2{left:42%;top:8%;width:5px;height:7px;animation:dnl-rv2-bead calc(13s / var(--dnl-rv2-pace)) ease-in-out infinite;animation-delay:4.4s}",
			".dnl-decor-rainv2 .b3{left:70%;top:30%;width:8px;height:10px;animation:dnl-rv2-bead calc(12s / var(--dnl-rv2-pace)) ease-in-out infinite;animation-delay:8.1s}",
			".dnl-decor-rainv2 .b4{left:26%;top:48%;width:4px;height:6px;animation:dnl-rv2-bead calc(14s / var(--dnl-rv2-pace)) ease-in-out infinite;animation-delay:2.2s}",
			".dnl-decor-rainv2 .b5{left:86%;top:62%;width:5px;height:7px;animation:dnl-rv2-bead calc(10.5s / var(--dnl-rv2-pace)) ease-in-out infinite;animation-delay:6.3s}",
			".dnl-decor-rainv2 .b6{left:52%;top:78%;width:6px;height:8px;animation:dnl-rv2-bead calc(12.5s / var(--dnl-rv2-pace)) ease-in-out infinite;animation-delay:9.4s}",
			".dnl-decor-rainv2 .b7{left:78%;top:84%;width:4px;height:6px;animation:dnl-rv2-bead calc(13.5s / var(--dnl-rv2-pace)) ease-in-out infinite;animation-delay:3.2s}",
			".dnl-decor-rainv2 .b8{left:36%;top:70%;width:3px;height:5px;animation:dnl-rv2-bead calc(11.6s / var(--dnl-rv2-pace)) ease-in-out infinite;animation-delay:5.5s}",
			".dnl-decor-rainv2 .b9{left:62%;top:52%;width:5px;height:6px;animation:dnl-rv2-bead calc(12.8s / var(--dnl-rv2-pace)) ease-in-out infinite;animation-delay:7.6s}",
			".dnl-decor-rainv2 .b10{left:8%;top:42%;width:3px;height:4px;animation:dnl-rv2-bead calc(13.2s / var(--dnl-rv2-pace)) ease-in-out infinite;animation-delay:1.4s}",
			".dnl-decor-rainv2 .b11{left:92%;top:38%;width:4px;height:6px;animation:dnl-rv2-bead calc(11.2s / var(--dnl-rv2-pace)) ease-in-out infinite;animation-delay:10.2s}",
			".dnl-decor-rainv2 .b12{left:46%;top:88%;width:5px;height:7px;animation:dnl-rv2-bead calc(14.4s / var(--dnl-rv2-pace)) ease-in-out infinite;animation-delay:11.3s}",
			"@keyframes dnl-rv2-bead{0%{opacity:0;transform:scale(.3)}10%{opacity:.92;transform:scale(.74)}18%{opacity:.95;transform:scale(1)}34%{transform:scale(1) translate3d(0,.3px,0)}56%{transform:scale(1.02) translate3d(.3px,.8px,0)}76%{opacity:.88;transform:scale(.985)}90%{opacity:0;transform:scale(.88)}100%{opacity:0;transform:scale(.3)}}",
			/* four sliders: hang first (big beads depart sooner — the engines trigger
			 * on r−minR·k), then run the FULL pane height and exit THROUGH the
			 * bottom edge (top → 110%, clipped by the pane's overflow), fading only
			 * in the last few % as they cross the rim — never a mid-pane fade.
			 * Travel is animated via `top` (pane-relative %): translateY % would
			 * resolve against the bead's own ~9px height and barely move (the
			 * v0.4.19 bug). Momentum profile: accelerating top deltas, steady
			 * shrink as the water pays for the remnant, no scale wobble. */
			".dnl-decor-rainv2 .sl1{left:56%;top:6%;animation:dnl-rv2-slide calc(14s / var(--dnl-rv2-pace)) cubic-bezier(.45,.05,.55,.95) infinite;animation-delay:2.6s}",
			".dnl-decor-rainv2 .sl2{left:32%;top:14%;width:5px;height:7px;animation:dnl-rv2-slide2 calc(16s / var(--dnl-rv2-pace)) cubic-bezier(.45,.05,.55,.95) infinite;animation-delay:9.1s}",
			".dnl-decor-rainv2 .sl3{left:74%;top:10%;width:8px;height:10px;animation:dnl-rv2-slide3 calc(15s / var(--dnl-rv2-pace)) cubic-bezier(.45,.05,.55,.95) infinite;animation-delay:5.8s}",
			".dnl-decor-rainv2 .sl4{left:18%;top:22%;width:4px;height:6px;animation:dnl-rv2-slide4 calc(17s / var(--dnl-rv2-pace)) cubic-bezier(.45,.05,.55,.95) infinite;animation-delay:12.6s}",
			"@keyframes dnl-rv2-slide{0%{top:6%;opacity:0;transform:translate3d(0,0,0) scale(.4)}8%{top:6%;opacity:.9;transform:translate3d(0,1px,0) scale(.9)}16%{top:6%;opacity:.95;transform:translate3d(0,1.5px,0) scale(1.04)}34%{top:6%;opacity:.95;transform:translate3d(0,2px,0) scale(1.04)}46%{top:14%;opacity:.95;transform:translate3d(-1px,0,0) scale(1,1.12)}58%{top:30%;opacity:.94;transform:translate3d(-2px,0,0) scale(.97,1.12)}70%{top:50%;opacity:.92;transform:translate3d(-3px,0,0) scale(.92,1.08)}80%{top:68%;opacity:.9;transform:translate3d(-2px,0,0) scale(.86,1.04)}88%{top:84%;opacity:.88;transform:translate3d(-3px,0,0) scale(.78,.98)}94%{top:97%;opacity:.85;transform:translate3d(-3px,0,0) scale(.7,.92)}100%{top:110%;opacity:0;transform:translate3d(-3px,0,0) scale(.62,.86)}}",
			"@keyframes dnl-rv2-slide2{0%{top:14%;opacity:0;transform:translate3d(0,0,0) scale(.38)}10%{top:14%;opacity:.9;transform:translate3d(0,1px,0) scale(.86)}20%{top:14%;opacity:.95;transform:translate3d(0,1.5px,0) scale(1.03)}44%{top:14%;opacity:.92;transform:translate3d(0,2px,0) scale(1.03)}56%{top:24%;opacity:.92;transform:translate3d(-1px,0,0) scale(.98,1.12)}68%{top:44%;opacity:.9;transform:translate3d(-2px,0,0) scale(.93,1.1)}80%{top:68%;opacity:.88;transform:translate3d(-1px,0,0) scale(.85,1.02)}88%{top:85%;opacity:.86;transform:translate3d(-2px,0,0) scale(.77,.96)}94%{top:98%;opacity:.84;transform:translate3d(-2px,0,0) scale(.7,.9)}100%{top:110%;opacity:0;transform:translate3d(-2px,0,0) scale(.63,.85)}}",
			"@keyframes dnl-rv2-slide3{0%{top:10%;opacity:0;transform:translate3d(0,0,0) scale(.42)}8%{top:10%;opacity:.92;transform:translate3d(0,1px,0) scale(.92)}15%{top:10%;opacity:.96;transform:translate3d(0,2px,0) scale(1.06)}30%{top:10%;opacity:.94;transform:translate3d(0,2px,0) scale(1.06)}44%{top:22%;opacity:.94;transform:translate3d(1px,0,0) scale(1,1.14)}58%{top:44%;opacity:.92;transform:translate3d(3px,0,0) scale(.96,1.14)}72%{top:66%;opacity:.9;transform:translate3d(2px,0,0) scale(.89,1.08)}84%{top:85%;opacity:.88;transform:translate3d(3px,0,0) scale(.8,1)}93%{top:98%;opacity:.85;transform:translate3d(3px,0,0) scale(.72,.94)}100%{top:112%;opacity:0;transform:translate3d(3px,0,0) scale(.64,.88)}}",
			"@keyframes dnl-rv2-slide4{0%{top:22%;opacity:0;transform:translate3d(0,0,0) scale(.36)}11%{top:22%;opacity:.88;transform:translate3d(0,1px,0) scale(.85)}22%{top:22%;opacity:.94;transform:translate3d(0,1.5px,0) scale(1.02)}48%{top:22%;opacity:.9;transform:translate3d(0,2px,0) scale(1.02)}60%{top:32%;opacity:.9;transform:translate3d(-1px,0,0) scale(.97,1.1)}72%{top:52%;opacity:.88;transform:translate3d(-2px,0,0) scale(.91,1.08)}84%{top:74%;opacity:.86;transform:translate3d(-1px,0,0) scale(.82,1)}92%{top:92%;opacity:.84;transform:translate3d(-2px,0,0) scale(.74,.94)}100%{top:110%;opacity:0;transform:translate3d(-2px,0,0) scale(.66,.88)}}",
			/* stepped remnant behind each slider: holds, then extends (broken beads
			 * of water, not a drawn line) and fades as the mother spends water. */
			".dnl-decor-rainv2 .sl1::after{animation:dnl-rv2-trail calc(14s / var(--dnl-rv2-pace)) cubic-bezier(.45,.05,.55,.95) infinite;animation-delay:2.6s}",
			".dnl-decor-rainv2 .sl2::after{animation:dnl-rv2-trail calc(16s / var(--dnl-rv2-pace)) cubic-bezier(.45,.05,.55,.95) infinite;animation-delay:9.1s}",
			".dnl-decor-rainv2 .sl3::after{animation:dnl-rv2-trail calc(15s / var(--dnl-rv2-pace)) cubic-bezier(.45,.05,.55,.95) infinite;animation-delay:5.8s}",
			".dnl-decor-rainv2 .sl4::after{animation:dnl-rv2-trail calc(17s / var(--dnl-rv2-pace)) cubic-bezier(.45,.05,.55,.95) infinite;animation-delay:12.6s}",
			"@keyframes dnl-rv2-trail{0%,30%{height:0;opacity:0}38%{height:6px;opacity:calc(var(--dnl-rv2-trail) * 1.1)}50%{height:6px;opacity:calc(var(--dnl-rv2-trail) * .9)}58%{height:15px;opacity:calc(var(--dnl-rv2-trail) * .75)}70%{height:15px;opacity:calc(var(--dnl-rv2-trail) * .55)}80%{height:26px;opacity:calc(var(--dnl-rv2-trail) * .34)}90%{height:26px;opacity:calc(var(--dnl-rv2-trail) * .14)}96%,100%{height:28px;opacity:0}}",
			/* daughter remnant beads (the engines' 0.2–0.5 trailScale): two per
			 * slider, ~40% / ~25% of the mother. They are PANE-POSITIONED
			 * siblings, not children — a child would ride along with the
			 * sliding mother instead of being left behind. Each is placed on
			 * its slider's drift line, appears as the mother passes
			 * (remnant-a mid-run, remnant-b late), then evaporates. Duration
			 * and delay match the parent slider exactly. */
			".dnl-decor-rainv2 .dnl-decor-remnant{border-radius:50%;background:radial-gradient(circle at 38% 30%,rgba(255,255,255,.12) 0%,rgba(160,185,228,.06) 46%,rgba(7,13,28,.34) 100%);box-shadow:inset 0 1px 1px rgba(255,255,255,.22);opacity:0}",
			/* each daughter's top matches where its mother actually is at the
			 * remnant's appear moment (remnant-a 58% / remnant-b 72% of cycle) */
			".dnl-decor-rainv2 .ra1{left:55%;top:29%;width:3px;height:4px;animation:dnl-rv2-remnant-a calc(14s / var(--dnl-rv2-pace)) ease-out infinite;animation-delay:2.6s}",
			".dnl-decor-rainv2 .ra2{left:54%;top:53%;width:2px;height:3px;animation:dnl-rv2-remnant-b calc(14s / var(--dnl-rv2-pace)) ease-out infinite;animation-delay:2.6s}",
			".dnl-decor-rainv2 .rb1{left:31%;top:26%;width:2px;height:3px;animation:dnl-rv2-remnant-a calc(16s / var(--dnl-rv2-pace)) ease-out infinite;animation-delay:9.1s}",
			".dnl-decor-rainv2 .rb2{left:30.5%;top:51%;width:2px;height:2px;animation:dnl-rv2-remnant-b calc(16s / var(--dnl-rv2-pace)) ease-out infinite;animation-delay:9.1s}",
			".dnl-decor-rainv2 .rc1{left:75%;top:43%;width:3px;height:4px;animation:dnl-rv2-remnant-a calc(15s / var(--dnl-rv2-pace)) ease-out infinite;animation-delay:5.8s}",
			".dnl-decor-rainv2 .rc2{left:76%;top:65%;width:2px;height:3px;animation:dnl-rv2-remnant-b calc(15s / var(--dnl-rv2-pace)) ease-out infinite;animation-delay:5.8s}",
			".dnl-decor-rainv2 .rd1{left:17%;top:29%;width:2px;height:2px;animation:dnl-rv2-remnant-a calc(17s / var(--dnl-rv2-pace)) ease-out infinite;animation-delay:12.6s}",
			".dnl-decor-rainv2 .rd2{left:16%;top:51%;width:1.5px;height:2px;animation:dnl-rv2-remnant-b calc(17s / var(--dnl-rv2-pace)) ease-out infinite;animation-delay:12.6s}",
			"@keyframes dnl-rv2-remnant-a{0%,54%{opacity:0}58%{opacity:calc(var(--dnl-rv2-trail) * 1.2)}76%{opacity:calc(var(--dnl-rv2-trail) * .8)}90%{opacity:calc(var(--dnl-rv2-trail) * .3)}96%,100%{opacity:0}}",
			"@keyframes dnl-rv2-remnant-b{0%,68%{opacity:0}72%{opacity:calc(var(--dnl-rv2-trail) * 1.1)}86%{opacity:calc(var(--dnl-rv2-trail) * .7)}95%{opacity:calc(var(--dnl-rv2-trail) * .25)}99%,100%{opacity:0}}",
			/* Petals: four bezier-ish shapes (border-radius tricks) falling with
			 * a swing; the skin's brand colour tints them via currentColor. */
			".dnl-decor-petals .dnl-decor-petal{width:9px;height:12px;background:linear-gradient(160deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,#ffffff 12%),color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,transparent));border-radius:80% 10% 80% 10%;opacity:0;animation:dnl-petal-fall 7s ease-in-out infinite}",
			".dnl-decor-petals .p1{left:16%;top:-16px;animation-delay:0s}",
			".dnl-decor-petals .p2{left:44%;top:-16px;animation-delay:1.9s;animation-duration:8.4s;transform:scale(.8)}",
			".dnl-decor-petals .p3{left:68%;top:-16px;animation-delay:3.6s}",
			".dnl-decor-petals .p4{left:88%;top:-16px;animation-delay:5.1s;animation-duration:7.6s;transform:scale(.7)}",
			"@keyframes dnl-petal-fall{0%{transform:translate3d(0,-10px,0) rotate(0deg);opacity:0}14%{opacity:.8}48%{transform:translate3d(-9px,58px,0) rotate(140deg)}84%{opacity:.5}100%{transform:translate3d(-18px,128px,0) rotate(290deg);opacity:0}}",
			/* Motes: six drifting light dots (radial gradients), slow sway. */
			".dnl-decor-motes .dnl-decor-mote{width:3px;height:3px;border-radius:50%;background:radial-gradient(circle,color-mix(in srgb,var(--dsw-alias-brand-primary) 70%,#ffffff 25%) 0%,transparent 70%);animation:dnl-mote-drift 8s ease-in-out infinite alternate;opacity:.7}",
			".dnl-decor-motes .m1{left:10%;top:28%}",
			".dnl-decor-motes .m2{left:30%;top:64%;animation-delay:-1.7s;animation-duration:9.5s;transform:scale(.7)}",
			".dnl-decor-motes .m3{left:52%;top:22%;animation-delay:-3.4s}",
			".dnl-decor-motes .m4{left:70%;top:58%;animation-delay:-5s;animation-duration:10.5s;transform:scale(1.2)}",
			".dnl-decor-motes .m5{left:86%;top:34%;animation-delay:-2.6s;transform:scale(.6)}",
			".dnl-decor-motes .m6{left:44%;top:78%;animation-delay:-6.8s;animation-duration:11s;transform:scale(.8)}",
			"@keyframes dnl-mote-drift{from{transform:translate3d(0,0,0)}to{transform:translate3d(6px,-9px,0)}}",
			"@media(prefers-reduced-motion:reduce){.dnl-decor span{animation:none}.dnl-decor-rain .dnl-decor-streak,.dnl-decor-rainv2 .dnl-decor-streak,.dnl-decor-petals .dnl-decor-petal{display:none}.dnl-decor-rain .dnl-decor-drop,.dnl-decor-rainv2 .dnl-decor-drop,.dnl-decor-motes .dnl-decor-mote{opacity:.5}.dnl-decor-rain .dnl-decor-drop::after,.dnl-decor-rainv2 .dnl-decor-drop::after{display:none}.dnl-style-arknights::before{animation:none;opacity:.75}}",
			/* grid-template-rows 0fr -> 1fr interpolates the panel's intrinsic
			 * height, so any lyric count animates without measuring anything.
			 * width:0 while collapsed keeps the panel's natural width from
			 * stretching the pill; both properties transition together. */
			".dnl-grow{display:grid;grid-template-rows:0fr;opacity:0;width:0;transition:grid-template-rows .28s cubic-bezier(.2,.7,.3,1),opacity .22s ease,width .28s cubic-bezier(.2,.7,.3,1)}",
			".dnl-expanded .dnl-grow{grid-template-rows:1fr;opacity:1;width:auto}",
			".dnl-grow-inner{min-height:0;min-width:0;overflow:hidden}",
			".dnl-grow[aria-hidden=true]{pointer-events:none}",
			/* The collapsed row yields its height through its own grid track, on the
			 * same easing and duration as the panel's. Both tracks therefore move
			 * together and the capsule's total height only ever grows while opening
			 * (and only ever shrinks while closing) - a dip would slide the box out
			 * from under a stationary pointer and bounce hover forever.
			 * Its width contribution is kept (the item is still laid out), so the
			 * capsule does not shrink-wrap to the panel. */
			/* width is written as an explicit px value by the line-change effect,
			 * so it can interpolate instead of jumping (content-sized pill used
			 * to shift the whole capsule sideways on every line change). */
			".dnl-now-wrap{display:grid;grid-template-rows:1fr;overflow:hidden;transition:grid-template-rows .28s cubic-bezier(.2,.7,.3,1),opacity .2s ease,width .28s cubic-bezier(.2,.7,.3,1)}",
			".dnl-now-wrap>*{min-height:0;min-width:0}",
			".dnl-expanded .dnl-now-wrap{grid-template-rows:0fr;opacity:0;pointer-events:none}",
			".dnl-now{display:flex;flex-direction:column;align-items:center;gap:1px;min-height:22px;min-width:0}",
			".dnl-now-text{color:var(--dnl-original,var(--dsw-alias-label-primary));font-size:13px;line-height:22px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:48vw}",
			/* v0.4.1: the translation row is a grid track of its own. A line with a
			 * translation is ~39px tall, without one ~22px; the old track-wide
			 * reservation (a hidden 16px spacer on EVERY line, even the title label)
			 * kept the pill permanently offset upward - the reported "the text sits
			 * high because the blank translation row is always reserved". Now each
			 * line owns its row: .dnl-now-trans-empty collapses it to 0fr and the
			 * same 0.2s ease animates the change, so translated/untranslated lines
			 * (and the title fallback) all centre the pill content. */
			".dnl-now-trans{display:grid;grid-template-rows:1fr;transition:grid-template-rows .2s ease;color:var(--dnl-translation,var(--dsw-alias-label-secondary));font-size:11px;line-height:16px;max-width:48vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dnl-now-trans>*{min-height:0}",
			".dnl-now-trans-empty{grid-template-rows:0fr}",
			".dnl-now-sub{color:var(--dsw-alias-label-tertiary);font-size:11px;flex:none}",
			/* padding-top keeps the first row off the clip edge of .dnl-grow-inner (see the
			 * gear hit-target note): a child flush with an overflow:hidden boundary has
			 * its edge clipped, which silently ate the top half of the gear's target. */
			".dnl-panel{display:flex;flex-direction:column;gap:10px;position:relative;padding-top:3px}",
			".dnl-panel-body{display:flex;flex-direction:column;gap:10px}",
			/* In flow at the end of the header row, so it never leaves the panel's
			 * clip box (the panel sits inside an overflow:hidden height animator). */
			/* The hit target is a SQUARE; the round look is drawn by ::before. A
			 * border-radius:50% button only answers clicks inside its inscribed
			 * circle - its four corners resolve to the parent header row, so aiming
			 * at a corner missed and only some diagonal approaches worked. */
			/* A 32x32 square target with a 26px round visual inside it: the extra
			 * 3px ring on each side means a click near the edge still lands on the
			 * button instead of the header row behind it. */
			".dnl-gear{position:absolute;top:4px;right:4px;width:32px;height:32px;padding:0;border:0;background:transparent;color:var(--dnl-gear-ink,var(--dsw-alias-label-tertiary));font-size:14px;line-height:32px;text-align:center;cursor:pointer;font-family:inherit;transition:color .15s ease;z-index:3}",
			".dnl-gear::before{content:'';position:absolute;inset:3px;border:.5px solid transparent;border-radius:50%;background:transparent;transition:background .15s ease,border-color .15s ease}",
			/* Hover used to jump to --dsw-alias-label-primary, which on the dark
			 * skins resolves to near-black: the gear turned into a black blob on
			 * a dark panel (reported live 2026-11-09). Readability beats the
			 * theme token here - prefer the user's own lyric colour (it is
			 * guaranteed legible on this background), then the accent, and only
			 * then the theme primary. The disc behind the icon carries the
			 * hover affordance instead of the ink colour. */
			".dnl-gear:hover{color:var(--dnl-original,var(--dnl-ak-accent,var(--dsw-alias-brand-primary)))}",
			".dnl-gear:hover::before{background:color-mix(in srgb,var(--dnl-ak-accent,var(--dnl-original,var(--dsw-alias-brand-primary))) 16%,var(--dsw-alias-bg-layer-2));border-color:color-mix(in srgb,var(--dnl-ak-accent,var(--dnl-original,var(--dsw-alias-brand-primary))) 55%,transparent)}",
			".dnl-gear-on::before{border-color:var(--dsw-alias-brand-primary)}",
			".dnl-gear-on{color:var(--dsw-alias-brand-primary)}",
			".dnl-settings{display:flex;flex-direction:column;gap:6px;max-height:240px;overflow-y:auto;padding-right:2px}",
			".dnl-set-head-row{display:flex;align-items:center;gap:8px;min-width:0}",
			".dnl-set-head{color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;font-weight:600;padding-bottom:2px}",
			".dnl-set-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px}",
			".dnl-set-row input[type=range]{flex:1;min-width:80px;accent-color:var(--dsw-alias-brand-primary);height:14px}",
			".dnl-set-row input[type=color]{width:28px;height:20px;padding:0;border:.5px solid var(--dsw-alias-border-l1);border-radius:4px;background:transparent;cursor:pointer}",
			".dnl-set-row select{font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);padding:1px 4px}",
			".dnl-set-text{flex:1;min-width:90px;font:inherit;color:var(--dsw-alias-label-primary);background:transparent;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,6px);padding:1px 6px}",
			".dnl-set-value{color:var(--dsw-alias-label-tertiary);font-size:10px;min-width:34px;text-align:right;font-variant-numeric:tabular-nums}",
			".dnl-set-btn{font:inherit;font-size:10px;color:var(--dsw-alias-label-secondary);background:transparent;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,6px);padding:0 6px;line-height:16px;cursor:pointer;align-self:flex-start}",
			".dnl-set-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}",
			".dnl-set-btn:disabled{opacity:.45;cursor:default}",
			".dnl-set-note{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:14px;margin:0}",
			".dnl-head{display:flex;gap:10px;align-items:center;min-width:0}",
			".dnl-cover{width:44px;height:44px;border-radius:8px;object-fit:cover;flex:none;border:.5px solid var(--dsw-alias-border-l1)}",
			".dnl-head-text{min-width:0;display:flex;flex-direction:column;gap:1px}",
			".dnl-title{color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dnl-artist{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dnl-match{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;display:flex;align-items:center;gap:8px;white-space:nowrap;overflow:hidden}",
			".dnl-btn{color:var(--dsw-alias-label-primary);background:transparent;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);padding:1px 8px;font-size:11px;line-height:16px;cursor:pointer;font-family:inherit;flex:none}",
			".dnl-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}",
			".dnl-btn:disabled{opacity:.5;cursor:default}",
			/* The list scrolls instead of growing: nine translated rows are ~297px,
			 * which made the whole capsule ~485px tall. Centring is done by scrolling
			 * the active row to the middle, so the window can be any height without
			 * losing the active line. */
			".dnl-lines{display:flex;flex-direction:column;gap:4px;max-height:184px;overflow-y:auto;overflow-x:hidden;scrollbar-width:none;-ms-overflow-style:none;-webkit-mask-image:linear-gradient(180deg,transparent,#000 12%,#000 88%,transparent);mask-image:linear-gradient(180deg,transparent,#000 12%,#000 88%,transparent)}",
			".dnl-lines::-webkit-scrollbar{display:none}",
			".dnl-lines-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;justify-content:center;align-items:center;height:60px}",
			".dnl-line{display:flex;flex-direction:column;align-items:center;text-align:center}",
			".dnl-line-pad{visibility:hidden}",
			".dnl-line-main{color:var(--dnl-original,var(--dsw-alias-label-secondary));font-size:12px;line-height:18px;font-weight:400;transition:color .2s ease,font-size .2s ease,font-weight .2s ease}",
			".dnl-line-trans{color:var(--dnl-translation,var(--dsw-alias-label-secondary));font-size:11px;line-height:15px}",
			/* Same duration as the colour change, so a line becoming active grows and
			 * brightens in one motion instead of jumping size and then re-scrolling. */
			".dnl-line-active .dnl-line-main{color:var(--dnl-active,var(--dnl-original,var(--dsw-alias-brand-primary)));font-size:13px;font-weight:600}",
			".dnl-progress{display:flex;align-items:center;gap:8px}",
			".dnl-time{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:12px;font-variant-numeric:tabular-nums;flex:none}",
			".dnl-bar{flex:1;height:3px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}",
			".dnl-bar-fill{height:100%;border-radius:2px;background:var(--dsw-alias-brand-primary)}",
			".dnl-controls{display:flex;align-items:center;justify-content:center;gap:14px;padding-top:2px}",
			".dnl-ctl{width:28px;height:28px;display:flex;align-items:center;justify-content:center;padding:0;border:.5px solid var(--dsw-alias-border-l1);border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;cursor:pointer;font-family:inherit;transition:color .15s ease,border-color .15s ease,background .15s ease}",
			".dnl-ctl:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}",
			".dnl-ctl:disabled{opacity:.4;cursor:default}",
			".dnl-ctl-main{width:34px;height:34px;font-size:14px;color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}",
			".dnl-ctl-sm{width:auto;min-width:34px;height:24px;padding:0 7px;border-radius:12px;font-size:10px;font-variant-numeric:tabular-nums}",
			".dnl-ctl-note{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:12px}",
			/* NOTE: .dnl-now-trans is declared ONCE, in the .dnl-now-* family above.
			 * A second declaration later in this array would silently override the
			 * grid/collapse behaviour (v0.4.1 per-line row collapse) - guarded by
			 * a count assertion in line-width.test.mjs. */
			/* The capsule's left gutter is pure padding (30px, no text or controls),
			 * so the WHOLE strip is a drag target in both states - notably the
			 * collapsed pill, where a small centred handle only covered part of it.
			 * Stretching it over the padding box cannot swallow a click meant for a
			 * control: every control starts after that box. flex centring keeps the
			 * glyph in place now that the button is full-height. */
			".dnl-drag{position:absolute;left:0;top:0;bottom:0;width:30px;height:auto;display:flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:4px;cursor:grab;touch-action:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:16px}.dnl-drag:active{cursor:grabbing}.dnl-drag:focus-visible{outline:2px solid var(--dsw-alias-brand-primary)}",
			".dnl-crossfade{display:grid;min-width:0}.dnl-fade-layer{grid-area:1/1;min-width:0}.dnl-fade-out{pointer-events:none;animation:dnl-lyric-out 340ms cubic-bezier(.4,0,.2,1) both}.dnl-fade-in{animation:dnl-lyric-in 340ms cubic-bezier(.4,0,.2,1) both}@keyframes dnl-lyric-out{from{opacity:1;transform:translateY(0)}to{opacity:0;transform:translateY(-4px)}}@keyframes dnl-lyric-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}@media(prefers-reduced-motion:reduce){.dnl-fade-in{animation:none}.dnl-fade-out{display:none;animation:none}.dnl-island,.dnl-line-main,.dnl-ctl,.dnl-grow,.dnl-now-wrap{transition:none}.dnl-halo>.h1,.dnl-halo>.h2,.dnl-halo>.h3,.dnl-halo>.h4,.dnl-halo>.dnl-kick{animation:none}.dnl-halo>.dnl-kick{display:none}.dnl-halo{animation:dnl-glow-soft 9s ease-in-out infinite}}",
			/* ---- workspace notices (v0.4.0) ---- */
			/* Collapsed notice row: same pill metrics as the lyric row it replaces
			 * (22px line height), so the pill never changes height when SMTC
			 * starts/stops and the island flips modes. */
			".dnl-notice-now{display:flex;align-items:center;gap:7px;min-height:22px;min-width:0}",
			".dnl-notice-icon{flex:none;font-size:12px;line-height:22px}",
			".dnl-notice-text{font-size:13px;line-height:22px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:44vw}",
			".dnl-notice-count{flex:none;color:var(--dsw-alias-label-secondary);font-size:10px;line-height:14px;padding:0 6px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}",
			".dnl-notice-panel{max-width:min(360px,80vw)}",
			".dnl-notices{display:flex;flex-direction:column;gap:8px;max-height:220px;overflow-y:auto;scrollbar-width:none;-ms-overflow-style:none}",
			".dnl-notices::-webkit-scrollbar{display:none}",
			".dnl-notice-head{color:var(--dsw-alias-label-secondary);font-size:10px;line-height:14px;letter-spacing:.4px}",
			".dnl-notice-row{display:flex;flex-direction:column;gap:2px;padding:6px 9px;border-radius:8px;background:var(--dsw-alias-bg-layer-1)}",
			".dnl-notice-row-jump{cursor:pointer}",
			".dnl-notice-row-jump:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,var(--dsw-alias-bg-layer-2))}",
			/* Question rows carry a brand tint so 待回答 stands out from the
			 * informational round-ending rows. */
			".dnl-notice-row-q{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,var(--dsw-alias-bg-layer-1))}",
			".dnl-notice-title{color:var(--dsw-alias-label-primary);font-size:12px;line-height:16px;font-weight:600}",
			".dnl-notice-detail{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:15px}",
			".dnl-notice-time{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:12px;font-variant-numeric:tabular-nums}",
			".dnl-notice-empty{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}",
			/* Red dot: an 18x18 square hit target with a round visual inside
			 * (same target-visual split as the gear button - a border-radius:50%
			 * button only answers clicks inside its inscribed circle, so the four
			 * corners missed). v0.4.1: quieter presence - a desaturated red, no
			 * scale pulse (an opacity breath reads as "something changed" without
			 * thumping). v0.4.2: appearances now FADE IN (dnl-dot-in, .18s) and the
			 * breath waits for it, so the dot materialises instead of popping;
			 * retirements keep fading (dnl-dot-out) — including the click-to-open
			 * hand-off, which no longer snaps the dot away. */
			".dnl-dot{position:absolute;right:4px;bottom:4px;width:18px;height:18px;padding:0;border:0;background:transparent;cursor:pointer;z-index:4;border-radius:50%}",
			".dnl-dot::before{content:'';position:absolute;left:5px;top:5px;width:8px;height:8px;border-radius:50%;background:#c65054;box-shadow:0 0 0 2px var(--dsw-alias-bg-overlay);animation:dnl-dot-in .18s ease-out both,dnl-dot-pulse 2.6s ease-in-out .18s infinite}",
			".dnl-dot:hover::before{box-shadow:0 0 0 2px var(--dsw-alias-bg-overlay),0 0 0 4px rgba(198,80,84,.3)}",
			".dnl-dot:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
			".dnl-dot-core{display:none}",
			/* Retirement: opacity + a slight shrink, NOT display:none (a removed
			 * animation would snap). The button is aria-hidden and inert while
			 * fading so it cannot be re-clicked. */
			".dnl-dot-out{cursor:default;pointer-events:none}",
			".dnl-dot-out::before{animation:dnl-dot-out .26s ease-out forwards}",
			"@keyframes dnl-dot-in{from{opacity:0;transform:scale(.6)}to{opacity:.95;transform:scale(1)}}",
			"@keyframes dnl-dot-pulse{0%,100%{opacity:.95}50%{opacity:.55}}",
			"@keyframes dnl-dot-out{from{opacity:.95;transform:scale(1)}to{opacity:0;transform:scale(.5)}}",
			/* Ghost pill: the whole host fades (then unmounts) after the notices
			 * clear while idle. */
			".dnl-host-fade{animation:dnl-host-out " + String(NOTICE_FADE_MS) + "ms ease-out forwards}",
			"@keyframes dnl-host-out{from{opacity:1}to{opacity:0}}",
			"@media(prefers-reduced-motion:reduce){.dnl-dot::before{animation:none;opacity:.95}.dnl-dot-out::before{animation:none;opacity:0}.dnl-host-fade{animation:none;opacity:0}}",
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
		exports.__test = { FloatLine, selectFloats, nextPlacement, CSS, lyricWindow, displayTitle, seekTarget, createTrackSource, sanitizeLines,
			currentLineIndex, stickyLineIndex, settleLineIndex, backwardSettleMs, nextTransitionFrame,
			hysteresisFor, BACKWARD_SETTLE_MS, LINE_HYSTERESIS_MIN_SEC, LINE_HYSTERESIS_MAX_SEC,
			sanitizeNotices, noticeHeadline, noticeOutcomeLabel, noticeClockLabel, noticeList, mainSessionIdOf, workspaceGroupOf,
			readNoticePrefs, writeNoticePrefs, expireTurnEnds, playNoticeChime, readDisplay };
		return module.exports;
	}
});

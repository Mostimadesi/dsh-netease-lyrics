// One-shot v0.4.37 patch: lyric-derived beat driver for the wave rings.
// Anchor-verified line edits against lib/client.js (kept for the record,
// same role as test/_apply-wave-v0436.mjs). Run from the repo root:
//   node test/_apply-beat-v0437.mjs
import fs from 'node:fs';

const path = 'lib/client.js';
let src = fs.readFileSync(path, 'utf8');

function replaceOnce(anchor, replacement) {
	const count = src.split(anchor).length - 1;
	if (count !== 1) throw new Error(`anchor not unique (${count}x): ${anchor.slice(0, 80)}`);
	src = src.split(anchor).join(replacement);
}

// ---- 1) sanitizer: glowBeatSource whitelist + glowBeatGain clamp ------------
replaceOnce(
	'if (raw?.glowWaveBright === "vivid") out.glowWaveBright = raw.glowWaveBright;',
	`if (raw?.glowWaveBright === "vivid") out.glowWaveBright = raw.glowWaveBright;
			// v0.4.37 beat driver: "lyric" is the default source, so only the
			// explicit choices are persisted. "audio" is whitelisted already;
			// it is the v0.4.38 FFT helper's option and falls back to the
			// lyric grid until that ships.
			if (raw?.glowBeatSource === "off" || raw?.glowBeatSource === "lyric" || raw?.glowBeatSource === "audio") out.glowBeatSource = raw.glowBeatSource;
			// 100 = the default strength, so only non-default values persist.
			if (Number.isFinite(raw?.glowBeatGain) && Math.round(raw.glowBeatGain) !== 100) {
				out.glowBeatGain = Math.min(200, Math.max(0, Math.round(raw.glowBeatGain)));
			}`);

// ---- 2) createBeatGrid (pure helper, exported via __test) -------------------
replaceOnce(
	'\t\t// Sample-and-hold aware clock (same contract as the original island).',
	`\t\t/** v0.4.37 lyric-derived beat grid: turns a lyric timeline into pulses
		 *  so the wave rings can pulse WITH the song instead of orbiting
		 *  blindly. A downbeat (strength 1) fires at every line start; word
		 *  onsets from the yrc word timeline (strength .42) — or even
		 *  subdivisions of long word-less lines (strength .45) — keep the
		 *  pulse alive between downbeats. Instrumental breaks (gap >=
		 *  max(2x median gap, 3.5s)) stay silent so the rings rest with the
		 *  music. beatAt(pos) = residual of the latest pulse:
		 *  strength * e^(-dt/tau), tau = 0.30s. Pure: no DOM, no React. */
		function createBeatGrid(lines) {
			const rows = sanitizeLines(lines).filter((row) => Number.isFinite(Number(row?.t)));
			if (rows.length === 0) return { beatAt: () => 0, pulseCount: 0 };
			const gaps = [];
			for (let i = 0; i < rows.length - 1; i += 1) {
				const d = Number(rows[i + 1].t) - Number(rows[i].t);
				if (d > 0) gaps.push(d);
			}
			gaps.sort((a, b) => a - b);
			// Lower median: with an even count the high pick would swallow
			// genuine rests (e.g. gaps [2, 28] -> high median 28 -> nothing
			// is ever a rest).
			const median = gaps.length > 0 ? gaps[Math.floor((gaps.length - 1) / 2)] : 3;
			const restGap = Math.max(median * 2, 3.5);
			const TAU = 0.3;
			const pulses = [];
			rows.forEach((row, i) => {
				const t = Number(row.t);
				pulses.push({ t, s: 1 });
				/* The trailing line rings out unknown; inventing a phantom
				 * segment for it would pulse past the end of the lyric data,
				 * so only real gaps subdivide. */
				const next = i + 1 < rows.length ? Number(rows[i + 1].t) : NaN;
				const d = next - t;
				if (!(d > 0) || d >= restGap) return;
				const words = Array.isArray(row.words) ? row.words : [];
				const onsets = words
					.map((word) => Number(word?.t))
					.filter((wt) => Number.isFinite(wt) && wt > t + 0.05 && wt < t + d - 0.02);
				if (onsets.length >= 2) {
					for (const wt of onsets) pulses.push({ t: wt, s: 0.42 });
				} else if (d >= 1.6) {
					const n = Math.min(4, Math.max(2, Math.round(d / 1.1)));
					for (let k = 1; k < n; k += 1) pulses.push({ t: t + (d * k) / n, s: 0.45 });
				}
			});
			pulses.sort((a, b) => a.t - b.t);
			function beatAt(pos) {
				if (!Number.isFinite(pos) || pulses.length === 0) return 0;
				let lo = 0;
				let hi = pulses.length - 1;
				let idx = -1;
				while (lo <= hi) {
					const mid = (lo + hi) >> 1;
					if (pulses[mid].t <= pos) { idx = mid; lo = mid + 1; } else hi = mid - 1;
				}
				if (idx < 0) return 0;
				return pulses[idx].s * Math.exp(-(pos - pulses[idx].t) / TAU);
			}
			return { beatAt, pulseCount: pulses.length };
		}

		// Sample-and-hold aware clock (same contract as the original island).`);

// ---- 3) beat driver effect + halo ref ---------------------------------------
replaceOnce(
	'\t\t\tif (linesForHooks.length === 0) lineStateRef.current.shown = -1;\n',
	`\t\t\tif (linesForHooks.length === 0) lineStateRef.current.shown = -1;

			/* v0.4.37 beat driver: a lyric timeline cannot reach CSS keyframes,
			 * so this rAF loop is the one place the wave rings actually follow
			 * the song. It samples the beat grid at the CALIBRATED lookup
			 * position (the same clock the caption uses) and writes a single
			 * 0..~1 scalar onto --dnl-beat; the rings consume it in CSS
			 * (brightness + a hint of scale, scaled by --dnl-beat-gain).
			 * "lyric" = line/word onset grid (createBeatGrid); "audio" is the
			 * v0.4.38 FFT helper's source and falls back to the lyric grid
			 * until that ships. Paused playback decays to zero instead of
			 * freezing a stale pulse — a frozen bright ring reads as stuck.
			 * Declared before the early return: hooks keep a constant order. */
			const haloRef = useRef(null);
			const beatSource = prefs.glowBeatSource === "off" ? "off" : "lyric";
			useEffect(() => {
				if (beatSource === "off" || linesForHooks.length === 0) {
					if (haloRef.current) haloRef.current.style.setProperty("--dnl-beat", "0");
					return undefined;
				}
				const grid = createBeatGrid(linesForHooks);
				let raf = 0;
				let timer = 0;
				let cur = 0;
				let last = Date.now();
				const tick = () => {
					const now = Date.now();
					const dt = Math.min(0.25, Math.max(0, (now - last) / 1000));
					last = now;
					const playing = st !== null && st.playing === true;
					const target = playing ? grid.beatAt(offsetPosition(clock.read(now), offsetMs)) : 0;
					/* Attack fast, release smooth: the grid's own exp decay
					 * shapes the envelope; these eases only keep one-frame
					 * jumps from reading as flicker. */
					const ease = target > cur ? Math.min(1, dt / 0.06) : Math.min(1, dt / 0.14);
					cur += (target - cur) * ease;
					if (haloRef.current) haloRef.current.style.setProperty("--dnl-beat", cur < 0.004 ? "0" : cur.toFixed(3));
					if (typeof requestAnimationFrame === "function") raf = requestAnimationFrame(tick);
					else timer = setTimeout(tick, 50);
				};
				tick();
				return () => {
					if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
					if (timer) clearTimeout(timer);
				};
			}, [beatSource, lyricSongKey, offsetMs, st?.playing]);
`);

// ---- 4) halo span: ref + --dnl-beat-gain inline var --------------------------
replaceOnce(
	'+ (st.playing === true || glowMode === "notice" ? "" : " dnl-halo-hold"),\n',
	'+ (st.playing === true || glowMode === "notice" ? "" : " dnl-halo-hold"),\n\t\t\t\t\tref: haloRef,\n');
replaceOnce(
	'style: { "--dnl-glow-dur": glowMode === "notice" ? "1.15s" : glowDur, "--dnl-glow-amp": glowAmp },',
	'style: { "--dnl-glow-dur": glowMode === "notice" ? "1.15s" : glowDur, "--dnl-glow-amp": glowAmp, "--dnl-beat-gain": String((Number.isFinite(prefs.glowBeatGain) ? prefs.glowBeatGain : 100) / 100) },');

// ---- 5) settings UI: 律动源 + 律动强度 ---------------------------------------
replaceOnce(
	'\t\t\t\th("label", { key: "font", className: "dnl-set-row" }, "字体",',
	`\t\t\t\tprefs.glowWaveStyle ? h("label", { key: "glow-beat-source", className: "dnl-set-row" }, "律动源",
					h("select", { "aria-label": "律动源",
						value: prefs.glowBeatSource === "off" ? "off" : "lyric",
						onChange: (event) => saveDisplay({ ...readDisplay(), glowBeatSource: event.target.value === "lyric" ? undefined : event.target.value }) },
						[["lyric", "歌词拍格（默认）"], ["off", "关闭"]].map(([id, label]) => h("option", { key: id, value: id }, label))))
					: null,
				prefs.glowWaveStyle ? h("label", { key: "glow-beat-gain", className: "dnl-set-row" }, "律动强度",
					h("input", { type: "range", min: 0, max: 200, step: 5, "aria-label": "律动强度",
						value: Number.isFinite(prefs.glowBeatGain) ? prefs.glowBeatGain : 100,
						onChange: (event) => saveDisplay({ ...readDisplay(), glowBeatGain: Number(event.target.value) }) }))
					: null,
				h("label", { key: "font", className: "dnl-set-row" }, "字体",`);

// ---- 6) CSS: --dnl-beat default + svg consumes beat (brightness + scale) ----
replaceOnce(
	'".dnl-halo-wave{overflow:visible;--dnl-wave-hi:1}",',
	'".dnl-halo-wave{overflow:visible;--dnl-wave-hi:1;--dnl-beat:0}",');
replaceOnce(
	'".dnl-halo-wave svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;display:block;filter:drop-shadow(0 0 2.5px color-mix(in srgb,var(--dnl-halo,var(--dsw-alias-brand-primary)) 55%,transparent))}",',
	'".dnl-halo-wave svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;display:block;transform:scale(calc(1 + var(--dnl-beat-gain,0) * var(--dnl-beat,0) * .05));filter:drop-shadow(0 0 2.5px color-mix(in srgb,var(--dnl-halo,var(--dsw-alias-brand-primary)) 55%,transparent)) brightness(calc(1 + var(--dnl-beat-gain,0) * var(--dnl-beat,0) * .55))}",');

// ---- 7) __test exports --------------------------------------------------------
replaceOnce(
	'lyricWindow, displayTitle, seekTarget, createTrackSource, sanitizeLines,',
	'lyricWindow, displayTitle, seekTarget, createTrackSource, sanitizeLines, createBeatGrid,');

fs.writeFileSync(path, src);
console.log('v0.4.37 beat driver patch applied');

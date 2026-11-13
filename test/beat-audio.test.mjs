import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const clientSrc = readFileSync(path.join(here, "..", "lib", "client.js"), "utf8");
const hostSrc = readFileSync(path.join(here, "..", "lib", "index.js"), "utf8");
const csSrc = readFileSync(path.join(here, "..", "lib", "LoopbackAudio.cs"), "utf8");

test("host: loopback line parser accepts a tick and rejects noise", async () => {
	const { parseLoopbackLine } = await import("../lib/index.js");
	assert.equal(typeof parseLoopbackLine, "function");
	const tick = parseLoopbackLine('{"t":3200,"rms":0.065,"b":[14.5,19.6,2.2,1.8,1.3,0.001,0.0009,0.0004,0.0003,0.0002]}');
	assert.ok(tick, "a real tick parses");
	assert.equal(tick.rms, 0.065);
	assert.equal(tick.b.length, 10);
	assert.equal(tick.t, 3200);
	// heartbeat (integer zeros) must parse too — silence is a live signal
	const hb = parseLoopbackLine('{"t":250,"rms":0,"b":[0,0,0,0,0,0,0,0,0,0]}');
	assert.ok(hb, "heartbeat parses");
	assert.equal(hb.rms, 0);
	// headers / errors / garbage never parse
	for (const line of [
		'{"device":"{0.0.0.00000000}.{abcd}"}',
		'{"fmt":{"ch":2,"rate":48000,"bits":32,"align":8,"tag":65534}}',
		'{"error":"no-default-render-device","hresult":-2004287480}',
		'{"rms":"NaN","b":[1,2,3,4,5,6,7,8,9,10]}',
		'{"rms":0.1,"b":[1,2,3]}',
		'not json at all',
		'',
	]) {
		assert.equal(parseLoopbackLine(line), null, "rejected: " + line.slice(0, 40));
	}
});

test("host: /beat.json is registered, lazily starts the helper, and reports honestly", () => {
	assert.match(hostSrc, /path: ROUTE_BASE \+ '\/beat\.json'/);
	// lazy: start on first request, not at apply()
	assert.match(hostSrc, /handler: \(req, res\) => \{\s*if \(!fence\(req, res\)\) return;\s*(?:\/\/[^\n]*\n\s*)*const bridge = readRegistryBeat\(\);\s*if \(bridge\) \{\s*if \(beatProc\) stopBeatHelper\(\); \/\/ no duplicate WASAPI client\s*sendJson\(res, bridge\); return;\s*\}\s*ensureBeatHelper\(\);\s*sendJson\(res, describeBeat\(\)\);/);
	// the build is hashed and cached under %TEMP%
	assert.match(hostSrc, /crypto\.createHash\('sha1'\)\.update\(src\)/);
	assert.match(hostSrc, /os\.tmpdir\(\)/);
	// a failed build never retries within a lifecycle (csc runs synchronously;
	// a hung retry loop would freeze state.json)
	assert.match(hostSrc, /beatBuildFailed = true;/);
	// teardown kills the helper
	assert.match(hostSrc, /disposers\.push\(\(\) => stopBeatHelper\(\)\)/);
	// serve mode dies with the host's stdin pipe too
	assert.match(csSrc, /Console\.In\.Read\(\) != -1/);
});

test("host: a live shared lyin-audio-beat bridge wins over the local helper", () => {
	// the registry slot read, with an explicit freshness gap (a bridge that
	// went quiet mid-song must not freeze the halo)
	assert.match(hostSrc, /globalThis\.__dshPluginRegistry/);
	assert.match(hostSrc, /slot\['lyin-audio-beat'\]/);
	assert.match(hostSrc, /BEAT_BRIDGE_FRESH_MS = 2000/);
	// shape guard: same { rms, b[10], at } contract as parseLoopbackLine
	assert.match(hostSrc, /!Array\.isArray\(tick\.b\) \|\| tick\.b\.length !== 10/);
	assert.match(hostSrc, /!Number\.isFinite\(tick\.rms\)/);
	assert.match(hostSrc, /Date\.now\(\) - Number\(tick\.at\) > BEAT_BRIDGE_FRESH_MS/);
	// served bridge must carry the full describeBeat shape
	assert.match(hostSrc, /\{ live: true, starting: false, buildFailed: false, tick \}/);
});

test("client: the audio lane polls, gates on freshness, and falls back to the lyric grid", () => {
	assert.match(clientSrc, /BEAT_ROUTE = "\/dsh-netease-lyrics\/beat\.json"/);
	// select offers the experimental lane; the sanitizer already accepts it
	assert.match(clientSrc, /\["audio", "音频 FFT（实验）"\]/);
	assert.match(clientSrc, /glowBeatSource === "audio" \? "audio"/);
	// polling loop with stop flag
	assert.match(clientSrc, /fetch\(BEAT_ROUTE, \{ cache: "no-store" \}\)/);
	assert.match(clientSrc, /poll = setTimeout\(pollBeat, 66\)/);
	// freshness gate: a stale tick is silence, not a beat
	assert.match(clientSrc, /now - lastTickAt < 2000/);
	// three consecutive misses fall back to the lyric grid
	assert.match(clientSrc, /miss >= 3/);
	// kick bands (60–240 Hz) drive the pulse, not overall loudness
	assert.match(clientSrc, /Number\(b\[1\]\) \|\| 0\) \+ \(Number\(b\[2\]\) \|\| 0/);
	// audio lane must not depend on lyric lines (instrumentals stay alive)
	assert.match(clientSrc, /beatSource === "lyric" && linesForHooks\.length === 0/);
	// cleanup stops the poller
	assert.match(clientSrc, /pollStop = true;/);
	assert.match(clientSrc, /if \(poll\) clearTimeout\(poll\);/);
});

test("helper source: the shipped C# compiles the same protocol the host parses", () => {
	// protocol markers the parser depends on
	assert.match(csSrc, /\"rms\"/);
	assert.match(csSrc, /\"b\":\[/);
	// ten bands, invariant formatting (a zh-CN box must not emit commas)
	assert.match(csSrc, /new double\[10\]/);
	assert.match(csSrc, /CultureInfo\.InvariantCulture/);
	// loopback only: the flag that makes this legal to ship
	assert.match(csSrc, /AUDCLNT_STREAMFLAGS_LOOPBACK/);
	// no file writing, no network: prove the helper only computes
	assert.doesNotMatch(csSrc, /System\.Net|WebRequest|File\.Write|FileStream|Registry/);
});

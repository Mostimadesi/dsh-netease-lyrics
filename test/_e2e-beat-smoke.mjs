// One-off E2E smoke for the beat-audio host path (NOT in the test chain).
// Drives lib/index.js through a mocked cordis root: the /beat.json handler
// triggers a REAL csc compile (or hash-cache hit) + REAL helper spawn; all
// other spawns (media bridge etc.) get a silent fake so the smoke stays local.
// Run: node test/_e2e-beat-smoke.mjs   (exit 0 = pass)
import { spawn as realSpawn } from 'node:child_process';
import plugin, { __setSpawnForTests } from '../lib/index.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
const check = (name, ok, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
  if (!ok) failures.push(name);
};

// --- selective spawn seam: real only for the loopback helper -----------------
let helperProc = null;
function fakeProc() {
  return {
    pid: 424242,
    stdout: { setEncoding() {}, on() {} },
    stderr: { on() {} },
    stdin: { on() {}, end() {}, write() { return true; } },
    on() {},
    kill() {},
    unref() {},
  };
}
__setSpawnForTests((cmd, args, opts) => {
  if (String(cmd).includes('loopback-audio')) {
    helperProc = realSpawn(cmd, args, opts);
    return helperProc;
  }
  return fakeProc();
});

// --- mocked cordis root ------------------------------------------------------
const routes = [];
let effectCleanup = null;
const fakeWebServer = {
  register(route) {
    routes.push(route);
    return () => {};
  },
};
const root = {
  config: {},
  webServer: fakeWebServer,
  get(name) { return name === 'webServer' ? fakeWebServer : undefined; },
  inject() {},
  effect(fn) { effectCleanup = fn(); return () => {}; },
  on() { return () => {}; },
};
const req = { headers: { host: '127.0.0.1:60478' }, method: 'GET', on() {} };
const callBeat = () => new Promise((resolve, reject) => {
  const route = routes.find((r) => String(r.path).endsWith('/beat.json'));
  if (!route) { reject(new Error('/beat.json route not registered')); return; }
  route.handler(req, {
    writeHead() {},
    setHeader() {},
    end(body) {
      try { resolve(JSON.parse(String(body))); } catch (err) { reject(err); }
    },
  });
});

// --- drive --------------------------------------------------------------------
try {
  plugin.apply(root, {});
  check('apply() + route registered', routes.some((r) => String(r.path).endsWith('/beat.json')));

  const first = await callBeat();
  console.log('first /beat.json:', JSON.stringify(first));
  check('first call accepted (helper starting)', first && typeof first === 'object');

  await sleep(4000); // compile ~1.5s cold (hash cache makes repeats instant) + boot
  const second = await callBeat();
  console.log('second /beat.json:', JSON.stringify(second).slice(0, 200));
  check('helper used the REAL spawn path', !!helperProc && helperProc.pid > 0,
    'pid=' + (helperProc && helperProc.pid));
  check('helper live after warmup', second && second.live === true,
    'live=' + (second && second.live));
  const tick = second && second.tick;
  check('tick carries 10 bands', !!tick && Array.isArray(tick.b) && tick.b.length === 10,
    tick ? 'b=' + JSON.stringify(tick.b.slice(0, 4)) + '…' : 'no tick');
  check('tick has finite rms', !!tick && Number.isFinite(tick.rms));
  check('tick timestamp fresh', !!tick && Number.isFinite(tick.at) && Date.now() - tick.at < 5000,
    tick ? 'age=' + (Date.now() - tick.at) + 'ms' : 'no tick');

  // --- shared bridge path: a live lyin-audio-beat slot wins, no local spawn
  globalThis.__dshPluginRegistry = {
    'lyin-audio-beat': {
      tick: { rms: 0.42, b: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], at: Date.now() },
    },
  };
  const bridged = await callBeat();
  check('live bridge tick is served', bridged && bridged.live === true
    && bridged.tick && bridged.tick.rms === 0.42 && bridged.tick.b.length === 10);
  await sleep(600);
  check('bridge path retires the duplicate local helper', helperProc
    && (helperProc.exitCode !== null || helperProc.signalCode !== null),
    'exitCode=' + (helperProc && helperProc.exitCode) + ' signal=' + (helperProc && helperProc.signalCode));
  // stale bridge (>2000 ms) disqualifies the slot
  globalThis.__dshPluginRegistry['lyin-audio-beat'].tick.at = Date.now() - 5000;
  const fellBack = await callBeat();
  check('stale bridge falls back to local helper lane', fellBack && typeof fellBack === 'object');
  delete globalThis.__dshPluginRegistry;

  // teardown must kill the helper (stdin EOF → serve-mode watchdog exit)
  if (typeof effectCleanup === 'function') effectCleanup();
  await sleep(700);
  const dead = !helperProc || helperProc.exitCode !== null || helperProc.signalCode !== null;
  check('teardown stopped the helper process', dead,
    'exitCode=' + (helperProc && helperProc.exitCode) + ' signal=' + (helperProc && helperProc.signalCode));
} catch (err) {
  check('smoke run completed without throw', false, String((err && err.stack) || err));
  try { if (typeof effectCleanup === 'function') effectCleanup(); } catch {}
  try { if (helperProc) helperProc.kill(); } catch {}
}

console.log(failures.length ? 'SMOKE FAIL (' + failures.length + ')' : 'SMOKE PASS');
process.exit(failures.length ? 1 : 0);

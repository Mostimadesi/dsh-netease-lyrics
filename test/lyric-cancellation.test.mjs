import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLyricService } from '../lib/lyric-service.js';

const track = title => ({ title, artist: 'Singer', durationSec: 100 });
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
 let resolve;
 const promise = new Promise(done => { resolve = done; });
 return { promise, resolve };
}
const searchResult = title => ({ ok: true, json: async () => ({ code: 200, result: {
 songs: [{ id: title === 'Alpha' ? 1 : title === 'Beta' ? 2 : 3, name: title, artists: [{ name: 'Singer' }], duration: 100000 }],
} }) });
const lyricResult = { ok: true, json: async () => ({ code: 200, lrc: { lyric: '[00:01.00]line' } }) };
function harness({ holdSearch, holdBody, ...options } = {}) {
 const calls = [], started = deferred(), held = deferred();
 const fetchImpl = async (url, request) => {
  const parsed = new URL(url);
  const search = parsed.pathname.includes('/api/search/get/web');
  assert(search || parsed.pathname === '/api/song/lyric', 'cancelled jobs must never reach another source');
  const normalizedTitle = search ? parsed.searchParams.get('s').replace(/ singer$/i, '').toLowerCase() : '';
  // Canonicalize normalized service queries to the fixture's Alpha/Beta/Gamma names.
  const title = normalizedTitle.replace(/^[a-z]/, first => first.toUpperCase());
  calls.push({ title, url, signal: request.signal, at: Date.now() });
  if (title === 'Alpha' && holdSearch) {
   started.resolve();
   return held.promise; // Deliberately ignore AbortSignal: the service must still progress.
  }
  if (title === 'Alpha' && holdBody) return { ok: true, json: () => { started.resolve(); return held.promise; } };
  return search ? searchResult(title) : lyricResult;
 };
 return { service: createLyricService({ fetchImpl, minRequestGapMs: 0, requestTimeoutMs: 10000, ...options }), calls, started, held };
}
let count = 0;
async function check(name, run) { await run(); count++; console.log('PASS ' + name); }

await check('latestOnly aborts old fetch, skips obsolete queued tracks, preserves same-key deduplication', async () => {
 const h = harness({ latestOnly: true, holdSearch: true });
 try {
  const alpha = h.service.resolve(track('Alpha'));
  const sameAlpha = h.service.resolve(track('Alpha'));
  await h.started.promise;
  const beta = h.service.resolve(track('Beta'));
  await Promise.resolve(); // Enqueue Beta while the aborted Alpha job is still unwinding.
  const gamma = h.service.resolve(track('Gamma'));
  const sameGamma = h.service.resolve(track('Gamma'));
  const [a, sameA, b, g, sameG] = await Promise.all([alpha, sameAlpha, beta, gamma, sameGamma]);
  assert.equal(a.status, 'cancelled'); assert.equal(sameA.status, 'cancelled'); assert.equal(b.status, 'cancelled');
  assert.equal(g.status, 'matched'); assert.equal(sameG.status, 'matched');
  assert(h.calls[0].signal.aborted);
  assert.deepEqual(h.calls.map(row => row.title), ['Alpha', 'Gamma', '']);
  h.held.resolve(searchResult('Alpha'));
  await tick();
  assert.equal(h.service.describe().entries, 1, 'obsolete result must never enter cache');
  assert.equal(h.calls.length, 3, 'obsolete search must not continue into lyrics or another source');
  const retried = await h.service.resolve(track('Alpha'));
  assert.equal(retried.status, 'matched', 'cancellation must not create a negative/error cache');
  assert.equal(h.calls.filter(row => row.title === 'Alpha').length, 2);
 } finally { h.service.dispose(); h.held.resolve(searchResult('Alpha')); }
});

await check('cancellation fences late response-body completion and retains request spacing', async () => {
 const h = harness({ latestOnly: true, holdBody: true, minRequestGapMs: 40 });
 try {
  const alpha = h.service.resolve(track('Alpha'));
  await h.started.promise;
  const beta = h.service.resolve(track('Beta'));
  assert.equal((await alpha).status, 'cancelled');
  assert.equal((await beta).status, 'matched');
  assert(h.calls[0].signal.aborted);
  for (let index = 1; index < h.calls.length; index++) {
   assert(h.calls[index].at - h.calls[index - 1].at >= 35, 'supersession must retain the shared spacing gate');
  }
  h.held.resolve(await searchResult('Alpha').json());
  await tick();
  assert.equal(h.calls.length, 3); assert.equal(h.service.describe().entries, 1);
 } finally { h.service.dispose(); h.held.resolve({ code: 200, result: { songs: [] } }); }
});

await check('cached current track supersedes an active HTTP request', async () => {
 const h = harness({ latestOnly: true, holdSearch: true });
 try {
  await h.service.resolve(track('Gamma'));
  const alpha = h.service.resolve(track('Alpha'));
  await h.started.promise;
  assert.equal((await h.service.resolve(track('Gamma'))).status, 'matched');
  assert.equal((await alpha).status, 'cancelled');
  assert(h.calls.at(-1).signal.aborted);
  assert.equal(h.calls.length, 3);
 } finally { h.service.dispose(); h.held.resolve(searchResult('Alpha')); }
});

await check('cached current track supersedes an aborted spacing wait', async () => {
 const h = harness({ latestOnly: true, holdSearch: true, minRequestGapMs: 300 });
 try {
  await h.service.resolve(track('Gamma'));
  const alpha = h.service.resolve(track('Alpha'));
  await tick(); // Alpha is waiting for the spacing gate after Gamma's lyric request.
  const callsBefore = h.calls.length;
  const cached = await h.service.resolve(track('Gamma'));
  assert.equal(cached.status, 'matched'); assert.equal((await alpha).status, 'cancelled');
  assert.equal(h.calls.length, callsBefore, 'aborted spacing wait must not send a later request');
 } finally { h.service.dispose(); h.held.resolve(searchResult('Alpha')); }
});

await check('default queue remains serial and does not supersede different tracks', async () => {
 const h = harness({ holdSearch: true });
 try {
  const alpha = h.service.resolve(track('Alpha'));
  await h.started.promise;
  const beta = h.service.resolve(track('Beta'));
  await tick();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].signal.aborted, false);
  h.held.resolve(searchResult('Alpha'));
  assert.equal((await alpha).status, 'matched'); assert.equal((await beta).status, 'matched');
  assert.deepEqual(h.calls.map(row => row.title), ['Alpha', '', 'Beta', '']);
 } finally { h.service.dispose(); h.held.resolve(searchResult('Alpha')); }
});

await check('dispose cancels active and queued work, fences late results, and rejects future work', async () => {
 const h = harness({ holdSearch: true });
 const alpha = h.service.resolve(track('Alpha'));
 await h.started.promise;
 const beta = h.service.resolve(track('Beta'));
 await tick();
 h.service.dispose(); h.service.dispose();
 assert.equal((await alpha).status, 'cancelled'); assert.equal((await beta).status, 'cancelled');
 assert(h.calls[0].signal.aborted);
 assert.equal((await h.service.resolve(track('Gamma'))).status, 'cancelled');
 h.held.resolve(searchResult('Alpha'));
 await tick();
 assert.equal(h.calls.length, 1); assert.equal(h.service.describe().entries, 0); assert.equal(h.service.describe().inflight, 0);
});

await check('dispose clears a pending persistence timer', async () => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cancel-persist-'));
 const cacheFile = path.join(dir, 'cache.json');
 const h = harness({ cacheFile });
 try {
  assert.equal((await h.service.resolve(track('Gamma'))).status, 'matched');
  h.service.dispose();
  await new Promise(resolve => setTimeout(resolve, 2200));
  await assert.rejects(fs.stat(cacheFile), { code: 'ENOENT' });
  await assert.rejects(fs.stat(cacheFile + '.tmp'), { code: 'ENOENT' });
 } finally {
  h.service.dispose();
  await fs.unlink(cacheFile).catch(() => {}); await fs.unlink(cacheFile + '.tmp').catch(() => {}); await fs.rmdir(dir);
 }
});

console.log('ALL ' + count + ' LYRIC-CANCELLATION TESTS PASS');

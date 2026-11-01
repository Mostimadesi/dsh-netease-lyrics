import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

let client;
vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load: ({ factory }) => { client = factory(() => ({ default: { createElement() {} } })); } } },
  AbortController,
});
const { createTrackSource, sanitizeLines } = client.__test;
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function harness() {
  const tasks = new Map();
  const requests = [];
  let id = 0;
  const source = createTrackSource({
    schedule(fn, delay) { const token = ++id; tasks.set(token, { fn, delay }); return token; },
    cancel(token) { tasks.delete(token); },
    now: () => 10000,
    request(url, options) { return new Promise((resolve, reject) => requests.push({ url, ...options, resolve, reject })); },
  });
  const reply = (request, payload) => request.resolve({ ok: true, json: async () => payload });
  const fire = delay => {
    const entry = [...tasks].find(([, t]) => t.delay === delay);
    assert.ok(entry, `timer ${delay} exists`);
    tasks.delete(entry[0]); entry[1].fn();
  };
  return { source, tasks, requests, reply, fire };
}
const payload = { active: true, playing: true, title: 'Track', positionSec: 10, durationSec: 120, pollMs: 500 };

test('two mounted consumers share one request loop and the same snapshot', async () => {
  const h = harness(); const a = [], b = [];
  const stopA = h.source.subscribe(s => a.push(s));
  const stopB = h.source.subscribe(s => b.push(s));
  assert.equal(h.requests.length, 1);
  h.reply(h.requests[0], payload); await flush();
  assert.equal(a[0], payload); assert.equal(b[0], payload);
  assert.equal(h.tasks.size, 1, 'only poll timer remains, deadline cleared');
  h.fire(500); assert.equal(h.requests.length, 2);
  stopA(); assert.equal(h.requests[1].signal.aborted, false);
  stopB(); assert.equal(h.requests[1].signal.aborted, true);
  h.reply(h.requests[1], { ...payload, title: 'Late' }); await flush();
  assert.equal(a.length, 1); assert.equal(b.length, 1);
  assert.equal(h.tasks.size, 0, 'no timers after last unmount');
});

test('unsubscribe/remount rejects a late response from the previous mount', async () => {
  const h = harness();
  const stopOld = h.source.subscribe(() => {});
  const old = h.requests[0]; stopOld();
  const seen = [];
  const stopNew = h.source.subscribe(s => seen.push(s.title));
  const current = h.requests[1];
  h.reply(old, { ...payload, title: 'Stale' }); await flush();
  assert.deepEqual(seen, []);
  h.reply(current, { ...payload, title: 'Current' }); await flush();
  assert.deepEqual(seen, ['Current']);
  stopNew(); assert.equal(h.tasks.size, 0);
});

test('network errors retry and request timeout aborts the request', async () => {
  const h = harness(); const stop = h.source.subscribe(() => {});
  h.fire(4000); assert.equal(h.requests[0].signal.aborted, true);
  h.requests[0].reject(new Error('aborted')); await flush();
  h.fire(1000); assert.equal(h.requests.length, 2);
  h.requests[1].reject(new Error('offline')); await flush();
  assert.equal(h.tasks.size, 1);
  stop(); assert.equal(h.tasks.size, 0);
});

test('poll interval is bounded and the loop does not overlap requests', async () => {
  for (const [interval, expected] of [[1, 250], [90000, 5000]]) {
    const h = harness(); const stop = h.source.subscribe(() => {});
    assert.equal(h.tasks.size, 1, 'in-flight request has only a deadline');
    h.reply(h.requests[0], { ...payload, pollMs: interval }); await flush();
    assert.equal([...h.tasks.values()][0].delay, expected);
    stop(); assert.equal(h.tasks.size, 0);
  }
});

test('malformed and unsorted lyric rows are filtered and shared without repeated allocation', () => {
  const raw = [{ t: 2, text: 'two' }, null, { t: 'bad', text: 'invalid' }, { t: 1, text: 'one' }];
  const lines = sanitizeLines(raw);
  assert.equal(JSON.stringify(lines.map(row => row.t)), '[1,2]');
  assert.equal(sanitizeLines(raw), lines);
  assert.equal(raw.length, 4, 'input is not mutated');
});

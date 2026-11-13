/**
 * Per-track lyric offset + failure diagnostics.
 *
 * Both are pure functions exported through `__test`; no React and no DOM. The
 * point of these tests is the CONTRACT, because both features are invisible
 * when they silently break:
 *   - a wrong offset sign shows the wrong line and looks like a lyric bug;
 *   - a wrong diagnostics projection hides the reason a match failed.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

// ── Load the client bundle under the same minimal mocks the sibling tests use ──
const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const storage = new Map()
const listeners = new Map()
const captured = { definition: null }

const context = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  performance,
  URL,
  URLSearchParams,
  AbortController,
  fetch: async () => ({ ok: true, json: async () => ({}) }),
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)) },
    removeItem: (key) => { storage.delete(key) },
  },
  Event: class Event { constructor(type) { this.type = type } },
  window: {
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
    },
    removeEventListener: (type, fn) => { listeners.get(type)?.delete(fn) },
    dispatchEvent: (event) => {
      for (const fn of listeners.get(event.type) || []) fn(event)
      return true
    },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    innerWidth: 1400,
    innerHeight: 900,
    __ModuleLoader__: { load(definition) { captured.definition = definition } },
  },
  document: {
    head: { appendChild() {} },
    querySelector: () => null,
    createElement: () => ({ dataset: {}, style: {}, remove() {}, set textContent(v) {} }),
    body: { appendChild() {} },
    documentElement: { getAttribute: () => 'zh-CN' },
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
  },
}
context.globalThis = context

vm.runInNewContext(source, context, { filename: 'lib/client.js' })

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect() {},
  useRef: (initial) => ({ current: initial }),
  useMemo: (factory) => factory(),
  useCallback: (factory) => factory,
  Component: class { constructor(props) { this.props = props; this.state = {} } setState() {} },
}
const api = captured.definition.factory((name) => {
  assert.equal(name, 'react')
  return React
})
api.apply({ effect: (fn) => fn(), slots: { inject: (n, cb) => cb(), register: () => () => {} } })

const T = api.__test

let pass = 0
const check = (name, cond, detail) => {
  assert.ok(cond, name + (detail === undefined ? '' : ' — ' + detail))
  pass += 1
  console.log('PASS ' + name)
}

// ── 1. clampOffsetMs ──────────────────────────────────────────────────────
check('clamp: 0 passes through', T.clampOffsetMs(0) === 0)
check('clamp: positive value kept', T.clampOffsetMs(1200) === 1200)
check('clamp: negative value kept', T.clampOffsetMs(-800) === -800)
check('clamp: rounds fractional ms', T.clampOffsetMs(100.6) === 101)
check('clamp: NaN becomes 0', T.clampOffsetMs('nope') === 0)
check('clamp: undefined becomes 0', T.clampOffsetMs(undefined) === 0)
check('clamp: clamps at +30s', T.clampOffsetMs(999999) === T.OFFSET_LIMIT_MS)
check('clamp: clamps at −30s', T.clampOffsetMs(-999999) === -T.OFFSET_LIMIT_MS)

// ── 2. offsetKeyOf ────────────────────────────────────────────────────────
const keyA = T.offsetKeyOf({ title: '晴天', artist: '周杰伦', durationSec: 269 })
check('key: stable for the same input', keyA === T.offsetKeyOf({ title: '晴天', artist: '周杰伦', durationSec: 269 }))
check('key: duration dither under 0.5s is the same key',
  T.offsetKeyOf({ title: '晴天', artist: '周杰伦', durationSec: 269.4 }) === keyA)
check('key: live version does NOT share the studio key',
  T.offsetKeyOf({ title: '晴天 (Live)', artist: '周杰伦', durationSec: 269 }) !== keyA)
check('key: case and spacing are normalized',
  T.offsetKeyOf({ title: '  HELLO ', artist: 'Adele', durationSec: 295 })
  === T.offsetKeyOf({ title: 'hello', artist: 'adele', durationSec: 295 }))
check('key: missing title yields the empty key (no storage)', T.offsetKeyOf({ title: '', artist: 'x' }) === '')
check('key: null track yields the empty key', T.offsetKeyOf(null) === '')
check('key: different durations differ', T.offsetKeyOf({ title: 'Hello', artist: 'Adele', durationSec: 295 })
  !== T.offsetKeyOf({ title: 'Hello', artist: 'Adele', durationSec: 400 }))

// ── 3. offsetPosition: the SIGN CONVENTION is the whole feature ───────────
check('pos: zero offset is identity', T.offsetPosition(60, 0) === 60)
// "歌词偏晚" → positive ms → look up an EARLIER position → line advances.
check('pos: +0.5s looks up 0.5s earlier', T.offsetPosition(60, 500) === 59.5)
// "歌词偏早" → negative ms → look up a LATER position → line delays.
check('pos: −0.5s looks up 0.5s later', T.offsetPosition(60, -500) === 60.5)
check('pos: a large positive offset cannot go below 0', T.offsetPosition(2, 5000) === 0)
check('pos: NaN position is treated as 0', T.offsetPosition(undefined, 500) === 0)
check('pos: offset is clamped before use', T.offsetPosition(100, 999999) === 100 - T.OFFSET_LIMIT_MS / 1000)

// The real regression this guards: applying the sign backwards would make the
// capsule show the NEXT line when the user is telling it the lyrics run ahead.
{
  const lines = [{ t: 0, text: 'a' }, { t: 10, text: 'b' }, { t: 20, text: 'c' }]
  const at = (pos, ms) => lines[T.currentLineIndex(lines, T.offsetPosition(pos, ms))].text
  // "歌词太快了" → positive → look up earlier → at t=21 the caption falls back
  // to the PREVIOUS line instead of running ahead to the next one.
  check('integration: +ms shows an EARLIER line than the raw position', at(21, 1500) === 'b',
    'expected b (delayed), got ' + at(21, 1500))
  check('integration: −ms shows a LATER line than the raw position',
    at(9, 0) === 'a' && at(9, -1200) === 'b' && at(19, -1200) === 'c',
    'raw a → −1.2s wants b, got ' + at(9, -1200) + '; at 19 got ' + at(19, -1200))
  check('integration: zero offset is the raw index', at(21, 0) === 'c', 'expected c')
  check('integration: +ms at a line start does not skip ahead', at(10, 1000) === 'a', 'expected a')
}

// ── 4. formatOffsetMs ─────────────────────────────────────────────────────
check('format: 0 reads 未校准', T.formatOffsetMs(0) === '未校准')
check('format: +500ms', T.formatOffsetMs(500) === '+0.5s', T.formatOffsetMs(500))
check('format: −500ms uses a real minus sign', T.formatOffsetMs(-500) === '\u22120.5s', T.formatOffsetMs(-500))
check('format: −1000ms has no trailing .00', T.formatOffsetMs(-1000) === '\u22121s', T.formatOffsetMs(-1000))
check('format: 1.2s', T.formatOffsetMs(1200) === '+1.2s', T.formatOffsetMs(1200))
check('format: 250ms keeps two decimals', T.formatOffsetMs(250) === '+0.25s', T.formatOffsetMs(250))

// ── 5. readOffsets / writeOffsets round-trip + hardening ──────────────────
storage.clear()
check('store: empty storage reads as an empty map', Object.keys(T.readOffsets()).length === 0)
check('store: write returns true', T.writeOffsets({ 'a|b|1': 500 }) === true)
check('store: round-trip keeps the value', T.readOffsets()['a|b|1'] === 500)
check('store: zero is not persisted', (() => {
  T.writeOffsets({ 'a|b|1': 500, 'c|d|2': 0 })
  return T.readOffsets()['c|d|2'] === undefined
})())
check('store: out-of-range values are clamped on write',
  (() => { T.writeOffsets({ 'e|f|3': 999999 }); return T.readOffsets()['e|f|3'] === T.OFFSET_LIMIT_MS })())
check('store: garbage in storage is ignored, not thrown', (() => {
  storage.set(T.OFFSET_KEY, '{"k":"nope","ok":-250,"bad":null}')
  const read = T.readOffsets()
  return read.k === undefined && read.ok === -250 && read.bad === undefined
})())
check('store: a non-object payload is ignored', (() => {
  storage.set(T.OFFSET_KEY, '[1,2,3]')
  return Object.keys(T.readOffsets()).length === 0
})())
check('store: entries are capped', (() => {
  const many = {}
  for (let i = 0; i < T.OFFSET_MAX_ENTRIES + 40; i += 1) many['k' + i + '|x|' + i] = 100
  T.writeOffsets(many)
  return Object.keys(T.readOffsets()).length === T.OFFSET_MAX_ENTRIES
})())

// ── 6. describeAttempt mapping ────────────────────────────────────────────
const att = (row) => T.describeAttempt(row)
check('attempt: matched row', (() => {
  const d = att({ source: 'netease', status: 'matched' })
  return d.state === 'matched' && d.label === '网易云' && d.detail === '命中'
})())
check('attempt: unmatched maps the known reason to prose', (() => {
  const d = att({ source: 'qq', status: 'unmatched', reason: 'no-confident-match' })
  return d.state === 'missed' && /没有可信匹配/.test(d.detail)
})())
check('attempt: timestamped-less lyric reason', (() => {
  const d = att({ source: 'kugou', status: 'unmatched', reason: 'no-timed-lyrics' })
  return /时间轴/.test(d.detail)
})())
check('attempt: an error keeps the raw reason verbatim', (() => {
  const d = att({ source: 'migu', status: 'error', reason: 'API status 500' })
  return d.state === 'error' && d.detail.includes('API status 500')
})())
check('attempt: an unknown reason is shown, not swallowed', (() => {
  const d = att({ source: 'local', status: 'unmatched', reason: 'some-new-code' })
  return d.detail === 'some-new-code'
})())
check('attempt: an unknown source still gets a row', (() => {
  const d = att({ source: 'newapi', status: 'matched' })
  return d.label === 'newapi' && d.state === 'matched'
})())
check('attempt: a malformed row does not throw', (() => {
  const d = att(null)
  return d.state === 'missed' && d.label === '未知来源'
})())

// ── 7. describeDiagnostics ────────────────────────────────────────────────
const service = { policy: 'bilibili-subtitle (bvid) > netease > qq > kugou > migu > local-file', entries: 299 }

check('diag: idle/loading payloads produce nothing', (() => {
  return T.describeDiagnostics({ status: 'idle' }, service, null) === null
    && T.describeDiagnostics({ status: 'loading' }, service, null) === null
    && T.describeDiagnostics(null, service, null) === null
})())

{
  const diag = T.describeDiagnostics({
    status: 'matched', source: 'qq', sourceLabel: 'QQ 音乐', fallbackUsed: true, score: 9,
    attempts: [{ source: 'netease', status: 'unmatched', reason: 'no-confident-match' }, { source: 'qq', status: 'matched' }],
  }, service, { delayMs: 15000, maxAutoRetries: 2, attempts: 0, pending: false })
  check('diag: matched exposes the winner', diag.winner.label === 'QQ 音乐', JSON.stringify(diag.winner))
  check('diag: matched counts the failed sources before the winner', diag.failed === 1, String(diag.failed))
  check('diag: matched marks fallbackUsed', diag.fallbackUsed === true)
  check('diag: matched keeps the score', diag.score === 9)
  check('diag: matched carries the policy through', diag.policy === service.policy)
  check('diag: matched hides the retry budget (noise on success)', diag.retry === null)
  check('diag: matched surfaces the cache size', diag.cacheEntries === 299)
  check('diag: headline names the source and the misses',
    T.diagnosticsHeadline(diag) === 'QQ 音乐歌词（前 1 个源未命中）', T.diagnosticsHeadline(diag))
}

{
  const diag = T.describeDiagnostics({
    status: 'unmatched',
    attempts: [
      { source: 'netease', status: 'unmatched', reason: 'no-confident-match' },
      { source: 'qq', status: 'error', reason: 'HTTP 502' },
      { source: 'kugou', status: 'unmatched', reason: 'no-timed-lyrics' },
      { source: 'local', status: 'unmatched', reason: 'no-search-dirs' },
    ],
  }, service, { delayMs: 15000, maxAutoRetries: 2, attempts: 1, pending: true })
  check('diag: unmatched has no winner', diag.winner === null)
  check('diag: unmatched counts every failed row', diag.failed === 4, String(diag.failed))
  check('diag: unmatched keeps the retry budget', diag.retry !== null && diag.retry.attempts === 1 && diag.retry.pending === true)
  check('diag: unmatched headline counts the request failures',
    T.diagnosticsHeadline(diag) === '4 个来源均未命中，其中 1 个请求失败', T.diagnosticsHeadline(diag))
}

{
  const diag = T.describeDiagnostics({
    status: 'error', message: 'network down',
    attempts: [{ source: 'netease', status: 'error', reason: 'network down' }],
  }, null, null)
  check('diag: error status is preserved', diag.status === 'error')
  check('diag: a missing service description degrades to empty policy', diag.policy === '')
  check('diag: a missing service leaves cacheEntries null', diag.cacheEntries === null)
  check('diag: error retry is null when the host did not report one', diag.retry === null)
}

check('diag: a matched payload with no attempts[] still renders', (() => {
  const diag = T.describeDiagnostics({ status: 'matched', source: 'migu', sourceLabel: '咪咕音乐' }, service, null)
  return diag !== null && diag.winner.label === '咪咕音乐' && diag.rows.length === 0
})())
check('diag: rows AFTER the winner count as skipped, not failed', (() => {
  const diag = T.describeDiagnostics({
    status: 'matched', source: 'qq', sourceLabel: 'QQ 音乐',
    attempts: [{ source: 'netease', status: 'unmatched' }, { source: 'qq', status: 'matched' }, { source: 'kugou', status: 'unmatched' }],
  }, service, null)
  return diag.failed === 1 && diag.skipped === 1
})())
check('diag: no attempts and no match says so', (() => {
  const diag = T.describeDiagnostics({ status: 'unmatched', attempts: [] }, service, null)
  return T.diagnosticsHeadline(diag) === '未匹配到歌词'
})())

// ── 8. The REASON_LABELS table must stay in sync with the host ────────────
{
  const hostSource = fs.readFileSync(new URL('../lib/lyric-service.js', import.meta.url), 'utf8')
  const emitted = new Set()
  for (const match of hostSource.matchAll(/reason:\s*'([a-z-]+)'/g)) emitted.add(match[1])
  for (const match of hostSource.matchAll(/local\.reason \|\| '([a-z-]+)'/g)) emitted.add(match[1])
  // The local scanner reports through `reason:` strings of its own.
  const localSource = fs.readFileSync(new URL('../lib/local-lyrics.js', import.meta.url), 'utf8')
  for (const match of localSource.matchAll(/reason:\s*'([a-z-]+)'/g)) emitted.add(match[1])
  const known = new Set(Object.keys(T.REASON_LABELS))
  const missing = [...emitted].filter((code) => !known.has(code))
  check('labels: every reason the host can emit has a human label', missing.length === 0,
    'missing: ' + missing.join(', '))
}

console.log('ALL ' + pass + ' OFFSET/DIAGNOSTICS TESTS PASS')

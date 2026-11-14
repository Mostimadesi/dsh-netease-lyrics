/**
 * Sweep driver audit (v0.4.46): the word-level fill is written by a rAF loop
 * onto the active row's .dnl-line-sweep node, because React only re-renders on
 * the 250 ms interpolation tick (4 fps stutter, user m04063).
 *
 * diagnostics-render.test.mjs renders with a no-op useEffect, so only the
 * React-render path is covered there. This file runs the REAL effects with a
 * runnable React shim, a fake DOM (className/querySelector/style.setProperty)
 * and a manual rAF pump, and asserts:
 *   1. the driver writes --dnl-sweep every frame while a word line is active
 *      and playing;
 *   2. plain lyrics (no word timeline) never start the loop;
 *   3. pausing cancels the loop — no further writes after the cleanup ran.
 */

import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

const store = new Map()
let hookIndex = 0
let effectIndex = 0
let states = []
let refs = []
let effectQueue = []
let dirty = false
let snapshot = null
const lastDeps = new Map()
const cleanups = new Map()

/** Minimal DOM facade: enough for className/querySelector/style.setProperty. */
const styleWrites = [] // {node, prop, value} — every setProperty on any fake node
function fakeEl(vnode) {
  const props = vnode && typeof vnode === 'object' ? (vnode.props || {}) : {}
  const el = {
    className: String(props.className || ''),
    style: { vars: {}, setProperty(k, v) { this.vars[k] = String(v); styleWrites.push({ node: el, prop: k, value: String(v) }) } },
    children: [],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 40, right: 320, bottom: 40 }),
    querySelector(sel) {
      const want = sel.replace(/^\./, '')
      const dfs = (node) => {
        for (const child of node.children) {
          if (child.className.split(/\s+/).includes(want)) return child
          const hit = dfs(child)
          if (hit) return hit
        }
        return null
      }
      return dfs(el)
    },
  }
  if (Array.isArray(vnode && vnode.children)) {
    for (const child of vnode.children) {
      if (child && typeof child === 'object' && child.type) el.children.push(fakeEl(child))
    }
  }
  return el
}

const React = {
  createElement: (type, props, ...children) => {
    const vnode = { type, props: props || {}, children: children.flat() }
    if (props && props.ref && typeof props.ref === 'object') props.ref.current = fakeEl(vnode)
    return vnode
  },
  useState: (initial) => {
    const i = hookIndex++
    if (states[i] === undefined) states[i] = typeof initial === 'function' ? initial() : initial
    return [i === 1 && snapshot ? snapshot : states[i], (value) => {
      states[i] = typeof value === 'function' ? value(states[i]) : value
      dirty = true
    }]
  },
  useEffect: (fn, deps) => { effectQueue.push({ fn, deps, id: effectIndex++ }) },
  useRef: () => { const i = hookIndex++; if (!refs[i]) refs[i] = { current: null }; return refs[i] },
}

const rafQueue = []
let rafSeq = 0
const rafCancelled = new Set()
const timers = [] // recorded, never fired: keeps polled loops from running away

let plugin
// Declared BEFORE apply: register() fires synchronously inside apply, and a
// later `const` would be in its temporal dead zone at that moment.
const entries = new Map()
const ISLAND = 'dsh-netease-lyrics-island'
const ctx = {
  window: {
    __ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => ({ default: React })) } },
    dispatchEvent() {}, addEventListener() {}, removeEventListener() {},
  },
  localStorage: {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
  },
  Event: class {},
  document: undefined,
  AbortController,
  AbortSignal,
  console,
  setTimeout: (fn) => { timers.push(fn); return timers.length },
  clearTimeout() {},
  setInterval: (fn) => { timers.push(fn); return timers.length },
  clearInterval() {},
  fetch: async () => ({ ok: true, json: async () => ({}) }),
  AbortSignal: { timeout: () => undefined },
  performance,
  requestAnimationFrame: (fn) => { const id = ++rafSeq; rafQueue.push({ id, fn }); return id },
  cancelAnimationFrame: (id) => { rafCancelled.add(id) },
}
ctx.globalThis = ctx
// Deterministic wall clock for the vm realm: the context auto-creates its own
// Date, and a HOST-level Date.now monkeypatch never reaches it. Shim the
// sandbox Date BEFORE the plugin loads; pump() advances sandboxNowMs by one
// frame (~16 ms) per rAF callback so the sweep value moves every frame.
let sandboxNowMs = Date.now()
ctx.Date = { now: () => sandboxNowMs }
vm.runInNewContext(source, ctx, { filename: 'lib/client.js' })

plugin.apply({
  effect(factory) { factory() },
  slots: {
    inject(name, callback) { callback() },
    register(options, component) {
      entries.set(options.key || options.id || options.name, component)
      return () => {}
    },
  },
})

function renderOnce() {
  hookIndex = 0
  effectIndex = 0
  dirty = false
  let out = entries.get(ISLAND)()
  let guard = 0
  while (dirty && guard++ < 20) { hookIndex = 0; effectIndex = 0; dirty = false; out = entries.get(ISLAND)() }
  return out
}

function runEffects() {
  const queue = effectQueue
  effectQueue = []
  for (const { fn, deps, id } of queue) {
    const prev = lastDeps.get(id)
    const changed = prev === undefined || deps === undefined
      || deps.length !== prev.length
      || deps.some((d, i) => d !== prev[i])
    if (!changed) continue
    const cleanup = cleanups.get(id)
    if (typeof cleanup === 'function') cleanup()
    lastDeps.set(id, deps)
    cleanups.set(id, fn() || null)
  }
}

function mount() {
  hookIndex = 0; effectIndex = 0; states = []; refs = []
  effectQueue = []; lastDeps.clear(); cleanups.clear(); dirty = false
  return renderOnce()
}

/** Render + settle effects, bounded (effects may setState → re-render). */
function renderSettled() {
  for (let round = 0; round < 5; round++) {
    renderOnceLite()
    runEffects()
    if (!dirty) break
  }
}
function renderOnceLite() {
  hookIndex = 0; effectIndex = 0; dirty = false
  let out = entries.get(ISLAND)()
  let guard = 0
  while (dirty && guard++ < 20) { hookIndex = 0; effectIndex = 0; dirty = false; out = entries.get(ISLAND)() }
  return out
}

/** Run every pending rAF callback (the driver re-schedules each frame). */
function pump(frames) {
  for (let i = 0; i < frames; i++) {
    const pending = rafQueue.splice(0)
    for (const { id, fn } of pending) {
      if (!rafCancelled.has(id)) {
        fn()
        sandboxNowMs += 16 // one frame of wall time for the vm-realm Date.now
      }
    }
  }
}

function setPosition(payload) {
  plugin.__test.trackSource.clock.update(payload, Date.now())
}

function sweepVars(root) {
  const found = []
  const dfs = (node) => {
    if (!node || typeof node !== 'object') return
    if (String(node.className || '').split(/\s+/).includes('dnl-line-sweep')) found.push(node)
    for (const child of node.children || []) dfs(child)
  }
  dfs(root)
  return found
}

/** The driver writes to the ref'd ACTIVE ROW DOM (via querySelector for its
 * .dnl-line-sweep child) — not to the vnode tree, so observation goes through
 * styleWrites, not through sweepVars over vnodes. */
function sweepWrites() {
  return styleWrites.filter(w => w.prop === '--dnl-sweep')
}

const results = []
function check(name, fn) {
  try {
    const note = fn()
    results.push({ name, ok: true, note: note || '' })
  } catch (err) {
    results.push({ name, ok: false, note: err.message })
  }
}

const BASE = {
  active: true, playing: true, title: '晴天', artist: '周杰伦', album: '叶惠美',
  durationSec: 253, positionSec: 12, rate: 1,
  canToggle: true, canNext: true, canPrev: true, canSeek: true,
  coverSerial: 3, positionEstimated: false, timelineRefreshes: 0,
  lyric: { status: 'matched', source: 'netease', sourceLabel: '网易云', songId: 7,
    songName: '晴天', artistNames: ['周杰伦'], score: 9,
    lines: [
      { t: 10, text: '第一句', words: [{ t: 10, end: 11, text: '第一' }, { t: 11, end: 13, text: '句' }] },
      { t: 20, text: '第二句' },
    ] },
}

check('the sweep driver writes --dnl-sweep every frame while playing', () => {
  store.clear()
  rafQueue.length = 0; rafCancelled.clear(); styleWrites.length = 0
  snapshot = { ...BASE }
  setPosition({ app: 'x', title: '晴天', artist: '周杰伦', album: 'a', positionSec: 12, durationSec: 253, playing: true, active: true, rate: 1 })
  mount()
  renderSettled()
  pump(3)
  const writes = sweepWrites()
  if (writes.length === 0) throw new Error('the driver never wrote --dnl-sweep')
  const pct = parseFloat(writes[0].value)
  if (!(pct > 40 && pct < 90)) throw new Error('implausible driven sweep ' + writes[0].value)
  // The value MOVES between frames: pos advances ~16 ms per frame, and at
  // word granularity [{10,11},{11,13}] the fill advances every frame.
  const values = writes.map(w => w.value)
  if (new Set(values).size < 2) throw new Error('sweep did not advance between frames: ' + values.join(','))
  return 'driver wrote ' + values.length + ' frames, advancing: ' + values.slice(0, 3).join(' → ')
})

check('plain lyrics (no word timeline) never start the driver', () => {
  store.clear()
  rafQueue.length = 0; rafCancelled.clear(); styleWrites.length = 0
  snapshot = { ...BASE, lyric: { ...BASE.lyric, lines: [{ t: 10, text: '无词级' }, { t: 20, text: '第二句' }] } }
  setPosition({ app: 'x', title: '晴天', artist: '周杰伦', album: 'a', positionSec: 12, durationSec: 253, playing: true, active: true, rate: 1 })
  mount()
  renderSettled()
  const els = sweepVars(entries.get(ISLAND)())
  if (els.length !== 0) throw new Error('a plain line got the sweep class')
  if (sweepWrites().length !== 0) throw new Error('driver wrote --dnl-sweep for a plain lyric')
  return 'no sweep class, no driver writes'
})

check('pausing cancels the driver: no writes after cleanup', () => {
  store.clear()
  rafQueue.length = 0; rafCancelled.clear(); styleWrites.length = 0
  snapshot = { ...BASE }
  setPosition({ app: 'x', title: '晴天', artist: '周杰伦', album: 'a', positionSec: 12, durationSec: 253, playing: true, active: true, rate: 1 })
  mount()
  renderSettled()
  pump(2)
  const before = sweepWrites().length
  if (before === 0) throw new Error('driver never wrote before the pause')
  // Pause: playing=false → sweepLineKey '' → effect cleanup must cancel the
  // pending frame so the loop stops.
  snapshot = { ...BASE, playing: false }
  setPosition({ app: 'x', title: '晴天', artist: '周杰伦', album: 'a', positionSec: 12, durationSec: 253, playing: false, active: true, rate: 1 })
  renderSettled()
  pump(3)
  if (sweepWrites().length !== before) {
    throw new Error('driver kept writing after pause: ' + before + ' → ' + sweepWrites().length + ' writes')
  }
  return 'no writes after pause (' + before + ' pre-pause frames)'
})

let failed = 0
for (const r of results) {
  if (!r.ok) failed += 1
  console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.note ? '  [' + r.note + ']' : ''))
}
console.log('')
if (failed > 0) {
  console.log(failed + ' SWEEP DRIVER CHECK(S) FAILED')
  process.exitCode = 1
} else {
  console.log('ALL ' + results.length + ' SWEEP DRIVER CHECKS PASS')
}

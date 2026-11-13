/**
 * Render audit for the two NEW interfaces (v0.4.27): the per-track offset control
 * and the "why" diagnostics panel.
 *
 * The point is not pixel output — it is that these surfaces exist, are reachable,
 * render the right numbers, and CANNOT crash the capsule on hostile input. The
 * capsule-vanished bug lived in a branch exactly like these.
 */

import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

const store = new Map()
const entries = new Map()
let hookIndex = 0
let states = []
let refs = []
let dirty = false
let snapshot = null

const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
  useState: (initial) => {
    const i = hookIndex++
    if (states[i] === undefined) states[i] = typeof initial === 'function' ? initial() : initial
    return [i === 1 && snapshot ? snapshot : states[i], (value) => {
      states[i] = typeof value === 'function' ? value(states[i]) : value
      dirty = true
    }]
  },
  useEffect() {},
  useRef: () => { const i = hookIndex++; if (!refs[i]) refs[i] = { current: null }; return refs[i] },
}

let plugin
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
  console,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: id => clearTimeout(id),
  fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
  AbortSignal: { timeout: () => undefined },
  performance,
}
ctx.globalThis = ctx
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

const ISLAND = 'dsh-netease-lyrics-island'

function render(id) {
  hookIndex = 0
  dirty = false
  let out = entries.get(id)()
  let guard = 0
  while (dirty && guard++ < 20) { hookIndex = 0; dirty = false; out = entries.get(id)() }
  return out
}
function mount(id) {
  hookIndex = 0; states = []; refs = []; dirty = false
  return render(id)
}
function walk(root) {
  if (!root || typeof root !== 'object') return []
  if (Array.isArray(root)) return root.flatMap(walk)
  if (typeof root.type === 'function') return walk(root.type({ ...root.props, children: root.children }))
  return [root, ...(root.children || []).flatMap(walk)]
}
function expand() {
  let tree = mount(ISLAND)
  walk(tree).find(n => String(n.props.className || '').startsWith('dnl-island')).props.onMouseEnter()
  return render(ISLAND)
}

/** Feed the REAL playback clock, which the render harness otherwise leaves at 0. */
function setPosition(payload) {
  plugin.__test.trackSource.clock.update(payload, Date.now())
}
function openSettings() {
  let tree = expand()
  walk(tree).find(n => String(n.props.className || '').includes('dnl-gear')).props.onClick({ stopPropagation() {} })
  return render(ISLAND)
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
    lines: [{ t: 0, text: '故事的小黄花', trans: 'the little yellow flower' }, { t: 5, text: '从出生那年就飘着' }] },
}

// ── offset control ─────────────────────────────────────────────────────────
check('the settings view shows the per-track offset block', () => {
  store.clear()
  snapshot = { ...BASE }
  const nodes = walk(openSettings())
  const note = nodes.find(n => String(n.props.className || '').includes('dnl-offset-value'))
  if (!note) throw new Error('no offset value in the settings view')
  if (note.children[0] !== '未校准') throw new Error('offset should start uncalibrated, got ' + note.children[0])
  const buttons = nodes.filter(n => String(n.props.className || '') === 'dnl-set-btn'
    && /^[+−]\d/.test(String((n.children || [])[0] || '')))
  if (buttons.length !== 4) throw new Error('expected 4 step buttons, got ' + buttons.length)
  return 'uncalibrated + 4 steps'
})

check('a step writes the offset for THIS track only', () => {
  store.clear()
  snapshot = { ...BASE }
  let nodes = walk(openSettings())
  const plus = nodes.find(n => String(n.props.className || '') === 'dnl-set-btn' && (n.children || [])[0] === '+0.5s')
  plus.props.onClick({ stopPropagation() {} })
  nodes = walk(render(ISLAND))
  const note = nodes.find(n => String(n.props.className || '').includes('dnl-offset-value'))
  if (note.children[0] !== '+0.5s') throw new Error('offset label did not update: ' + note.children[0])
  const saved = JSON.parse(store.get('dsh.netease-lyrics.offsets.v1') || '{}')
  const keys = Object.keys(saved)
  if (keys.length !== 1) throw new Error('expected exactly one stored key, got ' + keys.length)
  if (!keys[0].startsWith('晴天|周杰伦|253')) throw new Error('unexpected key: ' + keys[0])
  if (saved[keys[0]] !== 500) throw new Error('wrong value ' + saved[keys[0]])
  return 'persisted 晴天|周杰伦|253 = 500'
})

check('switching tracks does not carry the offset over', () => {
  store.clear()
  snapshot = { ...BASE }
  let nodes = walk(openSettings())
  nodes.find(n => String(n.props.className || '') === 'dnl-set-btn' && (n.children || [])[0] === '+0.5s')
    .props.onClick({ stopPropagation() {} })
  // A different song: 1500ms apart and another title/artist.
  snapshot = { ...BASE, title: '七里香', artist: '周杰伦', durationSec: 299 }
  nodes = walk(render(ISLAND))
  const note = nodes.find(n => String(n.props.className || '').includes('dnl-offset-value'))
  if (note.children[0] !== '未校准') throw new Error('offset leaked to another track: ' + note.children[0])
  return 'per-track isolation holds'
})

check('the reset button clears the stored offset', () => {
  store.clear()
  snapshot = { ...BASE }
  let nodes = walk(openSettings())
  nodes.find(n => String(n.props.className || '') === 'dnl-set-btn' && (n.children || [])[0] === '−0.5s')
    .props.onClick({ stopPropagation() {} })
  store.set('dsh.netease-lyrics.offsets.v1', JSON.stringify({ ['晴天|周杰伦|253']: -500 }))
  nodes = walk(render(ISLAND))
  const reset = nodes.find(n => String(n.props.className || '') === 'dnl-set-btn' && (n.children || [])[0] === '归零')
  reset.props.onClick({ stopPropagation() {} })
  const saved = JSON.parse(store.get('dsh.netease-lyrics.offsets.v1') || '{}')
  if (Object.keys(saved).length !== 0) throw new Error('offset was not cleared: ' + JSON.stringify(saved))
  return 'cleared'
})

check('no track identity → the offset buttons are disabled, not broken', () => {
  store.clear()
  snapshot = { ...BASE, title: '', artist: '' }
  const nodes = walk(openSettings())
  const buttons = nodes.filter(n => String(n.props.className || '') === 'dnl-set-btn'
    && /^(\+0\.5s|\+0\.1s|−0\.1s|−0\.5s)$/.test(String((n.children || [])[0] || '')))
  if (buttons.length !== 4) throw new Error('buttons missing entirely')
  if (!buttons.every(b => b.props.disabled === true)) throw new Error('steps are clickable without a track key')
  return 'disabled'
})

// Regression (reported live 2026-11-11): every step button looked hovered and
// the FIRST one (-0.5s) stayed lit. Cause was markup, not CSS: the row was a
// <label> holding five buttons, and HTML lets a label own exactly ONE labeled
// control — its first labelable descendant. Clicking the row's caption, its
// value, or the gaps between buttons then synthesised a click on "-0.5s", which
// also kept DOM focus afterwards.
check('the offset row is NOT a <label> (a label would own button #1)', () => {
  store.clear()
  snapshot = { ...BASE }
  const nodes = walk(openSettings())
  const stepButtons = nodes.filter(n => String(n.props.className || '') === 'dnl-set-btn'
    && /^[+−]\d/.test(String((n.children || [])[0] || '')))
  if (stepButtons.length === 0) throw new Error('no step buttons found')
  // Walk the tree and check no <label> ancestor contains a step button.
  const offenders = []
  const visit = (node, insideLabel) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const child of node) visit(child, insideLabel); return }
    const isLabel = node.type === 'label'
    if (insideLabel && stepButtons.includes(node)) offenders.push(node)
    for (const child of node.children || []) visit(child, insideLabel || isLabel)
  }
  for (const root of entries.values()) visit(root, false)
  if (offenders.length > 0) throw new Error(offenders.length + ' step button(s) sit inside a <label>')
  return stepButtons.length + ' buttons, none inside a label'
})

check('each step button carries an explicit aria-label and its own delta', () => {
  store.clear()
  snapshot = { ...BASE }
  const nodes = walk(openSettings())
  const steps = nodes.filter(n => String(n.props.className || '') === 'dnl-set-btn'
    && /^[+−]\d/.test(String((n.children || [])[0] || '')))
  if (steps.length !== 4) throw new Error('expected 4 steps, got ' + steps.length)
  for (const step of steps) {
    const label = String(step.props['aria-label'] || '')
    if (!label.includes('歌词偏移')) throw new Error('step lacks a descriptive aria-label: ' + label)
  }
  // Applying one step moves by ITS OWN delta only (no synthesised extra click).
  store.clear()
  const plus500 = steps.find(n => (n.children || [])[0] === '+0.5s')
  plus500.props.onClick({ stopPropagation() {} })
  const saved = JSON.parse(store.get('dsh.netease-lyrics.offsets.v1') || '{}')
  const value = Object.values(saved)[0]
  if (value !== 500) throw new Error('one click produced ' + value + 'ms, expected exactly 500')
  return 'one click = +500ms'
})

// ── diagnostics panel ──────────────────────────────────────────────────────
const FAILED = {
  ...BASE,
  lyric: {
    status: 'unmatched',
    attempts: [
      { source: 'netease', status: 'unmatched', reason: 'no-confident-match' },
      { source: 'qq', status: 'error', reason: 'HTTP 502' },
      { source: 'kugou', status: 'unmatched', reason: 'no-timed-lyrics' },
      { source: 'local', status: 'unmatched', reason: 'no-search-dirs' },
    ],
  },
  service: { policy: 'bilibili-subtitle (bvid) > netease > qq > kugou > migu > local-file', entries: 299 },
  retry: { delayMs: 15000, maxAutoRetries: 2, attempts: 1, pending: false },
}

check('a failed match explains itself instead of the old hard-coded sentence', () => {
  snapshot = FAILED
  const nodes = walk(expand())
  const match = nodes.find(n => String(n.props.className || '').includes('dnl-match'))
  const text = JSON.stringify(match.children)
  if (text.includes('网易云和 QQ 均未找到')) throw new Error('the stale hard-coded sentence is still there')
  if (!text.includes('4 个来源均未命中')) throw new Error('no real summary: ' + text)
  if (!text.includes('其中 1 个请求失败')) throw new Error('request failures are not counted: ' + text)
  return 'real summary from attempts[]'
})

check('the "匹配结果" button opens a per-source list with reasons', () => {
  snapshot = FAILED
  let nodes = walk(expand())
  const why = nodes.find(n => String(n.props.className || '').includes('dnl-btn-quiet'))
  if (!why) throw new Error('no diagnostics toggle')
  if (why.props['aria-expanded'] !== 'false') throw new Error('diagnostics start expanded')
  why.props.onClick({ stopPropagation() {} })
  nodes = walk(render(ISLAND))
  const panel = nodes.find(n => String(n.props.className || '') === 'dnl-diag')
  if (!panel) throw new Error('panel did not open')
  const rows = nodes.filter(n => String(n.props.className || '').includes('dnl-diag-row'))
  if (rows.length !== 4) throw new Error('expected 4 source rows, got ' + rows.length)
  const detail = JSON.stringify(rows.map(r => r.children))
  for (const needle of ['没有可信匹配', 'HTTP 502', '时间轴', '搜索目录']) {
    if (!detail.includes(needle)) throw new Error('missing reason for ' + needle + ': ' + detail)
  }
  if (!detail.includes('QQ 音乐')) throw new Error('sources are not labelled')
  return '4 rows with human reasons'
})

check('the diagnostics panel shows the policy, retry budget and cache size', () => {
  snapshot = FAILED
  let nodes = walk(expand())
  nodes.find(n => String(n.props.className || '').includes('dnl-btn-quiet')).props.onClick({ stopPropagation() {} })
  nodes = walk(render(ISLAND))
  const notes = nodes.filter(n => String(n.props.className || '') === 'dnl-diag-note').map(n => JSON.stringify(n.children))
  const joined = notes.join(' ')
  if (!joined.includes('bilibili-subtitle')) throw new Error('policy missing: ' + joined)
  if (!joined.includes('1/2')) throw new Error('retry budget missing: ' + joined)
  if (!joined.includes('299')) throw new Error('cache size missing: ' + joined)
  return 'policy + retry + cache'
})

check('a healthy match renders no diagnostics until asked', () => {
  snapshot = {
    ...BASE,
    lyric: { ...BASE.lyric, attempts: [{ source: 'netease', status: 'matched' }] },
    service: { policy: 'netease > qq', entries: 3 },
    retry: { delayMs: 15000, maxAutoRetries: 2, attempts: 0, pending: false },
  }
  const nodes = walk(expand())
  if (nodes.some(n => String(n.props.className || '') === 'dnl-diag')) throw new Error('diagnostics auto-opened on success')
  const why = nodes.find(n => String(n.props.className || '').includes('dnl-btn-quiet'))
  if (!why) throw new Error('no way to inspect a successful match')
  // The success case must not spend rows on a retry budget nobody is waiting on.
  why.props.onClick({ stopPropagation() {} })
  const opened = walk(render(ISLAND))
  const notes = opened.filter(n => String(n.props.className || '') === 'dnl-diag-note').map(n => JSON.stringify(n.children)).join(' ')
  if (notes.includes('自动重试')) throw new Error('retry budget shown on a success: ' + notes)
  return 'collapsed by default, no retry noise'
})

check('a successful match with fallback says which sources were skipped', () => {
  snapshot = {
    ...BASE,
    lyric: { ...BASE.lyric, fallbackUsed: true, attempts: [
      { source: 'netease', status: 'unmatched', reason: 'no-confident-match' },
      { source: 'qq', status: 'matched' },
      { source: 'kugou', status: 'unmatched' },
    ] },
    service: { policy: 'netease > qq > kugou', entries: 1 },
  }
  let nodes = walk(expand())
  nodes.find(n => String(n.props.className || '').includes('dnl-btn-quiet')).props.onClick({ stopPropagation() {} })
  nodes = walk(render(ISLAND))
  const head = nodes.find(n => String(n.props.className || '') === 'dnl-diag-head')
  if (!JSON.stringify(head.children).includes('后备源')) throw new Error('fallbackUsed is not shown')
  const rows = nodes.filter(n => String(n.props.className || '').includes('dnl-diag-row'))
  if (rows.length !== 3) throw new Error('expected 3 rows, got ' + rows.length)
  return 'winner + skipped sources'
})

// ── word-level sweep (plain lyrics must be unaffected) ─────────────────────
check('a line with words renders the sweep class; a line without does not', () => {
  snapshot = {
    ...BASE,
    positionSec: 12,
    lyric: { ...BASE.lyric, lines: [
      { t: 10, text: '第一句', words: [{ t: 10, end: 11, text: '第一' }, { t: 11, end: 13, text: '句' }] },
      { t: 20, text: '第二句' },
    ] },
  }
  // Drive the real clock: positionSec 12, playing, so the lookup lands on the
  // first line with ~2/3 of its words sung.
  setPosition({ app: 'x', title: '晴天', artist: '周杰伦', album: 'a', positionSec: 12, durationSec: 253, playing: true, active: true, rate: 1 })
  const nodes = walk(expand())
  const sweep = nodes.filter(n => String(n.props.className || '').includes('dnl-line-sweep'))
  if (sweep.length !== 1) throw new Error('expected exactly one swept line, got ' + sweep.length)
  const style = sweep[0].props.style || {}
  if (!Object.keys(style).includes('--dnl-sweep')) throw new Error('no sweep fraction on the style')
  const pct = parseFloat(String(style['--dnl-sweep']))
  if (!(pct > 30 && pct < 70)) throw new Error('implausible sweep ' + pct)
  const plain = nodes.filter(n => String(n.props.className || '') === 'dnl-line-main')
  if (plain.length === 0) throw new Error('the non-swept line lost its plain class')
  return 'one swept line at ' + pct + '%'
})

check('words never reach a translated line differently', () => {
  snapshot = {
    ...BASE,
    positionSec: 11,
    lyric: { ...BASE.lyric, lines: [
      { t: 10, text: '原文', trans: '译文', words: [{ t: 10, end: 13, text: '原文' }] },
    ] },
  }
  const nodes = walk(expand())
  if (!nodes.some(n => String(n.props.className || '') === 'dnl-line-trans')) throw new Error('translation row disappeared')
  return 'translation preserved alongside words'
})

// ── hostile input ──────────────────────────────────────────────────────────
// Regression (reported live 2026-11-13): "切歌时先闪现下一首歌的某一句歌词，
// 然后才是正常的 歌曲名→歌词".
//
// Mechanism: settleLineIndex's state ({shown, pending}) survives a track
// switch. On a cache-hit resolve (the COMMON case on a playlist — every song
// heard in the last 15 days resolves instantly) the client never sees the
// empty-lines "loading" snapshot, so the only reset (lines.length === 0) never
// fires. Song A's shown=40 then indexes into song B's line ARRAY — a valid
// index, a completely different line — and the backward-confirm window (750ms)
// keeps it on screen: the pill shows B's line 40 before settling to the start.
check('a track switch never flashes the new song’s mid-song line', () => {
  store.clear()
  const A_LINES = Array.from({ length: 60 }, (_, i) => ({ t: i * 5, text: 'A-' + i }))
  const B_LINES = Array.from({ length: 63 }, (_, i) => ({ t: i * 5, text: 'B-' + i }))

  // Song A playing at 202s → line 40 active.
  setPosition({ app: 'x', title: 'SongA', artist: 'a', album: 'al', positionSec: 202, durationSec: 320, playing: true, active: true, rate: 1 })
  snapshot = { ...BASE, title: 'SongA', artist: 'a', durationSec: 320, positionSec: 202,
    lyric: { status: 'matched', source: 'netease', sourceLabel: '网易云', songId: 'a1', songName: 'SongA',
      artistNames: ['a'], score: 9, lines: A_LINES, attempts: [{ source: 'netease', status: 'matched' }] } }
  let nodes = walk(expand())
  const activeA = nodes.find(n => String(n.props.className || '').includes('dnl-line-active'))
  if (!activeA) throw new Error('no active line on song A')
  if (!JSON.stringify(activeA).includes('A-40')) throw new Error('song A active line is not A-40: ' + JSON.stringify(activeA).slice(0, 120))

  // Switch: song B at pos 0 with B's first line at t=0 (the common LRC shape —
  // line 0 is the 作词/作曲 row). Raw target = 0 < song A's shown = 40, so the
  // backward-confirm window is what (wrongly) holds B's line 40 on screen.
  setPosition({ app: 'x', title: 'SongB', artist: 'b', album: 'al2', positionSec: 0, durationSec: 330, playing: true, active: true, rate: 1 })
  snapshot = { ...BASE, title: 'SongB', artist: 'b', durationSec: 330, positionSec: 0,
    lyric: { status: 'matched', source: 'netease', sourceLabel: '网易云', songId: 'b1', songName: 'SongB',
      artistNames: ['b'], score: 9, lines: B_LINES, attempts: [{ source: 'netease', status: 'matched' }] } }
  nodes = walk(render(ISLAND))
  const activeB = nodes.find(n => String(n.props.className || '').includes('dnl-line-active'))
  const text = activeB ? JSON.stringify(activeB) : '(no active line)'
  if (text.includes('B-40')) throw new Error('flashed song B’s line 40 (a mid-song line) right after the switch: ' + text.slice(0, 140))
  // The correct first render is B's line 0 — no confirmation delay on a song
  // switch, exactly like a fresh page load.
  if (!activeB || !text.includes('B-0')) throw new Error('expected B-0 active right after the switch, got: ' + text.slice(0, 140))
  return 'no flash; B-0 immediately'
})

check('hostile diagnostics payloads cannot crash the capsule', () => {
  for (const lyric of [
    { status: 'unmatched', attempts: 'not-an-array' },
    { status: 'unmatched', attempts: [null, 42, { source: null }, {}] },
    { status: 'error', attempts: [{ source: 'qq', status: 'error', reason: 42 }] },
  ]) {
    snapshot = { ...BASE, lyric, service: 'nope', retry: 7 }
    const tree = expand()
    if (!tree) throw new Error('crashed on ' + JSON.stringify(lyric))
    walk(tree).find(n => String(n.props.className || '').includes('dnl-btn-quiet'))?.props.onClick({ stopPropagation() {} })
    if (!render(ISLAND)) throw new Error('crashed expanding diagnostics')
  }
  return 'ok'
})

check('hostile word payloads degrade to plain lines', () => {
  snapshot = {
    ...BASE,
    lyric: { ...BASE.lyric, lines: [
      { t: 1, text: 'a', words: 'nope' },
      { t: 2, text: 'b', words: [null, { t: 'x' }, { t: 3, end: 2, text: 'inverted' }] },
      { t: 4, text: 'c', words: [{ t: 4, end: 5, text: 'ok' }] },
    ] },
  }
  const tree = expand()
  const sweep = walk(tree).filter(n => String(n.props.className || '').includes('dnl-line-sweep'))
  if (sweep.length > 1) throw new Error('bad word data produced swaths of sweep')
  return 'ok'
})

// ── report ─────────────────────────────────────────────────────────────────
let failed = 0
for (const r of results) {
  if (!r.ok) failed += 1
  console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.note ? '  [' + r.note + ']' : ''))
}
console.log('')
console.log(failed === 0
  ? 'ALL ' + results.length + ' OFFSET/DIAGNOSTICS RENDER CHECKS PASS'
  : failed + ' of ' + results.length + ' FAILED')
process.exit(failed === 0 ? 0 : 1)

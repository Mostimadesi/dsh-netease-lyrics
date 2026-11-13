/**
 * Word-level lyric timelines (NetEase YRC) — host parsing + client sweep.
 *
 * The user's constraint for this feature was explicit: "保证普通歌词显示效果
 * 优先，逐字歌词只是附加功能". These tests encode exactly that:
 *   1. attachYrcWords NEVER changes line text, order or count — it only adds
 *      `words` to lines it could align confidently;
 *   2. any doubt (no YRC, unalignable text, degenerate words) leaves the plain
 *      lines untouched;
 *   3. the client sanitizer drops bad words without dropping the line, and
 *      wordProgress() is monotonic and total-按-time, so the sweep can only
 *      affect colour, never content.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { attachYrcWords, parseLrc } from '../lib/lyric-service.js'

let pass = 0
const check = (name, cond, detail) => {
  assert.ok(cond, name + (detail === undefined ? '' : ' — ' + detail))
  pass += 1
  console.log('PASS ' + name)
}

// ── Real-shaped YRC fixture (absolute ms word stamps) ─────────────────────
// Note the repeated chorus at 90s: it must pair with its OWN word timeline, not
// with the first copy's.
const LRC = [
  '[00:00.00] 作词 : Adele Adkins',
  '[00:01.00] 作曲 : Adele Adkins/Greg Kurstin',
  "[00:06.22]Hello, it's me",
  '[00:11.32]I was wondering if after all these years',
  "[01:30.00]Hello, it's me",
].join('\n')
const YRC = [
  '[0,1000](0,1000,0) 作词 : Adele Adkins',
  '[1000,1000](1000,1000,0) 作曲 : Adele Adkins/Greg Kurstin',
  "[6220,4440](6220,2190,0)Hello(8410,540,0), (8950,360,0)it's (9310,1350,0)me",
  "[11320,6090](11320,360,0)I (11680,210,0)was (11890,1350,0)wondering",
  // A repeated chorus line: its OWN word timeline must pair with the 2nd LRC copy.
  "[90000,4440](90000,2190,0)Hello(92210,540,0), (92750,360,0)it's (93110,1350,0)me",
].join('\n')

const lrcRows = parseLrc(LRC)
const attached = attachYrcWords(YRC, lrcRows)

// ── 1. The plain lyric contract is untouched ──────────────────────────────
check('line count is unchanged', attached.length === lrcRows.length,
  attached.length + ' vs ' + lrcRows.length)
check('line times are unchanged', attached.every((row, i) => row.t === lrcRows[i].t))
check('line texts are unchanged', attached.every((row, i) => row.text === lrcRows[i].text))
check('nothing else was added', attached.every((row, i) => {
  const a = Object.keys(row).sort().join(',')
  const b = Object.keys(lrcRows[i]).sort().join(',')
  return a === b || a === b + ',words'
}))
check('a staff line still gains its (harmless) words', Array.isArray(attached[0].words))

// ── 2. Word contents ──────────────────────────────────────────────────────
{
  const row = attached[2]
  check('words attached to the matching line', Array.isArray(row.words) && row.words.length === 4)
  check('first word text', row.words[0].text === 'Hello')
  check('words are in seconds', Math.abs(row.words[0].t - 6.22) < 0.001, String(row.words[0].t))
  check('words are sorted', row.words.every((w, i) => i === 0 || w.t >= row.words[i - 1].t))
  check('every word has a positive duration', row.words.every((w) => w.end > w.t))
}

// ── 3. Repeated chorus lines get their OWN timeline (occurrence pairing) ──
{
  const first = attached[2]
  const second = attached[4]
  check('the second copy of a repeated line is also aligned', Array.isArray(second.words),
    JSON.stringify(second))
  check('the two copies carry DIFFERENT word times',
    first.words[0].t !== second.words[0].t,
    first.words[0].t + ' vs ' + second.words[0].t)
  check('the second copy starts at its own stamp', Math.abs(second.words[0].t - 90) < 0.001,
    String(second.words[0].t))
}

// ── 4. Guards: every doubtful payload degrades to the plain lines ─────────
check('no YRC at all → identical array', attachYrcWords('', lrcRows) === lrcRows)
check('undefined YRC → identical array', attachYrcWords(undefined, lrcRows) === lrcRows)
check('unparseable YRC → identical array', attachYrcWords('garbage\n[ti:x]', lrcRows) === lrcRows)
check('empty LRC input → unchanged', attachYrcWords(YRC, []).length === 0)
{
  // Text that shares nothing with the LRC: no alignment must be invented.
  const alien = '[0,1000](0,1000,0)totally\n[1000,1000](1000,1000,0)different'
  const result = attachYrcWords(alien, lrcRows)
  check('unalignable text adds no words', result.every((row) => row.words === undefined))
}
{
  // Equal counts is the ONLY case where index zip is allowed as a fallback.
  const sameCount = YRC.split('\n').slice(0, lrcRows.length).join('\n')
  const result = attachYrcWords(sameCount, lrcRows)
  check('equal-count fallback still returns the same lines',
    result.length === lrcRows.length && result.every((row, i) => row.text === lrcRows[i].text))
}
{
  // A word that claims to start before its line must be clamped INTO the line.
  const line = parseLrc('[00:10.00]abc')
  const yrc = '[10000,2000](10000,500,0)a(5000,500,0)b'
  const result = attachYrcWords(yrc, line)
  const words = result[0].words || []
  check('words outside the line window are dropped',
    words.every((w) => w.t >= 10), JSON.stringify(words))
}

// ── 5. Client sanitizer + sweep ───────────────────────────────────────────
const clientSource = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
let client
vm.runInNewContext(clientSource, {
  window: {
    __ModuleLoader__: { load: ({ factory }) => { client = factory(() => ({ default: { createElement() {}, useState() {}, useEffect() {}, useRef() {} } })) } },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true },
  },
  document: {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, style: {}, remove() {} }),
    head: { appendChild() {} }, body: { appendChild() {} },
  },
  AbortController,
  console,
})
const { sanitizeLines, wordProgress } = client.__test

{
  const rows = sanitizeLines([
    { t: 5, text: 'x', words: [{ t: 6, end: 7, text: 'b' }, { t: 5, end: 6, text: 'a' }] },
    { t: 8, text: 'y', words: [{ t: 8, end: 8, text: 'zero-duration' }] },
    { t: 9, text: 'z', words: [{ t: 1, end: 2, text: 'before-line' }] },
    { t: 10, text: 'w', words: [null, { t: 10, end: 11, text: 'ok' }] },
  ])
  check('sanitizer sorts words by time',
    rows[0].words[0].text === 'a' && rows[0].words[1].text === 'b', JSON.stringify(rows[0]))
  check('sanitizer drops a zero-duration word AND its line keeps no words',
    rows[1].words === undefined && rows[1].text === 'y', JSON.stringify(rows[1]))
  check('sanitizer drops words before the line start', rows[2].words === undefined)
  check('sanitizer skips null words but keeps the good one',
    rows[3].words.length === 1 && rows[3].words[0].text === 'ok')
  check('a line WITHOUT words stays byte-identical to the plain shape',
    sanitizeLines([{ t: 1, text: 'plain' }])[0].words === undefined)
}

{
  const line = { t: 10, text: 'ab cd', words: [{ t: 10, end: 11, text: 'ab' }, { t: 11, end: 13, text: 'cd' }] }
  check('sweep: before the line is 0', wordProgress(line, 9) === 0)
  check('sweep: at the first word is 0', wordProgress(line, 10) === 0)
  check('sweep: mid-first-word', Math.abs(wordProgress(line, 10.5) - 1 / 6) < 1e-9,
    String(wordProgress(line, 10.5)))
  check('sweep: inside the gap holds position', wordProgress(line, 12) > wordProgress(line, 10.5))
  check('sweep: after the last word is 1', wordProgress(line, 13) === 1)
  check('sweep: far past the line is 1', wordProgress(line, 9999) === 1)
  check('sweep: no words → 0 (plain path)', wordProgress({ t: 1, text: 'x' }, 5) === 0)
  check('sweep: monotonic over the whole line', (() => {
    let previous = -1
    for (let t = 9; t <= 14; t += 0.05) {
      const value = wordProgress(line, t)
      if (value < previous - 1e-9) return false
      previous = value
    }
    return true
  })())
  check('sweep: always within [0,1]', (() => {
    for (const pos of [-5, 0, 10, 10.4, 12.7, 13, 1e6]) {
      const value = wordProgress(line, pos)
      if (value < 0 || value > 1) return false
    }
    return true
  })())
}

// ── 6. The host must not send words the client cannot use ─────────────────
{
  const hostSource = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  check('lyricForWire projects words explicitly (no raw pass-through)',
    /out\.words = row\.words\.map/.test(hostSource))
  check('translation toggle governs both trans and words',
    /pluginConfig\.showTranslation !== true\) return \{ t: row\.t, text: row\.text \}/.test(hostSource))
}

console.log('ALL ' + pass + ' YRC / WORD-LEVEL TESTS PASS')

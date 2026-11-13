/**
 * CSS structure guard.
 *
 * The whole plugin stylesheet is one string array in lib/client.js, joined and
 * written into a <style> element at runtime. Browsers parse CSS with ERROR
 * RECOVERY, not error reporting: one unclosed "{" silently discards that rule
 * AND every rule after it. The symptom is "the whole plugin UI collapsed" with
 * no console error, `node --check` still green, and every existing test still
 * passing — because those tests assert on individual selectors with
 * `.includes()` and cannot see that the sheet stopped parsing.
 *
 * This guard is the cheapest possible gate against that class of failure:
 * ~40 lines, no dependencies, no browser. It walks the joined CSS and asserts
 * the brace/paren/quote stack is balanced.
 *
 * It deliberately does NOT try to be a CSS parser. What it catches:
 *   - a missing or extra "}" / ")" (the class that kills the sheet silently)
 *   - an unterminated quote in a content: value
 * What it does NOT catch (documented so nobody expects too much):
 *   - misspelled property names or values (needs a real parser)
 *   - a DUPLICATE rule overriding an earlier one (a different bug family —
 *     seen in v0.3.x, where a stale .dnl-now-trans rule silently overrode the
 *     new grid collapse rule; that needs a selector-set assertion, not a stack)
 *   - cascade conflicts with host styles (needs a real browser)
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// ── 1. Extract the joined stylesheet exactly as the runtime builds it ──────
// The array is declared as `const CSS = [ ... ].join("");`. Extracting by
// marker rather than by importing client.js keeps this guard independent of
// the module loader / React mocks the other tests need.
const startMarker = 'const CSS = ['
const startAt = source.indexOf(startMarker)
assert.notEqual(startAt, -1, 'lib/client.js must declare `const CSS = [`')

const endMarker = '].join("")'
const endAt = source.indexOf(endMarker, startAt)
assert.notEqual(endAt, -1, 'the CSS array must be joined with ].join("")')

const block = source.slice(startAt + startMarker.length, endAt)

/** Every double-quoted JS string literal in the block, escapes resolved. */
function stringLiterals(text) {
  const out = []
  let i = 0
  while (i < text.length) {
    if (text[i] !== '"') { i += 1; continue }
    let value = ''
    let p = i + 1
    let closed = false
    while (p < text.length) {
      const ch = text[p]
      if (ch === '\\') { value += text[p + 1] ?? ''; p += 2; continue }
      if (ch === '"') { closed = true; break }
      value += ch
      p += 1
    }
    assert.ok(closed, 'unterminated string literal in the CSS array near index ' + i)
    out.push(value)
    i = p + 1
  }
  return out
}

const fragments = stringLiterals(block)
assert.ok(fragments.length > 200, 'expected the stylesheet to hold hundreds of rules, got ' + fragments.length)

const css = fragments.join('')
assert.ok(css.length > 20_000, 'the joined stylesheet is unexpectedly small: ' + css.length)

// ── 2. Balance the stack ──────────────────────────────────────────────────
// Quotes are skipped so `content: '{'` cannot unbalance the braces.
const stack = []
let quote = null
let lastIndex = -1
for (let i = 0; i < css.length; i += 1) {
  const ch = css[i]
  if (quote !== null) {
    if (ch === quote) quote = null
    continue
  }
  if (ch === '"' || ch === "'") { quote = ch; lastIndex = i; continue }
  if (ch === '{' || ch === '(') { stack.push({ ch, i }); lastIndex = i; continue }
  if (ch === '}' || ch === ')') {
    const open = stack.pop()
    const expected = ch === '}' ? '{' : '('
    assert.ok(open, 'extra "' + ch + '" with nothing open at css[' + i + ']: ' + css.slice(Math.max(0, i - 60), i + 20))
    assert.equal(open.ch, expected, 'mismatched "' + ch + '" closes "' + open.ch + '" opened at css[' + open.i + ']')
    lastIndex = i
  }
}

assert.equal(quote, null, 'unterminated quote in the stylesheet (opened at css[' + lastIndex + '])')
assert.equal(
  stack.length,
  0,
  stack.length + ' unclosed block(s) — the browser would silently drop everything after the first one:\n'
    + stack.map((entry) => '  "' + entry.ch + '" at css[' + entry.i + ']: ' + css.slice(entry.i, entry.i + 70)).join('\n'),
)

// ── 3. A cheap sanity check that the join produced real rules ─────────────
const ruleCount = (css.match(/\{/g) || []).length
assert.ok(ruleCount > 200, 'expected >200 rule blocks, got ' + ruleCount)
assert.ok(!css.includes('undefined'), 'a JS `undefined` leaked into the stylesheet')

console.log(
  'style-balance.test.mjs ok — ' + fragments.length + ' fragments, ' + css.length + ' chars, '
    + ruleCount + ' blocks, balanced',
)

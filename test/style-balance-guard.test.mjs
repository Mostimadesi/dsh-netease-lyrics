/**
 * Meta-test for the CSS guard: prove style-balance.test.mjs FAILS on the bugs
 * it claims to catch.
 *
 * A guard that has only ever been observed passing is indistinguishable from a
 * no-op. This runs the real guard against mutated copies of client.js and
 * asserts a non-zero exit plus a message naming the problem.
 */

import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync, cpSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const guard = join(root, 'test', 'style-balance.test.mjs')
const original = join(root, 'lib', 'client.js')

/** Run the guard with `lib/client.js` replaced by `mutated` source. */
function runGuardWith(mutated) {
  const dir = mkdtempSync(join(tmpdir(), 'css-guard-'))
  try {
    cpSync(join(root, 'test'), join(dir, 'test'), { recursive: true })
    cpSync(join(root, 'lib'), join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'lib', 'client.js'), mutated, 'utf8')
    const result = spawnSync(process.execPath, [join(dir, 'test', 'style-balance.test.mjs')], {
      encoding: 'utf8',
      cwd: dir,
    })
    return { status: result.status, stderr: String(result.stderr || ''), stdout: String(result.stdout || '') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const base = readFileSync(original, 'utf8')
const cases = []

// 1. Baseline: the real file must pass.
{
  const result = runGuardWith(base)
  cases.push(['unmodified client.js passes', result.status === 0, result])
}

// 2. A dropped closing brace inside one rule — the exact silent-collapse bug.
{
  const needle = '.dnl-line-main{'
  const at = base.indexOf(needle)
  assert.ok(at > 0, 'fixture marker missing')
  // Turn the first `}` after the marker into nothing.
  const closeAt = base.indexOf('}', at)
  const mutated = base.slice(0, closeAt) + base.slice(closeAt + 1)
  const result = runGuardWith(mutated)
  cases.push(['a dropped "}" is caught', result.status !== 0 && /unclosed/i.test(result.stderr), result])
}

// 3. An extra closing brace.
{
  const at = base.indexOf('const CSS = [')
  const body = base.slice(0, at) + base.slice(at).replace('.dnla-layer{', '.dnla-layer{}}')
  const result = runGuardWith(body)
  cases.push(['an extra "}" is caught', result.status !== 0 && /extra/i.test(result.stderr), result])
}

// 4. A malformed join (missing .join) — the marker itself disappears.
{
  const mutated = base.replace('].join("")', ']')
  const result = runGuardWith(mutated)
  cases.push(['a missing .join("") is caught', result.status !== 0 && /join/i.test(result.stderr), result])
}

// 5. An unclosed var( — the paren half of the same failure family.
{
  const needle = '"' + '.dnl-dot{position:absolute;'
  const at = base.indexOf(needle)
  assert.ok(at > 0, 'fixture marker missing')
  const insertAt = at + needle.length
  const mutated = base.slice(0, insertAt) + 'color:var(--x;' + base.slice(insertAt)
  const result = runGuardWith(mutated)
  cases.push(['an unclosed var( is caught', result.status !== 0 && /unclosed|mismatched/i.test(result.stderr), result])
}

// 6. NEGATIVE control: a brace INSIDE a quoted content value must NOT trip the
//    guard. Without this, the guard could be "passing" simply by being broken.
{
  const needle = '"' + '.dnl-dot{position:absolute;'
  const at = base.indexOf(needle)
  const insertAt = at + needle.length
  const mutated = base.slice(0, insertAt) + `content:'{';` + base.slice(insertAt)
  const result = runGuardWith(mutated)
  cases.push(['a quoted "{" inside content: is tolerated', result.status === 0, result])
}

let failed = 0
for (const [name, ok, result] of cases) {
  if (ok) {
    console.log('PASS ' + name)
  } else {
    failed += 1
    console.log('FAIL ' + name + ' (exit ' + result.status + ')')
    if (result.stderr) console.log('  ' + result.stderr.split('\n').slice(0, 4).join('\n  '))
  }
}
assert.equal(failed, 0, failed + ' css-guard mutation case(s) failed')
console.log('ALL ' + cases.length + ' CSS GUARD MUTATION CASES PASS')

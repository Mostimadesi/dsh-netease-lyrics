/* v0.4.37 commit surgery: the shared working tree carries the lyric session's
 * uncommitted edits (lyricSongKey / lookupPos / their __test exports). My
 * v0.4.37 hunks sit in the SAME diff hunks, so the patch is edited by hand:
 *  H2 — drop their lyricSongKey block (+ lines 5-22 of the hunk), demote the
 *       `- clockPos` line to context, drop the `+ lookupPos` line.
 *  H6 — drop their six-line export block (pure + lines).
 * git apply --cached --recount recomputes the header counts, so only the body
 * lines are edited. One-shot: the script refuses to run twice by checking a
 * marker that only exists pre-surgery. */
import assert from "node:assert/strict";
import fs from "node:fs";

const raw = fs.readFileSync("filtered.patch", "utf8");
const parts = raw.split(/(?=^@@ )/m);
const header = parts[0];
const hunks = parts.slice(1);
assert.equal(hunks.length, 7, "expected 7 hunks");

/* ---- H2 ---------------------------------------------------------------- */
{
  const lines = hunks[2].split(/\r?\n/);
  // Guard: the hunk must still look like the pre-surgery version.
  assert.ok(lines.some((l) => l.startsWith("+\t\t\tconst lyricSongKey")), "H2 pre-state lost");
  const out = [];
  let skippedTheir = 0;
  let demoted = 0;
  for (const line of lines) {
    if (line.startsWith("+\t\t\t// The settle state belongs to ONE lyric document.")) {
      skippedTheir = 1; // comment block starts here; skip until the if-reset ends
      continue;
    }
    if (skippedTheir === 1) {
      if (line.startsWith("+\t\t\tif (lineStateRef.current.song !== lyricSongKey)")) {
        skippedTheir = 2; // if statement: skip this line + body + closing brace
        continue;
      }
      continue;
    }
    if (skippedTheir === 2) {
      // skip: `\t\t\t\tlineStateRef.current = { song: ... };` and `\t\t\t}`
      if (line.startsWith("+\t\t\t}")) { skippedTheir = 3; continue; }
      continue;
    }
    if (line.startsWith("-\t\t\t\t? settleLineIndex(linesForHooks, clockPos,")) {
      out.push(" " + line.slice(1)); // demote HEAD line to context
      demoted++;
      continue;
    }
    if (line.startsWith("+\t\t\t\t? settleLineIndex(linesForHooks, lookupPos,")) continue; // drop theirs
    out.push(line);
  }
  assert.equal(skippedTheir, 3, "H2 lyricSongKey block not fully skipped");
  assert.equal(demoted, 1, "H2 clockPos demotion missing");
  assert.ok(out.some((l) => l.startsWith("+\t\t\tconst haloRef = useRef(null);")), "my effect lost");
  // "lyricSongKey" may survive only inside my own explanatory comment line.
  assert.ok(out.filter((l) => l.includes("lyricSongKey")).every((l) => l.startsWith("+\t\t\t * session's lyricSongKey is uncommitted")), "their key leaked");
  assert.ok(!out.some((l) => l.includes("lookupPos")), "their lookupPos leaked");
  hunks[2] = out.join("\n");
}

/* ---- H6 ---------------------------------------------------------------- */
{
  const lines = hunks[6].split(/\r?\n/);
  const drop = /^\+\t\t\t(\/\/ v0\.4\.27|\/\/ v0\.4\.28|clampOffsetMs,|OFFSET_KEY,|describeAttempt,|wordProgress, sanitizeWords,)/;
  const out = lines.filter((l) => !drop.test(l));
  assert.equal(lines.length - out.length, 6, "H6 should drop exactly 6 lines");
  assert.ok(out.some((l) => l.includes("createBeatGrid,")), "my export lost");
  assert.ok(out.some((l) => l.includes("readDisplay, writeDisplay,")), "writeDisplay export lost");
  hunks[6] = out.join("\n");
}

fs.writeFileSync("surgical.patch", header + hunks.join(""));
console.log("surgical.patch written");

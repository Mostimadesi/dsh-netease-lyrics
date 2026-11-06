// Guard: JSON manifests must not start with a UTF-8 BOM.
//
// A BOM (EF BB BF) at the head of package.json makes the host's manifest loader
// fail with `Unexpected token '\uFEFF', "﻿{ "name"... is not valid JSON`, and
// the plugin then refuses to load at all. Windows PowerShell 5.1's
// `Set-Content -Encoding UTF8` writes a BOM, so a version bump done that way
// quietly breaks the package. Keep the manifests BOM-free.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function bytes(p) { return fs.readFileSync(p); }
function hasBom(buf) { return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf; }

// 1. package.json - the manifest the host parses before loading the plugin.
const pkgPath = path.join(root, 'package.json');
const pkgBuf = bytes(pkgPath);
assert.equal(hasBom(pkgBuf), false,
	'package.json must not start with a UTF-8 BOM (the host fails to parse it and the plugin will not load)');
const pkgText = pkgBuf.toString('utf8');
assert.doesNotThrow(() => JSON.parse(pkgText), 'package.json must be valid JSON as stored on disk');
assert.equal(JSON.parse(pkgText).name, 'dsh-netease-lyrics', 'package.json still names the plugin');

// 2. every tracked JSON manifest next to the sources (package-lock etc.).
const jsonFiles = fs.readdirSync(root).filter((f) => f.endsWith('.json'));
for (const file of jsonFiles) {
	const buf = bytes(path.join(root, file));
	assert.equal(hasBom(buf), false, file + ' must not start with a UTF-8 BOM');
	assert.doesNotThrow(() => JSON.parse(buf.toString('utf8')), file + ' must be valid JSON');
}

// 3. cordis.patch.yml is YAML, but a BOM there breaks strict YAML parsers too.
const patch = path.join(root, 'cordis.patch.yml');
assert.equal(hasBom(bytes(patch)), false, 'cordis.patch.yml must not start with a UTF-8 BOM');

console.log('PASS: package.json / lock / cordis.patch.yml are BOM-free and package.json parses');

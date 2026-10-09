#!/usr/bin/env node
/// Compares fingerprints of compiled JS against the source baseline snapshot.
/// Proves the conversion preserves behavior: types erase, so the executable
/// code AST must match. Only files with intended manual edits (new parameters,
/// initializers) may differ.
/// Printing mirrors tools/ast-fingerprint.mjs, but the root comes from an argument.
///
/// COMMANDS
///   fp-emit.mjs <baseline.json> <emitted-root>   compare emitted JS against
///                           the baseline snapshot; both paths come from args
///
/// WORKFLOW
///   ./tools/ast-fingerprint.mjs snapshot ./src /tmp/ast-before.json
///   # ...conversion...
///   ./node_modules/.bin/tsc -p /tmp/emit.json   # outDir outside the repo
///   ./tools/fp-emit.mjs /tmp/ast-before.json /tmp/emit-out
///
/// EXIT CODES
///   0  always (differences print as CHANGED/UNPARSE lists)
///   2  missing path, or unreadable baseline / emitted root
const USAGE = "usage: fp-emit.mjs <baseline.json> <emitted-root>";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import _generate from "@babel/generator";

const traverse = _traverse.default ?? _traverse;
const generate = _generate.default ?? _generate;

/**
 * Parses a file and prints the code back without comments.
 * @param {string} path file path
 * @returns {string} sha256 of the comment-free code
 */
function codeFingerprint(path) {
  const src = readFileSync(path, "utf8");
  const ast = parse(src, {
    sourceType: "unambiguous",
    allowReturnOutsideFunction: true,
    plugins: [
      "jsx",
      "classProperties",
      "optionalChaining",
      "nullishCoalescingOperator",
    ],
  });
  traverse(ast, {
    enter(p) {
      p.node.leadingComments = null;
      p.node.trailingComments = null;
      p.node.innerComments = null;
    },
  });
  const out = generate(ast, { comments: false, compact: false }, src).code;
  return createHash("sha256").update(out).digest("hex");
}

/**
 * Collects every `.js` (except `.min.js`) under a directory.
 * @param {string} dir root
 * @param {string[]} acc accumulator
 * @returns {string[]} paths
 */
function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (e.endsWith(".js") && !e.endsWith(".min.js")) acc.push(full);
  }
  return acc;
}

const [baselinePath, emitRoot] = process.argv.slice(2).filter((a) => a !== "--");
if (!baselinePath || !emitRoot) {
  console.error(`${USAGE}\nmissing ${!baselinePath ? "baseline" : "emitted root"}: point at <baseline.json> <emitted-root>`);
  process.exit(2);
}
let baseline;
try {
  baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
} catch {
  console.error(`${USAGE}\ncannot read baseline: ${baselinePath}`);
  process.exit(2);
}
let emitStat;
try {
  emitStat = statSync(emitRoot);
} catch {
  console.error(`${USAGE}\nno such file or directory: ${emitRoot}`);
  process.exit(2);
}
if (!emitStat.isDirectory()) {
  console.error(`${USAGE}\nnot a directory: ${emitRoot}`);
  process.exit(2);
}
const emitFiles = walk(emitRoot).sort();
let same = 0;
let diff = 0;
let unparse = 0;
const diffs = [];
for (const f of emitFiles) {
  const rel = relative(emitRoot, f);
  if (!(rel in baseline) || baseline[rel] === null) continue;
  let h;
  try {
    h = codeFingerprint(f);
  } catch {
    unparse++;
    diffs.push(`UNPARSE ${rel}`);
    continue;
  }
  if (h === baseline[rel]) {
    same++;
  } else {
    diff++;
    if (diffs.length < 30) diffs.push(`CHANGED ${rel}`);
  }
}
console.log({
  same,
  diff,
  unparse,
  total: Object.keys(baseline).length,
});
for (const d of diffs) console.log(d);

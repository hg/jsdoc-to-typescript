#!/usr/bin/env node
/// Walk every `.js` file under a tree, parse it and count where types are
/// thrown away. Results grouped by file and sorted by severity.
///
/// COMMANDS
///   summary <path> [filter...]  (default) totals per category plus the
///                           top-40 files by hit count. `path` is a directory
///                           to walk or a single `.js` file. `filter`:
///                           substring of the path relative to `path`,
///                           repeat to union them. A filter that matches no
///                           file is an error, not a clean result.
///   detail <path> [filter...]   TAB-separated line per matching file, sorted
///                           by count
///
/// EXIT CODES
///   0  every file was parsed
///   1  at least one file could not be parsed, no file matched, or the path
///      holds no scannable files
///   2  invalid mode, missing path, or unreadable path
///
/// EXAMPLES
///   ./tools/any-scan.mjs summary ./src
///   ./tools/any-scan.mjs summary ./src http-client.js number-utils.js
///   ./tools/any-scan.mjs detail ./src/modal.js
///   ./tools/any-scan.mjs detail ./src modal.js

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parse } from "@babel/parser";

const USAGE = "usage: any-scan.mjs [summary|detail] <path> [filter ...]";

const PARSER_OPTIONS = {
  sourceType: "unambiguous",
  allowReturnOutsideFunction: true,
  plugins: [
    "jsx",
    "classProperties",
    "optionalChaining",
    "nullishCoalescingOperator",
  ],
};

const JSDOC_TAGS =
  /@(param|arg|argument|returns?|return|type|typedef|property|prop|template)\s*\{([^}]*)\}/g;

/**
 * Collects the `.js` files of a tree.
 * @param {string} dir directory to walk
 * @param {string[]} [acc] files found so far, accumulated by recursion
 * @returns {string[]} absolute paths of the files found
 */
function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, acc);
    } else if (entry.endsWith(".js")) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Whether a file is a scan target: `.js`.
 * @param {string} filePath absolute path of the file
 * @returns {boolean} true when the file is scanned
 */
function isScannable(filePath) {
  return filePath.endsWith(".js");
}

/**
 * Resolves a CLI target to scan files: a directory is walked, a single file
 * is taken as is when it has a scannable extension.
 * @param {string} target directory or file path from the command line
 * @returns {{files: string[], root: string}} absolute file paths and the root
 *   report paths are shown relative to
 */
function collectTargets(target) {
  const resolved = resolve(target);
  let st;
  try {
    st = statSync(resolved);
  } catch {
    return { files: [], root: resolved, missing: true };
  }
  if (!st.isDirectory()) {
    if (!isScannable(resolved)) return { files: [], root: dirname(resolved) };
    return { files: [resolved], root: dirname(resolved) };
  }
  return { files: walk(resolved).sort(), root: resolved };
}

/**
 * Picks files by substrings of their path relative to the target root.
 * @param {string[]} all all scanned files
 * @param {string} root absolute target root for relative paths
 * @param {string[]} filters substrings to search for
 * @returns {{files: string[], empty: boolean}} the matching files
 */
function selectFiles(all, root, filters) {
  if (filters.length === 0) return { files: all, empty: false };
  const picked = all.filter((f) =>
    filters.some((s) => relative(root, f).includes(s)),
  );
  return { files: picked, empty: picked.length === 0 };
}

/**
 * Bodies of the JSDoc blocks of a parsed file. Babel collects comments
 * separately from literals, so nothing inside a string, a template or a
 * regex can reach this list.
 * @param {object} file File node returned by parse()
 * @returns {string[]} comment text of the JSDoc blocks, delimiters removed
 */
function jsdocBodies(file) {
  return (file.comments ?? [])
    .filter((c) => c.type === "CommentBlock" && c.value.startsWith("*"))
    .map((c) => c.value);
}

/**
 * Counts `any` in the type braces of the JSDoc tags of one comment body.
 * @param {string} body comment text without its delimiters
 * @returns {{param: number, returns: number, type: number, other: number}} hits per tag kind
 */
function countJsdocAny(body) {
  const hits = { param: 0, returns: 0, type: 0, other: 0 };
  // @ts-expect-error and friends are directives, not type annotations
  const clean = body.replace(/@ts-[a-z-]+[^\n]*/g, "");
  for (const m of clean.matchAll(JSDOC_TAGS)) {
    if (!/\bany\b/.test(m[2])) continue;
    const tag = m[1];
    if (tag === "param" || tag === "arg" || tag === "argument") hits.param++;
    else if (tag === "returns" || tag === "return") hits.returns++;
    else if (tag === "type") hits.type++;
    else hits.other++;
  }
  return hits;
}

const raw = process.argv.slice(2).filter((a) => a !== "--");
let mode = "summary";
let rest = raw;
if (raw[0] === "summary" || raw[0] === "detail") {
  mode = raw[0];
  rest = raw.slice(1);
}
const [targetArg, ...filters] = rest;

if (targetArg === undefined) {
  console.error(
    `${USAGE}\nmissing path: point at a directory or a .js file`,
  );
  process.exit(2);
}

const collected = collectTargets(targetArg);
if (collected.missing) {
  console.error(`${USAGE}\nno such file or directory: ${targetArg}`);
  process.exit(2);
}
const ROOT = collected.root;
const allFiles = collected.files;
if (allFiles.length === 0) {
  console.error(
    `FAIL: no .js files under ${targetArg}, nothing was checked.`,
  );
  process.exit(1);
}
const { files, empty } = selectFiles(allFiles, ROOT, filters);
if (empty) {
  console.error(
    `FAIL: no file matched ${filters.join(", ")}, nothing was checked. A filter is a substring of the path relative to ${targetArg}, e.g. "modal.js".`,
  );
  process.exit(1);
}

const rows = [];
const skipped = [];

for (const file of files) {
  const rel = relative(ROOT, file);
  let ast;
  try {
    ast = parse(readFileSync(file, "utf8"), PARSER_OPTIONS);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    skipped.push(`${rel}  ${msg.split("\n")[0]}`);
    continue;
  }

  const jsdoc = { param: 0, returns: 0, type: 0, other: 0 };
  for (const body of jsdocBodies(ast)) {
    const hits = countJsdocAny(body);
    jsdoc.param += hits.param;
    jsdoc.returns += hits.returns;
    jsdoc.type += hits.type;
    jsdoc.other += hits.other;
  }
  const total = jsdoc.param + jsdoc.returns + jsdoc.type + jsdoc.other;
  if (total > 0) {
    rows.push({
      file: rel,
      jsdocParam: jsdoc.param,
      jsdocReturns: jsdoc.returns,
      jsdocType: jsdoc.type,
      jsdocOther: jsdoc.other,
      total,
    });
  }
}

/**
 * Prints what the run could not read; shared by both modes.
 * @returns {boolean} true when the run covered the whole tree
 */
function reportSkipped() {
  const parsed = files.length - skipped.length;
  console.log(
    `parsed ${parsed} of ${files.length} files, ${skipped.length} unparseable`,
  );
  for (const s of skipped) console.log(`SKIPPED  ${s}`);
  return skipped.length === 0;
}

let complete;

if (mode === "summary") {
  rows.sort((a, b) => b.total - a.total);
  const sums = rows.reduce(
    (a, r) => {
      a.total += r.total;
      a.jsdocParam += r.jsdocParam;
      a.jsdocReturns += r.jsdocReturns;
      a.jsdocType += r.jsdocType;
      a.jsdocOther += r.jsdocOther;
      return a;
    },
    { total: 0, jsdocParam: 0, jsdocReturns: 0, jsdocType: 0, jsdocOther: 0 },
  );
  complete = reportSkipped();
  console.log(`files with 'any': ${rows.length}`);
  console.log(`total occurrences: ${sums.total}`);
  console.log(`  JSDoc @param:    ${sums.jsdocParam}`);
  console.log(`  JSDoc @type:     ${sums.jsdocType}`);
  console.log(`  JSDoc @returns:  ${sums.jsdocReturns}`);
  console.log(`  JSDoc other:     ${sums.jsdocOther}`);
  console.log("\n=== top-40 files ===");
  for (const r of rows.slice(0, 40)) {
    console.log(
      `${String(r.total).padStart(3)}  ${r.file}  (param:${r.jsdocParam} type:${r.jsdocType} ret:${r.jsdocReturns} other:${r.jsdocOther})`,
    );
  }
} else if (mode === "detail") {
  complete = reportSkipped();
  const rowsT = rows.sort((a, b) => b.total - a.total);
  for (const r of rowsT) {
    console.log(`${r.total}\t${r.file}`);
  }
} else {
  console.error(`${USAGE}\nunknown command: ${mode}`);
  process.exit(2);
}

if (!complete) process.exitCode = 1;

#!/usr/bin/env node
/// For JS files under a tree: parse source, print AST without comments, take its sha256.
/// Result: fingerprint of executable code: reformat or comment update leaves it unchanged;
/// rename or statement changes alter it. Workflow: snapshot → edit comments → diff.
/// Unchanged fingerprint ⇒  Babel printed this file identically, comments excluded.
///
/// COMMANDS
///   snapshot <path> <out.json>  Write {relativePath: fingerprint} for the tree
///                           to <out.json>; an unparseable file gets a null value.
///                           `path` is a directory to walk or a single `.js` file.
///   diff <path> <baseline.json> [filter...]
///                           Re-fingerprint the tree and compare it with
///                           baseline. Prints one line per difference:
///                             NEW        present now, absent from baseline
///                             CHANGED    fingerprint differs
///                             DELETED    present in baseline, gone from disk
///                             SKIPPED    cannot be parsed, so not verified
///                             RECOVERED  unparseable in baseline, parseable now
///                           `filter`: substring of the path relative to
///                           `path`; supply several to union them. A filter that
///                           matches no file is an error, not a pass.
///   files <path> [filter...]  Print scanned paths, one per line.
///
/// EXIT CODES
///   0  every file in scope parsed and its fingerprint matched
///   1  a difference was found, a file was skipped, no file matched, or the
///      path holds no scannable files
///   2  invalid command, missing path, or unreadable path
///
/// EXAMPLES
///   # Record tree baseline
///   ./tools/ast-fingerprint.mjs snapshot ./src /tmp/ast-before.json
///
///   # After comment only pass, nothing must be reported
///   ./tools/ast-fingerprint.mjs diff ./src /tmp/ast-before.json
///   echo $?    # 0 = comments only, 1 = real code changed
///
///   # Verify only some files; filter is relative to <path>
///   ./tools/ast-fingerprint.mjs diff ./src /tmp/ast-before.json Role/ edit.js
///
///   # List which files are scanned
///   ./tools/ast-fingerprint.mjs files ./src

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import _generate from "@babel/generator";

const traverse = _traverse.default ?? _traverse;
const generate = _generate.default ?? _generate;

const USAGE =
  "usage: ast-fingerprint.mjs snapshot <path> <out.json> | diff <path> <baseline.json> [filter ...] | files <path> [filter ...]";

/**
 * Collects the `.js` files of a tree, skipping minified bundles.
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
    } else if (entry.endsWith(".js") && !entry.endsWith(".min.js")) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Whether a file is a fingerprint target: `.js`, excluding minified bundles.
 * @param {string} filePath absolute path of the file
 * @returns {boolean} true when the file is scanned
 */
function isScannable(filePath) {
  return filePath.endsWith(".js") && !filePath.endsWith(".min.js");
}

/**
 * Resolves a CLI target to fingerprint files: a directory is walked, a
 * single file is taken as is when it has a scannable extension.
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
 * Parses the file and prints the code back without comments.
 * JSDoc is kept in the AST as leadingComments, so every comment is stripped
 * before generating: editing a comment must not change the fingerprint.
 * @param {string} path path to the file
 * @returns {string} sha256 of the comment-free code
 */
export function codeFingerprint(path) {
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
 * Fingerprints one file, turning a parse failure into a reportable result.
 * One unparseable file must not abort the run: it means the file is
 * unverified, which has to surface as SKIPPED rather than as a green result.
 * @param {string} path path to the file
 * @returns {{ok: true, hash: string} | {ok: false, error: string}} fingerprint or the parse error
 */
function fingerprintFile(path) {
  try {
    return { ok: true, hash: codeFingerprint(path) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg.split("\n")[0] };
  }
}

/**
 * Resolves a tree target or exits with a usage error.
 * @param {string|undefined} targetArg directory or file path from the command line
 * @returns {{files: string[], root: string}} absolute files and report root
 */
function needTree(targetArg) {
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
  if (collected.files.length === 0) {
    console.error(
      `FAIL: no .js files under ${targetArg}, nothing was checked.`,
    );
    process.exit(1);
  }
  return collected;
}

const [cmd, ...rest] = process.argv.slice(2).filter((a) => a !== "--");

/**
 * Writes a fingerprint snapshot for the tree.
 * @param {string[]} files absolute file paths in scope
 * @param {string} root absolute target root for relative paths
 * @param {string} outPath where to write the snapshot JSON
 * @returns {void}
 */
function runSnapshot(files, root, outPath) {
  const snap = {};
  const skipped = [];
  for (const f of files) {
    const rel = relative(root, f);
    const now = fingerprintFile(f);
    if (now.ok) {
      snap[rel] = now.hash;
    } else {
      snap[rel] = null;
      skipped.push(`${rel}  ${now.error}`);
    }
  }
  try {
    writeFileSync(outPath, JSON.stringify(snap, null, 2));
  } catch {
    console.error(`${USAGE}\ncannot write snapshot: ${outPath}`);
    process.exit(2);
  }
  const note = skipped.length > 0 ? `, ${skipped.length} unparseable` : "";
  console.log(`snapshot: ${files.length} files${note} -> ${outPath}`);
  for (const s of skipped) console.log(`SKIPPED  ${s}`);
  if (skipped.length > 0) process.exitCode = 1;
}

/**
 * Compares the tree against a baseline snapshot.
 * @param {string[]} allFiles absolute file paths before filtering
 * @param {string} root absolute target root for relative paths
 * @param {string} targetArg original path argument for messages
 * @param {string} baselinePath path to the baseline JSON
 * @param {string[]} filters substrings to search for
 * @returns {void}
 */
function runDiff(allFiles, root, targetArg, baselinePath, filters) {
  let base;
  try {
    base = JSON.parse(readFileSync(baselinePath, "utf8"));
  } catch {
    console.error(`${USAGE}\ncannot read baseline: ${baselinePath}`);
    process.exit(2);
  }
  const matches = (rel) =>
    filters.length === 0 || filters.some((f) => rel.includes(f));
  const { files, empty } = selectFiles(allFiles, root, filters);
  if (empty) {
    console.error(
      `FAIL: no file matched ${filters.join(", ")}, nothing was checked. A filter is a substring of the path relative to ${targetArg}, e.g. "Role/edit.js".`,
    );
    process.exit(1);
  }
  let checked = 0;
  let skipped = 0;
  const list = [];
  for (const f of files) {
    const rel = relative(root, f);
    if (!matches(rel)) continue;
    checked++;
    const now = fingerprintFile(f);
    const was = rel in base ? base[rel] : undefined;
    if (!now.ok) {
      list.push(`SKIPPED  ${rel}  ${now.error}`);
      skipped++;
    } else if (was === undefined) {
      list.push(`NEW      ${rel}`);
    } else if (was === null) {
      list.push(`RECOVERED ${rel}  parseable now, was skipped in baseline`);
    } else if (was !== now.hash) {
      list.push(`CHANGED  ${rel}`);
    }
  }
  for (const k of Object.keys(base)) {
    if (!matches(k)) continue;
    try {
      statSync(join(root, k));
    } catch {
      list.push(`DELETED  ${k}`);
    }
  }
  const scope = filters.length > 0 ? ` (filter: ${filters.join(", ")})` : "";
  if (checked === 0) {
    console.error(
      `FAIL: no file matched${scope}, nothing was checked. A filter is a substring of the path relative to ${targetArg}, e.g. "Role/edit.js".`,
    );
    process.exitCode = 1;
    return;
  }
  if (list.length === 0) {
    console.log(`OK: AST code unchanged in all ${checked} files${scope}`);
    return;
  }
  const note = skipped > 0 ? ` (${skipped} unparseable, not verified)` : "";
  console.log(
    `FAIL: ${list.length} difference(s) in ${checked} files${scope}${note}:`,
  );
  for (const l of list) console.log(l);
  process.exitCode = 1;
}

/**
 * Prints scanned paths, one per line.
 * @param {string[]} allFiles absolute file paths before filtering
 * @param {string} root absolute target root for relative paths
 * @param {string} targetArg original path argument for messages
 * @param {string[]} filters substrings to search for
 * @returns {void}
 */
function runFiles(allFiles, root, targetArg, filters) {
  const { files, empty } = selectFiles(allFiles, root, filters);
  if (empty) {
    console.error(
      `FAIL: no file matched ${filters.join(", ")}, nothing was checked. A filter is a substring of the path relative to ${targetArg}, e.g. "Role/edit.js".`,
    );
    process.exit(1);
  }
  for (const f of files) console.log(relative(root, f));
}

if (cmd === "snapshot") {
  const [targetArg, outPath, ...extra] = rest;
  if (targetArg === undefined || outPath === undefined) {
    console.error(
      `${USAGE}\nmissing ${targetArg === undefined ? "path" : "output"}: snapshot needs <path> <out.json>`,
    );
    process.exit(2);
  }
  if (extra.length > 0) {
    console.error(`${USAGE}\ntoo many arguments for snapshot`);
    process.exit(2);
  }
  const { files, root } = needTree(targetArg);
  runSnapshot(files, root, outPath);
} else if (cmd === "diff") {
  const [targetArg, baselinePath, ...filters] = rest;
  if (targetArg === undefined || baselinePath === undefined) {
    console.error(
      `${USAGE}\nmissing ${targetArg === undefined ? "path" : "baseline"}: diff needs <path> <baseline.json> [filter ...]`,
    );
    process.exit(2);
  }
  const { files, root } = needTree(targetArg);
  runDiff(files, root, targetArg, baselinePath, filters);
} else if (cmd === "files") {
  const [targetArg, ...filters] = rest;
  const { files, root } = needTree(targetArg);
  runFiles(files, root, targetArg, filters);
} else {
  console.error(
    `${USAGE}\nunknown command: ${cmd === undefined ? "(missing)" : cmd}`,
  );
  process.exit(2);
}

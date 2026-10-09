#!/usr/bin/env node
/// Find JS symbols whose JSDoc types are missing or incomplete: classes,
/// functions, methods, class fields, variables. Walks a tree, parses
/// every file and prints one line per symbol:
///     <name> <path relative to <path>>:<line>  <missing annotations>
/// Sorted by path and line, so the output is stable between runs and can be
/// piped into grep or an editor. Only the JSDoc blocks Babel attached to the
/// symbol itself are read, so a comment inside a body or a string never counts.
///
/// WHAT COUNTS AS MISSING
///   A symbol is reported when its JSDoc block lacks the type annotations its
///   kind needs; a symbol with no JSDoc block at all needs all of them.
///     function/method   one `@param` per declared parameter, plus `@returns`
///                       when the function takes at least one parameter
///     constructor       one `@param` per declared parameter, no `@returns`
///     setter            one `@param` per declared parameter
///     getter            nothing: TypeScript reads the type off the body
///     variable/field    `@type`
///     class             the JSDoc block itself, it documents the type
///   Tags are counted, not matched by name: a destructured parameter counts as
///   one `@param` whatever the JSDoc calls the pattern. A standalone `@typedef`
///   or `@callback` block declares a type of its own and therefore documents
///   nothing, not even the symbol that follows it. A cast spells its type next
///   to the value, as in `let n = /** @type {number} */ (input.val());`, and
///   counts as well.
///   Skipped on purpose: anonymous values (inline callbacks, `export default`
///   without a name), object properties, destructuring patterns, declarators
///   without initializer, and any declaration nested inside a function unless
///   `--all` is given.
///
/// WHAT TYPESCRIPT INFERS ON ITS OWN
///   The tool asks for `@type` only where TypeScript has nothing to read:
///     `null`, `undefined`, `void 0`   widen to `any` under strict, and tsc
///                                    reports TS7034/TS7005 for them
///     `[]`, `{}`                       widen to `any[]` and `{}`; tsc stays
///                                    quiet here, it evolves the array from
///                                    later writes, so this row is stricter
///                                    than the compiler on purpose
///     a declarator with no initializer has no type at all, tsc reports TS7008
///   Everything else is left alone, because its type has a source: a builtin
///   type for a literal, the class for `new Date()`, the declared type of a
///   callee or of a member, the type of a referenced symbol, and the types of
///   the operands of an operator. That source is either JSDoc elsewhere in
///   this repository or a `@types` package from tsconfig.json, so these all
///   infer on their own and need no `@type`:
///     const year = new Date().getFullYear();
///     const element = $("#id");
///     const table = initEntityDataTable("#t", options);
///   A symbol whose own type is unstated is reported at its own definition, so
///   asking for `@type` at each of its uses would report one defect once per
///   use rather than once.
///   `@returns` is asked of a function only when it takes parameters: without
///   them TypeScript derives the result from the body alone, so there is
///   nothing left to state. Parameters are never inferred, tsc reports TS7006
///   for them, so they stay required.
///
/// COMMANDS
///   list <path> [filter...]      (default) one line per symbol missing types.
///                           `path` is a directory to walk or a single `.js`
///                           file. `filter`: substring of the path relative
///                           to `path`, repeat to union them. A filter that
///                           matches no file is an error, not a clean result.
///   summary <path> [filter...]   Totals per symbol kind plus the top-40 files.
///
/// FLAGS
///   --all                    Also report declarations nested inside functions.
///                           Default scope: program level and class members.
///
/// EXIT CODES
///   0  every file parsed and nothing was reported
///   1  symbols were reported, a file was skipped, a filter matched nothing,
///      or the path holds no scannable files
///   2  invalid command, invalid flag, missing path, or unreadable path
///
/// EXAMPLES
///   # Everything that still needs JSDoc types
///   ./tools/jsdoc-scan.mjs list ./src
///
///   # One file, locals included
///   ./tools/jsdoc-scan.mjs --all list ./src/http-client.js
///
///   # Narrow to matching files
///   ./tools/jsdoc-scan.mjs --all list ./src http-client.js
///
///   # Where to work next
///   ./tools/jsdoc-scan.mjs summary ./src

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";

const traverse = _traverse.default ?? _traverse;

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

const TYPE_TAG = /@type\s*\{/;
const RETURNS_TAG = /@returns?\s*\{/;
const PARAM_TAG = /@(?:param|arg|argument)\s*\{/g;
// `@typedef` declares a type of its own, so it says nothing about the symbol
// that follows it
const TYPEDEF_TAG = /@(?:typedef|callback)\s*\{/;

const KNOWN_FLAGS = new Set(["--all"]);

// Candidate nodes: declarations that have a name worth documenting
const CANDIDATES = new Set([
  "FunctionDeclaration",
  "ClassDeclaration",
  "VariableDeclarator",
  "ClassMethod",
  "ClassPrivateMethod",
  "ClassProperty",
  "ClassPrivateProperty",
  "ObjectMethod",
]);

// A comment hangs on the outermost node, so an export wrapper and a
// VariableDeclaration own their JSDoc while a VariableDeclarator never does
const DOC_OWNERS = new Set([
  "ExportNamedDeclaration",
  "ExportDefaultDeclaration",
  "VariableDeclaration",
]);

const USAGE = "usage: jsdoc-scan.mjs [--all] [list|summary] <path> [filter ...]";

/**
 * Collects the .js files of a tree, skipping minified ones.
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
 * Whether a file is a scan target: `.js`, excluding minified bundles.
 * @param {string} filePath absolute path of the file
 * @returns {boolean} true when the file is scanned
 */
function isScannable(filePath) {
  return filePath.endsWith(".js") && !filePath.endsWith(".min.js");
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
 * JSDoc block texts of a node and of the parent that owns its comment.
 * Babel hands comments only to the outermost node: for `export const x = 1`
 * that is ExportNamedDeclaration, for `const x = 1` it is VariableDeclaration,
 * so a VariableDeclarator itself never carries any comment.
 * @param {object} node tree node
 * @param {object} [parent] parent of the node in the tree
 * @returns {string[]} comment texts of the JSDoc blocks, delimiters removed
 */
function docBodies(node, parent) {
  const own = node.leadingComments ?? [];
  const inherited = DOC_OWNERS.has(parent?.type)
    ? (parent.leadingComments ?? [])
    : [];
  return [...own, ...inherited]
    .filter(
      (c) => c.type === "CommentBlock" && c.value.trimStart().startsWith("*"),
    )
    .filter((c) => !TYPEDEF_TAG.test(c.value))
    .map((c) => c.value);
}

/**
 * Symbol name: an identifier, a string key or a private `#name` field.
 * @param {object} node tree node
 * @returns {string|null} the name, or null when the symbol is anonymous
 */
function symbolName(node) {
  const key = node.key ?? node.id;
  if (!key) return null;
  if (key.type === "PrivateName") return `#${key.id.name}`;
  if (key.type === "Identifier") return key.name;
  if (key.type === "StringLiteral") return key.value;
  return null;
}

/**
 * Whether TypeScript can read the type of an initializer off the code.
 * Literals, `new`, calls, member accesses, bare identifiers, template and
 * collection literals and operators all have a source: a builtin type, or a
 * symbol that carries its own type, whether that comes from JSDoc in this
 * repository or from a `@types` package listed in tsconfig.json.
 * Only a nullish-only expression and an empty collection have no source at
 * all: `null`, `undefined` and `void 0` widen to `any` under strict, and `[]`
 * and `{}` widen to `any[]` and `{}`.
 * A symbol whose own type is unstated is reported at its own definition, so
 * asking for `@type` again at each of its uses would report one defect once
 * per use.
 * @param {object|null} [init] initializer node of a declarator or of a field
 * @returns {boolean} true when no `@type` is asked for
 */
function inferableInit(init) {
  if (init === null || init === undefined) return false;
  if (init.type === "NullLiteral") return false;
  if (init.type === "Identifier" && init.name === "undefined") return false;
  if (init.type === "UnaryExpression" && init.operator === "void") return false;
  // An empty collection has no element and no property to take a type from
  if (init.type === "ArrayExpression") return init.elements.length > 0;
  if (init.type === "ObjectExpression") return init.properties.length > 0;
  return true;
}
/**
 * Kind of a symbol, the annotations it requires and the initializer a type
 * could be read from. The same source shape arrives here both as
 * `class Foo {}` and as `const Foo = class {}`, so a declarator reports the
 * kind of its init.
 * @param {object} node tree node
 * @returns {{kind: string, params: number, returns: boolean, init: object|null}|null}
 *   requirements, or null for a kind this tool does not document
 */
function requirements(node) {
  switch (node.type) {
    case "FunctionDeclaration": {
      const params = node.params.length;
      return { kind: "function", params, returns: params > 0, init: null };
    }
    case "ClassDeclaration":
      return { kind: "class", params: 0, returns: false, init: null };
    case "ClassMethod":
    case "ClassPrivateMethod":
    case "ObjectMethod": {
      const params = node.params.length;
      if (node.kind === "constructor") {
        return { kind: "constructor", params, returns: false, init: null };
      }
      if (node.kind === "set") {
        return { kind: "setter", params, returns: false, init: null };
      }
      // A getter takes no parameters, so its type is all the body
      if (node.kind === "get") {
        return { kind: "getter", params: 0, returns: false, init: null };
      }
      return { kind: "method", params, returns: params > 0, init: null };
    }
    case "ClassProperty":
    case "ClassPrivateProperty": {
      if (
        node.value?.type === "ArrowFunctionExpression" ||
        node.value?.type === "FunctionExpression"
      ) {
        const params = node.value.params.length;
        return { kind: "method", params, returns: params > 0, init: null };
      }
      return { kind: "field", params: 0, returns: false, init: node.value };
    }
    case "VariableDeclarator": {
      if (node.id?.type !== "Identifier" || node.init === null) return null;
      const init = node.init;
      if (
        init.type === "ArrowFunctionExpression" ||
        init.type === "FunctionExpression"
      ) {
        const params = init.params.length;
        return { kind: "function", params, returns: params > 0, init: null };
      }
      if (init.type === "ClassExpression") {
        return { kind: "class", params: 0, returns: false, init: null };
      }
      return { kind: "variable", params: 0, returns: false, init };
    }
    default:
      return null;
  }
}

/**
 * A symbol inside a function stays out of the report: this code does not give
 * JSDoc to local constants, and listing them would make the output unreadable.
 * @param {object} path node path in the tree
 * @param {boolean} all whether to include declarations inside functions
 * @returns {boolean} true when the declaration belongs in the report
 */
function inScope(path, all) {
  return all || path.findParent((p) => p.isFunction()) === null;
}

/**
 * Checks one node and returns the annotations it lacks.
 * @param {object} path node path to check in the tree
 * @returns {{name: string, kind: string, line: number, missing: string[]}|null}
 *   the symbol found, or null when it is documented
 */
function inspect(path) {
  const { node } = path;
  const req = requirements(node);
  if (req === null) return null;

  const name = symbolName(node);
  if (name === null) return null;

  const bodies = docBodies(node, path.parent);
  // `@type` describes the whole signature and covers every function requirement
  if (bodies.some((b) => TYPE_TAG.test(b))) return null;

  const missing = [];
  if (req.kind === "class") {
    if (bodies.length === 0) missing.push("no-jsdoc");
  } else if (req.kind === "variable" || req.kind === "field") {
    // A cast spells its type next to the value rather than above the
    // declaration, so the initializer carries its own JSDoc block
    const cast = req.init === null ? [] : docBodies(req.init);
    const typed = [...bodies, ...cast].some((b) => TYPE_TAG.test(b));
    if (!typed && !inferableInit(req.init)) missing.push("no-@type");
  } else {
    const params = bodies.reduce(
      (n, b) => n + [...b.matchAll(PARAM_TAG)].length,
      0,
    );
    if (req.params > 0 && params < req.params) missing.push("no-@param");
    if (req.returns && !bodies.some((b) => RETURNS_TAG.test(b))) {
      missing.push("no-@returns");
    }
  }

  if (missing.length === 0) return null;
  return { name, kind: req.kind, line: node.loc.start.line, missing };
}

/**
 * Parses a file and collects every missing annotation.
 * An unreadable file does not abort the run: it is unverified, so it has to
 * surface as SKIPPED rather than as a clean result.
 * @param {string} path path to the file
 * @param {boolean} all whether to include declarations inside functions
 * @returns {{found: {name: string, kind: string, line: number, missing: string[]}[], error: string|null}}
 *   the symbols found, or the parse error
 */
function scanFile(path, all) {
  const found = [];
  try {
    const ast = parse(readFileSync(path, "utf8"), PARSER_OPTIONS);
    traverse(ast, {
      enter(path) {
        if (!CANDIDATES.has(path.node.type)) return;
        if (!inScope(path, all)) return;
        const hit = inspect(path);
        if (hit !== null) found.push(hit);
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { found, error: msg.split("\n")[0] };
  }
  return { found, error: null };
}

const noDashDash = process.argv.slice(2).filter((a) => a !== "--");
const flags = noDashDash.filter((a) => a.startsWith("--"));
const unknown = flags.filter((f) => !KNOWN_FLAGS.has(f));
if (unknown.length > 0) {
  console.error(`${USAGE}\nunknown flag: ${unknown.join(", ")}`);
  process.exit(2);
}
const all = flags.includes("--all");
const nonFlags = noDashDash.filter((a) => !a.startsWith("--"));
let cmd = "list";
let targetArg;
let filters;
if (nonFlags[0] === "list" || nonFlags[0] === "summary") {
  cmd = nonFlags[0];
  [targetArg, ...filters] = nonFlags.slice(1);
} else {
  [targetArg, ...filters] = nonFlags;
}

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

/**
 * Picks files by substrings of their path relative to the target root.
 * @param {string[]} all all scanned files
 * @param {string} root absolute target root for relative paths
 * @param {string[]} filters substrings to search for
 * @returns {{files: string[], empty: boolean}} the matching files, or a flag saying none matched
 */
function selectFiles(all, root, filters) {
  if (filters.length === 0) return { files: all, empty: false };
  const picked = all.filter((f) =>
    filters.some((s) => relative(root, f).includes(s)),
  );
  return { files: picked, empty: picked.length === 0 };
}

const { files, empty } = selectFiles(allFiles, ROOT, filters);
if (empty) {
  console.error(
    `FAIL: no file matched ${filters.join(", ")}, nothing was checked. A filter is a substring of the path relative to ${targetArg}, e.g. "http-client.js".`,
  );
  process.exit(1);
}

const rows = [];
const skipped = [];

for (const file of files) {
  const rel = relative(ROOT, file);
  const { found, error } = scanFile(file, all);
  for (const hit of found) rows.push({ ...hit, file: rel });
  if (error !== null) skipped.push(`${rel}  ${error}`);
}

rows.sort((a, b) =>
  a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1,
);

if (skipped.length > 0) {
  console.log(
    `parsed ${files.length - skipped.length} of ${files.length} files, ${skipped.length} unparseable`,
  );
  for (const s of skipped) console.log(`SKIPPED  ${s}`);
}

if (cmd === "list") {
  for (const r of rows) {
    console.log(`${r.name} ${r.file}:${r.line}  ${r.missing.join(",")}`);
  }
} else {
  const totals = {};
  for (const r of rows) totals[r.kind] = (totals[r.kind] ?? 0) + 1;
  const byFile = new Map();
  for (const r of rows) byFile.set(r.file, (byFile.get(r.file) ?? 0) + 1);
  console.log(`files scanned: ${files.length}`);
  console.log(`symbols missing types: ${rows.length}`);
  for (const kind of Object.keys(totals).sort()) {
    console.log(`  ${kind.padEnd(12)}${totals[kind]}`);
  }
  console.log("\n=== top-40 files ===");
  const top = [...byFile].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  for (const [file, count] of top.slice(0, 40)) {
    console.log(`${String(count).padStart(4)}  ${file}`);
  }
}

if (rows.length > 0 || skipped.length > 0) process.exitCode = 1;

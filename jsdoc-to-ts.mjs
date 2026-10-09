#!/usr/bin/env node
/// Move JSDoc types of `.ts` and `.mts` files into real TypeScript
/// annotations. The tree holds JS bodies in `.ts` files, where tsc ignores
/// JSDoc: every `@param`/`@returns`/`@type` there is prose only, so
/// parameters stay implicit `any` (TS7006) and documented types never check.
/// This tool parses each file with Babel, reads the JSDoc block of every
/// declaration, and inserts the documented type as syntax, keeping the prose:
/// only a consumed `{type}` (and a tag line left without text) is removed.
///
/// WHAT IT CONVERTS
///   `@param {T} name`         `name: T` on the matching parameter
///   `@param {T} [name]`       `name?: T`, unless the code has a default
///   `@param {T} [name=d]`     `name: T`, the default stays in code
///   `@param {...T} rest`      `...rest: T[]`; `{T[]}` stays verbatim.
///                             A tuple rest (`...[a, b]` with `{...[X, Y]}`)
///                             becomes `...[a, b]: [X, Y][]`.
///   `@param {T}` (no name)    documents the lone undocumented parameter,
///                             e.g. single-param callbacks
///   `@param {{a: T}} opts`    `opts` is a destructured pattern: the literal
///                             annotates the pattern itself
///   `@param {object} opts` plus `@param {T} opts.key` sub-tags: builds
///                             `{ key: T, ... }` for the destructured pattern;
///                             every destructured key must resolve, else the
///                             pattern is left alone (annotating it `object`
///                             would fail tsc with TS2339). A rest element in
///                             the pattern (`...rest`) gathers the remainder
///                             under `[key: string]: unknown`. The same shape
///                             is built for a plain parameter documented only
///                             by sub-tags.
///   JSDoc spellings           `*` means `any`, `Object` means `object`,
///                             `Array.<T>`/`Object<K, V>` spell the TS
///                             generics, `function(A, B): R` becomes a function
///                             type, capitalized primitives mean primitives,
///                             `?T`/`T?` mark `| null`. Anything else keeps its
///                             JSDoc spelling.
///   `@this {T}`               `this: T` first parameter of functions and
///                             methods; never on arrows, constructors, getters
///                             and setters
///   statement callback docs   a block above a bare call with a single
///                             function argument documents that argument when
///                             every `@param` name matches one of its
///                             parameters (validator-style registrations)
///   `@returns {R}`            `: R` on functions, methods and arrows; never
///                             on constructors and setters; `this` returns on
///                             methods
///   `@type {T}`               `: T` on a single-declarator variable and on
///                             a class field; `value as T` on an object
///                             property value
///   `/** @type {T} */ (expr)` `expr as T` (`as const` for `{const}`); a cast
///                             addressing a parenthesized group lands after
///                             its closing paren, anything else wraps the
///                             whole subject in parentheses
///   `/** @type {T} */ name`   leading comment of a still untyped parameter
///                             becomes `name: T`
///   `@typedef`/`@callback`    `interface` for object shapes (same-name
///                             interfaces merge across global scripts),
///                             `type` for the rest; blocks inside class bodies
///                             move before the class
///   `this.x = ...`            `declare x: T` field at the top of the class,
///                             typed from a hanging `@type`, the assigned
///                             parameter, a `new` expression or a literal
///                             (`null` initializers defer to later values,
///                             anything else is evolving `any` as in checkJs);
///                             `declare` emits no code, so behavior never
///                             changes
///   `@template ...`           `<T>`, `<T = D>`, `<T extends C = D>` on
///                             functions, arrows, methods and classes; an
///                             `unknown` constraint is dropped
///   A declaration that already carries the annotation is never touched.
///
/// WHAT IT SKIPS (left in place and counted in the summary)
///   blocks with `@overload`: they declare alternate signatures, the
///   implementation docblock is converted on its own
///   a type that does not parse as TypeScript (even after JSDoc mapping):
///   the tag is left verbatim
///   a `@param` name matching no declared parameter, dotted names deeper
///   than one level (`opts.nested.key`), nested patterns in parameters
///   `*.d.ts` files: already declarations, their JSDoc is documentation
///   files using decorators: Babel parses them only with an extra plugin,
///   so they are reported unparsable and left untouched
///
/// HOW IT REWRITES
///   Edits are pure insertions at token boundaries plus JSDoc cleanups, so
///   formatting, line breaks and runtime code never change. A file whose
///   edits overlap is reported and left untouched.
///
/// WORKFLOW
///   Converted types keep their JSDoc spelling except for the legacy forms
///   above, which formatters may restyle once they become code
///   (`number|null` wants spaces), so run the formatter after converting,
///   then the compiler:
///     node jsdoc-to-ts.mjs convert ./src
///     tsc --noEmit -p tsconfig.json
///   tsc errors must drop overall. New errors are surfaced intent, not
///   damage: uses that only checked because a parameter stopped being `any`
///   (narrow the code or fix the docs). If a file gains errors you disagree
///   with, revert it, fix the JSDoc, and convert again: the tool is
///   idempotent. Mechanical leftovers go through the tools pipeline:
///   `tools/tsdup.mjs` for same-name globals across page scripts (TS2393),
///   `tools/tsfix.mjs` to a fixpoint for cast overlap (TS2352), bad annotated
///   initializers (TS2322), untyped parameters (TS7006) and catch variables.
///
/// COMMANDS
///   check <path> [filter...]  (default) one line per pending annotation,
///                           then a summary; writes nothing. `path` is a
///                           directory to walk or a single `.ts`/`.mts` file.
///                           `filter`: substring of the path relative to
///                           `path`, repeat to union them. A filter that
///                           matches no file is an error, not a clean result.
///   convert <path> [filter...] rewrite the files in place, one line per
///                           rewritten file, then a summary
///   files <path> [filter...]  print scanned paths, one per line
///
/// EXIT CODES
///   0  check found nothing pending / convert rewrote without skips
///   1  check found pending annotations, convert skipped a file, no file
///      matched, or the path holds no scannable files
///   2  invalid command, missing path, or unreadable path
///
/// EXAMPLES
///   # What would change in two files
///   ./jsdoc-to-ts.mjs check ./src http-client.ts number-utils.ts
///
///   # Convert one file, then verify: tsc errors must drop, runtime intact
///   ./jsdoc-to-ts.mjs convert ./src/number-utils.ts
///
///   # Convert a whole tree
///   ./jsdoc-to-ts.mjs convert ./src
///

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";

const traverse = _traverse.default ?? _traverse;

const PARSER_OPTIONS = {
  sourceType: "unambiguous",
  allowReturnOutsideFunction: true,
  plugins: ["typescript"],
};

// A comment hangs on the outermost node, so an export wrapper, a declaration
// or a statement owns the JSDoc of the symbol inside it. A declarator never
// owns one: it only passes the walk through to its declaration.
const DOC_OWNERS = new Set([
  "ExportNamedDeclaration",
  "ExportDefaultDeclaration",
  "VariableDeclaration",
  "ExpressionStatement",
  "ReturnStatement",
  "ClassProperty",
  "ClassPrivateProperty",
  "ObjectProperty",
]);

// Transparent wrappers between a function and the statement owning its JSDoc.
// ObjectExpression passes through: a block inside a literal documents the
// inner symbol, while name matching plus single-claim tags keep a block above
// the literal from leaking into unrelated methods.
const DOC_TRANSPARENT = new Set([
  "AssignmentExpression",
  "VariableDeclarator",
  "ObjectExpression",
]);

const EXCLUDED_BLOCK = /@(?:typedef|callback|overload)\b/;

const USAGE =
  "usage: jsdoc-to-ts.mjs [check|convert|files] <path> [filter ...]";

/**
 * Collects the `.ts`/`.mts` files of a tree, skipping declarations.
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
    } else if (
      (entry.endsWith(".ts") || entry.endsWith(".mts")) &&
      !entry.endsWith(".d.ts") &&
      !entry.endsWith(".min.ts") &&
      !entry.endsWith(".min.mts")
    ) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Whether a file is a conversion target: `.ts`/`.mts`, excluding
 * declarations and minified bundles.
 * @param {string} filePath absolute path of the file
 * @returns {boolean} true when the file is scanned
 */
function isScannable(filePath) {
  return (
    (filePath.endsWith(".ts") || filePath.endsWith(".mts")) &&
    !filePath.endsWith(".d.ts") &&
    !filePath.endsWith(".min.ts") &&
    !filePath.endsWith(".min.mts")
  );
}

/**
 * Resolves a CLI target to conversion files: a directory is walked, a single
 * file is taken as is when it has a scannable extension.
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
 * Strips JSDoc continuation-line prefixes (`\n * `) inside a type. Multiline
 * object literals are written one property per `*` line; the prefixes are
 * comment syntax, not type syntax.
 * @param {string} raw type text as written in braces
 * @returns {string} text usable as a TypeScript type
 */
function cleanTypeText(raw) {
  return raw.replace(/\r?\n[ \t]*\*[ \t]?/g, "\n").trim();
}

/**
 * Reads a balanced `{...}` span, ignoring braces inside string literals.
 * @param {string} text text to scan
 * @param {number} open index of the opening brace
 * @param {number} [limit] index to stop at, defaults to the end of the text
 * @returns {{type: string, end: number}|null} inner text and the index after
 *   the closing brace, or null when unbalanced
 */
function readBraced(text, open, limit = text.length) {
  let i = open + 1;
  let depth = 1;
  let quote = null;
  while (i < limit) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === "\\") i += 2;
      else {
        if (ch === quote) quote = null;
        i++;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i++;
    } else if (ch === "{") {
      depth++;
      i++;
    } else if (ch === "}") {
      depth--;
      i++;
      if (depth === 0) return { type: text.slice(open + 1, i - 1), end: i };
    } else {
      i++;
    }
  }
  return null;
}

/**
 * Splits one JSDoc tag name into shape flags: rest marker, optionality with
 * an optional default, and dotted sub-property path.
 * @param {string} raw name token as written after the `{type}`
 * @returns {{name: string, rest: boolean, optional: boolean, hasDefault: boolean, top: string, sub: string[]}}
 *   decoded name
 */
function decodeName(raw) {
  let s = raw;
  let rest = false;
  if (s.startsWith("...")) {
    rest = true;
    s = s.slice(3);
  }
  let optional = false;
  let hasDefault = false;
  if (s.startsWith("[") && s.endsWith("]") && s.length >= 2) {
    optional = true;
    s = s.slice(1, -1);
    const eq = s.indexOf("=");
    if (eq >= 0) {
      hasDefault = true;
      s = s.slice(0, eq);
    }
  }
  const parts = s.split(".");
  return {
    name: s,
    rest,
    optional,
    hasDefault,
    top: parts[0],
    sub: parts.slice(1),
  };
}

/**
 * Splits on a separator ignoring nesting and strings.
 * @param {string} s text
 * @param {string} sep separator char
 * @returns {string[]} parts
 */
function splitTop(s, sep) {
  const out = [];
  let depth = 0;
  let inStr = null;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr !== null) {
      cur += c;
      if (c === inStr && s[i - 1] !== "\\") inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      cur += c;
      continue;
    }
    if (c === "<" || c === "(" || c === "{" || c === "[") depth++;
    else if (c === ">" || c === ")" || c === "}" || c === "]") depth--;
    if (c === sep && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Maps a JSDoc type string to TypeScript syntax: `*` means `any`, a bare
 * `Object` means `object`, `Array.<T>`/`Object<K, V>` spell the TS generics,
 * `function(A, B): R` becomes a function type, capitalized primitives mean
 * primitives, and `?T`/`T?`/`T=` mark nullability. Returns null when the
 * construct is unknown: the tag stays JSDoc for the manual pass.
 * @param {string} raw JSDoc type text
 * @returns {string|null} TS type text, or null when unmappable
 */
function mapJsType(raw) {
  let s = raw.trim();
  if (s === "") return null;
  // Rest element: ...T -> (T)[] (callers on rest positions strip the marker
  // themselves; a `...` surviving here still maps so tuple literals convert).
  let rest = false;
  if (s.startsWith("...")) {
    rest = true;
    s = s.slice(3);
  }
  // Nullable / optional markers.
  let suffix = "";
  if (s.startsWith("?")) {
    s = s.slice(1);
    suffix = " | null";
  } else if (s.endsWith("?") && !s.endsWith("??")) {
    s = s.slice(0, -1);
    suffix = " | null";
  } else if (s.endsWith("=")) {
    s = s.slice(0, -1);
    suffix = " | undefined";
  }
  if (s === "*") s = "any";
  else if (s === "Object") s = "object";
  else {
    s = s.replace(/^Array\.<([\s\S]+)>$/, "Array<$1>");
    s = s.replace(/^Object<([\s\S]+?)>$/, "Record<$1>");
    // function(A, B): R -> (arg0: A, arg1: B) => R
    const fn = s.match(/^function\s*\(([\s\S]*)\)\s*:\s*([\s\S]+)$/);
    if (fn) {
      const parts = splitTop(fn[1], ",");
      const params = parts
        .filter((p) => p.trim() !== "")
        .map((p, i) => {
          const pm = p.trim().match(/^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+)$/);
          if (pm) return `${pm[1]}: ${pm[2]}`;
          return `arg${i}: ${p.trim()}`;
        });
      s = `(${params.join(", ")}) => ${fn[2].trim()}`;
    }
    // Capitalized primitives mean primitives in this tree.
    s = s.replace(/\bString\b/g, "string");
    s = s.replace(/\bNumber\b/g, "number");
    s = s.replace(/\bBoolean\b/g, "boolean");
  }
  if (suffix !== "") s = `(${s})${suffix}`;
  if (rest) s = `(${s})[]`;
  return validType(s) ? s : null;
}

const typeCache = new Map();

/**
 * Whether a JSDoc type string parses as a TypeScript type. Only validated
 * strings are ever inserted, so a weird JSDoc spelling stays a comment.
 * @param {string} text candidate type text
 * @returns {boolean} true when usable as an annotation
 */
function validType(text) {
  const key = text.trim();
  if (key === "") return false;
  const hit = typeCache.get(key);
  if (hit !== undefined) return hit;
  let ok = true;
  try {
    parse(`type __T__ = ${key};`, { plugins: ["typescript"] });
  } catch {
    ok = false;
  }
  typeCache.set(key, ok);
  return ok;
}

/**
 * Whether a JSDoc type string parses as a function return annotation.
 * Predicates (`x is string`, `asserts x`) are no alias types, so they are
 * validated in return position instead.
 * @param {string} text candidate type text
 * @returns {boolean} true when usable after a parameter list
 */
function validReturnType(text) {
  if (validType(text)) return true;
  try {
    parse(`declare function __f__(x: any): ${text.trim()};`, {
      plugins: ["typescript"],
    });
  } catch {
    return false;
  }
  return true;
}

/**
 * Whether a JSDoc type string parses as a method return annotation.
 * `this` types only exist on members, so the alias-position check rejects
 * them even when the documented symbol is a method.
 * @param {string} text candidate type text
 * @returns {boolean} true when usable after a method parameter list
 */
function validMethodReturnType(text) {
  try {
    parse(`class __C__ { __m(): ${text.trim()}; }`, {
      plugins: ["typescript"],
    });
  } catch {
    return false;
  }
  return true;
}

/**
 * Resolves a `@returns` type to the text to insert: the mapped spelling when
 * the JSDoc form translates, otherwise the verbatim spelling when it parses
 * in return position (predicates like `x is string`, or `this` on methods).
 * @param {string} raw type text as written in braces
 * @param {string} kind function kind from fnKind()
 * @returns {string|null} annotation text, or null when unusable
 */
function mapReturnType(raw, kind) {
  const mapped = mapJsType(raw);
  if (mapped !== null) return mapped;
  const text = raw.trim();
  if (validReturnType(raw)) return text;
  if ((kind === "method" || kind === "get") && validMethodReturnType(raw)) {
    return text;
  }
  return null;
}

/**
 * Parses the tags of one JSDoc block. A tag runs from its `@` to the next
 * `@` or the end of the block, so multiline types and descriptions survive.
 * @param {string} body comment text without its delimiters
 * @param {number} base absolute offset of the start of the body in the file
 * @returns {{kind: string, at: number, end: number, brace: {text: string, start: number, end: number}|null, rawName: string, nameStart: number, nameEnd: number, descEmpty: boolean}[]}
 *   tags in document order with absolute offsets
 */
function parseTags(body, base) {
  const atSigns = [];
  // Only `@` at the start of a JSDoc line opens a tag (after optional
  // whitespace and one `*`), plus tags chained on the same line after an
  // accepted one. An `@param` inside prose or an indented code sample
  // documents nothing; without this, example text would convert as tags.
  let chainLineStart = -1;
  for (const m of body.matchAll(/@([A-Za-z]+)/g)) {
    const prev = m.index === 0 ? "" : body[m.index - 1];
    if (prev !== "" && !/\s/.test(prev) && prev !== "*") continue;
    const lineStart = body.lastIndexOf("\n", m.index - 1) + 1;
    const chained = chainLineStart === lineStart;
    if (!chained && !/^[ \t]*\*?[ \t]*$/.test(body.slice(lineStart, m.index))) {
      continue;
    }
    chainLineStart = lineStart;
    atSigns.push({ index: m.index, kind: m[1] });
  }
  const tags = [];
  for (let k = 0; k < atSigns.length; k++) {
    const { index: at, kind } = atSigns[k];
    const spanEnd = k + 1 < atSigns.length ? atSigns[k + 1].index : body.length;
    let i = at + 1 + kind.length;
    // Gap between tag parts: whitespace and `*` opening continuation lines
    const skipGap = () => {
      const starAtLineStart = () => {
        if (body[i] !== "*") return false;
        let q = i - 1;
        while (q >= 0 && (body[q] === " " || body[q] === "\t")) q--;
        return q < 0 || body[q] === "\n" || body[q] === "\r";
      };
      for (;;) {
        while (i < spanEnd && (body[i] === " " || body[i] === "\t")) i++;
        if (body[i] === "\r" || body[i] === "\n") {
          i++;
          continue;
        }
        if (starAtLineStart()) {
          i++;
          continue;
        }
        break;
      }
    };
    skipGap();
    let brace = null;
    if (body[i] === "{") {
      const b = readBraced(body, i, spanEnd);
      if (b !== null) {
        brace = {
          text: cleanTypeText(b.type),
          start: base + i,
          end: base + b.end,
        };
        i = b.end;
      }
    }
    skipGap();
    const n = i;
    let nameEnd = n;
    if (body[n] === "[") {
      // A bracketed (optional) name may hold a quoted default with spaces:
      // scan to its `]`, honouring quotes
      let m = n;
      let quote = null;
      let closed = false;
      while (m < spanEnd) {
        const ch = body[m];
        if (quote !== null) {
          if (ch === "\\") m += 2;
          else {
            if (ch === quote) quote = null;
            m++;
          }
          continue;
        }
        if (ch === '"' || ch === "'") {
          quote = ch;
          m++;
        } else if (ch === "]") {
          m++;
          closed = true;
          break;
        } else if (/\s/.test(ch)) {
          break;
        } else {
          m++;
        }
      }
      nameEnd = closed ? m : n;
    }
    if (nameEnd === n) {
      while (nameEnd < spanEnd && !/\s/.test(body[nameEnd])) nameEnd++;
    }
    const descEmpty = body.slice(nameEnd, spanEnd).replace(/[\s*]/g, "") === "";
    tags.push({
      kind,
      at: base + at,
      end: base + spanEnd,
      brace,
      rawName: body.slice(n, nameEnd),
      nameStart: base + n,
      nameEnd: base + nameEnd,
      descEmpty,
    });
  }
  return tags;
}

/**
 * Matches one `@template` item at a position: `[Name]`, `[Name=Default]` or
 * a bare `Name`. The default is scanned with nesting awareness so commas
 * inside `Map<K, V>` do not end the item early.
 * @param {string} text tag text after `@template`
 * @param {number} from index to start at
 * @returns {{item: {name: string, def: string|null}, next: number}|null}
 *   the item and the index after it, or null when no item starts here
 */
function matchTemplateItem(text, from) {
  let p = from;
  while (p < text.length && /\s/.test(text[p])) p++;
  let bracket = false;
  if (text[p] === "[") {
    bracket = true;
    p++;
    while (p < text.length && /\s/.test(text[p])) p++;
  }
  const name = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(p));
  if (name === null) return null;
  p += name[0].length;
  while (p < text.length && /\s/.test(text[p])) p++;
  let def = null;
  if (bracket && text[p] === "=") {
    p++;
    while (p < text.length && /\s/.test(text[p])) p++;
    const start = p;
    let depth = 0;
    let quote = null;
    while (p < text.length) {
      const ch = text[p];
      if (quote !== null) {
        if (ch === "\\") p += 2;
        else {
          if (ch === quote) quote = null;
          p++;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        p++;
      } else if (ch === "{" || ch === "[" || ch === "(" || ch === "<") {
        depth++;
        p++;
      } else if (ch === "}" || ch === ")" || ch === "]") {
        if (depth === 0) break;
        depth--;
        p++;
      } else if (ch === ">") {
        if (!text.slice(0, p).trimEnd().endsWith("=") && depth > 0) depth--;
        p++;
      } else if (ch === "," && depth === 0) {
        break;
      } else {
        p++;
      }
    }
    def = cleanTypeText(text.slice(start, p));
    if (def === "") return null;
    // A legacy JSDoc spelling in a default converts to its TS form; an
    // unmappable one keeps the whole tag out of the conversion
    const mappedDef = mapJsType(def) ?? (validType(def) ? def : null);
    if (mappedDef === null) return null;
    def = mappedDef;
    while (p < text.length && /\s/.test(text[p])) p++;
  }
  if (bracket) {
    if (text[p] !== "]") return null;
    p++;
  }
  return { item: { name: name[0], def }, next: p };
}

/**
 * Parses an `@template` tag: an optional `{constraint}` plus comma-separated
 * items. Stops at trailing prose (a template documented as
 * `@template [R=Response] R result...` keeps its description).
 * @param {string} text tag text after the `@template` keyword
 * @returns {{items: {name: string, def: string|null}[], constraint: string|null, end: number}|null}
 *   items with the constraint and the length consumed, or null when invalid
 */
function parseTemplate(text) {
  let p = 0;
  while (p < text.length && /\s/.test(text[p])) p++;
  let constraint = null;
  if (text[p] === "{") {
    const b = readBraced(text, p);
    if (b === null) return null;
    constraint = cleanTypeText(text.slice(p + 1, b.end - 1));
    if (constraint !== "") {
      const mappedConstraint =
        mapJsType(constraint) ??
        (validType(constraint) ? constraint : null);
      if (mappedConstraint === null) return null;
      constraint = mappedConstraint;
    }
    p = b.end;
    while (p < text.length && /\s/.test(text[p])) p++;
  }
  const items = [];
  for (;;) {
    const m = matchTemplateItem(text, p);
    if (m === null) break;
    items.push(m.item);
    p = m.next;
    while (p < text.length && /\s/.test(text[p])) p++;
    if (text[p] === ",") {
      p++;
      continue;
    }
    break;
  }
  if (items.length === 0) return null;
  // A remainder starting with `=` means the parse split a nonstandard
  // `Name=Default` without brackets: leave the whole tag alone
  if (text.slice(p).startsWith("=")) return null;
  return { items, constraint, end: p };
}

/**
 * Builds a `<...>` parameter list from parsed template items.
 * @param {{name: string, def: string|null}[]} items template names
 * @param {string|null} constraint shared `{constraint}`, if any
 * @returns {string} parameter list text, safe by construction
 */
function templateText(items, constraint) {
  const ext =
    constraint !== null && constraint !== "" && constraint !== "unknown"
      ? ` extends ${constraint}`
      : "";
  const parts = items.map((it) =>
    it.def === null ? `${it.name}${ext}` : `${it.name}${ext} = ${it.def}`,
  );
  return `<${parts.join(", ")}>`;
}

/**
 * Picks the JSDoc block documenting a node: its own comments plus the ones
 * owned by export wrappers, declarations and statements above it. Blocks
 * declaring their own types (`@typedef`, `@callback`, `@overload`) never
 * document a neighbour; of the rest the nearest one wins.
 * @param {object} path Babel path of the node to document
 * @returns {object|null} comment node, or null when nothing documents it
 */
function ownerDoc(path) {
  const found = [];
  const push = (node) => {
    for (const c of node.leadingComments ?? []) {
      if (c.type === "CommentBlock" && c.value.trimStart().startsWith("*")) {
        found.push(c);
      }
    }
  };
  push(path.node);
  let parent = path.parentPath;
  while (
    parent !== null &&
    (DOC_OWNERS.has(parent.type) || DOC_TRANSPARENT.has(parent.type))
  ) {
    if (DOC_OWNERS.has(parent.type)) push(parent.node);
    parent = parent.parentPath;
  }
  const usable = found.filter((c) => !EXCLUDED_BLOCK.test(c.value));
  usable.sort((a, b) => b.start - a.start);
  return usable.length > 0 ? usable[0] : null;
}

/**
 * Names bound by function parameters, for matching docblock tags.
 * @param {object[]} params parameter nodes
 * @returns {Set<string>} identifier names
 */
function declaredParamNames(params) {
  const names = new Set();
  const walkP = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "Identifier") {
      names.add(n.name);
      return;
    }
    if (n.type === "AssignmentPattern") {
      walkP(n.left);
      return;
    }
    if (n.type === "RestElement") {
      walkP(n.argument);
      return;
    }
    if (n.type === "ObjectPattern") {
      for (const p of n.properties) walkP(p.value ?? p.argument);
      return;
    }
    if (n.type === "ArrayPattern") {
      for (const e of n.elements) walkP(e);
    }
  };
  for (const p of params ?? []) walkP(p);
  return names;
}

/**
 * Docblock of a bare call statement for its lone function argument.
 * Registrations document the callback above the whole statement
 * (`$.validator.addMethod("name", (value, ...) => ...)`), where neither the
 * function nor the call owns the block. Applies only when the call takes
 * exactly one function argument and carries at least one `@param` tag with
 * every named parameter matching a declared parameter, so a block describing
 * the call itself (e.g. above `fetch(url).then((r) => ...)`) never leaks onto
 * an argument.
 * @param {FileConvert} file conversion state
 * @param {object} path Babel path of the function-like node
 * @returns {object|null} comment node, or null when nothing applies
 */
function statementCallbackDoc(file, path) {
  const parent = path.parentPath;
  if (parent === null) return null;
  if (parent.type !== "CallExpression" && parent.type !== "NewExpression") {
    return null;
  }
  const fns = parent.node.arguments.filter(
    (a) =>
      a.type === "FunctionExpression" ||
      a.type === "ArrowFunctionExpression",
  );
  if (fns.length !== 1 || fns[0] !== path.node) return null;
  const stmt = parent.parentPath;
  if (stmt === null || stmt.type !== "ExpressionStatement") return null;
  const blocks = (stmt.node.leadingComments ?? []).filter(
    (c) =>
      c.type === "CommentBlock" &&
      c.value.trimStart().startsWith("*") &&
      !EXCLUDED_BLOCK.test(c.value),
  );
  if (blocks.length === 0) return null;
  const comment = blocks[blocks.length - 1];
  const { tags } = docTags(file, comment);
  const usable = tags.filter(
    (t) => !file.consumedTags.has(`${comment.start}:${t.at}`),
  );
  const paramTags = usable.filter(
    (t) =>
      (t.kind === "param" || t.kind === "arg" || t.kind === "argument") &&
      t.brace !== null,
  );
  if (paramTags.length === 0) return null;
  const declared = declaredParamNames(path.node.params);
  for (const t of paramTags) {
    if (!declared.has(decodeName(t.rawName).top)) return null;
  }
  return comment;
}

/**
 * End offset (exclusive) of the paren group opening at `open`, skipping over
 * string literals. -1 when unbalanced.
 * @param {string} src file text
 * @param {number} open offset of `(`
 * @returns {number} offset just past the matching `)`, or -1
 */
function groupEnd(src, open) {
  let depth = 0;
  let str = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (str !== null) {
      if (c === "\\") i++;
      else if (c === str) str = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      str = c;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Whether a subject is a `this.name = ...` statement at the top level of a
 * class method body: the declare-field pass owns those, not the cast pass.
 * @param {object} path Babel path of the comment-owning node
 * @param {object} subject expression the cast would address
 * @returns {boolean} true when the declare-field pass owns it
 */
function isTopLevelThisAssign(path, subject) {
  if (
    subject.type !== "AssignmentExpression" ||
    subject.operator !== "=" ||
    path.node.type !== "ExpressionStatement"
  ) {
    return false;
  }
  const l = subject.left;
  if (
    l.type !== "MemberExpression" ||
    l.object.type !== "ThisExpression" ||
    l.computed ||
    l.property.type !== "Identifier"
  ) {
    return false;
  }
  const body = path.parentPath;
  if (body === null || body.type !== "BlockStatement") return false;
  const method = body.parentPath;
  if (method === null) return false;
  return (
    method.type === "ClassMethod" || method.type === "ClassPrivateMethod"
  );
}

/**
 * Nearest enclosing symbol for the report.
 * @param {object} path Babel path
 * @returns {string} display name
 */
function enclosingSymbol(path) {
  let p = path;
  while (p !== null) {
    const n = p.node;
    if (
      n.type === "FunctionDeclaration" ||
      n.type === "FunctionExpression" ||
      n.type === "ArrowFunctionExpression" ||
      n.type === "ClassMethod" ||
      n.type === "ClassPrivateMethod" ||
      n.type === "ObjectMethod"
    ) {
      return `${fnName(n)} (${fnKind(n)})`;
    }
    if (n.type === "ClassDeclaration" || n.type === "ClassExpression") {
      return `${n.id !== null ? n.id.name : "(anonymous)"} (class)`;
    }
    if (n.type === "VariableDeclarator" && n.id.type === "Identifier") {
      return `${n.id.name} (variable)`;
    }
    p = p.parentPath;
  }
  return "(top level)";
}

/**
 * Consumes a cast comment: a lone tag vanishes with its comment, prose
 * around the tag survives as an ordinary comment.
 * @param {FileConvert} file conversion state
 * @param {object} comment owning comment node
 * @param {object} tag parsed `@type` tag
 * @returns {void}
 */
function consumeCastComment(file, comment, tag) {
  if (tag.descEmpty) {
    file.removeComment(comment);
    file.cleanedTags++;
  } else {
    cleanTypeTag(file, comment, tag, true, comment.start + 2, comment.end - 2);
  }
}

/**
 * Converts leading single-purpose `/** @type {T} *\/` comments into `as T`
 * assertions. Pure insertions (plus comment cleanup), so runtime code never
 * changes: wrapping adds parentheses, and a cast addressing a parenthesized
 * group lands right after its closing paren.
 * @param {FileConvert} file conversion state
 * @param {object} path Babel path of the comment-owning node
 * @returns {void}
 */
function convertCasts(file, path) {
  const node = path.node;
  if (
    node.leadingComments === null ||
    node.leadingComments === undefined ||
    node.type === "DirectiveLiteral" ||
    node.type === "VariableDeclarator" ||
    node.type === "VariableDeclaration" ||
    node.type === "FunctionDeclaration" ||
    node.type === "ClassDeclaration" ||
    node.type === "ClassProperty" ||
    node.type === "ClassPrivateProperty" ||
    node.type === "ObjectProperty" ||
    node.type === "ClassMethod" ||
    node.type === "ClassPrivateMethod" ||
    node.type === "ObjectMethod" ||
    node.type === "ExportNamedDeclaration" ||
    node.type === "ExportDefaultDeclaration"
  ) {
    return;
  }
  // Single-purpose cast comments only: documented declarations keep theirs
  // (a `@type` next to `@param` annotates a function value, not a cast).
  const candidates = [];
  for (const c of node.leadingComments) {
    if (c.type !== "CommentBlock" || !c.value.trimStart().startsWith("*")) {
      continue;
    }
    if (EXCLUDED_BLOCK.test(c.value)) continue;
    const inner = parseTags(
      file.src.slice(c.start + 2, c.end - 2),
      c.start + 2,
    );
    if (inner.length === 1 && inner[0].kind === "type") {
      candidates.push({ comment: c, tag: inner[0] });
    }
  }
  if (candidates.length === 0) return;
  let subject =
    node.type === "ExpressionStatement"
      ? node.expression
      : node.type === "ReturnStatement" || node.type === "ThrowStatement"
        ? node.argument
        : node;
  if (!subject) return;
  // Function values take `@type` as their annotation, handled (or left) by
  // the declaration passes; a cast on them would bind the wrong node.
  if (
    subject.type === "FunctionExpression" ||
    subject.type === "ArrowFunctionExpression"
  ) {
    return;
  }
  if (isTopLevelThisAssign(path, subject)) return;
  // Binding positions, keys and declarator ids never cast.
  const parent = path.parent;
  if (parent) {
    if (
      parent.type === "ObjectProperty" &&
      parent.key === subject &&
      !parent.computed
    ) {
      return;
    }
    if (
      (parent.type === "ClassMethod" ||
        parent.type === "ClassPrivateMethod" ||
        parent.type === "ObjectMethod") &&
      parent.key === subject
    ) {
      return;
    }
    if (
      parent.type === "MemberExpression" &&
      parent.property === subject &&
      !parent.computed
    ) {
      return;
    }
    if (parent.type === "VariableDeclarator" && parent.id === subject) {
      return;
    }
    if (
      (parent.type === "FunctionDeclaration" ||
        parent.type === "FunctionExpression" ||
        parent.type === "ArrowFunctionExpression" ||
        parent.type === "ClassMethod" ||
        parent.type === "ClassPrivateMethod" ||
        parent.type === "ObjectMethod") &&
      (parent.params ?? []).includes(subject)
    ) {
      return;
    }
  }
  const t = subject.type;
  if (
    !(
      t.endsWith("Expression") ||
      t.endsWith("Literal") ||
      t === "TemplateLiteral" ||
      t === "Identifier"
    )
  ) {
    return;
  }
  const wrapsOperand =
    t === "AssignmentExpression" ||
    t === "SequenceExpression" ||
    t === "YieldExpression" ||
    t === "AwaitExpression";
  const symbol = enclosingSymbol(path);
  const wraps = [];
  for (const { comment, tag } of candidates) {
    const ckey = `${comment.start}:${tag.at}`;
    if (file.consumedTags.has(ckey)) continue;
    let mapped;
    if (tag.brace !== null) {
      if (tag.brace.text.trim() === "const") {
        mapped = "const";
      } else {
        mapped = mapJsType(tag.brace.text);
      }
    } else {
      // Bare `@type Name`: checkJs reads the type to the end of the comment.
      const rest = file.src.slice(tag.at + "@type".length, tag.end).trim();
      if (!/^[A-Za-z_$]/.test(rest)) continue;
      mapped = mapJsType(rest);
    }
    if (mapped === null) {
      file.leave("invalid-type");
      continue;
    }
    const asText = mapped === "const" ? " as const" : ` as ${mapped}`;
    // A cast addresses the parenthesized group right after it: when that
    // group is narrower than the subject (`/** @type */ (el).files`), when
    // it holds another cast (`/** {A} */ (/** {B} */ (x))` nests as
    // `((x as B) as A)`), or when the subject would misbind a wrap (an
    // assignment casts its whole group cleanly), the group itself is
    // wrapped: appending `as T` after the group would glue a following
    // `.member` onto the type (`X as T.prop` reads `T.prop` as the type).
    // Anything else wraps the whole subject. Extra parentheses either way;
    // identical runtime.
    let j = comment.end;
    while (j < file.src.length && /\s/.test(file.src[j])) j++;
    if (file.src[j] === "(") {
      const g = groupEnd(file.src, j);
      if (g !== -1) {
        const narrower = subject.end > g;
        const nested =
          !narrower && file.src.slice(j, g).includes("@type");
        if (narrower || nested || (wrapsOperand && subject.end <= g)) {
          file.edits.push({ start: j, end: j, text: "(" });
          file.edits.push({ start: g, end: g, text: `${asText})` });
          file.annotations.push({
            line: file.lineOf(j),
            symbol,
            action: `cast${asText}`,
          });
          file.consumedTags.add(ckey);
          consumeCastComment(file, comment, tag);
          continue;
        }
      }
    }
    if (wrapsOperand) {
      file.leave("unsupported-cast");
      continue;
    }
    wraps.push({ comment, tag, ckey, asText });
  }
  // Stacked casts on one subject nest in source order (`/** {A} */ /** {B} */`
  // becomes `((x as B) as A)`): opens emit first, closers in reverse.
  for (let k = 0; k < wraps.length; k++) {
    file.edits.push({ start: subject.start, end: subject.start, text: "(" });
  }
  for (let i = wraps.length - 1; i >= 0; i--) {
    const w = wraps[i];
    file.edits.push({
      start: subject.end,
      end: subject.end,
      text: `${w.asText})`,
    });
    file.annotations.push({
      line: file.lineOf(subject.start),
      symbol,
      action: `cast${w.asText}`,
    });
    file.consumedTags.add(w.ckey);
    consumeCastComment(file, w.comment, w.tag);
  }
}

/**
 * Converts `@type` on one object-literal property: the value carries the
 * assertion, as in checkJs (`{key: value as T}`).
 * @param {FileConvert} file conversion state
 * @param {object} path Babel path of the property node
 * @returns {void}
 */
function convertObjectPropType(file, path) {
  const node = path.node;
  if (path.parent.type !== "ObjectExpression") return;
  const value = node.value;
  if (
    !value ||
    value.type === "FunctionExpression" ||
    value.type === "ArrowFunctionExpression"
  ) {
    return;
  }
  const keyName =
    node.computed || node.key.type !== "Identifier"
      ? "(computed)"
      : node.key.name;
  if (node.shorthand) {
    const comment = ownerDoc(path);
    if (comment === null) return;
    const { tags } = docTags(file, comment);
    if (
      tags.some(
        (t) =>
          t.kind === "type" &&
          !file.consumedTags.has(`${comment.start}:${t.at}`),
      )
    ) {
      file.leave("shorthand-@type");
    }
    return;
  }
  const comment = ownerDoc(path);
  if (comment === null) return;
  const { tags, bodyStart, bodyEnd } = docTags(file, comment);
  const key = `${comment.start}`;
  const tag = tags.find(
    (t) =>
      t.kind === "type" &&
      t.brace !== null &&
      !file.consumedTags.has(`${key}:${t.at}`),
  );
  if (tag === undefined) return;
  const mapped = mapJsType(tag.brace.text);
  if (mapped === null) {
    file.leave("invalid-type");
    return;
  }
  file.insert(
    value.end,
    ` as ${mapped}`,
    `${keyName} (property)`,
    `prop as ${mapped}`,
  );
  file.consumedTags.add(`${key}:${tag.at}`);
  cleanTypeTag(file, comment, tag, true, bodyStart, bodyEnd);
}

/**
 * Short display name of a function-like node for the report.
 * @param {object} node Babel node
 * @returns {string} name or a placeholder for anonymous symbols
 */
function fnName(node) {
  const key = node.key ?? node.id;
  if (key !== null && key !== undefined) {
    if (key.type === "PrivateName") return `#${key.id.name}`;
    if (key.type === "Identifier") return key.name;
    if (key.type === "StringLiteral") return key.value;
  }
  return "(anonymous)";
}

/**
 * Kind label of a function-like node for the report.
 * @param {object} node Babel node
 * @returns {string} function, method, constructor, getter, setter or arrow
 */
function fnKind(node) {
  if (node.type === "ArrowFunctionExpression") return "arrow";
  if (
    node.type === "ClassMethod" ||
    node.type === "ClassPrivateMethod" ||
    node.type === "ObjectMethod"
  ) {
    return node.kind === "method" ? "method" : node.kind;
  }
  return "function";
}

/**
 * Classifies one declared parameter for annotation.
 * @param {object} param Babel parameter node
 * @returns {{id: object, hasDefault: boolean, isRest: boolean}|{pattern: object, hasDefault: boolean, isRest?: boolean}|{skip: true}}
 *   how the parameter can carry a type
 */
function classifyParam(param) {
  if (param.type === "Identifier") {
    return { id: param, hasDefault: false, isRest: false };
  }
  if (param.type === "RestElement") {
    if (param.argument.type === "Identifier") {
      return { id: param.argument, hasDefault: false, isRest: true };
    }
    // Tuple rest (`...[a, b]`): the element type comes from the tag with
    // the same `...`-marker rules as identifier rest
    if (param.argument.type === "ArrayPattern") {
      return { pattern: param.argument, hasDefault: false, isRest: true };
    }
    return { skip: true };
  }
  if (param.type === "AssignmentPattern") {
    if (param.left.type === "Identifier") {
      return { id: param.left, hasDefault: true, isRest: false };
    }
    if (
      param.left.type === "ObjectPattern" ||
      param.left.type === "ArrayPattern"
    ) {
      return { pattern: param.left, hasDefault: true };
    }
    return { skip: true };
  }
  if (param.type === "ObjectPattern" || param.type === "ArrayPattern") {
    return { pattern: param, hasDefault: false };
  }
  return { skip: true };
}

/**
 * Whether a type text is a bare object placeholder that must never annotate
 * a destructured pattern: tsc rejects every destructured key on it.
 * @param {string} text type text from JSDoc braces
 * @returns {boolean} true for `object`, `Object` and `{}`
 */
function isBareObject(text) {
  const t = text.trim();
  return t === "object" || t === "Object" || t === "{}";
}

/**
 * Display text of a destructured key inside a synthesized object type.
 * @param {string} name key name
 * @returns {string} source text, quoted when not an identifier
 */
function propText(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

/**
 * Per-file conversion state: source text, line table, collected annotation
 * inserts and per-comment JSDoc cleanups. Tags are marked consumed so two
 * symbols sharing one JSDoc block cannot claim the same tag twice.
 */
class FileConvert {
  /**
   * @param {string} src file text
   * @param {string} rel path relative to the target root for the report
   */
  constructor(src, rel) {
    this.src = src;
    this.rel = rel;
    this.lineStarts = [0];
    for (let i = 0; i < src.length; i++) {
      if (src[i] === "\n") this.lineStarts.push(i + 1);
    }
    this.edits = [];
    this.commentOps = new Map();
    this.annotations = [];
    this.cleanedTags = 0;
    this.left = {};
    this.consumedTags = new Set();
    this.classRanges = [];
  }

  /**
   * Counts a tag left in place, grouped by reason for the summary.
   * @param {string} reason why the tag was not converted
   * @returns {void}
   */
  leave(reason) {
    this.left[reason] = (this.left[reason] ?? 0) + 1;
  }

  /**
   * Line number of an absolute offset, 1-based.
   * @param {number} offset offset in the file text
   * @returns {number} line number
   */
  lineOf(offset) {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if (this.lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  /**
   * Body line index (0-based within the comment body) of a file line index.
   * @param {number} bodyStart absolute start of the comment body
   * @param {number} fileLine 0-based file line index
   * @returns {number} 0-based body line index
   */
  bodyLineOf(bodyStart, fileLine) {
    return fileLine - (this.lineOf(bodyStart) - 1);
  }

  /**
   * Queues a pure insertion at a token boundary.
   * @param {number} at absolute offset to insert at
   * @param {string} text text to insert
   * @param {string} symbol documented symbol for the report
   * @param {string} action what was annotated, for the report
   * @returns {void}
   */
  insert(at, text, symbol, action) {
    this.edits.push({ start: at, end: at, text });
    this.annotations.push({ line: this.lineOf(at), symbol, action });
  }

  /**
   * Queues JSDoc cleanup for one comment; materialized later by finalize().
   * @param {object} comment Babel comment node
   * @param {object} op cleanup op for the comment
   * @returns {void}
   */
  op(comment, op) {
    const entry = this.commentOps.get(comment.start) ?? { comment, ops: [] };
    entry.ops.push(op);
    this.commentOps.set(comment.start, entry);
    this.cleanedTags++;
  }

  /**
   * Removes a whole consumed tag: full lines when the tag owns them, a bare
   * span when it shares lines with surviving text.
   * @param {object} comment owning comment node
   * @param {object} tag parsed tag with absolute offsets
   * @param {number} bodyStart absolute start of the comment body
   * @param {number} bodyEnd absolute end of the comment body
   * @returns {void}
   */
  removeTag(comment, tag, bodyStart, bodyEnd) {
    const l0 = this.lineOf(tag.at) - 1;
    // Owned lines end before the line holding the next tag (or the `*/`
    // line for the last tag): removing whole lines must never eat those
    const endLine = this.lineOf(Math.min(tag.end, bodyEnd)) - 1 - 1;
    const prefix = this.src
      .slice(this.lineStarts[l0], tag.at)
      .replace(/^[ \t]*\*?/, "");
    if (prefix.trim() === "" && endLine >= l0) {
      this.op(comment, {
        type: "lines",
        b0: this.bodyLineOf(bodyStart, l0),
        b1: this.bodyLineOf(bodyStart, endLine),
        start: this.lineStarts[l0],
        end: this.lineStarts[endLine + 1],
      });
    } else {
      this.op(comment, {
        type: "span",
        start: tag.at,
        end: Math.min(tag.end, bodyEnd),
        text: "",
      });
    }
  }

  /**
   * Emits queued comment cleanups as file edits: whole-comment removal when
   * nothing but blank `*` lines remains, otherwise the tag edits as queued.
   * Pre-existing blank `*` lines are never touched. Ranges are disjoint by
   * construction: whole-line removals cover tag lines only, span edits live
   * inside surviving tag lines.
   * @returns {void}
   */
  finalize() {
    for (const { comment, ops } of this.commentOps.values()) {
      const bodyStart = comment.start + 2;
      const bodyEnd = comment.end - 2;
      const lines = this.src.slice(bodyStart, bodyEnd).split("\n");
      const removed = new Set();
      for (const op of ops) {
        if (op.type === "lines") {
          for (let l = op.b0; l <= op.b1; l++) removed.add(l);
        }
      }
      const blank = (line) => /^\s*\*?\s*$/.test(line);
      // A single-line comment only ever holds span ops: apply them to the
      // line copy, so `/** @type {X} */` tests as the husk it becomes
      if (lines.length === 1) {
        let line = lines[0];
        const spans = ops
          .filter((op) => op.type === "span")
          .sort((a, b) => b.start - a.start);
        for (const s of spans) {
          line =
            line.slice(0, s.start - bodyStart) +
            s.text +
            line.slice(s.end - bodyStart);
        }
        if (blank(line)) {
          this.removeComment(comment);
          continue;
        }
      }
      const alive = lines.map((_, i) => i).filter((i) => !removed.has(i));
      const kept = alive.filter((i) => !blank(lines[i]));
      if (kept.length === 0) {
        this.removeComment(comment);
        continue;
      }
      for (const op of ops) {
        if (op.type === "lines") {
          this.edits.push({ start: op.start, end: op.end, text: "" });
        } else {
          this.edits.push({ start: op.start, end: op.end, text: op.text });
        }
      }
    }
    this.commentOps.clear();
  }

  /**
   * Removes a whole comment node, swallowing its line when it holds nothing
   * else and one following newline when the rest of the line is blank.
   * @param {object} comment Babel comment node
   * @returns {void}
   */
  removeComment(comment) {
    const lineIdx = this.lineOf(comment.start) - 1;
    const start =
      this.src.slice(this.lineStarts[lineIdx], comment.start).trim() === ""
        ? this.lineStarts[lineIdx]
        : comment.start;
    const tail = /^[ \t]*\r?\n?/.exec(this.src.slice(comment.end))[0];
    const end = tail.trim() === "" ? comment.end + tail.length : comment.end;
    this.edits.push({ start, end, text: "" });
  }
}

/**
 * Finds the convertible tags of a docblock that this run has not consumed.
 * @param {FileConvert} file conversion state
 * @param {object} comment Babel comment node
 * @returns {{tags: object[], bodyStart: number, bodyEnd: number}} usable tags
 */
function docTags(file, comment) {
  const bodyStart = comment.start + 2;
  const bodyEnd = comment.end - 2;
  const tags = parseTags(file.src.slice(bodyStart, bodyEnd), bodyStart).filter(
    (t) => !file.consumedTags.has(`${comment.start}:${t.at}`),
  );
  return { tags, bodyStart, bodyEnd };
}

/**
 * Cleans a consumed `@param` tag: drops `{type}` and JSDoc-only name
 * markers when prose follows, removes the whole tag otherwise.
 * @param {FileConvert} file conversion state
 * @param {object} comment owning comment node
 * @param {object} tag parsed tag
 * @param {object} info decoded name
 * @param {number} bodyStart absolute start of the comment body
 * @param {number} bodyEnd absolute end of the comment body
 * @returns {void}
 */
function cleanParamTag(file, comment, tag, info, bodyStart, bodyEnd) {
  if (tag.descEmpty) {
    file.removeTag(comment, tag, bodyStart, bodyEnd);
    return;
  }
  const plain = info.rest || info.optional ? info.name : tag.rawName;
  // The space before `{` stays: replace `{type} name` with the plain name
  const before = file.src[tag.brace.start - 1];
  const text = before === " " || before === "\t" ? plain : ` ${plain}`;
  file.op(comment, {
    type: "span",
    start: tag.brace.start,
    end: tag.nameEnd,
    text,
  });
}

/**
 * Whether prose follows a consumed tag after its `{type}`. `@type` and
 * `@returns` take no name, so the first word past the braces is prose, not
 * a name: only `*` and whitespace mean the tag stands alone.
 * @param {FileConvert} file conversion state
 * @param {object} tag parsed tag
 * @returns {boolean} true when nothing follows the braces
 */
function tailEmpty(file, tag) {
  return file.src.slice(tag.brace.end, tag.end).replace(/[\s*]/g, "") === "";
}

/**
 * Cleans a consumed `@returns`/`@type` tag: drops the keyword through the
 * `{type}` when prose follows, removes the whole tag otherwise.
 * @param {FileConvert} file conversion state
 * @param {object} comment owning comment node
 * @param {object} tag parsed tag
 * @param {boolean} withKeyword whether to drop the tag keyword as well
 * @param {number} bodyStart absolute start of the comment body
 * @param {number} bodyEnd absolute end of the comment body
 * @returns {void}
 */
function cleanTypeTag(file, comment, tag, withKeyword, bodyStart, bodyEnd) {
  if (tailEmpty(file, tag)) {
    file.removeTag(comment, tag, bodyStart, bodyEnd);
    return;
  }
  let end = tag.brace.end;
  while (file.src[end] === " " || file.src[end] === "\t") end++;
  file.op(comment, {
    type: "span",
    start: withKeyword ? tag.at : tag.brace.start,
    end,
    text: "",
  });
}

/**
 * Converts the `@template` tag of a documented node into `<...>` type
 * parameters at the anchor. Consumes the first parseable tag only.
 * @param {FileConvert} file conversion state
 * @param {object} comment owning comment node
 * @param {object} tag parsed `@template` tag
 * @param {number} anchor absolute offset to insert at
 * @param {string} symbol documented symbol for the report
 * @param {number} bodyStart absolute start of the comment body
 * @param {number} bodyEnd absolute end of the comment body
 * @returns {boolean} true when a tag was consumed
 */
function convertTemplate(
  file,
  comment,
  tag,
  anchor,
  symbol,
  bodyStart,
  bodyEnd,
) {
  // From the keyword: the generic tag parser mistakes `{constraint}` for a
  // tag brace, so parseTemplate reads the constraint itself
  const base = tag.at + "@template".length;
  const parsed = parseTemplate(file.src.slice(base, tag.end));
  if (parsed === null) {
    file.leave("invalid-template");
    return false;
  }
  const text = templateText(parsed.items, parsed.constraint);
  file.insert(anchor, text, symbol, `template ${text}`);
  file.consumedTags.add(`${comment.start}:${tag.at}`);
  const headerEnd = base + parsed.end;
  if (file.src.slice(headerEnd, tag.end).replace(/[\s*]/g, "") === "") {
    file.removeTag(comment, tag, bodyStart, bodyEnd);
  } else {
    let end = headerEnd;
    while (file.src[end] === " " || file.src[end] === "\t") end++;
    file.op(comment, { type: "span", start: tag.at, end, text: "" });
  }
  return true;
}

/**
 * Offset of the `(` opening the parameter list: the parenthesis right
 * before the first parameter, or the first one after the name when the
 * function takes no parameters.
 * @param {FileConvert} file conversion state
 * @param {object} node function-like node
 * @returns {number|null} offset of `(`, or null when not found
 */
function parenBefore(file, node) {
  if (node.params.length === 0) {
    const from =
      node.id !== null && node.id !== undefined
        ? node.id.end
        : node.type === "ArrowFunctionExpression"
          ? node.start
          : node.key !== undefined
            ? node.key.end
            : node.start;
    const open = file.src.indexOf("(", from);
    if (open < 0 || open > node.end) return null;
    return open;
  }
  const first = node.params[0].start;
  let p = first - 1;
  while (p >= node.start && /[\s]/.test(file.src[p])) p--;
  if (file.src[p] !== "(") return null;
  return p;
}

/**
 * Anchor for a `<...>` insertion: after the name, or before the parameter
 * list when anonymous.
 * @param {FileConvert} file conversion state
 * @param {object} node function, method or class node
 * @returns {number|null} absolute offset, or null when not placeable
 */
function templateAnchor(file, node) {
  if (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "TSDeclareFunction"
  ) {
    if (node.id !== null) return node.id.end;
    return parenBefore(file, node);
  }
  if (node.type === "ArrowFunctionExpression") {
    return parenBefore(file, node);
  }
  if (
    node.type === "ClassMethod" ||
    node.type === "ObjectMethod" ||
    node.type === "ClassPrivateMethod"
  ) {
    let at = node.key.end;
    if (file.src[at] === "?") at++;
    return at;
  }
  if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
    if (node.id !== null) return node.id.end;
    return null;
  }
  return null;
}

/**
 * Offset of the `=>` of an arrow: trivia (and comments) between the
 * parameter list and the arrow are skipped, so a comment there cannot hide
 * the anchor. Between the parameters and `=>` only `)`, `,` and trivia can
 * legally appear.
 * @param {FileConvert} file conversion state
 * @param {object} node arrow node
 * @returns {number|null} offset of `=`, or null when not found
 */
function arrowReturnAnchor(file, node) {
  const src = file.src;
  let p;
  if (node.params.length === 0) {
    const open = parenBefore(file, node);
    if (open === null) return null;
    p = open + 1;
  } else {
    p = node.params[node.params.length - 1].end;
  }
  for (;;) {
    while (p < src.length && /\s/.test(src[p])) p++;
    if (src.startsWith("//", p)) {
      const nl = src.indexOf("\n", p + 2);
      p = nl < 0 ? src.length : nl + 1;
      continue;
    }
    if (src.startsWith("/*", p)) {
      const end = src.indexOf("*/", p + 2);
      if (end < 0) return null;
      p = end + 2;
      continue;
    }
    if (src[p] === "," || src[p] === ")") {
      p++;
      continue;
    }
    break;
  }
  return src[p] === "=" && src[p + 1] === ">" ? p : null;
}

/**
 * Offset to insert a return type at: before `{` of a block body, or before
 * `=>` of an arrow (both block and expression bodies annotate parameters).
 * @param {FileConvert} file conversion state
 * @param {object} node function-like node with a body
 * @returns {number|null} absolute offset, or null when not placeable
 */
function returnAnchor(file, node) {
  if (node.body === null || node.body === undefined) return null;
  if (node.type === "ArrowFunctionExpression") {
    return arrowReturnAnchor(file, node);
  }
  if (node.body.type !== "BlockStatement") return null;
  return node.body.start;
}

/**
 * Whether a `<...>` may be placed on a node: never on constructors,
 * getters and setters.
 * @param {object} node function-like or class node
 * @returns {boolean} true when type parameters are placeable
 */
function allowsTemplate(node) {
  if (
    node.type === "ClassMethod" ||
    node.type === "ObjectMethod" ||
    node.type === "ClassPrivateMethod"
  ) {
    return node.kind === "method";
  }
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "TSDeclareFunction" ||
    node.type === "ArrowFunctionExpression" ||
    node.type === "ClassDeclaration" ||
    node.type === "ClassExpression"
  );
}

/**
 * Converts one function-like node: template, parameters and returns.
 * @param {FileConvert} file conversion state
 * @param {object} path Babel path of the function-like node
 * @returns {void}
 */
function convertFunction(file, path) {
  const node = path.node;
  const kind = fnKind(node);
  const symbol = `${fnName(node)} (${kind})`;
  const comment = ownerDoc(path) ?? statementCallbackDoc(file, path);
  if (comment !== null) {
    const { tags, bodyStart, bodyEnd } = docTags(file, comment);
    const key = `${comment.start}`;
    const isTpl = (t) => t.kind === "template";
    const isRet = (t) =>
      (t.kind === "returns" || t.kind === "return") && t.brace !== null;

    // @this -> this param (never on arrows, constructors, getters, setters).
    if (
      node.type !== "ArrowFunctionExpression" &&
      kind !== "constructor" &&
      kind !== "get" &&
      kind !== "set"
    ) {
      const first = node.params[0];
      const explicit =
        first !== undefined &&
        first.type === "Identifier" &&
        first.name === "this";
      if (!explicit) {
        const ti = tags.findIndex(
          (t) =>
            t.kind === "this" &&
            t.brace !== null &&
            !file.consumedTags.has(`${key}:${t.at}`),
        );
        if (ti !== -1) {
          const mapped = mapJsType(tags[ti].brace.text);
          if (mapped !== null) {
            if (node.params.length > 0) {
              file.insert(
                first.start,
                `this: ${mapped}, `,
                symbol,
                `this: ${mapped}`,
              );
            } else {
              const open = parenBefore(file, node);
              if (open === null) {
                file.leave("no-this-anchor");
              } else {
                file.insert(
                  open + 1,
                  `this: ${mapped}`,
                  symbol,
                  `this: ${mapped}`,
                );
              }
            }
            file.consumedTags.add(`${key}:${tags[ti].at}`);
            cleanTypeTag(file, comment, tags[ti], true, bodyStart, bodyEnd);
          } else {
            file.leave("invalid-this");
          }
        }
      }
    }

    if (node.typeParameters === null || node.typeParameters === undefined) {
      if (allowsTemplate(node)) {
        for (const t of tags.filter(isTpl)) {
          if (file.consumedTags.has(`${key}:${t.at}`)) continue;
          const anchor = templateAnchor(file, node);
          if (anchor === null) {
            file.leave("no-template-anchor");
            continue;
          }
          if (
            convertTemplate(
              file,
              comment,
              t,
              anchor,
              symbol,
              bodyStart,
              bodyEnd,
            )
          ) {
            break;
          }
        }
      } else if (tags.some(isTpl)) {
        file.leave("template-not-allowed");
      }
    } else if (tags.some(isTpl)) {
      file.leave("already-has-type-params");
    }

    const paramTags = tags.filter(
      (t) =>
        (t.kind === "param" || t.kind === "arg" || t.kind === "argument") &&
        t.brace !== null &&
        !file.consumedTags.has(`${key}:${t.at}`),
    );
    convertParams(file, node, symbol, paramTags, comment, bodyStart, bodyEnd, {
      isSetter: kind === "set",
    });

    for (const t of tags.filter(isRet)) {
      if (file.consumedTags.has(`${key}:${t.at}`)) continue;
      if (kind === "constructor" || kind === "set") {
        file.leave("returns-not-allowed");
        continue;
      }
      if (node.returnType !== null && node.returnType !== undefined) {
        file.leave("already-annotated");
        continue;
      }
      const type = mapReturnType(t.brace.text, kind);
      if (type === null) {
        file.leave("invalid-type");
        continue;
      }
      const anchor = returnAnchor(file, node);
      if (anchor === null) {
        file.leave("no-return-anchor");
        continue;
      }
      if (
        node.type === "ArrowFunctionExpression" &&
        isBareArrowParam(file, node)
      ) {
        // An unparenthesized parameter cannot hold `: R` unless the parameter
        // conversion wrapped it in parentheses just above
        const wrapped = file.edits.some(
          (e) =>
            e.start === node.params[0].start &&
            e.end === node.params[0].end &&
            e.text.startsWith("("),
        );
        if (!wrapped) {
          file.leave("unparenthesized-arrow");
          continue;
        }
      }
      // `) {` and `) =>` carry a space the annotation absorbs: `): R {`.
      // A wrapped bare parameter (`(x: T) =>`) absorbs it the same way.
      const wrappedBare =
        node.type === "ArrowFunctionExpression" && isBareArrowParam(file, node);
      if (
        (file.src[anchor - 1] === " " || file.src[anchor - 1] === "\t") &&
        (file.src[anchor - 2] === ")" || wrappedBare)
      ) {
        file.edits.push({
          start: anchor - 1,
          end: anchor,
          text: `: ${type} `,
        });
        file.annotations.push({
          line: file.lineOf(anchor),
          symbol,
          action: `returns ${type}`,
        });
      } else {
        file.insert(anchor, `: ${type}`, symbol, `returns ${type}`);
      }
      file.consumedTags.add(`${key}:${t.at}`);
      if (tailEmpty(file, t)) file.removeTag(comment, t, bodyStart, bodyEnd);
      else cleanTypeTag(file, comment, t, false, bodyStart, bodyEnd);
      break;
    }
  }

  convertInlineParamTypes(file, path, symbol);
}

/**
 * Converts leading `/** @type {T} *\/` comments of still untyped parameters.
 * @param {FileConvert} file conversion state
 * @param {object} path Babel path of the function-like node
 * @param {string} symbol documented symbol for the report
 * @returns {void}
 */
function convertInlineParamTypes(file, path, symbol) {
  for (const param of path.node.params) {
    const target =
      param.type === "Identifier"
        ? param
        : param.type === "AssignmentPattern" && param.left.type === "Identifier"
          ? param.left
          : param.type === "RestElement" && param.argument.type === "Identifier"
            ? param.argument
            : null;
    if (target === null) continue;
    if (target.typeAnnotation !== null && target.typeAnnotation !== undefined) {
      continue;
    }
    if (
      file.edits.some(
        (e) =>
          e.start === e.end && e.start === target.end && e.text.startsWith(":"),
      )
    ) {
      continue;
    }
    const inline = (target.leadingComments ?? []).find(
      (c) =>
        c.type === "CommentBlock" &&
        c.value.trimStart().startsWith("*") &&
        !EXCLUDED_BLOCK.test(c.value),
    );
    if (inline === undefined) continue;
    const inner = parseTags(
      file.src.slice(inline.start + 2, inline.end - 2),
      inline.start + 2,
    );
    if (inner.length !== 1 || inner[0].kind !== "type") continue;
    const brace = inner[0].brace;
    if (brace === null) continue;
    const type = mapJsType(brace.text);
    if (type === null) {
      file.leave("invalid-type");
      continue;
    }
    file.insert(
      target.end,
      `: ${type}`,
      symbol,
      `param ${target.name}: ${type}`,
    );
    file.edits.push({ start: inline.start, end: inline.end, text: "" });
    if (file.src[inline.end] === " ") {
      file.edits.push({ start: inline.end, end: inline.end + 1, text: "" });
    }
    file.cleanedTags++;
  }
}

/**
 * Converts the parameters of one function-like node from `@param` tags.
 * @param {FileConvert} file conversion state
 * @param {object} node function-like node
 * @param {string} symbol documented symbol for the report
 * @param {object[]} paramTags unused `@param` tags of the docblock
 * @param {object} comment owning comment node
 * @param {number} bodyStart absolute start of the comment body
 * @param {number} bodyEnd absolute end of the comment body
 * @param {{isSetter: boolean}} opts setter parameters never take `?`
 * @returns {void}
 */
function convertParams(
  file,
  node,
  symbol,
  paramTags,
  comment,
  bodyStart,
  bodyEnd,
  opts,
) {
  const key = `${comment.start}`;
  const decoded = paramTags.map((tag) => ({
    tag,
    info: decodeName(tag.rawName),
  }));
  const used = new Set();
  const unmatched = [];

  node.params.forEach((param) => {
    const c = classifyParam(param);
    if (c.skip !== undefined) {
      file.leave("unsupported-param-shape");
      return;
    }
    if (c.id === undefined) {
      unmatched.push(c);
      return;
    }
    if (c.id.typeAnnotation !== null && c.id.typeAnnotation !== undefined) {
      file.leave("already-annotated");
      return;
    }
    let found = null;
    for (let i = 0; i < decoded.length; i++) {
      if (used.has(i)) continue;
      const d = decoded[i];
      if (d.info.sub.length === 0 && d.info.top === c.id.name) {
        found = { d, i };
        break;
      }
    }
    if (found === null) {
      unmatched.push(c);
      return;
    }
    const { d, i } = found;
    const rawType = d.tag.brace.text.trim();
    // Sub-tags of this parameter, e.g. `opts.key` next to `@param {object} opts`
    const subIndexes = [];
    for (let j = 0; j < decoded.length; j++) {
      if (used.has(j) || j === i) continue;
      const x = decoded[j];
      if (x.info.top === c.id.name && x.info.sub.length > 0) subIndexes.push(j);
    }
    if (
      !c.isRest &&
      isBareObject(rawType) &&
      subIndexes.some((j) => decoded[j].info.sub.length === 1)
    ) {
      // `@param {object} opts` says nothing: the documented shape is the
      // sub-tags. Annotating `object` would reject every `opts.key` (TS2339)
      if (subIndexes.some((j) => decoded[j].info.sub.length > 1)) {
        file.leave("pattern-incomplete");
        return;
      }
      const subMapped = new Map();
      for (const j of subIndexes) {
        const mapped = mapJsType(decoded[j].tag.brace.text);
        if (mapped === null) {
          file.leave("pattern-incomplete");
          return;
        }
        subMapped.set(j, mapped);
      }
      const entries = subIndexes.map((j) => {
        const s = decoded[j];
        const opt = s.info.optional ? "?" : "";
        return `${propText(s.info.sub[0])}${opt}: ${subMapped.get(j)}`;
      });
      const annotation = `{ ${entries.join(", ")} }`;
      if (!validType(annotation)) {
        file.leave("invalid-type");
        return;
      }
      const optional = d.info.optional && !c.hasDefault && !opts.isSetter;
      annotateIdentifier(file, node, symbol, c, annotation, optional);
      used.add(i);
      file.consumedTags.add(`${key}:${d.tag.at}`);
      cleanParamTag(file, comment, d.tag, d.info, bodyStart, bodyEnd);
      for (const j of subIndexes) {
        used.add(j);
        const s = decoded[j];
        file.consumedTags.add(`${key}:${s.tag.at}`);
        cleanParamTag(file, comment, s.tag, s.info, bodyStart, bodyEnd);
      }
      return;
    }
    if (c.isRest) {
      const m = /^\.\.\.(.*)$/s.exec(rawType);
      const inner = (m !== null ? m[1] : rawType).trim();
      const mappedInner = mapJsType(inner);
      if (mappedInner === null) {
        file.leave("invalid-type");
        return;
      }
      const annotation = m !== null ? `${mappedInner}[]` : mappedInner;
      if (!validType(annotation)) {
        file.leave("invalid-type");
        return;
      }
      annotateIdentifier(file, node, symbol, c, annotation, false);
    } else {
      if (rawType.startsWith("...")) {
        file.leave("invalid-type");
        return;
      }
      const annotation = mapJsType(rawType);
      if (annotation === null) {
        file.leave("invalid-type");
        return;
      }
      const optional = d.info.optional && !c.hasDefault && !opts.isSetter;
      annotateIdentifier(file, node, symbol, c, annotation, optional);
    }
    used.add(i);
    file.consumedTags.add(`${key}:${d.tag.at}`);
    cleanParamTag(file, comment, d.tag, d.info, bodyStart, bodyEnd);
    // Sub-tags of a verbatim-typed parameter stay as documentation of its
    // shape; they are placed, just not as syntax
    for (const j of subIndexes) {
      used.add(j);
      file.consumedTags.add(`${key}:${decoded[j].tag.at}`);
    }
  });

  const patterns = unmatched.filter((u) => u.pattern !== undefined);
  if (patterns.length === 0) {
    // A lone `@param {T}` with no name and no prose documents the lone
    // undocumented parameter, e.g. single-param callbacks. Anything more
    // specific keeps the rules above; patterns keep their own logic.
    const orphans = unmatched.filter((u) => u.id !== undefined);
    const nameless = decoded.filter(
      (d, i) =>
        !used.has(i) &&
        !file.consumedTags.has(`${key}:${d.tag.at}`) &&
        d.info.sub.length === 0 &&
        tailEmpty(file, d.tag),
    );
    if (orphans.length === 1 && nameless.length === 1) {
      const c = orphans[0];
      const d = nameless[0];
      const rawType = d.tag.brace.text.trim();
      let annotation = null;
      if (c.isRest) {
        const m = /^\.\.\.(.*)$/s.exec(rawType);
        const inner = (m !== null ? m[1] : rawType).trim();
        const mappedInner = mapJsType(inner);
        if (mappedInner !== null) {
          annotation = m !== null ? `${mappedInner}[]` : mappedInner;
        }
      } else if (!rawType.startsWith("...")) {
        annotation = mapJsType(rawType);
      }
      if (annotation !== null && validType(annotation)) {
        annotateIdentifier(file, node, symbol, c, annotation, false);
        used.add(decoded.indexOf(d));
        file.consumedTags.add(`${key}:${d.tag.at}`);
        cleanParamTag(file, comment, d.tag, d.info, bodyStart, bodyEnd);
        unmatched.splice(unmatched.indexOf(c), 1);
      } else {
        file.leave("invalid-type");
      }
    }
  }
  const hasTags = paramTags.length > 0;
  for (const u of unmatched) {
    if (u.pattern === undefined && hasTags) file.leave("no-match");
  }

  if (patterns.length === 1) {
    convertPattern(
      file,
      symbol,
      patterns[0],
      decoded,
      used,
      comment,
      key,
      bodyStart,
      bodyEnd,
    );
  } else {
    for (let n = 0; n < patterns.length; n++) file.leave("ambiguous-pattern");
  }
  decoded.forEach((d, i) => {
    if (!used.has(i) && !file.consumedTags.has(`${key}:${d.tag.at}`)) {
      file.leave("unused-param-tag");
    }
  });
}

/**
 * Whether an arrow has a single unparenthesized parameter (`x => x`,
 * `async x => x`): the parameter cannot hold `: T` without wrapping.
 * @param {FileConvert} file conversion state
 * @param {object} node arrow node
 * @returns {boolean} true when the parameter lacks parentheses
 */
function isBareArrowParam(file, node) {
  if (node.type !== "ArrowFunctionExpression" || node.params.length !== 1) {
    return false;
  }
  let p = node.start;
  if (
    file.src.startsWith("async", p) &&
    !/[A-Za-z0-9_$]/.test(file.src[p + 5] ?? "")
  ) {
    p += 5;
  }
  while (p < node.params[0].start && /\s/.test(file.src[p])) p++;
  return file.src[p] !== "(";
}

/**
 * Inserts a type annotation on an identifier parameter, wrapping an
 * unparenthesized single arrow parameter in parentheses first.
 * @param {FileConvert} file conversion state
 * @param {object} fn function-like node owning the parameter
 * @param {string} symbol documented symbol for the report
 * @param {{id: object, hasDefault: boolean, isRest: boolean}} c classified parameter
 * @param {string} type validated annotation text
 * @param {boolean} optional whether to mark the parameter `?`
 * @returns {void}
 */
function annotateIdentifier(file, fn, symbol, c, type, optional) {
  const mark = optional ? "?" : "";
  if (isBareArrowParam(file, fn)) {
    const text = file.src.slice(c.id.start, c.id.end);
    file.edits.push({
      start: c.id.start,
      end: c.id.end,
      text: `(${text}${mark}: ${type})`,
    });
    file.annotations.push({
      line: file.lineOf(c.id.start),
      symbol,
      action: `param ${c.id.name}${mark}: ${type}`,
    });
    return;
  }
  file.insert(
    c.id.end,
    `${mark}: ${type}`,
    symbol,
    `param ${c.id.name}${mark}: ${type}`,
  );
}

/**
 * Annotates one destructured parameter: from a matching object literal, from
 * a named type, or by synthesizing `{ key: T }` from `opts.key` sub-tags.
 * @param {FileConvert} file conversion state
 * @param {string} symbol documented symbol for the report
 * @param {{pattern: object, hasDefault: boolean, isRest?: boolean}} c classified pattern parameter
 * @param {{tag: object, info: object}[]} decoded all `@param` tags decoded
 * @param {Set<number>} used indexes already consumed
 * @param {object} comment owning comment node
 * @param {string} key consume-key prefix of the comment
 * @param {number} bodyStart absolute start of the comment body
 * @param {number} bodyEnd absolute end of the comment body
 * @returns {void}
 */
function convertPattern(
  file,
  symbol,
  c,
  decoded,
  used,
  comment,
  key,
  bodyStart,
  bodyEnd,
) {
  const pattern = c.pattern;
  if (pattern.typeAnnotation !== null && pattern.typeAnnotation !== undefined) {
    file.leave("already-annotated");
    return;
  }
  const free = decoded.filter((_, i) => !used.has(i));
  const tops = free.filter((d) => d.info.sub.length === 0);
  const subs = free.filter((d) => d.info.sub.length === 1);
  if (free.some((d) => d.info.sub.length > 1)) {
    file.leave("nested-sub-param");
    return;
  }

  if (pattern.type === "ArrayPattern") {
    if (tops.length === 1 && subs.length === 0) {
      const rawType = tops[0].tag.brace.text.trim();
      // Rest markers belong on rest elements: strip them there, refuse them
      // on plain patterns instead of emitting invalid syntax
      let type = mapJsType(rawType);
      if (c.isRest === true) {
        const m = /^\.\.\.(.*)$/s.exec(rawType);
        const inner = (m !== null ? m[1] : rawType).trim();
        const mappedInner = mapJsType(inner);
        type = mappedInner === null ? null : m !== null ? `${mappedInner}[]` : mappedInner;
      } else if (rawType.startsWith("...")) {
        file.leave("invalid-type");
        return;
      }
      if (type === null || !validType(type)) {
        file.leave("invalid-type");
        return;
      }
      file.insert(pattern.end, `: ${type}`, symbol, `param pattern: ${type}`);
      used.add(decoded.indexOf(tops[0]));
      file.consumedTags.add(`${key}:${tops[0].tag.at}`);
      cleanParamTag(
        file,
        comment,
        tops[0].tag,
        tops[0].info,
        bodyStart,
        bodyEnd,
      );
    } else {
      file.leave("ambiguous-pattern");
    }
    return;
  }

  // Object pattern: every destructured key must resolve a type, or tsc
  // rejects the missing key on the annotation (TS2339). A rest element
  // (`...options`) gathers the undocumented remainder under an index
  // signature: every type extends `unknown`, so it never conflicts.
  const props = [];
  let restProp = false;
  for (const prop of pattern.properties) {
    if (prop.type === "RestElement") {
      if (restProp || prop.argument.type !== "Identifier") {
        file.leave("unsupported-pattern-prop");
        return;
      }
      restProp = true;
      continue;
    }
    if (
      prop.type !== "ObjectProperty" ||
      prop.computed ||
      (prop.key.type !== "Identifier" && prop.key.type !== "StringLiteral")
    ) {
      file.leave("unsupported-pattern-prop");
      return;
    }
    const name =
      prop.key.type === "Identifier" ? prop.key.name : prop.key.value;
    const simple =
      prop.value.type === "Identifier" ||
      (prop.value.type === "AssignmentPattern" &&
        prop.value.left.type === "Identifier");
    if (!simple) {
      file.leave("unsupported-pattern-prop");
      return;
    }
    props.push({
      name,
      hasDefault: prop.value.type === "AssignmentPattern",
    });
  }

  const groups = new Map();
  for (const d of subs) {
    const list = groups.get(d.info.top) ?? [];
    list.push(d);
    groups.set(d.info.top, list);
  }

  if (groups.size === 1) {
    const [[topName, list]] = [...groups];
    const top = tops.find((d) => d.info.top === topName) ?? null;
    const byName = new Map(list.map((d) => [d.info.sub[0], d]));
    const subMapped = new Map();
    const covers = props.every((p) => {
      const d = byName.get(p.name);
      if (d === undefined) return false;
      const mapped = mapJsType(d.tag.brace.text);
      if (mapped === null) return false;
      subMapped.set(p.name, mapped);
      return true;
    });
    if (
      (top === null || isBareObject(top.tag.brace.text)) &&
      covers &&
      tops.length <= 1
    ) {
      const entries = props.map((p) => {
        const d = byName.get(p.name);
        const type = subMapped.get(p.name);
        const opt = d.info.optional || p.hasDefault || c.hasDefault ? "?" : "";
        return `${propText(p.name)}${opt}: ${type}`;
      });
      if (restProp) entries.push("[key: string]: unknown");
      const annotation = `{ ${entries.join(", ")} }`;
      if (!validType(annotation)) {
        file.leave("invalid-type");
        return;
      }
      file.insert(
        pattern.end,
        `: ${annotation}`,
        symbol,
        `param pattern: ${annotation}`,
      );
      for (const d of list) {
        used.add(decoded.indexOf(d));
        file.consumedTags.add(`${key}:${d.tag.at}`);
        cleanParamTag(file, comment, d.tag, d.info, bodyStart, bodyEnd);
      }
      if (top !== null) {
        used.add(decoded.indexOf(top));
        file.consumedTags.add(`${key}:${top.tag.at}`);
        cleanParamTag(file, comment, top.tag, top.info, bodyStart, bodyEnd);
      }
      return;
    }
    if (top !== null && !isBareObject(top.tag.brace.text)) {
      const type = mapJsType(top.tag.brace.text);
      if (type === null || !validType(type)) {
        file.leave("invalid-type");
        return;
      }
      file.insert(pattern.end, `: ${type}`, symbol, `param pattern: ${type}`);
      used.add(decoded.indexOf(top));
      file.consumedTags.add(`${key}:${top.tag.at}`);
      cleanParamTag(file, comment, top.tag, top.info, bodyStart, bodyEnd);
      return;
    }
    file.leave("pattern-incomplete");
    return;
  }

  if (tops.length === 1 && subs.length === 0) {
    const rawType = tops[0].tag.brace.text.trim();
    if (isBareObject(rawType)) {
      file.leave("bare-object-pattern");
      return;
    }
    const type = mapJsType(tops[0].tag.brace.text);
    if (type === null || !validType(type)) {
      file.leave("invalid-type");
      return;
    }
    file.insert(pattern.end, `: ${type}`, symbol, `param pattern: ${type}`);
    used.add(decoded.indexOf(tops[0]));
    file.consumedTags.add(`${key}:${tops[0].tag.at}`);
    cleanParamTag(file, comment, tops[0].tag, tops[0].info, bodyStart, bodyEnd);
    return;
  }

  file.leave(subs.length > 0 ? "ambiguous-pattern" : "no-match");
}

/**
 * Converts `@template` on a class into class type parameters.
 * @param {FileConvert} file conversion state
 * @param {object} path Babel path of the class node
 * @returns {void}
 */
function convertClassTemplate(file, path) {
  const { node } = path;
  if (node.typeParameters !== null && node.typeParameters !== undefined) {
    return;
  }
  const comment = ownerDoc(path);
  if (comment === null) return;
  const { tags, bodyStart, bodyEnd } = docTags(file, comment);
  const symbol = `${node.id !== null ? node.id.name : "(anonymous)"} (class)`;
  for (const t of tags.filter((t) => t.kind === "template")) {
    if (file.consumedTags.has(`${comment.start}:${t.at}`)) continue;
    const anchor = templateAnchor(file, node);
    if (anchor === null) {
      file.leave("no-template-anchor");
      continue;
    }
    if (convertTemplate(file, comment, t, anchor, symbol, bodyStart, bodyEnd)) {
      break;
    }
  }
}

/**
 * Converts `@type` on one class field.
 * @param {FileConvert} file conversion state
 * @param {object} path Babel path of the field node
 * @returns {void}
 */
function convertField(file, path) {
  const { node } = path;
  if (node.key.type !== "Identifier" && node.key.type !== "PrivateName") {
    return;
  }
  if (node.typeAnnotation !== null && node.typeAnnotation !== undefined) {
    file.leave("already-annotated");
    return;
  }
  const name =
    node.key.type === "PrivateName" ? `#${node.key.id.name}` : node.key.name;
  convertVarType(file, path, `${name} (field)`, node.key.end, false);
}

/**
 * One-line description of a tag: text after the name, `*` prefixes stripped,
 * whitespace collapsed, comment closers escaped.
 * @param {FileConvert} file conversion state
 * @param {object} tag parsed tag
 * @returns {string} description, or "" when none
 */
function tagDescLine(file, tag) {
  const text = file.src
    .slice(tag.nameEnd, tag.end)
    .replace(/\r?\n[ \t]*\*[ \t]?/g, " ")
    .replace(/[\s*]+$/, "")
    .trim();
  return text.replace(/\*\//g, "* /");
}

/**
 * Description lines above the first tag of a comment.
 * @param {FileConvert} file conversion state
 * @param {object} comment comment node
 * @param {object[]} tags parsed tags of the comment
 * @returns {string[]} prose lines
 */
function blockProse(file, comment, tags) {
  const firstAt = tags.length > 0 ? tags[0].at : comment.end - 2;
  return file.src
    .slice(comment.start + 2, firstAt)
    .split("\n")
    .map((l) => l.replace(/^[ \t]*\*?[ \t]?/, "").replace(/\s+$/, ""))
    .filter((l) => l !== "");
}

/**
 * Doc comment for a generated declaration.
 * @param {string[]} prose description lines
 * @returns {string} `/** ... *\/` block with trailing newline, or ""
 */
function proseDoc(prose) {
  if (prose.length === 0) return "";
  const safe = prose.map((l) => l.replace(/\*\//g, "* /"));
  return `/**\n${safe.map((l) => ` * ${l}`.trimEnd()).join("\n")}\n */\n`;
}

/**
 * Whether snippet text parses as TypeScript.
 * @param {string} text candidate declaration text
 * @returns {boolean} true when parseable
 */
function validDecl(text) {
  try {
    parse(text, { plugins: ["typescript"] });
  } catch {
    return false;
  }
  return true;
}

/**
 * Builds the declaration text for one `@typedef`/`@callback` block.
 * Object shapes become interfaces (same-name interfaces merge across the
 * global scripts, while duplicate `type` aliases would collide); unions and
 * other aliases become `type` declarations.
 * @param {FileConvert} file conversion state
 * @param {object} comment comment node
 * @returns {{name: string, kind: string, text: string, tags: number}|null}
 *   declaration with its tag count, or null when it stays JSDoc (counted)
 */
function buildTypedefDecl(file, comment) {
  const bodyStart = comment.start + 2;
  const bodyEnd = comment.end - 2;
  const tags = parseTags(file.src.slice(bodyStart, bodyEnd), bodyStart);
  const defs = tags.filter((t) => t.kind === "typedef" || t.kind === "callback");
  if (defs.length !== 1) {
    file.leave("invalid-typedef");
    return null;
  }
  const def = defs[0];
  const prose = blockProse(file, comment, tags);
  const doc = proseDoc(prose);
  if (def.kind === "callback") {
    if (def.brace !== null) {
      file.leave("invalid-typedef");
      return null;
    }
    const name = def.rawName.replace(/^\[|\]$/g, "");
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
      file.leave("invalid-typedef");
      return null;
    }
    const params = [];
    let ret = "void";
    for (const t of tags) {
      if (t === def) continue;
      if (t.kind === "param" || t.kind === "arg" || t.kind === "argument") {
        if (t.brace === null) {
          file.leave("invalid-typedef");
          return null;
        }
        const rawName = t.rawName.trimStart();
        const restMarker = rawName.startsWith("...");
        const info = decodeName(rawName);
        if (info.sub.length > 0) {
          file.leave("invalid-typedef");
          return null;
        }
        const mapped = mapJsType(t.brace.text);
        if (mapped === null) {
          file.leave("invalid-typedef");
          return null;
        }
        const ann = restMarker ? `${mapped}[]` : mapped;
        if (!validType(ann)) {
          file.leave("invalid-typedef");
          return null;
        }
        params.push(
          `${restMarker ? "..." : ""}${info.name}${info.optional ? "?" : ""}: ${ann}`,
        );
      } else if (t.kind === "returns" || t.kind === "return") {
        if (t.brace === null) continue;
        const mapped = mapReturnType(t.brace.text, "function");
        if (mapped !== null) ret = mapped;
      }
    }
    const text = `${doc}type ${name} = (${params.join(", ")}) => ${ret};`;
    if (!validDecl(text)) {
      file.leave("invalid-typedef");
      return null;
    }
    return { name, kind: "callback", text, tags: tags.length };
  }
  if (def.brace === null) {
    file.leave("invalid-typedef");
    return null;
  }
  const rawType = def.brace.text;
  const name = def.rawName.replace(/^\[|\]$/g, "");
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
    file.leave("invalid-typedef");
    return null;
  }
  const props = tags.filter((t) => t.kind === "property" || t.kind === "prop");
  if (/^\s*object\s*$/i.test(rawType) && props.length > 0) {
    const members = [];
    for (const t of props) {
      if (t.brace === null) {
        file.leave("invalid-typedef");
        return null;
      }
      const info = decodeName(t.rawName);
      if (info.rest || info.sub.length > 0) {
        file.leave("nested-typedef-prop");
        return null;
      }
      const mapped = mapJsType(t.brace.text);
      if (mapped === null) {
        file.leave("invalid-typedef");
        return null;
      }
      const desc = tagDescLine(file, t);
      members.push(
        `${desc === "" ? "" : `/** ${desc} */ `}${info.name}${
          info.optional || info.hasDefault ? "?" : ""
        }: ${mapped};`,
      );
    }
    const text = `${doc}interface ${name} {\n${members.map((m) => `  ${m}`).join("\n")}\n}`;
    if (!validDecl(text)) {
      file.leave("invalid-typedef");
      return null;
    }
    return { name, kind: "interface", text, tags: tags.length };
  }
  if (props.length > 0) {
    file.leave("invalid-typedef");
    return null;
  }
  const mapped = mapJsType(rawType);
  if (mapped === null) {
    file.leave("invalid-typedef");
    return null;
  }
  const t0 = mapped.trim();
  // An object literal body doubles as an interface body, so same-name
  // declarations merge instead of colliding. Anything else (unions,
  // intersections, references) stays a `type` alias exactly as written:
  // decomposing it would drop unresolvable parts and spread errors to
  // every use site, while checkJs contains the failure at the declaration.
  if (t0.startsWith("{")) {
    const cand = `${doc}interface ${name} ${t0}`;
    if (validDecl(cand)) return { name, kind: "interface", text: cand, tags: tags.length };
  }
  const text = `${doc}type ${name} = ${mapped};`;
  if (!validDecl(text)) {
    file.leave("invalid-typedef");
    return null;
  }
  return { name, kind: "type", text, tags: tags.length };
}

/**
 * Converts `@typedef`/`@callback` blocks into declarations. Standalone
 * blocks are replaced in place; blocks inside class bodies (where types are
 * illegal) move before the innermost containing class statement.
 * @param {FileConvert} file conversion state
 * @param {object} ast parsed file
 * @returns {void}
 */
function convertTypedefs(file, ast) {
  for (const comment of ast.comments ?? []) {
    if (comment.type !== "CommentBlock") continue;
    if (!comment.value.trimStart().startsWith("*")) continue;
    if (!/@(?:typedef|callback)\b/.test(comment.value)) continue;
    const decl = buildTypedefDecl(file, comment);
    if (decl === null) continue;
    // A declaration spliced mid-line would glue onto code: only standalone
    // blocks convert.
    const after = file.src.slice(comment.end).match(/^[ \t]*(\r?\n|$)/);
    if (after === null) {
      file.leave("invalid-typedef");
      continue;
    }
    let holder = null;
    for (const r of file.classRanges) {
      if (r.start <= comment.start && comment.end <= r.end) {
        if (holder === null || r.end - r.start < holder.end - holder.start) {
          holder = r;
        }
      }
    }
    if (holder === null) {
      file.edits.push({
        start: comment.start,
        end: comment.end,
        text: decl.text,
      });
    } else {
      file.removeComment(comment);
      const lineIdx = file.lineOf(holder.stmtStart) - 1;
      const at = file.lineStarts[lineIdx];
      file.edits.push({ start: at, end: at, text: `${decl.text}\n` });
    }
    file.annotations.push({
      line: file.lineOf(comment.start),
      symbol: `${decl.name} (typedef)`,
      action: `typedef ${decl.kind}`,
    });
    file.cleanedTags += decl.tags;
  }
}

/**
 * `@param` types of one method, for `this.x = ident` right-hand sides.
 * @param {FileConvert} file conversion state
 * @param {object} method method node
 * @returns {Map<string, string>} parameter name to mapped type
 */
function methodParamTypes(file, method) {
  const paramTypes = new Map();
  const doc = (method.leadingComments ?? [])
    .filter(
      (c) =>
        c.type === "CommentBlock" &&
        c.value.trimStart().startsWith("*") &&
        !EXCLUDED_BLOCK.test(c.value),
    )
    .at(-1);
  if (doc === undefined) return paramTypes;
  const tags = parseTags(
    file.src.slice(doc.start + 2, doc.end - 2),
    doc.start + 2,
  );
  for (const t of tags) {
    if (
      (t.kind === "param" || t.kind === "arg" || t.kind === "argument") &&
      t.brace !== null
    ) {
      const info = decodeName(t.rawName);
      if (info.sub.length > 0 || paramTypes.has(info.top)) continue;
      const mapped = mapJsType(t.brace.text);
      if (mapped !== null) paramTypes.set(info.top, mapped);
    }
  }
  return paramTypes;
}

/**
 * Type for a `this.name` field from every direct assignment in the class:
 * a hanging `@type` wins, then the assigned parameter's type, a `new`
 * expression's class, a literal, skipping `null`/`undefined` initializers
 * for later values. Anything else is evolving `any`, as in checkJs.
 * @param {FileConvert} file conversion state
 * @param {string} name field name
 * @param {{method: object, stmt: object}[]} uses assignments in order
 * @returns {string|null} field type, or null when it stays undeclared
 */
function thisFieldType(file, name, uses) {
  void name;
  const paramCache = new Map();
  for (const { method, stmt } of uses) {
    const rhs = stmt.expression.right;
    // (a) a hanging `/** @type */` on the statement.
    const lead = (stmt.leadingComments ?? [])
      .filter(
        (c) =>
          c.type === "CommentBlock" &&
          c.value.trimStart().startsWith("*") &&
          !EXCLUDED_BLOCK.test(c.value),
      )
      .reverse();
    for (const c of lead) {
      const inner = parseTags(
        file.src.slice(c.start + 2, c.end - 2),
        c.start + 2,
      );
      if (inner.length === 1 && inner[0].kind === "type") {
        const ckey = `${c.start}:${inner[0].at}`;
        if (file.consumedTags.has(ckey)) continue;
        if (inner[0].brace === null) break;
        const mapped = mapJsType(inner[0].brace.text);
        if (mapped === null) {
          file.leave("invalid-type");
          return null;
        }
        file.consumedTags.add(ckey);
        consumeCastComment(file, c, inner[0]);
        return mapped;
      }
    }
    // (b) the assigned parameter's type.
    if (rhs.type === "Identifier") {
      if (!paramCache.has(method)) {
        paramCache.set(method, methodParamTypes(file, method));
      }
      const found = paramCache.get(method).get(rhs.name);
      if (found !== undefined) return found;
      continue;
    }
    // Nullish initializers say nothing: a later value may still type it.
    if (
      rhs.type === "NullLiteral" ||
      (rhs.type === "Identifier" && rhs.name === "undefined") ||
      (rhs.type === "UnaryExpression" &&
        rhs.operator === "void" &&
        rhs.prefix)
    ) {
      continue;
    }
    // (c) literals and `new` expressions.
    if (rhs.type === "BooleanLiteral") return "boolean";
    if (rhs.type === "StringLiteral") return "string";
    if (rhs.type === "NumericLiteral") return "number";
    if (rhs.type === "TemplateLiteral") return "string";
    if (
      rhs.type === "NewExpression" &&
      rhs.callee.type === "Identifier" &&
      validType(rhs.callee.name)
    ) {
      return rhs.callee.name;
    }
  }
  return "any";
}

/**
 * Inserts `declare x: T` fields for `this.x = ...` assignments in class
 * methods that declare nothing. `declare` emits no code, so behavior never
 * changes while tsc stops reporting the property as missing (TS2339).
 * @param {FileConvert} file conversion state
 * @param {object} path Babel path of the class node
 * @returns {void}
 */
function convertDeclareFields(file, path) {
  const cls = path.node;
  if (cls.body.type !== "ClassBody") return;
  const className =
    cls.id !== null && cls.id !== undefined ? cls.id.name : "(anonymous)";
  const declared = new Set();
  for (const el of cls.body.body) {
    if (
      (el.type === "ClassProperty" || el.type === "ClassMethod") &&
      el.key.type === "Identifier"
    ) {
      declared.add(el.key.name);
    }
    if (
      el.type === "ClassPrivateProperty" ||
      el.type === "ClassPrivateMethod"
    ) {
      declared.add(`#${el.key.id.name}`);
    }
  }
  const lines = [];
  // All direct `this.name = rhs` statements per field, in order: a field
  // first set to `null` and later to a value takes the value's type.
  const assignments = new Map();
  for (const el of cls.body.body) {
    if (el.type !== "ClassMethod" && el.type !== "ClassPrivateMethod") continue;
    if (!el.body || el.body.type !== "BlockStatement") continue;
    for (const st of el.body.body) {
      if (
        st.type !== "ExpressionStatement" ||
        st.expression.type !== "AssignmentExpression" ||
        st.expression.operator !== "="
      ) {
        continue;
      }
      const l = st.expression.left;
      if (
        l.type !== "MemberExpression" ||
        l.object.type !== "ThisExpression" ||
        l.computed ||
        l.property.type !== "Identifier"
      ) {
        continue;
      }
      const name = l.property.name;
      if (declared.has(name)) continue;
      const list = assignments.get(name) ?? [];
      list.push({ method: el, stmt: st });
      assignments.set(name, list);
    }
  }
  for (const [name, uses] of assignments) {
    declared.add(name);
    const first = uses[0];
    const typeText = thisFieldType(file, name, uses);
    // Bad `@type` is already counted inside; anything else is valid by
    // construction, so this guard only fires on a bug.
    if (typeText === null || !validType(typeText)) {
      if (typeText !== null) file.leave("this-field-untyped");
      continue;
    }
    lines.push({
      name,
      type: typeText,
      isStatic: !!first.method.static,
    });
  }
  if (lines.length === 0) return;
  let indent = "  ";
  const first = cls.body.body[0];
  if (first !== undefined) {
    const li = file.lineOf(first.start) - 1;
    const m = /^[ \t]*/.exec(file.src.slice(file.lineStarts[li], first.start));
    if (m !== null && m[0] !== "") indent = m[0];
  }
  const text = lines
    .map(
      ({ name, type, isStatic }) =>
        `\n${indent}declare ${isStatic ? "static " : ""}${name}: ${type};`,
    )
    .join("");
  file.edits.push({
    start: cls.body.start + 1,
    end: cls.body.start + 1,
    text,
  });
  for (const { name, type } of lines) {
    file.annotations.push({
      line: file.lineOf(cls.body.start),
      symbol: `${className} (class)`,
      action: `declare ${name}: ${type}`,
    });
  }
}

/**
 * Converts `@type` on a variable declarator or class field.
 * @param {FileConvert} file conversion state
 * @param {object} path Babel path of the declarator or field node
 * @param {string} symbol documented symbol for the report
 * @param {number} anchor absolute offset to insert the annotation at
 * @param {boolean} alreadyAnnotated whether syntax already types it
 * @returns {void}
 */
function convertVarType(file, path, symbol, anchor, alreadyAnnotated) {
  const comment = ownerDoc(path);
  if (comment === null) {
    file.leave("no-jsdoc");
    return;
  }
  const { tags, bodyStart, bodyEnd } = docTags(file, comment);
  const key = `${comment.start}`;
  const tag = tags.find(
    (t) =>
      t.kind === "type" &&
      t.brace !== null &&
      !file.consumedTags.has(`${key}:${t.at}`),
  );
  if (tag === undefined) {
    file.leave("no-@type");
    return;
  }
  const type = mapJsType(tag.brace.text);
  if (type === null) {
    file.leave("invalid-type");
    return;
  }
  if (alreadyAnnotated) {
    file.leave("already-annotated");
    return;
  }
  file.insert(anchor, `: ${type}`, symbol, `type ${type}`);
  file.consumedTags.add(`${key}:${tag.at}`);
  cleanTypeTag(file, comment, tag, true, bodyStart, bodyEnd);
}

/**
 * Applies queued edits to the source; overlapping edits veto the file.
 * @param {string} src original file text
 * @param {{start: number, end: number, text: string}[]} edits edits to apply
 * @returns {{ok: boolean, src: string}} result, or ok:false on overlap
 */
function applyEdits(src, edits) {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) return { ok: false, src };
  }
  let out = src;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const e = sorted[i];
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return { ok: true, src: out };
}

/**
 * Converts one file: parses, collects annotation and JSDoc edits.
 * @param {string} filePath absolute path of the file
 * @param {string} rel path relative to ROOT for the report
 * @returns {{rel: string, file: FileConvert|null, error: string|null}} result
 */
function convertFile(filePath, rel) {
  const src = readFileSync(filePath, "utf8");
  let ast;
  try {
    ast = parse(src, PARSER_OPTIONS);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { rel, file: null, error: msg.split("\n")[0] };
  }
  const file = new FileConvert(src, rel);
  traverse(ast, {
    enter(path) {
      convertCasts(file, path);
    },
    FunctionDeclaration(path) {
      convertFunction(file, path);
    },
    TSDeclareFunction(path) {
      convertFunction(file, path);
    },
    FunctionExpression(path) {
      convertFunction(file, path);
    },
    ArrowFunctionExpression(path) {
      convertFunction(file, path);
    },
    ClassMethod(path) {
      convertFunction(file, path);
    },
    ClassPrivateMethod(path) {
      convertFunction(file, path);
    },
    ObjectMethod(path) {
      convertFunction(file, path);
    },
    ClassDeclaration(path) {
      convertClassTemplate(file, path);
    },
    ClassExpression(path) {
      convertClassTemplate(file, path);
    },
    VariableDeclarator(path) {
      const { node } = path;
      if (node.id.type !== "Identifier") return;
      if (path.parent.declarations.length !== 1) {
        file.leave("multi-declarator");
        return;
      }
      // An arrow or function value takes its types from `@param`/`@returns`;
      // `@type` would double-annotate the same signature
      const init = node.init;
      if (
        init !== null &&
        init.type !== undefined &&
        (init.type === "ArrowFunctionExpression" ||
          init.type === "FunctionExpression")
      ) {
        const comment = ownerDoc(path);
        if (comment !== null) {
          const { tags } = docTags(file, comment);
          if (
            tags.some(
              (t) =>
                t.kind === "type" &&
                t.brace !== null &&
                !file.consumedTags.has(`${comment.start}:${t.at}`),
            )
          ) {
            file.leave("function-value-@type");
          }
        }
        return;
      }
      convertVarType(
        file,
        path,
        `${node.id.name} (variable)`,
        node.id.end,
        node.id.typeAnnotation !== null && node.id.typeAnnotation !== undefined,
      );
    },
    ClassProperty(path) {
      convertField(file, path);
    },
    ClassPrivateProperty(path) {
      convertField(file, path);
    },
    ObjectProperty(path) {
      convertObjectPropType(file, path);
    },
    Class(path) {
      let top = path;
      while (
        top.parentPath &&
        (top.parent.type === "VariableDeclarator" ||
          top.parent.type === "VariableDeclaration" ||
          top.parent.type === "AssignmentExpression" ||
          top.parent.type === "ExportNamedDeclaration" ||
          top.parent.type === "ExportDefaultDeclaration")
      ) {
        top = top.parentPath;
      }
      file.classRanges.push({
        start: path.node.start,
        end: path.node.end,
        stmtStart: top.node.start,
      });
    },
  });
  traverse(ast, {
    Class(path) {
      convertDeclareFields(file, path);
    },
  });
  convertTypedefs(file, ast);
  file.finalize();
  return { rel, file, error: null };
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

const [cmd = "check", targetArg, ...filters] = process.argv
  .slice(2)
  .filter((a) => a !== "--");

if (cmd !== "check" && cmd !== "convert" && cmd !== "files") {
  console.error(`${USAGE}\nunknown command: ${cmd}`);
  process.exit(2);
}

if (targetArg === undefined) {
  console.error(
    `${USAGE}\nmissing path: point at a directory or a .ts/.mts file`,
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
    `FAIL: no .ts/.mts files under ${targetArg}, nothing was checked.`,
  );
  process.exit(1);
}

if (cmd === "files") {
  const { files, empty } = selectFiles(allFiles, ROOT, filters);
  if (empty) {
    console.error(
      `FAIL: no file matched ${filters.join(", ")}, nothing was checked. A filter is a substring of the path relative to ${targetArg}, e.g. "http-client.ts".`,
    );
    process.exit(1);
  }
  for (const f of files) console.log(relative(ROOT, f));
  process.exit(0);
}

const { files, empty } = selectFiles(allFiles, ROOT, filters);
if (empty) {
  console.error(
    `FAIL: no file matched ${filters.join(", ")}, nothing was checked. A filter is a substring of the path relative to ${targetArg}, e.g. "http-client.ts".`,
  );
  process.exit(1);
}

let converted = 0;
let pending = 0;
let cleanedTotal = 0;
const leftTotal = {};
const failed = [];

for (const filePath of files) {
  const rel = relative(ROOT, filePath);
  const { file, error } = convertFile(filePath, rel);
  if (error !== null) {
    console.log(`SKIPPED  ${rel}  ${error}`);
    failed.push(rel);
    continue;
  }
  for (const [reason, count] of Object.entries(file.left)) {
    leftTotal[reason] = (leftTotal[reason] ?? 0) + count;
  }
  const applied = applyEdits(file.src, file.edits);
  if (!applied.ok) {
    console.log(`SKIPPED  ${rel}  overlapping edits, left untouched`);
    failed.push(rel);
    continue;
  }
  if (cmd === "check") {
    const rows = [...file.annotations].sort((a, b) => a.line - b.line);
    for (const r of rows) {
      console.log(`${rel}:${r.line} ${r.symbol} ${r.action}`);
    }
    pending += rows.length;
    cleanedTotal += file.cleanedTags;
  } else {
    if (file.annotations.length === 0 && file.cleanedTags === 0) continue;
    writeFileSync(filePath, applied.src);
    console.log(
      `${rel} ${file.annotations.length} annotation(s), ${file.cleanedTags} jsdoc tag(s) cleaned`,
    );
    converted++;
    pending += file.annotations.length;
    cleanedTotal += file.cleanedTags;
  }
}

if (cmd === "check") {
  console.log(`files scanned: ${files.length}`);
  console.log(`annotations pending: ${pending}`);
  console.log(`jsdoc tags that would be cleaned: ${cleanedTotal}`);
  if (Object.keys(leftTotal).length > 0) {
    console.log("left in place:");
    for (const reason of Object.keys(leftTotal).sort()) {
      console.log(`  ${reason.padEnd(24)}${leftTotal[reason]}`);
    }
  }
  if (failed.length > 0) {
    console.log(`unparseable: ${failed.length}`);
  }
  if (pending > 0 || failed.length > 0) process.exitCode = 1;
} else {
  console.log(`files rewritten: ${converted} of ${files.length}`);
  console.log(`annotations inserted: ${pending}`);
  console.log(`jsdoc tags cleaned: ${cleanedTotal}`);
  if (Object.keys(leftTotal).length > 0) {
    console.log("left in place:");
    for (const reason of Object.keys(leftTotal).sort()) {
      console.log(`  ${reason.padEnd(24)}${leftTotal[reason]}`);
    }
  }
  if (failed.length > 0) {
    console.log(`skipped: ${failed.length}`);
    for (const f of failed) console.log(`SKIPPED  ${f}`);
    process.exitCode = 1;
  }
}

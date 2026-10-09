#!/usr/bin/env node
// One-shot JSDoc-to-TypeScript promoter for classic browser scripts.
// Reads JS sources (already renamed to .ts paths, content still JS),
// promotes JSDoc type tags to TS syntax, keeps prose. Mechanical only:
// anything it cannot map stays JSDoc and is reported for the manual pass.
//
// COMMANDS
//   js2ts.mjs <path> [...]   convert files in place; each `path` is a `.ts`
//                           file or a directory walked recursively (same
//                           scannable set as jsdoc-to-ts.mjs: `.ts`/`.mts`,
//                           excluding `*.d.ts` and `*.min.ts`/`*.min.mts`).
//                           Paths come from args, as in jsdoc-to-ts.mjs.
//
// WORKFLOW
//   ./tools/js2ts.mjs ./src/number-utils.ts
//   ./tools/js2ts.mjs ./src
//
// EXIT CODES
//   0  always (unmappable spots show as WARN lines)
//   2  missing path, or unreadable path
const USAGE = "usage: js2ts.mjs <path> [...]";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import _generate from "@babel/generator";
const traverse = _traverse.default ?? _traverse;
const generate = _generate.default ?? _generate;

const warnings = [];

/**
 * Warns once per file about a spot needing the manual pass.
 * @param {string} file converted file
 * @param {number} line 1-based line
 * @param {string} msg what is left for humans
 */
function warn(file, line, msg) {
  warnings.push(`${file}:${line}  ${msg}`);
}

// --- JSDoc scanning (brace-aware) -------------------------------------------

/**
 * Splits a comment block into description lines and tags.
 * @param {string} value comment text without delimiters
 * @returns {{prose: string[], tags: {tag: string, text: string}[]}}
 */
function splitBlock(value) {
  const lines = value.split("\n").map((l) => l.replace(/^\s*\*\s?/, ""));
  // Drop the opening-/** first star remnant and trailing empties.
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  const prose = [];
  const tags = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^\s*@(\w+)\b\s?([\s\S]*)$/);
    if (m) {
      current = { tag: m[1], text: m[2] ?? "" };
      tags.push(current);
    } else if (current !== null) {
      current.text += `\n${line}`;
    } else {
      prose.push(line);
    }
  }
  return { prose, tags };
}

/**
 * Reads a {...} type starting at the brace, nesting-aware.
 * @param {string} text tag text starting with {
 * @returns {{type: string, rest: string}|null}
 */
function readBraceType(text) {
  if (!text.startsWith("{")) return null;
  let depth = 0;
  let inStr = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr !== null) {
      if (c === inStr && text[i - 1] !== "\\") inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        return { type: text.slice(1, i), rest: text.slice(i + 1) };
      }
    }
  }
  return null;
}

/**
 * Parses one @param/@property tag text into name parts and description.
 * @param {string} text tag text after the tag word
 * @returns {{type: string|null, name: string, desc: string}|null}
 */
function parseNamedTag(text) {
  const t = text.trimStart();
  let type = null;
  let rest = t;
  if (rest.startsWith("{")) {
    const b = readBraceType(rest);
    if (b === null) return null;
    type = b.type;
    rest = b.rest.trimStart();
  }
  // Имя в скобках может содержать пробелы ([options.x="a; b"]).
  const m = rest.match(/^(\[[^\]]*\]|\S+)([\s\S]*)$/);
  if (!m) return { type, name: "", desc: "" };
  return { type, name: m[1], desc: m[2].trim() };
}

/**
 * Splits [name], [name=default] into optionality and default.
 * @param {string} name raw name
 * @returns {{name: string, optional: boolean}}
 */
function optionalName(name) {
  if (name.startsWith("[") && name.endsWith("]")) {
    const inner = name.slice(1, -1);
    const eq = inner.indexOf("=");
    return { name: eq === -1 ? inner : inner.slice(0, eq), optional: true };
  }
  return { name, optional: false };
}

// --- JSDoc type mapping -------------------------------------------------------

/**
 * Maps a JSDoc type string to TypeScript syntax. Returns null when the
 * construct is unknown: the tag stays JSDoc for the manual pass.
 * @param {string} raw JSDoc type text
 * @returns {string|null} TS type text
 */
function mapType(raw) {
  let s = raw.trim();
  if (s === "") return null;
  // Rest element: ...T -> T[] (caller picks element vs array by position).
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
  return checkType(s) ? s : null;
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

const typeCache = new Map();

/**
 * Checks TS type text by parsing it.
 * @param {string} s TS type text
 * @returns {boolean} parseable
 */
function checkType(s) {
  if (typeCache.has(s)) return typeCache.get(s);
  let ok = true;
  try {
    parse(`type __T = ${s};`, {
      sourceType: "unambiguous",
      plugins: ["typescript"],
    });
  } catch {
    ok = false;
  }
  typeCache.set(s, ok);
  return ok;
}

/**
 * Repairs TS nodes for @babel/generator 8: parser 7 emits
 * `typeParameters` on TSTypeReference/TSImportType, the printer reads
 * `typeArguments` and silently drops the arguments otherwise; a
 * TSTypeParameter name arrives as a string, the printer wants an Identifier.
 * @param {object} root subtree to repair in place
 */
function fixTsRefs(root) {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (node.type === "TSTypeReference" || node.type === "TSImportType") {
      if (node.typeParameters && !node.typeArguments) {
        node.typeArguments = node.typeParameters;
        delete node.typeParameters;
      }
    }
    if (node.type === "TSImportType" && node.argument && !node.source) {
      node.source = node.argument;
      delete node.argument;
    }
    if (
      (node.type === "TSFunctionType" ||
        node.type === "TSConstructorType" ||
        node.type === "TSMethodSignature" ||
        node.type === "TSCallSignatureDeclaration" ||
        node.type === "TSConstructSignatureDeclaration") &&
      node.parameters &&
      !node.params
    ) {
      node.params = node.parameters;
      delete node.parameters;
    }
    if (
      (node.type === "TSFunctionType" ||
        node.type === "TSConstructorType" ||
        node.type === "TSMethodSignature" ||
        node.type === "TSCallSignatureDeclaration" ||
        node.type === "TSConstructSignatureDeclaration") &&
      node.typeAnnotation &&
      !node.returnType
    ) {
      node.returnType = node.typeAnnotation;
      delete node.typeAnnotation;
    }
    if (node.type === "TSTypeParameter" && typeof node.name === "string") {
      node.name = { type: "Identifier", name: node.name };
    }
    for (const key of Object.keys(node)) {
      if (
        key === "loc" ||
        key === "leadingComments" ||
        key === "trailingComments"
      )
        continue;
      const v = node[key];
      if (Array.isArray(v)) {
        for (const el of v) stack.push(el);
      } else if (v && typeof v === "object" && v.type) {
        stack.push(v);
      }
    }
  }
}

/**
 * Parses TS type text into an annotation node.
 * @param {string} s TS type text
 * @returns {object} TSTypeAnnotation node
 */
function typeAnnotation(s) {
  const ast = parse(`type __T = ${s};`, {
    sourceType: "unambiguous",
    plugins: ["typescript"],
  });
  const alias = ast.program.body[0];
  fixTsRefs(alias.typeAnnotation);
  return {
    type: "TSTypeAnnotation",
    typeAnnotation: alias.typeAnnotation,
  };
}

/**
 * Parses a param declaration snippet to borrow its node shape.
 * @param {string} snippet e.g. "this: Foo"
 * @returns {object} param node
 */
function snippetParam(snippet) {
  const ast = parse(`function __f(${snippet}) {}`, {
    sourceType: "unambiguous",
    plugins: ["typescript"],
  });
  const param = ast.program.body[0].params[0];
  fixTsRefs(param);
  return param;
}

// --- Comment plumbing ----------------------------------------------------------

/**
 * Leading JSDoc blocks of a node or of its comment-owning parent.
 * @param {object} path node path
 * @returns {{blocks: object[], owner: object}[]} blocks with their owner node
 */
function jsdocBlocks(path) {
  const out = [];
  const seen = new Set();
  const take = (node) => {
    if (!node?.leadingComments) return;
    for (const c of node.leadingComments) {
      if (
        c.type === "CommentBlock" &&
        c.value.trimStart().startsWith("*") &&
        !seen.has(c)
      ) {
        seen.add(c);
        out.push({ block: c, owner: node });
      }
    }
  };
  take(path.node);
  // Comments hang on the outermost node: export ... > var ... = <fn>, or on
  // the holder: { key: <fn> }, class { key = <fn> }, `ns.fn = <fn>;`.
  let up = path;
  while (
    up.parent &&
    (up.parent.type === "VariableDeclarator" ||
      up.parent.type === "VariableDeclaration" ||
      up.parent.type === "ObjectProperty" ||
      up.parent.type === "ClassProperty" ||
      up.parent.type === "ClassPrivateProperty")
  ) {
    if (!up.parentPath) break;
    up = up.parentPath;
    take(up.node);
  }
  if (
    up.parent &&
    (up.parent.type === "ExportNamedDeclaration" ||
      up.parent.type === "ExportDefaultDeclaration")
  ) {
    take(up.parent);
  }
  // `/** docs */ ns.fn = function ...;`: the block hangs on the statement.
  // Only the direct RHS shape qualifies, so a statement documenting a call
  // never leaks onto a callback argument. Same for `return function ...;`.
  const par = path.parent;
  if (
    par &&
    par.type === "AssignmentExpression" &&
    par.operator === "=" &&
    par.right === path.node &&
    path.parentPath?.parent &&
    path.parentPath.parent.type === "ExpressionStatement"
  ) {
    take(path.parentPath.parent);
  }
  if (
    par &&
    (par.type === "ReturnStatement" || par.type === "ThrowStatement") &&
    par.argument === path.node
  ) {
    take(par);
  }
  return out;
}

/**
 * Rewrites one JSDoc block: drops consumed tag indexes, keeps the rest.
 * @param {object} block comment node
 * @param {Set<number>} drop tag indexes (per splitBlock order) to remove
 * @param {string[]} proseKept description lines to keep (default: all)
 */
function rewriteBlock(block, drop, proseKept = null) {
  const { prose, tags } = splitBlock(block.value);
  const keptProse = proseKept ?? prose;
  const kept = tags.filter((_, i) => !drop.has(i));
  const lines = [...keptProse];
  for (const t of kept) {
    const first = `@${t.tag}${t.text.startsWith("\n") || t.text === "" ? "" : " "}${t.text.split("\n")[0]}`;
    lines.push(first);
    for (const cont of t.text.split("\n").slice(1)) lines.push(cont);
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  if (lines.length === 0) {
    block._drop = true;
    return;
  }
  block.value = `*\n${lines.map((l) => ` * ${l}`.trimEnd()).join("\n")}\n `;
}

/**
 * Removes comments flagged with _drop from a node.
 * @param {object} node AST node
 */
function sweepDropped(node) {
  if (!node || typeof node !== "object") return;
  for (const key of ["leadingComments", "trailingComments", "innerComments"]) {
    if (Array.isArray(node[key])) {
      node[key] = node[key].filter((c) => !c._drop);
    }
  }
}

// --- File conversion ------------------------------------------------------------

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

const TYPEDEF_TAGS = new Set(["typedef", "callback"]);

/**
 * Converts one file in place.
 * @param {string} file path to the (renamed, still-JS) .ts file
 */
function convertFile(file) {
  const src = readFileSync(file, "utf8");
  const ast = parse(src, PARSER_OPTIONS);
  const lineOf = (node) => node.loc?.start.line ?? 0;
  // Binding identifiers (params, declarator ids): annotations go on them,
  // casts never apply to them (but do apply inside default values).
  const boundIds = new WeakSet();

  /**
   * Records every binding identifier inside a pattern.
   * @param {object} node pattern node
   */
  function markBound(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "Identifier") {
      boundIds.add(node);
      return;
    }
    if (node.type === "AssignmentPattern") {
      markBound(node.left);
      return;
    }
    if (node.type === "RestElement") {
      markBound(node.argument);
      return;
    }
    if (node.type === "ObjectPattern") {
      for (const p of node.properties) {
        if (p.type === "ObjectProperty") markBound(p.value);
        else markBound(p.argument ?? p.value);
      }
      return;
    }
    if (node.type === "ArrayPattern") {
      for (const e of node.elements) markBound(e);
    }
  }

  /**
   * Applies @param entries to a function-like node.
   * @param {object} path node path
   * @param {{tag: string, text: string}[]} tags parsed tags
   * @param {Set<number>} drop consumed tag indexes (mutated)
   * @param {number[]} tagIndex index map (mutated view)
   */
  function applyParams(path, tags, drop) {
    const node = path.node;
    const params = node.params ?? [];
    // Group dotted children by root.
    const byRoot = new Map();
    const roots = [];
    tags.forEach((t, i) => {
      if (t.tag !== "param" && t.tag !== "arg" && t.tag !== "argument") return;
      const p = parseNamedTag(t.text);
      if (!p || p.name === "") return;
      const bare = p.name.replace(/^\.\.\./, "");
      const unbracketed =
        bare.startsWith("[") && bare.endsWith("]")
          ? bare.slice(1, -1).split("=")[0]
          : bare;
      const root = unbracketed.split(".")[0];
      if (!byRoot.has(root)) {
        byRoot.set(root, []);
        roots.push(root);
      }
      byRoot.get(root).push({ index: i, parsed: p });
    });
    const allNames = new Set();
    for (const param of params) {
      for (const n of patternNames(param)) allNames.add(n);
    }
    params.forEach((param, pi) => {
      const core = param.type === "AssignmentPattern" ? param.left : param;
      const names = patternNames(param);
      // Direct match: any pattern name with a root entry.
      let entries = null;
      for (const n of names) {
        if (byRoot.has(n)) {
          entries = byRoot.get(n);
          break;
        }
      }
      // RestElement ...args matches root "args" (or "...args").
      if (!entries && core.type === "RestElement") {
        const argNames = patternNames(core.argument);
        for (const n of argNames) {
          if (byRoot.has(n)) {
            entries = byRoot.get(n);
            break;
          }
        }
      }
      // Destructured pattern whose group no name claims (the usual
      // `@param {object} options` over fields): take it when it is the only
      // unclaimed group, so a stale extra group never misassigns.
      if (
        !entries &&
        (core.type === "ObjectPattern" || core.type === "ArrayPattern")
      ) {
        const unclaimed = roots.filter((r) => !allNames.has(r));
        if (process.env.JS2TS_DEBUG) {
          console.error(
            `DBG-FB keys=${JSON.stringify([...byRoot.keys()])} unclaimed=${JSON.stringify(unclaimed)} param=${param.type}`,
          );
        }
        if (unclaimed.length === 1) {
          entries = byRoot.get(unclaimed[0]);
        }
      }
      if (!entries) {
        if (process.env.JS2TS_DEBUG) {
          console.error(
            `DBG-NOMATCH2 roots=${JSON.stringify(roots)} allNames=${JSON.stringify([...allNames])} names=${JSON.stringify(names)}`,
          );
          console.error(
            `DBG-NOMATCH roots=${JSON.stringify(roots)} names=${JSON.stringify(params.flatMap((p) => patternNames(p)))} line=${lineOf(params[0] ?? node)}`,
          );
        }
        return;
      }
      const [head, ...children] = entries;
      const mapped = head.parsed.type ? mapType(head.parsed.type) : null;
      const { name: rawName } = head.parsed;
      const cleanName = rawName.replace(/^\.\.\./, "");
      const { name: headName, optional } = optionalName(
        cleanName.split(".")[0],
      );
      void headName;
      // Object shape from dotted children (options.actions, ...).
      // Member docs ride along as leading comments: without them the child
      // descriptions would be lost when the tags are dropped.
      const childShape = () => {
        const members = [];
        for (const c of children) {
          const raw = c.parsed.name.replace(/^\.\.\./, "");
          const bracketed = raw.startsWith("[") && raw.endsWith("]");
          const flat = bracketed ? raw.slice(1, -1) : raw;
          const sub = flat.split(".").slice(1).join(".");
          if (!sub || sub.includes(".")) return null;
          const mt = c.parsed.type ? mapType(c.parsed.type) : null;
          if (mt === null) return null;
          const eq = sub.indexOf("=");
          const { name: mn, optional: mo } = optionalName(
            bracketed || eq !== -1
              ? `[${eq === -1 ? sub : sub.slice(0, eq)}]`
              : sub,
          );
          const doc = c.parsed.desc
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l !== "")
            .join(" ")
            .replace(/\*\//g, "* /");
          const member = `${mn}${mo ? "?" : ""}: ${mt}`;
          members.push(doc === "" ? member : `/** ${doc} */ ${member}`);
          if (!checkType(`{ ${members[members.length - 1]} }`)) return null;
        }
        for (const c of children) drop.add(c.index);
        drop.add(head.index);
        const shape = `{ ${members.join("; ")} }`;
        if (!checkType(shape)) return null;
        return shape;
      };
      if (core.type === "Identifier") {
        if (children.length > 0 && mapped === "object") {
          const shape = childShape();
          if (shape === null) {
            warn(file, lineOf(param), "не собран тип вложенных параметров");
            return;
          }
          // Аннотация — на имя, а не на AssignmentPattern: `options = {}?: T`
          // непечатаемо, а `?` при умолчании и не нужен (оно уже необязательно).
          core.typeAnnotation = typeAnnotation(shape);
          if (optional && param.type === "Identifier") core.optional = true;
          return;
        }
        if (mapped === null) {
          warn(
            file,
            lineOf(param),
            `неизвестный тип @param ${head.parsed.type}`,
          );
          return;
        }
        if (core.name === "this") return; // handled as this-param
        core.typeAnnotation = typeAnnotation(mapped);
        if (optional && param.type === "Identifier") core.optional = true;
        drop.add(head.index);
      } else if (
        core.type === "ObjectPattern" ||
        core.type === "ArrayPattern"
      ) {
        // Object shape from dotted children, else the inline entry type.
        let shape = null;
        if (process.env.JS2TS_DEBUG) {
          console.error(
            `DBG roots=${JSON.stringify(roots)} params=${params.length} children=${children.length} head=${head.parsed.name}`,
          );
        }
        if (children.length > 0) {
          const built = childShape();
          if (built === null) {
            warn(
              file,
              lineOf(param),
              "не собран тип деструктурированного параметра",
            );
            return;
          }
          shape = built;
        } else if (mapped !== null) {
          shape = mapped;
          drop.add(head.index);
        }
        if (shape === null || !checkType(shape)) {
          warn(
            file,
            lineOf(param),
            "не собран тип деструктурированного параметра",
          );
          return;
        }
        core.typeAnnotation = typeAnnotation(shape);
        if (
          children.length === 0 &&
          optional &&
          param.type !== "AssignmentPattern"
        ) {
          core.optional = true;
        }
      } else if (core.type === "RestElement") {
        if (mapped === null) {
          warn(
            file,
            lineOf(param),
            `неизвестный тип @param ${head.parsed.type}`,
          );
          return;
        }
        // {...T} -> element T for ...args: T[]; T[] stays.
        const m = head.parsed.type.trim();
        const elem = m.startsWith("...") ? m.slice(3) : null;
        const arr = elem ? mapType(`(${elem})[]`) : mapped;
        if (arr === null || !checkType(arr)) {
          warn(file, lineOf(param), "не собран тип rest-параметра");
          return;
        }
        param.typeAnnotation = typeAnnotation(arr);
        drop.add(head.index);
      }
      void pi;
    });
  }

  /**
   * Applies inline @type comments sitting on parameters.
   * Runs with or without a JSDoc block.
   * @param {object} path function path
   */
  function inlineParamTypes(path) {
    for (const param of path.node.params ?? []) {
      if (
        (param.type === "Identifier" || param.type === "AssignmentPattern") &&
        !param.typeAnnotation &&
        !(param.type === "AssignmentPattern" && param.left.typeAnnotation)
      ) {
        const target = param.type === "Identifier" ? param : param.left;
        const comments = target.leadingComments ?? [];
        const ci = comments.findIndex(
          (c) =>
            c.type === "CommentBlock" &&
            c.value.trimStart().startsWith("*") &&
            /@type\s*\{/.test(c.value),
        );
        if (ci !== -1) {
          const brace = readBraceType(
            comments[ci].value.slice(comments[ci].value.indexOf("{")),
          );
          const mapped = brace ? mapType(brace.type) : null;
          if (mapped !== null) {
            target.typeAnnotation = typeAnnotation(mapped);
            comments.splice(ci, 1);
          } else {
            warn(file, lineOf(param), "неизвестный тип inline @type");
          }
        }
      }
    }
  }

  /**
   * Identifier names bound by one pattern.
   * @param {object} node pattern node
   * @returns {string[]} names
   */
  function patternNames(node) {
    if (!node) return [];
    if (node.type === "Identifier") return [node.name];
    if (node.type === "ObjectPattern") {
      return node.properties.flatMap((p) =>
        patternNames(p.value ?? p.argument),
      );
    }
    if (node.type === "ArrayPattern") {
      return node.elements.flatMap((e) => patternNames(e));
    }
    if (node.type === "RestElement") return patternNames(node.argument);
    if (node.type === "AssignmentPattern") return patternNames(node.left);
    return [];
  }

  const isFunctionLike = (t) =>
    t === "FunctionDeclaration" ||
    t === "FunctionExpression" ||
    t === "ArrowFunctionExpression" ||
    t === "ClassMethod" ||
    t === "ClassPrivateMethod" ||
    t === "ObjectMethod";

  /**
   * Promotes JSDoc type tags on a function to TS syntax. Accepts a real
   * traversal path or a {node, parent} stand-in for holder-owned values.
   * @param {object} path function path
   */
  function annotateFunctionLike(path) {
    const { node } = path;
    for (const param of node.params ?? []) markBound(param);
    inlineParamTypes(path);
    const blocks = jsdocBlocks(path);
    if (blocks.length === 0) return;
    // Use the first block carrying type tags, skipping @overload variants:
    // they describe alternate signatures, the implementation is documented
    // by the plain block (converting overloads is manual work).
    let used = null;
    for (const b of blocks) {
      const { tags } = splitBlock(b.block.value);
      if (tags.some((t) => t.tag === "overload")) continue;
      if (
        tags.some((t) =>
          [
            "param",
            "arg",
            "argument",
            "returns",
            "return",
            "this",
            "template",
          ].includes(t.tag),
        )
      ) {
        used = { ...b, tags };
        break;
      }
    }
    if (!used) return;
    const { tags } = used;
    const drop = new Set();
    // @this -> this param (not arrows).
    if (node.type !== "ArrowFunctionExpression") {
      const ti = tags.findIndex((t) => t.tag === "this");
      if (ti !== -1) {
        const p = parseNamedTag(tags[ti].text);
        const mapped = p?.type ? mapType(p.type) : null;
        if (mapped !== null) {
          node.params.unshift(snippetParam(`this: ${mapped}`));
          drop.add(ti);
        } else {
          warn(file, lineOf(node), "неизвестный тип @this");
        }
      }
    }
    // @template -> type params.
    const templates = [];
    tags.forEach((t, i) => {
      if (t.tag !== "template") return;
      let rest = t.text.trim();
      let constraint = null;
      if (rest.startsWith("{")) {
        const b = readBraceType(rest);
        if (b === null) {
          warn(file, lineOf(node), "не разобрано ограничение @template");
          return;
        }
        constraint = mapType(b.type);
        if (constraint === null) {
          warn(
            file,
            lineOf(node),
            `неизвестное ограничение @template ${b.type}`,
          );
          return;
        }
        rest = b.rest.trimStart();
      }
      // [T], [T=Default] или голое T (умолчание — только в скобках).
      let tName;
      let tDef = null;
      if (rest.startsWith("[")) {
        const close = rest.indexOf("]");
        if (close === -1) {
          warn(file, lineOf(node), "не разобран @template");
          return;
        }
        const inner = rest.slice(1, close);
        const eq = inner.indexOf("=");
        if (eq === -1) {
          tName = inner.trim();
        } else {
          tName = inner.slice(0, eq).trim();
          tDef = inner.slice(eq + 1).trim();
        }
      } else {
        const m = rest.match(/^([A-Za-z_$][\w$]*)([\s\S]*)$/);
        if (!m) {
          warn(file, lineOf(node), "не разобран @template");
          return;
        }
        tName = m[1];
      }
      if (!/^[A-Za-z_$][\w$]*$/.test(tName)) {
        warn(file, lineOf(node), "не разобран @template");
        return;
      }
      const tDefMapped = tDef ? mapType(tDef) : null;
      if (tDef && tDefMapped === null) {
        warn(file, lineOf(node), `неизвестное умолчание @template ${tDef}`);
        return;
      }
      templates.push(
        `${tName}${constraint ? ` extends ${constraint}` : ""}${tDefMapped ? ` = ${tDefMapped}` : ""}`,
      );
      drop.add(i);
    });
    if (templates.length > 0) {
      try {
        const ast2 = parse(`function __f<${templates.join(", ")}>() {}`, {
          sourceType: "unambiguous",
          plugins: ["typescript"],
        });
        fixTsRefs(ast2.program.body[0].typeParameters);
        node.typeParameters = ast2.program.body[0].typeParameters;
      } catch {
        warn(file, lineOf(node), "не собраны параметры @template");
      }
    }
    applyParams(path, tags, drop);
    // @returns -> return type (not ctors).
    if (node.kind !== "constructor") {
      const ri = tags.findIndex(
        (t) => t.tag === "returns" || t.tag === "return",
      );
      if (ri !== -1) {
        const p = parseNamedTag(tags[ri].text);
        const mapped = p?.type ? mapType(p.type) : null;
        if (mapped !== null) {
          node.returnType = typeAnnotation(mapped);
          drop.add(ri);
        } else {
          warn(file, lineOf(node), "неизвестный тип @returns");
        }
      }
    }
    rewriteBlock(used.block, drop);
    sweepDropped(used.owner);
  }

  /**
   * Annotates an object/class property holding a function value.
   * @param {object} path property path
   */
  function annotateIfFunctionValue(path) {
    const fn = path.node.value;
    if (
      !fn ||
      (fn.type !== "ArrowFunctionExpression" &&
        fn.type !== "FunctionExpression") ||
      (fn.params.length === 0 && fn.returnType)
    ) {
      return;
    }
    if (
      fn.params.length > 0 &&
      fn.params.every(
        (p) =>
          p.typeAnnotation ||
          (p.type === "AssignmentPattern" && p.left.typeAnnotation),
      ) &&
      fn.returnType
    ) {
      return;
    }
    annotateFunctionLike({ node: fn, parent: path.node, parentPath: path });
  }
  traverse(ast, {
    exit(path) {
      const { node } = path;
      // --- inline casts: /** @type {X} */ (expr) -> expr as X.
      // Exit order: innermost first, so double casts nest correctly.
      if (
        !node.leadingComments ||
        node.type === "VariableDeclarator" ||
        node.type === "FunctionDeclaration" ||
        node.type === "ClassDeclaration"
      ) {
        return;
      }
      // Комментарий перед выражением-оператором висит на самом операторе:
      // каст применяется к его выражению (`/** @type {X} */ foo();`).
      // То же для `return`/`throw` с выражением.
      const subject =
        node.type === "ExpressionStatement"
          ? node.expression
          : node.type === "ReturnStatement" || node.type === "ThrowStatement"
            ? node.argument
            : node;
      if (!subject) return;
      // Присваивание полю через this с @type — не каст, а объявление поля, но
      // только на верхнем уровне метода класса (там его разбирает проход
      // полей). В остальных местах комментарий — обычный каст цели.
      if (
        subject.type === "AssignmentExpression" &&
        subject.left.type === "MemberExpression" &&
        subject.left.object.type === "ThisExpression" &&
        !subject.left.computed &&
        subject.left.property.type === "Identifier" &&
        node.type === "ExpressionStatement" &&
        path.findParent &&
        (() => {
          const mp = path.findParent((p) => p.isClassMethod?.());
          return !!mp && mp.node.body.body.includes(node);
        })()
      ) {
        return;
      }
      // Binding positions never cast: params (handled with @param), ids,
      // keys, assignment targets.
      if (boundIds.has(subject)) return;
      if (path.isBindingIdentifier?.()) return;
      const parent = path.parent;
      if (
        (parent.type === "ObjectProperty" &&
          parent.key === subject &&
          !parent.computed) ||
        (parent.type === "ClassMethod" && parent.key === subject) ||
        (parent.type === "ObjectMethod" && parent.key === subject) ||
        (parent.type === "MemberExpression" &&
          parent.property === subject &&
          !parent.computed) ||
        (parent.type === "VariableDeclarator" && parent.id === subject) ||
        ((parent.type === "FunctionDeclaration" ||
          parent.type === "FunctionExpression" ||
          parent.type === "ArrowFunctionExpression" ||
          parent.type === "ClassMethod" ||
          parent.type === "ObjectMethod") &&
          parent.params.includes(subject))
      ) {
        return;
      }
      if (
        !subject.type.endsWith("Expression") &&
        !subject.type.endsWith("Literal") &&
        subject.type !== "TemplateLiteral" &&
        subject.type !== "Identifier"
      ) {
        return;
      }
      const idxs = [];
      node.leadingComments.forEach((c, i) => {
        if (
          c.type === "CommentBlock" &&
          c.value.trimStart().startsWith("*") &&
          (/@type\s*\{/.test(c.value) || /@type\s+[A-Za-z_$]/.test(c.value))
        ) {
          idxs.push(i);
        }
      });
      if (idxs.length === 0) return;
      const readMappedObj = (comment) => {
        // Многострочный JSDoc-тип несёт префиксы `*` продолжений: без зачистки
        // тип не разбирается.
        const tagText = comment.value.replace(/^[ \t]*\*[ \t]?/gm, "");
        const at = tagText.search(/@type\s*/);
        if (at === -1) return null;
        const rest = tagText.slice(at + 5).replace(/^\s+/, "");
        // Бесскобочный `@type X` checkJs понимает как тип до конца комментария.
        if (!rest.startsWith("{")) {
          const bare = rest.trim();
          if (!/^[A-Za-z_$]/.test(bare)) return null;
          const mapped = mapType(bare);
          if (mapped === null) {
            warn(file, lineOf(subject), `неизвестный тип каста ${bare}`);
            return null;
          }
          return mapped;
        }
        const brace = readBraceType(rest);
        if (!brace) return null;
        // `/** @type {const} */` — const-assertion, а не тип.
        if (brace.type.trim() === "const") return "const";
        const mapped = mapType(brace.type);
        if (mapped === null) {
          warn(file, lineOf(subject), `неизвестный тип каста ${brace.type}`);
          return null;
        }
        return mapped;
      };
      // Конец группы скобок с открывающей на позиции open.
      const groupEnd = (open) => {
        let d = 0;
        let str = null;
        for (let i = open; i < src.length; i++) {
          const c = src[i];
          if (str !== null) {
            if (c === str && src[i - 1] !== "\\") str = null;
            continue;
          }
          if (c === '"' || c === "'" || c === "`") {
            str = c;
            continue;
          }
          if (c === "(") d++;
          else if (c === ")") {
            d--;
            if (d === 0) return i;
          }
        }
        return -1;
      };
      const fits = (n, open, g) =>
        typeof n.start === "number" &&
        typeof n.end === "number" &&
        n.start >= open &&
        n.end <= g + 1;
      const asNode = (expr, mapped) => {
        let parsed;
        if (mapped === "const") {
          parsed = parse("(0 as const);", {
            sourceType: "unambiguous",
            plugins: ["typescript"],
          }).program.body[0].expression.typeAnnotation;
        } else {
          parsed = parse(`type __T = ${mapped};`, {
            sourceType: "unambiguous",
            plugins: ["typescript"],
          }).program.body[0].typeAnnotation;
        }
        fixTsRefs(parsed);
        const wrapped = {
          type: "TSAsExpression",
          expression: expr,
          typeAnnotation: parsed,
        };
        // Позиция обёртки — позиция цели: текст не меняется (приведение лишь
        // печатается), а внешние касты той же группы сравнивают охваты.
        wrapped.start = expr.start;
        wrapped.end = expr.end;
        wrapped.loc = expr.loc;
        return wrapped;
      };
      const casts = idxs.map((i) => node.leadingComments[i]);
      node.leadingComments = node.leadingComments.filter(
        (_, i) => !idxs.includes(i),
      );
      // Возвращает неприменённые комментарии обратно на текущий узел,
      // чтобы ручная правка видела их.
      const reattach = (rest) => {
        if (rest.length === 0) return;
        const target = path.node;
        target.leadingComments = [...rest, ...(target.leadingComments ?? [])];
      };
      // Заменяет вхождение oldNode на newNode внутри root (по ссылке).
      const swapIn = (root, oldNode, newNode) => {
        const SKIP = new Set([
          "loc",
          "leadingComments",
          "trailingComments",
          "innerComments",
          "extra",
          "start",
          "end",
        ]);
        const wl = [root];
        while (wl.length > 0) {
          const n = wl.pop();
          if (!n || typeof n !== "object") continue;
          for (const key of Object.keys(n)) {
            if (SKIP.has(key)) continue;
            const v = n[key];
            if (Array.isArray(v)) {
              const i = v.indexOf(oldNode);
              if (i !== -1) {
                v[i] = newNode;
                return true;
              }
              for (const el of v) wl.push(el);
            } else if (v && typeof v === "object" && v.type) {
              if (v === oldNode) {
                n[key] = newNode;
                return true;
              }
              wl.push(v);
            }
          }
        }
        return false;
      };
      let topped = false;
      for (let k = casts.length - 1; k >= 0; k--) {
        const comment = casts[k];
        const mapped = readMappedObj(comment);
        if (mapped === null) {
          reattach(casts.slice(0, k + 1));
          break;
        }
        let j = comment.end;
        while (j < src.length && /\s/.test(src[j])) j++;
        // Группа короче узла: спускаемся к крупнейшему входящему
        // выражению без захода внутрь функций.
        let best = null;
        let cur = subject;
        if (!topped && src[j] === "(") {
          const g = groupEnd(j);
          if (g !== -1 && !fits(cur, j, g)) {
            const SKIP = new Set([
              "loc",
              "leadingComments",
              "trailingComments",
              "innerComments",
              "extra",
              "start",
              "end",
            ]);
            const span = (n) => n.end - n.start;
            const wl = [cur];
            while (wl.length > 0) {
              const n = wl.pop();
              if (!n || typeof n !== "object") continue;
              if (
                typeof n.start === "number" &&
                typeof n.end === "number" &&
                (/Expression$/.test(n.type || "") || n.type === "Identifier") &&
                !/^Function/.test(n.type || "") &&
                !/^Class/.test(n.type || "") &&
                fits(n, j, g) &&
                (!best || span(n) > span(best))
              ) {
                best = n;
              }
              for (const key of Object.keys(n)) {
                if (SKIP.has(key)) continue;
                const v = n[key];
                if (Array.isArray(v)) {
                  for (const el of v) wl.push(el);
                } else if (v && typeof v === "object" && v.type) {
                  wl.push(v);
                }
              }
            }
            if (best !== null && best !== cur) {
              cur = best;
            } else if (best === null) {
              warn(
                file,
                lineOf(cur),
                `каст шире группы скобок (${cur.type} ${cur.start}-${cur.end} vs (${j}-${g}))`,
              );
            }
          }
        }
        if (cur.type === "Identifier" && boundIds.has(cur)) {
          warn(file, lineOf(cur), "каст на связывании пропущен");
          reattach(casts.slice(0, k + 1));
          break;
        }
        // Внутренняя цель хранит свои комментарии как есть: израсходованы
        // лишь комментарии текущего узла, снятые заранее.
        const wrapped = asNode(cur, mapped);
        if (cur !== subject) {
          if (!swapIn(subject, cur, wrapped)) {
            warn(file, lineOf(cur), "каст не привязан к подвыражению");
            reattach(casts.slice(0, k + 1));
            break;
          }
        } else if (node.type === "ExpressionStatement") {
          node.expression = wrapped;
          topped = true;
        } else if (
          (node.type === "ReturnStatement" || node.type === "ThrowStatement") &&
          cur === node.argument
        ) {
          // Каст на возвращаемом/бросаемом выражении: оборачиваем аргумент,
          // оператор остаётся (`return`/`throw` терять нельзя).
          node.argument = wrapped;
          topped = true;
        } else {
          path.replaceWith(wrapped);
          topped = true;
        }
      }
    },

    ObjectProperty(path) {
      annotateIfFunctionValue(path);
      // `/** @type {T} */ key: value` — тип значения, как в checkJs: значение
      // приводится к T, свойство выводится из него.
      const { node } = path;
      if (
        path.parent.type === "ObjectPattern" ||
        node.value.type === "FunctionExpression" ||
        node.value.type === "ArrowFunctionExpression"
      ) {
        return;
      }
      const blocks = jsdocBlocks(path);
      for (const b of blocks) {
        const { tags } = splitBlock(b.block.value);
        const ti = tags.findIndex((t) => t.tag === "type");
        if (ti === -1) continue;
        const p = parseNamedTag(tags[ti].text);
        const mapped = p?.type ? mapType(p.type) : null;
        if (mapped === null) {
          warn(file, lineOf(node), `неизвестный тип @type ${p?.type}`);
          continue;
        }
        const parsed = parse(`type __T = ${mapped};`, {
          sourceType: "unambiguous",
          plugins: ["typescript"],
        }).program.body[0].typeAnnotation;
        fixTsRefs(parsed);
        node.value = {
          type: "TSAsExpression",
          expression: node.value,
          typeAnnotation: parsed,
        };
        rewriteBlock(b.block, new Set([ti]));
        sweepDropped(b.owner);
        break;
      }
    },

    Function(path) {
      const { node } = path;
      if (!isFunctionLike(node.type)) return;
      // Object/class holders annotate their function values themselves;
      // skip here to avoid double work. Declarators go through the climb
      // below on the real path.
      const holder = path.parent;
      if (
        (holder.type === "ObjectProperty" && holder.value === node) ||
        ((holder.type === "ClassProperty" ||
          holder.type === "ClassPrivateProperty") &&
          holder.value === node)
      ) {
        return;
      }
      annotateFunctionLike(path);
    },

    VariableDeclarator(path) {
      const { node } = path;
      markBound(node.id);
      // Аннотация — на имя или на образец целиком (`const [a]: T[] = ...`).
      const target =
        node.id.type === "Identifier" ||
        node.id.type === "ObjectPattern" ||
        node.id.type === "ArrayPattern"
          ? node.id
          : null;
      if (!target || target.typeAnnotation) return;
      const blocks = jsdocBlocks(path);
      for (const b of blocks) {
        const { tags } = splitBlock(b.block.value);
        const ti = tags.findIndex((t) => t.tag === "type");
        if (ti === -1) continue;
        const p = parseNamedTag(tags[ti].text);
        const mapped = p?.type ? mapType(p.type) : null;
        if (mapped === null) {
          warn(file, lineOf(node), `неизвестный тип @type ${p?.type}`);
          continue;
        }
        target.typeAnnotation = typeAnnotation(mapped);
        rewriteBlock(b.block, new Set([ti]));
        sweepDropped(b.owner);
        break;
      }
    },

    ClassProperty(path) {
      const { node } = path;
      annotateIfFunctionValue(path);
      if (node.typeAnnotation) return;
      const blocks = jsdocBlocks(path);
      for (const b of blocks) {
        const { tags } = splitBlock(b.block.value);
        const ti = tags.findIndex((t) => t.tag === "type");
        if (ti === -1) continue;
        const p = parseNamedTag(tags[ti].text);
        const mapped = p?.type ? mapType(p.type) : null;
        if (mapped === null) {
          warn(file, lineOf(node), `неизвестный тип @type ${p?.type}`);
          continue;
        }
        node.typeAnnotation = typeAnnotation(mapped);
        rewriteBlock(b.block, new Set([ti]));
        sweepDropped(b.owner);
        break;
      }
    },

    ClassPrivateProperty(path) {
      const { node } = path;
      annotateIfFunctionValue(path);
      if (node.typeAnnotation) return;
      const blocks = jsdocBlocks(path);
      for (const b of blocks) {
        const { tags } = splitBlock(b.block.value);
        const ti = tags.findIndex((t) => t.tag === "type");
        if (ti === -1) continue;
        const p = parseNamedTag(tags[ti].text);
        const mapped = p?.type ? mapType(p.type) : null;
        if (mapped === null) {
          warn(file, lineOf(node), `неизвестный тип @type ${p?.type}`);
          continue;
        }
        node.typeAnnotation = typeAnnotation(mapped);
        rewriteBlock(b.block, new Set([ti]));
        sweepDropped(b.owner);
        break;
      }
    },
  });

  // --- standalone @typedef/@callback -> interface/type -------------------------
  // Typedef blocks often stand alone (not leading a statement), so scan all
  // comments. The declaration lands in the smallest enclosing block: class
  // bodies cannot hold types, so class-level ones go top-level (their uses
  // rely on file visibility in checkJs).
  const blockRanges = [];
  traverse(ast, {
    enter(path) {
      const n = path.node;
      const arr =
        n.type === "Program"
          ? n.body
          : n.type === "BlockStatement" || n.type === "StaticBlock"
            ? n.body
            : null;
      if (arr && n.start !== undefined)
        blockRanges.push({ arr, start: n.start, end: n.end });
    },
  });
  for (const comment of ast.comments ?? []) {
    if (
      comment.type !== "CommentBlock" ||
      !comment.value.trimStart().startsWith("*") ||
      !/@(typedef|callback)\b/.test(comment.value)
    ) {
      continue;
    }
    const { prose, tags } = splitBlock(comment.value);
    const def = tags.find((t) => TYPEDEF_TAGS.has(t.tag));
    if (!def) continue;
    const stmtLine = comment.loc?.start.line ?? 0;
    const decl = convertTypedef(file, stmtLine, prose, tags);
    if (!decl) continue;
    // Smallest block holding the comment; Program when none (top-level or
    // class-level comments).
    let target = null;
    for (const b of blockRanges) {
      if (b.start <= comment.start && comment.end <= b.end) {
        if (!target || b.end - b.start < target.end - target.start) target = b;
      }
    }
    if (!target) target = { arr: ast.program.body, start: 0, end: Infinity };
    const body = target.arr;
    let at = body.findIndex((st) => st.start > comment.end);
    if (at === -1) at = body.length;
    body.splice(at, 0, decl);
    const keep = tags.filter(
      (t) =>
        !TYPEDEF_TAGS.has(t.tag) && t.tag !== "property" && t.tag !== "prop",
    );
    // Описание переехало в объявление: в исходном комментарии его не дублируем.
    if (keep.length === 0) {
      comment._drop = true;
    } else {
      const lines = [];
      for (const t of keep) lines.push(`@${t.tag} ${t.text}`.trimEnd());
      comment.value = `*\n${lines.map((l) => ` * ${l}`.trimEnd()).join("\n")}\n `;
    }
  }
  traverse(ast, {
    enter(path) {
      sweepDropped(path.node);
    },
  });

  // this.X assignments without declarations -> `declare X: T` fields.
  // `declare` не излучает код, поэтому поведение не меняется: присваивания на
  // месте остаются. Тип берётся из висячего `/** @type */`, из аннотации
  // одноимённого параметра метода или из литерала справа; иначе — warn.
  traverse(ast, {
    Class(path) {
      const cls = path.node;
      const declared = new Set();
      for (const el of cls.body.body) {
        if (
          (el.type === "ClassProperty" || el.type === "ClassMethod") &&
          el.key.type === "Identifier"
        ) {
          declared.add(el.key.name);
        }
        if (el.type === "ClassPrivateProperty") {
          declared.add(`#${el.key.id.name}`);
        }
      }
      const added = [];
      for (const el of cls.body.body) {
        if (el.type !== "ClassMethod") continue;
        const paramTypes = new Map();
        for (const p of el.params) {
          const core = p.type === "AssignmentPattern" ? p.left : p;
          if (core.type === "Identifier" && core.typeAnnotation) {
            paramTypes.set(core.name, core.typeAnnotation.typeAnnotation);
          }
        }
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
          declared.add(name);
          const field = fieldFor(name, st, paramTypes);
          if (field) added.push(field);
        }
      }
      if (added.length > 0) {
        cls.body.body.unshift(...added);
      }
      // Тип поля: @type из висячего комментария, тип параметра или литерал.
      function fieldFor(name, st, paramTypes) {
        const rhs = st.expression.right;
        let typeText = null;
        let doc = null;
        for (const c of st.leadingComments ?? []) {
          if (
            c.type === "CommentBlock" &&
            c.value.trimStart().startsWith("*") &&
            /@type\s*\{/.test(c.value)
          ) {
            const { prose, tags } = splitBlock(
              c.value.replace(/^[ \t]*\*[ \t]?/gm, ""),
            );
            const ti = tags.findIndex((t) => t.tag === "type");
            if (ti !== -1) {
              const p = parseNamedTag(tags[ti].text);
              const mapped = p?.type ? mapType(p.type) : null;
              if (mapped === null) {
                warn(
                  file,
                  st.loc?.start.line ?? 0,
                  `неизвестный тип поля this.${name}`,
                );
                return null;
              }
              typeText = mapped;
              doc = prose.length > 0 ? prose : null;
              c._drop = true;
            }
            break;
          }
        }
        if (
          typeText === null &&
          rhs.type === "Identifier" &&
          paramTypes.has(rhs.name)
        ) {
          const ann = paramTypes.get(rhs.name);
          fixTsRefs(ann);
          typeText = generate(ann).code;
        }
        if (typeText === null) {
          if (rhs.type === "BooleanLiteral") typeText = "boolean";
          else if (rhs.type === "StringLiteral") typeText = "string";
          else if (rhs.type === "NumericLiteral") typeText = "number";
        }
        if (typeText === null || !checkType(typeText)) {
          warn(
            file,
            st.loc?.start.line ?? 0,
            `this.${name} без объявления поля`,
          );
          return null;
        }
        try {
          const parsed = parse(`class __C { declare ${name}: ${typeText}; }`, {
            sourceType: "unambiguous",
            plugins: ["typescript"],
          });
          const prop = parsed.program.body[0].body.body[0];
          fixTsRefs(prop);
          if (doc) {
            prop.leadingComments = [
              {
                type: "CommentBlock",
                value: `*\n${doc.map((l) => ` * ${l}`.trimEnd()).join("\n")}\n `,
              },
            ];
          }
          sweepDropped(st);
          return prop;
        } catch {
          warn(
            file,
            st.loc?.start.line ?? 0,
            `this.${name} без объявления поля`,
          );
          return null;
        }
      }
    },
  });

  const out = generate(ast, { comments: true, compact: false }, src).code;
  writeFileSync(file, `${out}\n`);
}

/**
 * Converts one @typedef/@callback block into a declaration node.
 * @param {string} file converted file
 * @param {number} line block line
 * @param {string[]} prose description lines
 * @param {{tag: string, text: string}[]} tags parsed tags
 * @returns {object|null} interface/type alias node
 */
function convertTypedef(file, line, prose, tags) {
  const def = tags.find((t) => TYPEDEF_TAGS.has(t.tag));
  const isCallback = def.tag === "callback";
  const head = parseNamedTag(isCallback ? def.text : def.text);
  // @callback Name + @param/@returns in the same block.
  if (isCallback) {
    const name = (head?.name ?? "").replace(/^\[|\]$/g, "");
    if (!name) {
      warn(file, line, "безымянный @callback");
      return null;
    }
    const params = [];
    let ret = "void";
    for (const t of tags) {
      if (t.tag !== "param" && t.tag !== "arg" && t.tag !== "argument") {
        if (t.tag === "returns" || t.tag === "return") {
          const p = parseNamedTag(t.text);
          const m = p?.type ? mapType(p.type) : null;
          if (m) ret = m;
        }
        continue;
      }
      const p = parseNamedTag(t.text);
      if (!p?.name) continue;
      const m = p.type ? mapType(p.type) : null;
      if (!m) {
        warn(file, line, `неизвестный тип @param @callback ${p.type}`);
        return null;
      }
      const { name: n, optional } = optionalName(p.name);
      params.push(`${n}${optional ? "?" : ""}: ${m}`);
    }
    return snippetDecl(
      `type ${name} = (${params.join(", ")}) => ${ret};`,
      file,
      line,
    );
  }
  const m = head?.type ? null : null;
  void m;
  const rawType = head?.type ?? "";
  const rawName = (head?.name ?? "").replace(/^\[|\]$/g, "");
  if (!rawName) {
    warn(file, line, "безымянный @typedef");
    return null;
  }
  const props = tags.filter((t) => t.tag === "property" || t.tag === "prop");
  if (/^\s*object\s*$/i.test(rawType) && props.length > 0) {
    const members = [];
    for (const t of props) {
      const p = parseNamedTag(t.text);
      if (!p?.name) continue;
      const mt = p.type ? mapType(p.type) : null;
      if (!mt) {
        warn(file, line, `неизвестный тип @property ${p.type}`);
        return null;
      }
      const parts = p.name.split(".");
      if (parts.length > 1) {
        warn(file, line, "вложенное @property пропущено");
        return null;
      }
      const { name: n, optional } = optionalName(p.name);
      const full = p.desc
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "")
        .join("\n");
      const safe = full.replace(/\*\//g, "* /");
      const docLines =
        safe === ""
          ? []
          : safe.includes("\n")
            ? [
                `/** ${safe.split("\n")[0]}`,
                ...safe.split("\n").slice(1),
                " */",
              ]
            : [`/** ${safe} */`];
      members.push(
        [
          ...docLines.map((l) => `  ${l}`),
          `  ${n}${optional ? "?" : ""}: ${mt};`,
        ].join("\n"),
      );
    }
    const doc =
      prose.length > 0
        ? `/**\n${prose.map((l) => ` * ${l}`.trimEnd()).join("\n")}\n */\n`
        : "";
    return snippetDecl(
      `${doc}interface ${rawName} {\n${members.map((x) => `  ${x}`).join("\n")}\n}`,
      file,
      line,
    );
  }
  const mapped = mapType(rawType);
  if (!mapped) {
    warn(file, line, `неизвестный тип @typedef ${rawType}`);
    return null;
  }
  const doc =
    prose.length > 0
      ? `/**\n${prose.map((l) => ` * ${l}`.trimEnd()).join("\n")}\n */\n`
      : "";
  return snippetDecl(`${doc}type ${rawName} = ${mapped};`, file, line);
}

/**
 * Parses a declaration snippet into its node.
 * @param {string} code declaration code
 * @param {string} file converted file
 * @param {number} line block line
 * @returns {object|null} first statement or null
 */
function snippetDecl(code, file, line) {
  try {
    const ast = parse(code, {
      sourceType: "unambiguous",
      plugins: ["typescript"],
    });
    const stmt = ast.program.body[0] ?? null;
    if (stmt) fixTsRefs(stmt);
    return stmt;
  } catch {
    warn(file, line, "не собрано объявление typedef");
    return null;
  }
}

// --- main -----------------------------------------------------------------------

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
 * @returns {boolean} true when the file is converted
 */
function isScannable(filePath) {
  return (
    (filePath.endsWith(".ts") || filePath.endsWith(".mts")) &&
    !filePath.endsWith(".d.ts") &&
    !filePath.endsWith(".min.ts") &&
    !filePath.endsWith(".min.mts")
  );
}

const targets = process.argv.slice(2).filter((a) => a !== "--");
if (targets.length === 0) {
  console.error(`${USAGE}\nmissing path: point at a .ts file or a directory`);
  process.exit(2);
}
const files = [];
for (const t of targets) {
  const resolved = resolve(t);
  let st;
  try {
    st = statSync(resolved);
  } catch {
    console.error(`${USAGE}\nno such file or directory: ${t}`);
    process.exit(2);
  }
  if (st.isDirectory()) {
    files.push(...walk(resolved).sort());
  } else {
    if (!isScannable(resolved)) {
      console.error(
        `FAIL: no .ts/.mts files under ${t}, nothing was checked.`,
      );
      process.exit(1);
    }
    files.push(resolved);
  }
}
if (files.length === 0) {
  console.error(
    `FAIL: no .ts/.mts files under ${targets.join(", ")}, nothing was checked.`,
  );
  process.exit(1);
}
for (const f of files) {
  try {
    convertFile(f);
  } catch (e) {
    const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
    warnings.push(`${f}:0  cannot convert: ${msg}`);
  }
}
for (const w of warnings) console.log(`WARN  ${w}`);
console.log(`converted ${files.length} files, ${warnings.length} warnings`);

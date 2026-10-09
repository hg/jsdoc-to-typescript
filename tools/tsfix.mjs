#!/usr/bin/env node
/// Fixes mechanical strictness gaps between checkJs and `.ts`.
/// Reads tsc error output, patches converted files, repeats to fixpoint.
///
/// Classes (all behavior-preserving — types only):
///   TS2352  cast without type overlap -> `expr as unknown as T` (like JSDoc casts in checkJs);
///   TS2322  `let x: T = <bad init>` carrying our annotation -> init via unknown;
///   TS7006  untyped parameter -> `: any` (`...args` -> `: any[]`, pattern -> `: any`);
///   TS2571/TS18046/TS2532 from a catch variable -> `catch (e: any)`;
///   TS2578  stale directive (a suppression turned unnecessary) -> delete the line.
/// Plus collapsing `(X as T) as unknown` into `X as T` (nested-cast artifact).
/// The rest goes to `skip` for the manual pass.
///
/// COMMANDS
///   tsfix.mjs <tsc-log>   apply fixes, print JSON stats; the log path comes
///                           from args, as in jsdoc-to-ts.mjs
///
/// WORKFLOW
///   ./node_modules/.bin/tsc --noEmit > tsc.log
///   ./tools/tsfix.mjs tsc.log   # repeat until counters hit zero
///
/// EXIT CODES
///   0  always (unfixed items show in stats)
///   2  missing path, or unreadable log
const USAGE = "usage: tsfix.mjs <tsc-log>";
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import _generate from "@babel/generator";

const traverse = _traverse.default ?? _traverse;
const generate = _generate.default ?? _generate;

const logPath = process.argv.slice(2).filter((a) => a !== "--")[0];
if (!logPath) {
  console.error(`${USAGE}\nmissing path: point at a tsc log file`);
  process.exit(2);
}

let logText;
try {
  logText = readFileSync(logPath, "utf8");
} catch {
  console.error(`${USAGE}\nno such file or directory: ${logPath}`);
  process.exit(2);
}

const errors = [];
for (const line of logText.split("\n")) {
  const m = line.match(/^(.*?)\((\d+),(\d+)\): error (TS\d+): (.*)$/);
  if (m) {
    errors.push({
      file: m[1],
      line: +m[2],
      col: +m[3],
      code: m[4],
      msg: m[5],
    });
  }
}

// Stale directives are deleted by line: the tsc position points right at
// them. This runs before the AST fixes, on the original text: the fixes
// reprint the file and shift line numbers, so positions from this log would
// no longer point at the directives afterwards. Each deletion above an error
// shifts that error one line up.
const staleErrors = errors.filter((e) => e.code === "TS2578");
const staleByFile = new Map();
for (const e of staleErrors) {
  if (!staleByFile.has(e.file)) staleByFile.set(e.file, []);
  staleByFile.get(e.file).push(e.line);
}
const deletedLines = new Map();
let staleRemoved = 0;
for (const [file, positions] of staleByFile) {
  let lines;
  try {
    lines = readFileSync(file, "utf8").split("\n");
  } catch {
    // No file — nothing to fix.
    continue;
  }
  const gone = [];
  // Bottom-up with dedupe, so deletions don't shift each other and a
  // duplicated log line cannot eat the line below the directive.
  for (const ln of [...new Set(positions)].sort((a, b) => b - a)) {
    const idx = ln - 1;
    if (
      idx >= 0 &&
      idx < lines.length &&
      lines[idx].trimStart().startsWith("// @ts-expect-error")
    ) {
      lines.splice(idx, 1);
      gone.push(ln);
    }
  }
  if (gone.length > 0) {
    writeFileSync(file, lines.join("\n"));
    gone.sort((a, b) => a - b);
    deletedLines.set(file, gone);
    staleRemoved += gone.length;
  }
}

const byFile = new Map();
for (const e of errors) {
  if (e.code === "TS2578") continue;
  const gone = deletedLines.get(e.file);
  if (gone) {
    for (const d of gone) if (d < e.line) e.line--;
  }
  if (!byFile.has(e.file)) byFile.set(e.file, []);
  byFile.get(e.file).push(e);
}

/**
 * Checks that a tsc position is inside a node (tsc: 1-based lines/columns;
 * babel: 1-based lines, 0-based columns).
 * @param {object} loc babel loc of the node
 * @param {number} L tsc line
 * @param {number} C tsc column
 * @returns {boolean} position inside the node
 */
const contains = (loc, L, C) => {
  if (!loc) return false;
  const c = C - 1;
  const afterStart =
    loc.start.line < L || (loc.start.line === L && loc.start.column <= c);
  const beforeEnd =
    loc.end.line > L || (loc.end.line === L && loc.end.column >= c);
  return afterStart && beforeEnd;
};

/**
 * Whether a type node is the `unknown` keyword. The bundled parser emits
 * `unknown` as TSUnknownKeyword rather than as a TSTypeReference, so both
 * shapes are accepted.
 * @param {object} t type node
 * @returns {boolean} true for `unknown`
 */
function isUnknownType(t) {
  if (!t || typeof t !== "object") return false;
  if (t.type === "TSUnknownKeyword") return true;
  return (
    t.type === "TSTypeReference" &&
    t.typeName?.type === "Identifier" &&
    t.typeName.name === "unknown"
  );
}

/**
 * Builds a type annotation from text.
 * @param {string} code type text
 * @returns {object} TSTypeAnnotation node
 */
function loadTypeAnnotation(code) {
  const ast = parse(`type __T = ${code};`, {
    sourceType: "unambiguous",
    plugins: ["typescript"],
  });
  const t = ast.program.body[0].typeAnnotation;
  fixNode(t);
  return { type: "TSTypeAnnotation", typeAnnotation: t };
}

/**
 * Normalizes parser 7 nodes to printer 8 shapes over a subtree: without it,
 * reprinting drops the source in `import()` and function parameters.
 * @param {object} root subtree root
 */
function fixNode(root) {
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
      ) {
        continue;
      }
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
 * Reads and parses a file.
 * @param {string} file path
 * @returns {{src: string, ast: object}} text and AST
 */
function parseFile(file) {
  const src = readFileSync(file, "utf8");
  const ast = parse(src, {
    sourceType: "unambiguous",
    allowReturnOutsideFunction: true,
    plugins: [
      "typescript",
      "jsx",
      "classProperties",
      "optionalChaining",
      "nullishCoalescingOperator",
    ],
  });
  return { src, ast };
}

/**
 * Writes the AST back to the file.
 * @param {string} file path
 * @param {object} ast tree
 * @param {string} src source text (for the printer)
 */
function saveFile(file, ast, src) {
  writeFileSync(
    file,
    `${generate(ast, { comments: true, compact: false }, src).code}\n`,
  );
}

/**
 * Span length of a node, for smallest-match search.
 * @param {object} n node
 * @returns {number} length
 */
function spanOf(n) {
  return (n.end ?? 0) - (n.start ?? 0);
}

const stats = { cast: 0, catch: 0, param: 0, init: 0, skip: [] };

for (const [file, list] of byFile) {
  let ast;
  let src;
  try {
    ({ ast, src } = parseFile(file));
  } catch {
    continue;
  }
  let dirty = false;
  fixNode(ast);
  try {
    // Fix targets per kind.
    const asTargets = [];
    const catchTargets = new Set();
    const paramTargets = [];
    const initTargets = [];

    for (const e of list) {
      if (e.code === "TS2352") {
        // Smallest `as` containing the position (not via unknown yet).
        let best = null;
        traverse(ast, {
          TSAsExpression(path) {
            if (!contains(path.node.loc, e.line, e.col)) return;
            if (!best || spanOf(path.node) < spanOf(best)) best = path.node;
          },
        });
        if (best) {
          const inner = best.expression;
          const viaUnknown =
            inner.type === "TSAsExpression" &&
            isUnknownType(inner.typeAnnotation);
          if (!viaUnknown && !asTargets.includes(best)) asTargets.push(best);
        }
      } else if (
        e.code === "TS2571" ||
        e.code === "TS18046" ||
        e.code === "TS2532"
      ) {
        // Catch variable used as unknown: find the try holding the position
        // and annotate its catch parameter.
        traverse(ast, {
          TryStatement(path) {
            const n = path.node;
            const h = n.handler;
            if (
              h?.param?.type === "Identifier" &&
              !h.param.typeAnnotation &&
              contains(n.loc, e.line, e.col)
            ) {
              catchTargets.add(h);
            }
          },
        });
      } else if (e.code === "TS7006") {
        paramTargets.push(e);
      } else if (e.code === "TS2322") {
        initTargets.push(e);
      }
    }

    for (const n of asTargets) {
      const unk = parse("type __T = unknown;", {
        sourceType: "unambiguous",
        plugins: ["typescript"],
      }).program.body[0].typeAnnotation;
      const wrapped = {
        type: "TSAsExpression",
        expression: n.expression,
        typeAnnotation: unk,
      };
      // Wrapper position tracks the target: otherwise outer casts of the same
      // group compare spans blindly (loc-less nodes).
      wrapped.start = n.expression.start;
      wrapped.end = n.expression.end;
      wrapped.loc = n.expression.loc;
      n.expression = wrapped;
      stats.cast++;
      dirty = true;
    }

    for (const h of catchTargets) {
      if (h.param && h.param.type === "Identifier") {
        h.param.typeAnnotation = loadTypeAnnotation("any");
        stats.catch++;
        dirty = true;
      }
    }

    for (const e of paramTargets) {
      // Outermost parameter of the enclosing function containing the position.
      let done = false;
      traverse(ast, {
        Function(path) {
          if (done || !contains(path.node.loc, e.line, e.col)) return;
          for (const p of path.node.params) {
            if (!contains(p.loc, e.line, e.col)) continue;
            const core = p.type === "AssignmentPattern" ? p.left : p;
            if (core.type === "Identifier" && !core.typeAnnotation) {
              core.typeAnnotation = loadTypeAnnotation("any");
              stats.param++;
              dirty = true;
              done = true;
              return;
            }
            if (core.type === "RestElement" && !core.typeAnnotation) {
              core.typeAnnotation = loadTypeAnnotation("any[]");
              stats.param++;
              dirty = true;
              done = true;
              return;
            }
            if (
              (core.type === "ObjectPattern" || core.type === "ArrayPattern") &&
              !core.typeAnnotation
            ) {
              core.typeAnnotation = loadTypeAnnotation("any");
              stats.param++;
              dirty = true;
              done = true;
              return;
            }
          }
        },
      });
      if (!done) {
        stats.skip.push(
          `${e.file}(${e.line},${e.col}): ${e.code} param not placed`,
        );
      }
    }

    // Collapsing `(X as T) as unknown` into `X as T`: the outer unknown is
    // always an artifact (nested casts apply inside-out), and reading
    // properties off it yields TS2571. The direction is safe: T is assignable
    // to unknown anyway.
    traverse(ast, {
      TSAsExpression(path) {
        const n = path.node;
        if (
          n.expression.type === "TSAsExpression" &&
          isUnknownType(n.typeAnnotation) &&
          // Part of a longer chain — leave alone to avoid oscillating with
          // the TS2352 wrapper.
          !(path.parent && path.parent.type === "TSAsExpression")
        ) {
          path.replaceWith(n.expression);
          stats.cast++;
          dirty = true;
        }
      },
    });

    for (const e of initTargets) {
      // `let x: T = <bad init>` where the converter put the annotation: trust
      // it (like checkJs) and route the init through unknown.
      let done = false;
      traverse(ast, {
        VariableDeclarator(path) {
          if (done) return;
          const n = path.node;
          if (
            n.id.type === "Identifier" &&
            n.id.typeAnnotation &&
            n.init &&
            n.id.loc &&
            n.id.loc.start.line === e.line &&
            n.id.loc.start.column === e.col - 1
          ) {
            const tParsed = structuredClone(n.id.typeAnnotation.typeAnnotation);
            fixNode(tParsed);
            const unk = parse("type __T = unknown;", {
              sourceType: "unambiguous",
              plugins: ["typescript"],
            }).program.body[0].typeAnnotation;
            n.init = {
              type: "TSAsExpression",
              expression: {
                type: "TSAsExpression",
                expression: n.init,
                typeAnnotation: unk,
              },
              typeAnnotation: tParsed,
            };
            stats.init++;
            dirty = true;
            done = true;
          }
        },
      });
      if (!done) {
        stats.skip.push(
          `${e.file}(${e.line},${e.col}): ${e.code} init not placed`,
        );
      }
    }

    if (dirty) {
      try {
        saveFile(file, ast, src);
      } catch (err) {
        stats.skip.push(`${file}: generate failed: ${err.message}`);
      }
    }
  } catch (err) {
    stats.skip.push(`${file}: fix failed: ${err.message}`);
  }
}

console.log(
  JSON.stringify(
    { ...stats, staleRemoved, stale: staleErrors.length },
    null,
    1,
  ),
);

#!/usr/bin/env node
/// Inserts suppressions for duplicated page globals.
/// Pages load one domain script each, so same-name globals in different files
/// never collide in the browser (the last definition wins), while tsc, which
/// merges every file into one program, answers TS2393/TS2394 (functions) and
/// TS2451 (block-scoped redeclares). The directive
/// documents exactly that. Idempotent: already suppressed sites are skipped.
///
/// COMMANDS
///   tsdup.mjs <tsc-log>   insert directives, print stats; the log path
///                           comes from args, as in jsdoc-to-ts.mjs
///
/// WORKFLOW
///   ./node_modules/.bin/tsc --noEmit > tsc.log
///   ./tools/tsdup.mjs tsc.log
///
/// EXIT CODES
///   0  always
///   2  missing path, or unreadable log
const USAGE = "usage: tsdup.mjs <tsc-log>";
import { readFileSync, writeFileSync } from "node:fs";

const NOTE =
  "// @ts-expect-error: намеренное переопределение: страницы грузят по одному скрипту, побеждает последнее определение";

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

const sites = new Map();
for (const line of logText.split("\n")) {
  const m = line.match(/^(.*?)\((\d+),(\d+)\): error (TS2393|TS2394|TS2451)/);
  if (m) {
    const key = m[1];
    if (!sites.has(key)) sites.set(key, new Set());
    sites.get(key).add(+m[2]);
  }
}

let inserted = 0;
let touched = 0;
for (const [file, lines] of sites) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  touched++;
  const out = text.split("\n");
  let fileInserted = 0;
  // Bottom-up so insertions don't shift line numbers.
  for (const ln of [...lines].sort((a, b) => b - a)) {
    const idx = ln - 1;
    if (idx < 0 || idx >= out.length) continue;
    // Already suppressed: the tsc line points at our own previous
    // insertion (same-log rerun) or right below one (shifted report).
    if (out[idx].trim() === NOTE) continue;
    let prev = idx - 1;
    while (prev >= 0 && out[prev].trim() === "") prev--;
    if (prev >= 0 && out[prev].trim() === NOTE) continue;
    const indent = out[idx].match(/^\s*/)[0];
    out.splice(idx, 0, `${indent}${NOTE}`);
    inserted++;
    fileInserted++;
  }
  if (fileInserted > 0) writeFileSync(file, out.join("\n"));
}
console.log(`suppressed ${inserted} duplicate sites in ${touched} files`);

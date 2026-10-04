import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const TOOL = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "jsdoc-to-ts.mjs",
);

/**
 * Creates a temp tree from fixtures and runs the tool. `<DIR>` inside any
 * argument is replaced with the tree root.
 * @param {string[]} args CLI arguments after the script path
 * @param {Record<string, string>} fixtures relative path to file text
 * @returns {{status: number, stdout: string, stderr: string, output: string, dir: string}}
 *   exit code, streams, their concatenation, and the tree root
 */
export function run(args, fixtures = {}) {
  const dir = mkdtempSync(join(tmpdir(), "jsdoc-to-ts-"));
  for (const [rel, text] of Object.entries(fixtures)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  const resolved = args.map((a) => a.split("<DIR>").join(dir));
  return { ...runIn(resolved), dir };
}

/**
 * Runs the tool with explicit arguments and no fixture setup.
 * @param {string[]} args CLI arguments after the script path
 * @returns {{status: number, stdout: string, stderr: string, output: string}}
 *   exit code, streams and their concatenation
 */
export function runIn(args) {
  const proc = spawnSync(process.execPath, [TOOL, ...args], {
    encoding: "utf8",
  });
  const stdout = proc.stdout ?? "";
  const stderr = proc.stderr ?? "";
  return { status: proc.status, stdout, stderr, output: `${stdout}${stderr}` };
}

/**
 * Reads a file from a temp tree.
 * @param {string} dir tree root from run()
 * @param {string} rel path relative to the root
 * @returns {string} file text
 */
export function read(dir, rel) {
  return readFileSync(join(dir, rel), "utf8");
}

/**
 * Asserts a convert run rewrote exactly the expected text.
 * @param {string} dir tree root from run()
 * @param {string} rel converted file path
 * @param {string} expected exact expected text
 * @returns {void}
 */
export function assertConverted(dir, rel, expected) {
  assert.equal(read(dir, rel), expected);
}

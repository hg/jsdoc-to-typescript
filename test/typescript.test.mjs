import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import { join } from "node:path";
import { run } from "./helpers.mjs";

const FIXTURE = `/**
 * Greets or defaults.
 *
 * @param {string} [name="world"] who
 * @returns {string} greeting
 */
export function greet(name = "world") {
  return \`hi \${name}\`;
}

/**
 * Boxes a payload.
 *
 * @template [T=unknown] payload
 * @param {T} value content
 * @returns {T} same
 */
export function box(value) {
  return value;
}

/**
 * Joins words.
 *
 * @param {string} sep separator
 * @param {...string} words parts
 * @returns {string} joined
 */
export function joinAll(sep, ...words) {
  return words.join(sep);
}

/**
 * Endpoint from parts.
 *
 * @param {object} opts settings
 * @param {string} opts.host name
 * @param {number} [opts.port=80] port
 * @returns {string} endpoint
 */
export function endpoint({ host, port = 80 }) {
  const base: string = host;
  const num: number = port;
  return \`\${base}:\${num}\`;
}

export class Store {
  /** @type {number} total */
  total = 0;

  /**
   * Adds up.
   *
   * @param {number} n amount
   * @returns {number} new total
   */
  add(n) {
    this.total += n;
    return this.total;
  }
}
`;

/**
 * Locates a TypeScript compiler: project-local first, then PATH.
 * @returns {string|null} binary to run, or null when none is available
 */
function findTsc() {
  const root = join(new URL(".", import.meta.url).pathname, "..");
  const local = join(root, "node_modules", ".bin", "tsc");
  if (existsSync(local)) return local;
  const probed = spawnSync("tsc", ["--version"], { encoding: "utf8" });
  if (probed.status === 0) return "tsc";
  if (existsSync("/usr/bin/tsc")) return "/usr/bin/tsc";
  return null;
}

const tsc = findTsc();

describe("tsc validation", { skip: tsc === null }, () => {
  it("converted output typechecks under strict", () => {
    const { status, dir } = run(["convert", "<DIR>"], {
      "src/a.ts": FIXTURE,
    });
    assert.equal(status, 0);
    const checked = spawnSync(
      tsc,
      [
        "--ignoreConfig",
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--target",
        "es2020",
        "--module",
        "esnext",
        join(dir, "src", "a.ts"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  });
});

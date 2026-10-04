import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { assertConverted, read, run } from "./helpers.mjs";

describe("comments and attachment", () => {
  it("strips multiline types including * prefixes", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * Loads.
 *
 * @param {{
 *   url: string,
 *   retry?: number
 * }} opts settings
 * @returns {void}
 */
export function f({ url, retry }) {
  console.log(url, retry);
}
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `/**
 * Loads.
 *
 * @param opts settings
 */
export function f({ url, retry }: {
  url: string,
  retry?: number
}): void {
  console.log(url, retry);
}
`,
    );
  });

  it("reads bracket defaults containing spaces and quotes", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @param {string|false} [contentType="application/json; charset=utf-8"] mime
 * @returns {void}
 */
export function f(contentType = "application/json; charset=utf-8") {
  console.log(contentType);
}
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `/**
 * @param contentType mime
 */
export function f(contentType: string|false = "application/json; charset=utf-8"): void {
  console.log(contentType);
}
`,
    );
  });

  it("reads names on continuation lines", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @param {((value: string) => Promise<unknown>|unknown)|undefined}
 * [parse] optional parser
 * @returns {void}
 */
export function f(parse) {
  console.log(parse);
}
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `/**
 * @param parse optional parser
 */
export function f(parse?: ((value: string) => Promise<unknown>|unknown)|undefined): void {
  console.log(parse);
}
`,
    );
  });

  it("excludes typedef, callback and overload blocks", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * Row map.
 *
 * @typedef {Record<string, number>} RowMap
 */

/**
 * @overload
 * @param {string} text words
 */
/**
 * Takes text or a count.
 *
 * @param {string|number} value input
 * @returns {string} text
 */
export function take(value) {
  return String(value);
}
`,
    });
    const out = read(dir, "a.ts");
    assert.match(out, /@typedef \{Record<string, number>\} RowMap/);
    assert.match(out, /@overload/);
    assert.match(out, /@param \{string\} text words/);
    assert.match(out, /function take\(value: string\|number\): string/);
  });

  it("ignores @tags inside prose and code samples", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * Trims text.
 *
 * Example: trim(s) where
 *   // @param {string} s the value
 *   // @returns {string} trimmed
 *
 * @param {string} s the value
 * @returns {string} trimmed
 */
export function trim(s) {
  return s.trim();
}
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `/**
 * Trims text.
 *
 * Example: trim(s) where
 *   // @param {string} s the value
 *   // @returns {string} trimmed
 *
 * @param s the value
 * @returns trimmed
 */
export function trim(s: string): string {
  return s.trim();
}
`,
    );
  });

  it("still converts several tags on one line", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/** @param {string} a first @returns {number} count */
export function f(a) {
  return [a];
}
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `/** @param a first @returns count */
export function f(a: string): number {
  return [a];
}
`,
    );
  });

  it("finds docs through exports, assignments and returns", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @param {string} key lock
 * @returns {string} same
 */
export const get = (key) => key;
/**
 * @param {string} key lock
 * @returns {string} same
 */
const fn = function (key) {
  return key;
};
/**
 * Makes a getter.
 *
 * @param {string} key lock
 * @returns {(k: string) => string} reader
 */
export function maker() {
  /**
   * @param {string} key lock
   * @returns {string} same
   */
  return function (key) {
    return key;
  };
}
`,
    });
    const out = read(dir, "a.ts");
    assert.match(out, /export const get = \(key: string\): string => key;/);
    assert.match(out, /const fn = function \(key: string\): string \{/);
    assert.match(out, /return function \(key: string\): string \{/);
  });

  it("reports unparsable files without touching them", () => {
    const { status, stdout, dir } = run(["convert", "<DIR>"], {
      "a.ts": `export function broken( {
  console.log("missing paren");
}
`,
    });
    assert.equal(status, 1);
    assert.match(stdout, /SKIPPED\s+a\.ts/);
    assert.match(read(dir, "a.ts"), /export function broken\( \{/);
  });

  it("never lets two symbols claim the same tag", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @param {string} x input
 * @returns {string} same
 */
export const f = (x) => x, g = (x) => x;
`,
    });
    // The first arrow consumes the tags; the second finds them consumed and
    // stays untyped rather than duplicating edits over the same comment
    assertConverted(
      dir,
      "a.ts",
      `/**
 * @param x input
 * @returns same
 */
export const f = (x: string): string => x, g = (x) => x;
`,
    );
  });
});

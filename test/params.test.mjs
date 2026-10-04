import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { assertConverted, read, run } from "./helpers.mjs";

describe("@param", () => {
  it("annotates plain parameters and strips braces", () => {
    const { status, dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * Greets.
 *
 * @param {string} name user name
 * @returns {string} greeting
 */
export function greet(name) {
  return name;
}
`,
    });
    assert.equal(status, 0);
    assertConverted(
      dir,
      "a.ts",
      `/**
 * Greets.
 *
 * @param name user name
 * @returns greeting
 */
export function greet(name: string): string {
  return name;
}
`,
    );
  });

  it("marks optional parameters with ?", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @param {string} [greeting] hi
 * @returns {void}
 */
export function hi(greeting) {
  console.log(greeting);
}
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `/**
 * @param greeting hi
 */
export function hi(greeting?: string): void {
  console.log(greeting);
}
`,
    );
  });

  it("never adds ? next to a code default", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @param {number} [scale=2] decimals
 * @returns {void}
 */
export function f(scale = 2) {
  console.log(scale);
}
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `/**
 * @param scale decimals
 */
export function f(scale: number = 2): void {
  console.log(scale);
}
`,
    );
  });

  it("marks JSDoc-defaulted parameters optional without editing code", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @param {number} [limit=10] at most
 * @returns {void}
 */
export function f(limit) {
  console.log(limit);
}
`,
    });
    // The default lives in prose only: the tool types but never adds `= 10`
    assertConverted(
      dir,
      "a.ts",
      `/**
 * @param limit at most
 */
export function f(limit?: number): void {
  console.log(limit);
}
`,
    );
  });

  it("maps rest types to arrays", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @param {string} sep separator
 * @param {...number} values numbers
 * @returns {string} joined
 */
export function f(sep, ...values) {
  return values.join(sep);
}
/**
 * @param {string[]} names names
 * @returns {void}
 */
export function g(...names) {
  console.log(names);
}
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `/**
 * @param sep separator
 * @param values numbers
 * @returns joined
 */
export function f(sep: string, ...values: number[]): string {
  return values.join(sep);
}
/**
 * @param names names
 */
export function g(...names: string[]): void {
  console.log(names);
}
`,
    );
  });

  it("leaves rest markers on non-rest parameters alone", () => {
    const { status, stdout, dir } = run(["check", "<DIR>"], {
      "a.ts": `/**
 * @param {...string} single not actually rest
 * @returns {void}
 */
export function f(single) {
  console.log(single);
}
`,
    });
    assert.equal(status, 1);
    assert.match(stdout, /invalid-type\s+1/);
    assert.equal(read(dir, "a.ts").includes("single: "), false);
  });

  it("skips already-annotated parameters and keeps their tags", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @param {string} a typed already
 * @param {number} b fresh
 * @returns {void}
 */
export function f(a: string, b) {
  console.log(a, b);
}
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `/**
 * @param {string} a typed already
 * @param b fresh
 */
export function f(a: string, b: number): void {
  console.log(a, b);
}
`,
    );
  });

  it("never attaches a tag to the wrong parameter", () => {
    const { status, stdout, dir } = run(["check", "<DIR>"], {
      "a.ts": `/**
 * @param {string} oldName stale docs
 * @returns {void}
 */
export function f(newName) {
  console.log(newName);
}
`,
    });
    assert.equal(status, 1);
    assert.match(stdout, /no-match\s+1/);
    assert.match(stdout, /unused-param-tag\s+1/);
    assert.equal(read(dir, "a.ts").includes("newName: "), false);
  });

  it("annotates setter parameters without ?", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `export class C {
  /**
   * @param {number} [v] next
   */
  set value(v) {
    console.log(v);
  }
}
`,
    });
    // `v?: number` would be a syntax error on a setter
    assertConverted(
      dir,
      "a.ts",
      `export class C {
  /**
   * @param v next
   */
  set value(v: number) {
    console.log(v);
  }
}
`,
    );
  });

  it("converts constructor parameters but never constructor returns", () => {
    const { status, stdout, dir } = run(["check", "<DIR>"], {
      "a.ts": `export class C {
  /**
   * @param {string} name label
   * @returns {C} instance
   */
  constructor(name) {
    console.log(name);
  }
}
`,
    });
    assert.match(stdout, /param name: string/);
    assert.match(stdout, /returns-not-allowed\s+1/);
    assert.equal(status, 1);
    const converted = run(["convert", "<DIR>"], {
      "a.ts": `export class C {
  /**
   * @param {string} name label
   * @returns {C} instance
   */
  constructor(name) {
    console.log(name);
  }
}
`,
    });
    assert.equal(converted.status, 0);
    assert.match(read(converted.dir, "a.ts"), /constructor\(name: string\) \{/);
    void dir;
  });

  it("wraps unparenthesized arrow parameters", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @param {string} x input
 * @returns {string} same
 */
export const f = x => x;
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `/**
 * @param x input
 * @returns same
 */
export const f = (x: string): string => x;
`,
    );
  });

  it("promotes leading /** @type */ on parameters", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `export function f(/** @type {string} */ name) {
  return name;
}
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `export function f(name: string) {
  return name;
}
`,
    );
  });

  it("converts only documented parameters of many", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @param {string} a first
 * @returns {void}
 */
export function f(a, b) {
  console.log(a, b);
}
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `/**
 * @param a first
 */
export function f(a: string, b): void {
  console.log(a, b);
}
`,
    );
  });
});

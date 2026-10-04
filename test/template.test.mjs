import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { assertConverted, run } from "./helpers.mjs";

describe("@template", () => {
  it("adds plain type parameters", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * Wraps a value.
 *
 * @template T
 * @param {T} value payload
 * @returns {T} same
 */
export function box(value) {
  return value;
}
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `/**
 * Wraps a value.
 *
 * @param value payload
 * @returns same
 */
export function box<T>(value: T): T {
  return value;
}
`,
    );
  });

  it("supports defaults and constraints, drops unknown", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @template {unknown} [T=Response] result
 * @param {T} value payload
 * @returns {T} same
 */
export function f(value) {
  return value;
}
/**
 * @template {(...args: unknown[]) => unknown} F callback
 * @param {F} func deferred call
 * @returns {void}
 */
export function g(func) {
  console.log(func);
}
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `/**
 * result
 * @param value payload
 * @returns same
 */
export function f<T = Response>(value: T): T {
  return value;
}
/**
 * callback
 * @param func deferred call
 */
export function g<F extends (...args: unknown[]) => unknown>(func: F): void {
  console.log(func);
}
`,
    );
  });

  it("places type parameters on methods, arrows and classes", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @template T
 */
export class Box {
  /**
   * @template K
   * @param {K} key name
   * @returns {K} same
   */
  get(key) {
    return key;
  }
}
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `export class Box<T> {
  /**
   * @param key name
   * @returns same
   */
  get<K>(key: K): K {
    return key;
  }
}
`,
    );
  });

  it("refuses templates on constructors, setters and getters", () => {
    const { status, stdout } = run(["check", "<DIR>"], {
      "a.ts": `export class C {
  /**
   * @template T
   * @param {T} value next
   */
  constructor(value) {
    console.log(value);
  }
  /**
   * @template T
   * @param {T} v next
   */
  set prop(v) {
    console.log(v);
  }
}
`,
    });
    assert.match(stdout, /template-not-allowed\s+2/);
    assert.doesNotMatch(stdout, /template </);
    void status;
  });

  it("leaves invalid templates verbatim", () => {
    const { status, stdout } = run(["check", "<DIR>"], {
      "a.ts": `/**
 * @template {Record<string, function>} T broken
 * @param {T} value payload
 * @returns {T} same
 */
export function f(value) {
  return value;
}
`,
    });
    assert.match(stdout, /invalid-template\s+1/);
    assert.match(stdout, /param value: T/);
    void status;
  });

  it("skips nodes that already declare type parameters", () => {
    const { status, stdout } = run(["check", "<DIR>"], {
      "a.ts": `/**
 * @template U
 * @param {T} value payload
 * @returns {T} same
 */
export function f<T>(value) {
  return value;
}
`,
    });
    assert.match(stdout, /already-has-type-params\s+1/);
    void status;
  });
});

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { assertConverted, read, run } from "./helpers.mjs";

describe("edge constructs", () => {
  it("converts declare function parameters, never their returns", () => {
    const { status, stdout, dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @param {string} x input
 * @returns {number} length
 */
export declare function declared(x): number;
`,
    });
    assert.equal(status, 0);
    assertConverted(
      dir,
      "a.ts",
      `/**
 * @param x input
 * @returns {number} length
 */
export declare function declared(x: string): number;
`,
    );
    void stdout;
  });

  it("reaches methods through outward-attached docs", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @param {string} x input
 * @returns {number} length
 */
export declare function declared(x): number;
/**
 * @param {string} key name
 * @returns {string} same
 */
export const obj = {
  get(key) {
    return key;
  },
};
`,
    });
    const out = read(dir, "a.ts");
    assert.match(out, /declared\(x: string\): number;/);
    assert.match(out, /get\(key: string\): string \{/);
  });

  it("supports @arg/@argument/@return aliases and joint templates", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @arg {string} a first
 * @argument {number} b second
 * @return {string} joined
 */
export function f(a, b) {
  return a + b;
}
/**
 * @template T, U
 * @param {T} a first
 * @param {U} b second
 * @returns {[T, U]} pair
 */
export function pair(a, b) {
  return [a, b];
}
`,
    });
    const out = read(dir, "a.ts");
    assert.match(out, /function f\(a: string, b: number\): string/);
    assert.match(out, /function pair<T, U>\(a: T, b: U\): \[T, U\]/);
  });

  it("converts async, generator, private and nested functions", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @param {number} n input
 * @returns {AsyncGenerator<number>} stream
 */
export async function* gen(n) {
  yield n;
}
export class P {
  /**
   * @param {string} s input
   * @returns {string} same
   */
  #m(s) {
    return s;
  }
}
/**
 * @param {string} x input
 * @returns {(x: string) => string} reader
 */
export function outer() {
  /**
   * @param {string} x input
   * @returns {string} same
   */
  return function inner(x) {
    return x;
  };
}
`,
    });
    const out = read(dir, "a.ts");
    assert.match(out, /gen\(n: number\): AsyncGenerator<number>/);
    assert.match(out, /#m\(s: string\): string/);
    assert.match(out, /return function inner\(x: string\): string \{/);
  });

  it("converts anonymous default exports", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @param {string} x input
 * @returns {string} same
 */
export default function (x) {
  return x;
}
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `/**
 * @param x input
 * @returns same
 */
export default function (x: string): string {
  return x;
}
`,
    );
  });

  it("preserves CRLF, BOM and unicode identifiers", () => {
    const crlf =
      "/**\r\n * @param {string} x input\r\n * @returns {string} same\r\n */\r\nexport function f(x) {\r\n  return x;\r\n}\r\n";
    const bom =
      "﻿/**\n * @param {string} x input\n * @returns {string} same\n */\nexport function g(x) {\n  return x;\n}\n";
    const uni = `/**
 * @param {string} имя input
 * @returns {string} same
 */
export function hi(имя) {
  return имя;
}
`;
    const { status, dir } = run(["convert", "<DIR>"], {
      "crlf.ts": crlf,
      "bom.ts": bom,
      "uni.ts": uni,
    });
    assert.equal(status, 0);
    assertConverted(
      dir,
      "crlf.ts",
      "/**\r\n * @param x input\r\n * @returns same\r\n */\r\nexport function f(x: string): string {\r\n  return x;\r\n}\r\n",
    );
    const bomOut = read(dir, "bom.ts");
    assert.equal(bomOut.codePointAt(0), 0xfeff);
    assert.match(bomOut, /function g\(x: string\): string/);
    assert.match(read(dir, "uni.ts"), /function hi\(имя: string\): string/);
  });

  it("annotates tuple rest elements", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @param {...[string, number]} pairs entries
 * @returns {void}
 */
export function f(...[name, count]) {
  console.log(name, count);
}
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `/**
 * @param pairs entries
 */
export function f(...[name, count]: [string, number][]): void {
  console.log(name, count);
}
`,
    );
  });

  it("refuses rest markers on plain array patterns", () => {
    const { status, stdout } = run(["check", "<DIR>"], {
      "a.ts": `/**
 * @param {...string} pair not rest
 * @returns {void}
 */
export function f([name]) {
  console.log(name);
}
`,
    });
    assert.match(stdout, /invalid-type\s+1/);
    assert.doesNotMatch(stdout, /param pattern/);
    void status;
  });

  it("places templates on declare functions", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @template {string} K keys
 * @param {K} key name
 * @returns {K} same
 */
export declare function lookup(key): K;
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `/**
 * keys
 * @param key name
 * @returns {K} same
 */
export declare function lookup<K extends string>(key: K): K;
`,
    );
  });

  it("reports decorator files as unparsable without touching them", () => {
    const src = `function sealed(t) {}
/**
 * @param {string} x input
 * @returns {string} same
 */
@sealed
export class C {}
`;
    const { status, stdout, dir } = run(["convert", "<DIR>"], {
      "a.ts": src,
    });
    assert.equal(status, 1);
    assert.match(stdout, /SKIPPED\s+a\.ts/);
    assert.equal(read(dir, "a.ts"), src);
  });

  it("converts functions in object literals and module.exports", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @param {string} name user
 * @returns {string} greeting
 */
const handlers = {
  greet(name) {
    return name;
  },
};
/**
 * @param {string} name user
 * @returns {string} greeting
 */
module.exports = function hi(name) {
  return name;
};
`,
    });
    const out = read(dir, "a.ts");
    assert.match(out, /greet\(name: string\): string \{/);
    assert.match(
      out,
      /module\.exports = function hi\(name: string\): string \{/,
    );
  });

  it("handles two thousand functions without falling over", () => {
    const parts = [];
    for (let i = 0; i < 2000; i++) {
      parts.push(`/**
 * @param {number} n input
 * @returns {number} same
 */
export function f${i}(n) {
  return n;
}
`);
    }
    const started = Date.now();
    const { status, stdout, dir } = run(["convert", "<DIR>"], {
      "big.ts": parts.join("\n"),
    });
    assert.equal(status, 0);
    assert.match(stdout, /4000 annotation\(s\)/);
    assert.match(read(dir, "big.ts"), /function f1999\(n: number\): number/);
    assert.ok(Date.now() - started < 30000, "took too long");
  });
});

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { assertConverted, run } from "./helpers.mjs";

describe("@returns", () => {
  it("annotates returns and keeps prose", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * Loads text.
 *
 * @param {string} url address
 * @returns {Promise<string>} body text
 */
export async function load(url) {
  return "x";
}
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `/**
 * Loads text.
 *
 * @param url address
 * @returns body text
 */
export async function load(url: string): Promise<string> {
  return "x";
}
`,
    );
  });

  it("removes bare @returns lines but keeps the closer aligned", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * Runs.
 *
 * @returns {void}
 */
export function run() {
  console.log(1);
}
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `/**
 * Runs.
 *
 */
export function run(): void {
  console.log(1);
}
`,
    );
  });

  it("never annotates setter returns", () => {
    const { status, stdout } = run(["check", "<DIR>"], {
      "a.ts": `export class C {
  /**
   * @param {number} v next
   * @returns {void} nothing
   */
  set value(v) {
    console.log(v);
  }
}
`,
    });
    assert.equal(status, 1);
    assert.match(stdout, /returns-not-allowed\s+1/);
    assert.doesNotMatch(stdout, /returns void/);
  });

  it("skips functions that already declare a return type", () => {
    const { status, stdout } = run(["check", "<DIR>"], {
      "a.ts": `/**
 * @returns {number} already there
 */
export function f(): number {
  return 1;
}
`,
    });
    assert.match(stdout, /already-annotated\s+1/);
    assert.doesNotMatch(stdout, /returns number/);
    void status;
  });

  it("supports type predicates in return position", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `export function f(arr) {
  return arr.filter(
    /** @returns {x is string} */
    (x) => !!x,
  );
}
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `export function f(arr) {
  return arr.filter(
    (x): x is string => !!x,
  );
}
`,
    );
  });

  it("places arrow returns before => for block and expression bodies", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @param {number} x input
 * @returns {number} doubled
 */
export const twice = (x) => x * 2;
/**
 * @param {number} x input
 * @returns {number} logged
 */
export const log = (x) => {
  console.log(x);
  return x;
};
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `/**
 * @param x input
 * @returns doubled
 */
export const twice = (x: number): number => x * 2;
/**
 * @param x input
 * @returns logged
 */
export const log = (x: number): number => {
  console.log(x);
  return x;
};
`,
    );
  });

  it("converts documented getter returns", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `export class C {
  /**
   * @returns {number} current
   */
  get value() {
    return 1;
  }
}
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `export class C {
  /**
   * @returns current
   */
  get value(): number {
    return 1;
  }
}
`,
    );
  });

  it("leaves unparsable return types verbatim", () => {
    const { status, stdout } = run(["check", "<DIR>"], {
      "a.ts": `/**
 * @returns {Record<string, function>} handlers
 */
export function f() {
  return {};
}
`,
    });
    // Skipped tags alone do not fail the run; only pending work does
    assert.equal(status, 0);
    assert.match(stdout, /invalid-type\s+1/);
    assert.doesNotMatch(stdout, /returns Record/);
  });
});

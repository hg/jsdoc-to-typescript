import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { assertConverted, read, run } from "./helpers.mjs";

// Branches of the language features introduced in HEAD~
// ("improve language feature coverage") that adopted.test.mjs does not
// exercise: suffix spellings, @this on members, statement callbacks on
// `new` and multi-callback calls, bare/invalid/unsupported casts,
// shorthand props, bad typedefs, same-name merging and declare-field
// fallbacks. Every expectation below was verified against the tool.
describe("HEAD~ language-feature branches", () => {
  it("maps =/? suffixes, Object<K, V> and named function params", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @param {string=} a opt
 * @param {number?} b maybe
 * @param {Object<string, number>} c map
 * @param {function(name: string, count: number): boolean} d fn
 * @returns {void}
 */
export function f(a, b, c, d) {
  console.log(a, b, c, d);
}
`,
    });
    const out = read(dir, "a.ts");
    assert.match(out, /a: \(string\) \| undefined/);
    assert.match(out, /b: \(number\) \| null/);
    assert.match(out, /c: Record<string, number>/);
    assert.match(out, /d: \(name: string, count: number\) => boolean/);
  });

  it("inserts @this on methods but leaves getters and setters alone", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `export class C {
  /**
   * @this {Widget} scope
   * @param {string} x input
   * @returns {void}
   */
  method(x) {
    console.log(this, x);
  }
  /**
   * @this {Widget} scope
   */
  get thing() {
    return this._t;
  }
  /**
   * @this {Widget} scope
   * @param {string} v val
   */
  set thing(v) {
    this._t = v;
  }
}
`,
    });
    const out = read(dir, "a.ts");
    assert.match(out, /method\(this: Widget, x: string\): void/);
    assert.match(out, /get thing\(\)/);
    assert.match(out, /@this \{Widget\} scope/);
    assert.match(out, /set thing\(v: string\)/);
    assert.match(out, /declare _t: string;/);
  });

  it("documents new-expression callbacks, ignores multi-callback calls", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @param {string} value field value
 * @returns {boolean} valid
 */
new Validator((value) => !!value);
/**
 * @param {string} a first
 * @returns {void}
 */
register("x", (a) => console.log(a), (b) => console.log(b));
`,
    });
    const out = read(dir, "a.ts");
    assert.match(out, /new Validator\(\(value: string\): boolean =>/);
    assert.match(out, /@param \{string\} a first/);
    assert.match(out, /\(a\) => console\.log\(a\), \(b\) => console\.log\(b\)/);
  });

  it("casts bare @type names with legacy mapping", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `const n = /** @type Number */ (input.val());
`,
    });
    assert.match(read(dir, "a.ts"), /\(\(input\.val\(\) as number\)\)/);
  });

  it("leaves unmappable cast types in place", () => {
    const { status, stdout, dir } = run(["convert", "<DIR>"], {
      "a.ts": `const bad = /** @type {Array.<>} */ (v);
`,
    });
    assert.equal(status, 0);
    assert.match(stdout, /invalid-type\s+1/);
    assertConverted(dir, "a.ts", `const bad = /** @type {Array.<>} */ (v);\n`);
  });

  it("leaves assignment-subject casts and shorthand props in place", () => {
    const { status, stdout, dir } = run(["check", "<DIR>"], {
      "a.ts": `/** @type {string} */
x = compute();
const cfg = {
  /** @type {number} count */
  n,
};
`,
    });
    assert.equal(status, 0);
    assert.match(stdout, /unsupported-cast\s+1/);
    assert.match(stdout, /shorthand-@type\s+1/);
    assertConverted(
      dir,
      "a.ts",
      `/** @type {string} */
x = compute();
const cfg = {
  /** @type {number} count */
  n,
};
`,
    );
  });

  it("leaves bad and unnamed typedefs in place", () => {
    const { status, stdout } = run(["check", "<DIR>"], {
      "a.ts": `/**
 * @typedef {not a valid type @@} Broken
 */
/**
 * @typedef {string}
 */
`,
    });
    assert.equal(status, 0);
    assert.match(stdout, /invalid-typedef\s+2/);
  });

  it("merges same-name typedef objects into interfaces", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @typedef {object} Shared
 * @property {string} a first
 */
/**
 * @typedef {object} Shared
 * @property {number} b second
 */
`,
    });
    const out = read(dir, "a.ts");
    assert.match(out, /interface Shared \{\n  \/\*\* first \*\/ a: string;\n\}/);
    assert.match(
      out,
      /interface Shared \{\n  \/\*\* second \*\/ b: number;\n\}/,
    );
  });

  it("types null-only fields as evolving any", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `export class K {
  constructor() {
    this.lonely = null;
  }
}
`,
    });
    assert.match(read(dir, "a.ts"), /declare lonely: any;/);
  });

  it("types fields from the assigned parameter", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `export class J {
  /**
   * @param {string} name label
   */
  constructor(name) {
    this.name = name;
    this.other = name;
  }
}
`,
    });
    const out = read(dir, "a.ts");
    assert.match(out, /declare name: string;/);
    assert.match(out, /declare other: string;/);
    assert.match(out, /constructor\(name: string\)/);
  });
});

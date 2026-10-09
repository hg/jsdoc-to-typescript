import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { assertConverted, read, run } from "./helpers.mjs";

describe("adopted JSDoc features", () => {
  it("maps legacy type spellings to TypeScript", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @param {String} a text
 * @param {Number} b count
 * @param {Boolean} c flag
 * @param {*} d anything
 * @param {Array.<string>} e list
 * @param {?string} f maybe
 * @param {function(string): number} g fn
 * @returns {void}
 */
export function f(a, b, c, d, e, f, g) {
  console.log(a, b, c, d, e, f, g);
}
`,
    });
    const out = read(dir, "a.ts");
    assert.match(
      out,
      /function f\(a: string, b: number, c: boolean, d: any, e: Array<string>, f: \(string\) \| null, g: \(arg0: string\) => number\): void/,
    );
  });

  it("maps Object to object", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @param {Object} o bag
 * @returns {void}
 */
export function f(o) {
  console.log(o);
}
`,
    });
    assert.match(read(dir, "a.ts"), /function f\(o: object\): void/);
  });

  it("inserts this parameters from @this", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * Works on the scope.
 *
 * @this {Widget} scope
 * @param {string} x input
 * @returns {void}
 */
export function f(x) {
  console.log(this, x);
}
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `/**
 * Works on the scope.
 *
 * scope
 * @param x input
 */
export function f(this: Widget, x: string): void {
  console.log(this, x);
}
`,
    );
  });

  it("leaves @this on arrows and constructors alone", () => {
    const { status, stdout } = run(["check", "<DIR>"], {
      "a.ts": `/**
 * @this {Widget} scope
 * @param {string} x input
 * @returns {void}
 */
export const f = (x) => x;
export class C {
  /**
   * @this {Widget} scope
   * @param {string} x input
   */
  constructor(x) {
    console.log(x);
  }
}
`,
    });
    assert.doesNotMatch(stdout, /this: Widget/);
    void status;
  });

  it("converts statement-level callback docs with matching names", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @param {string} value field value
 * @param {HTMLElement} element field element
 * @returns {boolean} valid
 */
register("name", (value, element) => {
  return !!value;
});
`,
    });
    assert.match(
      read(dir, "a.ts"),
      /register\("name", \(value: string, element: HTMLElement\): boolean =>/,
    );
  });

  it("never leaks call docs onto unrelated callbacks", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @returns {Promise<string>} fetched
 */
fetch(url).then((r) => r.text());
/**
 * @param {string} value which one
 * @returns {void}
 */
register("name", (value) => {
  console.log(value);
});
`,
    });
    const out = read(dir, "a.ts");
    assert.match(out, /\.then\(\(r\) => r\.text\(\)\)/);
    assert.match(out, /\(value: string\): void =>/);
  });

  it("rewrites inline casts as assertions", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `const el = /** @type {HTMLInputElement} */ (document.getElementById("x"));
const v = /** @type {string} */ (el.value);
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `const el = ((document.getElementById("x") as HTMLInputElement));
const v = ((el.value as string));
`,
    );
  });

  it("nests stacked casts in source order", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `const a = /** @type {string} */ (/** @type {unknown} */ (v));
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `const a = ((((v as unknown))) as string);
`,
    );
  });

  it("casts the parenthesized group when it is narrower", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `const files = /** @type {HTMLInputElement} */ (element).files;
`,
    });
    assert.match(
      read(dir, "a.ts"),
      /const files = \(\(element\) as HTMLInputElement\)\.files;/,
    );
  });

  it("supports const assertions and keeps cast prose", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `const t = /** @type {const} */ (["a"]);
const u = /** @type {string} element name */ (el.name);
`,
    });
    assert.match(read(dir, "a.ts"), /\(\["a"\] as const\)/);
    assert.match(read(dir, "a.ts"), /\/\*\* element name \*\//);
  });

  it("never casts bindings, keys or params", () => {
    const { status, stdout, dir } = run(["convert", "<DIR>"], {
      "a.ts": `/** @type {string} */
let bound = "x";
export function f(/** @type {string} */ name) {
  return name;
}
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `let bound: string = "x";
export function f(name: string) {
  return name;
}
`,
    );
    void status;
    void stdout;
  });

  it("asserts object property values", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `const cfg = {
  /** @type {number} count */
  n: 5,
};
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `const cfg = {
  /** count */
  n: 5 as number,
};
`,
    );
  });

  it("declares this-assigned fields from params, types and literals", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `export class K {
  /**
   * @param {Map<string, number>} cache store
   */
  constructor(cache) {
    this.cache = cache;
    this.ready = true;
    this.count = 0;
  }
}
`,
    });
    const out = read(dir, "a.ts");
    assert.match(out, /declare cache: Map<string, number>;/);
    assert.match(out, /declare ready: boolean;/);
    assert.match(out, /declare count: number;/);
    assert.match(out, /constructor\(cache: Map<string, number>\) \{/);
  });

  it("declares this-assigned fields from hanging @type", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `export class K {
  load() {
    /** @type {string[]} rows */
    this.rows = [];
  }
}
`,
    });
    assert.match(read(dir, "a.ts"), /declare rows: string\[\];/);
  });

  it("defers null initializers to later values, else any", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `export class K {
  constructor() {
    this.name = null;
    this.helper = null;
    this.made = make();
  }
  setup() {
    this.name = "x";
    this.helper = new Helper();
  }
}
`,
    });
    const out = read(dir, "a.ts");
    assert.match(out, /declare name: string;/);
    assert.match(out, /declare helper: Helper;/);
    assert.match(out, /declare made: any;/);
  });

  it("converts typedef objects to interfaces and aliases to types", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * Options bag.
 *
 * @typedef {object} Opts
 * @property {string} url address
 * @property {number} [retry=3] attempts
 */
/**
 * @typedef {{ id: string|number }} Row
 */
/**
 * @typedef {"a"|"b"} Kind
 */
/**
 * @param {Opts} o settings
 * @returns {Row[]} out
 */
export function f(o) {
  return [{ id: 1 }];
}
`,
    });
    const out = read(dir, "a.ts");
    assert.match(out, /interface Opts \{\n  \/\*\* address \*\/ url: string;\n  \/\*\* attempts \*\/ retry\?: number;\n\}/);
    assert.match(out, /interface Row \{ id: string\|number \}/);
    assert.match(out, /type Kind = "a"\|"b";/);
    assert.match(out, /function f\(o: Opts\): Row\[\]/);
  });

  it("converts callbacks to function types", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @callback Done
 * @param {string} value result
 * @returns {void}
 */
`,
    });
    assert.match(read(dir, "a.ts"), /type Done = \(value: string\) => void;/);
  });

  it("moves class-level typedefs before the class", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `export class K {
  /**
   * Kinds.
   *
   * @typedef {"a"|"b"} Kind
   */
  /**
   * @param {Kind} k kind
   * @returns {void}
   */
  pick(k) {
    console.log(k);
  }
}
`,
    });
    const out = read(dir, "a.ts");
    assert.match(out, /type Kind = "a"\|"b";\nexport class K \{/);
    assert.match(out, /pick\(k: Kind\): void/);
  });

  it("leaves bad typedefs and nested properties in place", () => {
    const { status, stdout } = run(["check", "<DIR>"], {
      "a.ts": `/**
 * @typedef {object} Bad
 * @property {string} nested.key deep
 */
`,
    });
    assert.match(stdout, /nested-typedef-prop\s+1/);
    void status;
  });

  it("annotates method this-returns", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `export class Chain {
  /**
   * @returns {this} self
   */
  next() {
    return this;
  }
}
`,
    });
    assert.match(read(dir, "a.ts"), /next\(\): this \{/);
  });

  it("is idempotent across the new features", () => {
    const first = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @typedef {object} Opts
 * @property {string} url address
 */
export class K {
  /**
   * @this {Opts} scope
   * @param {Opts} o settings
   */
  setup(o) {
    this.o = o;
    const el = /** @type {Opts} */ (o);
    console.log(el);
  }
}
`,
    });
    const once = read(first.dir, "a.ts");
    assert.match(once, /interface Opts/);
    assert.match(once, /setup\(this: Opts, o: Opts\)/);
    assert.match(once, /declare o: Opts;/);
    const { status, stdout } = run(["check", first.dir]);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /annotations pending: 0/);
  });
});

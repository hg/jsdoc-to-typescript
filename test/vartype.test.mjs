import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { assertConverted, run } from "./helpers.mjs";

describe("@type", () => {
  it("annotates uninitialized variables", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/** @type {ReturnType<typeof setTimeout>|undefined} */
let timeout;
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `let timeout: ReturnType<typeof setTimeout>|undefined;
`,
    );
  });

  it("keeps descriptions and drops only the type", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/** @type {number} Active request count. */
let active = 0;
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `/** Active request count. */
let active: number = 0;
`,
    );
  });

  it("annotates class fields including #private ones", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `export class C {
  /** @type {string} Label. */
  label;
  /** @type {number} Counter. */
  #count = 0;
}
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `export class C {
  /** Label. */
  label: string;
  /** Counter. */
  #count: number = 0;
}
`,
    );
  });

  it("removes husk comments left with no prose", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/** @type {string} */
const name = "x";
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `const name: string = "x";
`,
    );
  });

  it("skips multi-declarator statements entirely", () => {
    const { status, stdout } = run(["check", "<DIR>"], {
      "a.ts": `/** @type {string} */
const a = "x", b = "y";
`,
    });
    assert.match(stdout, /multi-declarator\s+2/);
    assert.doesNotMatch(stdout, /\(variable\)/);
    void status;
  });

  it("skips already-annotated variables and reports them", () => {
    const { status, stdout } = run(["check", "<DIR>"], {
      "a.ts": `/** @type {number} */
const n: number = 1;
`,
    });
    assert.match(stdout, /already-annotated\s+1/);
    assert.doesNotMatch(stdout, /\(variable\) type/);
    void status;
  });

  it("counts documented variables without @type", () => {
    const { status, stdout } = run(["check", "<DIR>"], {
      "a.ts": `/** Just a note, no type. */
const x = 1;
`,
    });
    assert.match(stdout, /no-@type\s+1/);
    assert.doesNotMatch(stdout, /\(variable\) type/);
    void status;
  });

  it("prefers @param over @type on function values", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @type {(x: string) => void}
 * @param {string} x input
 * @returns {void}
 */
export const f = (x) => {
  console.log(x);
};
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `/**
 * @type {(x: string) => void}
 * @param x input
 */
export const f = (x: string): void => {
  console.log(x);
};
`,
    );
  });

  it("leaves invalid @type text verbatim", () => {
    const { status, stdout } = run(["check", "<DIR>"], {
      "a.ts": `/** @type {Record<string, function>} */
const handlers = {};
`,
    });
    assert.match(stdout, /invalid-type\s+1/);
    assert.doesNotMatch(stdout, /\(variable\) type/);
    void status;
  });
});

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { read, runTool } from "./helpers.mjs";

const SIMPLE = `/**
 * Adds.
 *
 * @param {number} x input
 * @returns {number} doubled
 */
function dbl(x) {
  return x * 2;
}
`;

describe("tools/js2ts.mjs", () => {
  it("promotes params and returns in one file", () => {
    const { status, stdout, dir } = runTool(
      "js2ts.mjs",
      ["<DIR>/src/a.ts"],
      { "src/a.ts": SIMPLE },
    );
    assert.equal(status, 0);
    assert.match(stdout, /converted 1 files, 0 warnings/);
    assert.match(read(dir, "src/a.ts"), /function dbl\(x: number\): number/);
  });

  it("walks directories and skips declarations and bundles", () => {
    const { status, stdout, dir } = runTool(
      "js2ts.mjs",
      ["<DIR>/src"],
      {
        "src/a.ts": SIMPLE,
        "src/nested/b.mts": SIMPLE,
        "src/skip.d.ts": "export declare const x: number;\n",
        "src/skip.min.ts": "var x=1;\n",
        "src/notes.txt": "hi\n",
      },
    );
    assert.equal(status, 0);
    assert.match(stdout, /converted 2 files, 0 warnings/);
    assert.match(read(dir, "src/a.ts"), /function dbl\(x: number\): number/);
    assert.match(read(dir, "src/nested/b.mts"), /function dbl\(x: number\): number/);
    assert.equal(read(dir, "src/skip.d.ts"), "export declare const x: number;\n");
    assert.equal(read(dir, "src/skip.min.ts"), "var x=1;\n");
  });

  it("warns and continues on unmappable types", () => {
    const { status, stdout, dir } = runTool(
      "js2ts.mjs",
      ["<DIR>/src/a.ts"],
      {
        "src/a.ts": `/**
 * @param {???} x value
 * @returns {void}
 */
function f(x) {}
`,
      },
    );
    assert.equal(status, 0);
    assert.match(stdout, /WARN/);
    assert.match(stdout, /converted 1 files, 1 warnings/);
    assert.match(read(dir, "src/a.ts"), /function f\(x\)/);
  });

  it("rejects missing paths and trees without scannable files", () => {
    let r = runTool("js2ts.mjs", [], {});
    assert.equal(r.status, 2);
    assert.match(r.output, /missing path/);
    r = runTool("js2ts.mjs", ["<DIR>/nope"], {});
    assert.equal(r.status, 2);
    assert.match(r.output, /no such file or directory/);
    r = runTool("js2ts.mjs", ["<DIR>"], { "a.txt": "hi\n" });
    assert.equal(r.status, 1);
    assert.match(r.output, /no \.ts\/\.mts files/);
    r = runTool("js2ts.mjs", ["<DIR>/a.txt"], { "a.txt": "hi\n" });
    assert.equal(r.status, 1);
    assert.match(r.output, /no \.ts\/\.mts files/);
  });
});

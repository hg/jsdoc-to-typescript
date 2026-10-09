import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { runTool } from "./helpers.mjs";

const ANY = `/**
 * @param {any} x value
 * @param {string} y label
 * @returns {any} result
 * @type {any} tag
 */
function f(x, y) {
  return x;
}
`;

describe("tools/any-scan.mjs", () => {
  it("summarizes any counts per category", () => {
    const { status, stdout } = runTool(
      "any-scan.mjs",
      ["summary", "<DIR>"],
      { "src/a.js": ANY, "src/b.js": "const z = 1;\n" },
    );
    assert.equal(status, 0);
    assert.match(stdout, /parsed 2 of 2 files, 0 unparseable/);
    assert.match(stdout, /files with 'any': 1/);
    assert.match(stdout, /total occurrences: 3/);
    assert.match(stdout, /JSDoc @param:\s+1/);
    assert.match(stdout, /JSDoc @type:\s+1/);
    assert.match(stdout, /JSDoc @returns:\s+1/);
    assert.match(stdout, /3\s+src\/a\.js\s+\(param:1 type:1 ret:1 other:0\)/);
  });

  it("reports unparseable files and exits 1", () => {
    const { status, stdout } = runTool(
      "any-scan.mjs",
      ["summary", "<DIR>"],
      { "src/a.js": ANY, "src/broken.js": "function broken( {\n" },
    );
    assert.equal(status, 1);
    assert.match(stdout, /parsed 1 of 2 files, 1 unparseable/);
    assert.match(stdout, /SKIPPED\s+src\/broken\.js/);
    assert.match(stdout, /files with 'any': 1/);
  });

  it("details one TAB-separated line per file", () => {
    const { status, stdout } = runTool(
      "any-scan.mjs",
      ["detail", "<DIR>"],
      { "src/a.js": ANY, "src/b.js": "const z = 1;\n" },
    );
    assert.equal(status, 0);
    assert.match(stdout, /^3\tsrc\/a\.js$/m);
    assert.doesNotMatch(stdout, /b\.js/);
  });

  it("unions filters and accepts a single file", () => {
    const fixtures = { "src/a.js": ANY, "src/b.js": ANY };
    let r = runTool("any-scan.mjs", ["summary", "<DIR>", "a.js", "b.js"], fixtures);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /parsed 2 of 2 files/);
    r = runTool("any-scan.mjs", ["summary", "<DIR>/src/a.js"], fixtures);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /parsed 1 of 1 files/);
    assert.match(r.stdout, /3\s+a\.js\s+\(param:1 type:1 ret:1 other:0\)/);
  });

  it("ignores any outside JSDoc blocks", () => {
    const { status, stdout } = runTool(
      "any-scan.mjs",
      ["summary", "<DIR>"],
      {
        "src/a.js": `const s = "any";
const t = \`any\`;
/* any */
// @ts-expect-error any
function f(x) {
  return /any/.test(x);
}
`,
      },
    );
    assert.equal(status, 0);
    assert.match(stdout, /files with 'any': 0/);
    assert.match(stdout, /total occurrences: 0/);
  });

  it("rejects missing paths, empty trees and empty matches", () => {
    let r = runTool("any-scan.mjs", ["summary"], {});
    assert.equal(r.status, 2);
    assert.match(r.output, /missing path/);
    r = runTool("any-scan.mjs", ["summary", "<DIR>/nope"], {});
    assert.equal(r.status, 2);
    assert.match(r.output, /no such file or directory/);
    r = runTool("any-scan.mjs", ["summary", "<DIR>"], { "a.txt": "hi\n" });
    assert.equal(r.status, 1);
    assert.match(r.output, /no \.js files/);
    r = runTool("any-scan.mjs", ["summary", "<DIR>", "zzz"], {
      "src/a.js": ANY,
    });
    assert.equal(r.status, 1);
    assert.match(r.output, /no file matched/);
  });
});

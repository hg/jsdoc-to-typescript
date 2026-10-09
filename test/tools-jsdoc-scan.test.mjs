import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { runTool } from "./helpers.mjs";

const NEEDY = `/**
 * @param {string} x documented, result missing
 */
function docd(x) {
  return x;
}
function undoc(a, b) {
  return a;
}
const empty = [];
const nully = null;
`;

describe("tools/jsdoc-scan.mjs", () => {
  it("lists one line per symbol missing types", () => {
    const { status, stdout } = runTool(
      "jsdoc-scan.mjs",
      ["list", "<DIR>"],
      { "src/a.js": NEEDY },
    );
    assert.equal(status, 1);
    assert.match(stdout, /^docd src\/a\.js:4\s+no-@returns$/m);
    assert.match(stdout, /^undoc src\/a\.js:7\s+no-@param,no-@returns$/m);
    assert.match(stdout, /^empty src\/a\.js:10\s+no-@type$/m);
    assert.match(stdout, /^nully src\/a\.js:11\s+no-@type$/m);
  });

  it("stays quiet on a documented tree", () => {
    const { status, stdout } = runTool(
      "jsdoc-scan.mjs",
      ["list", "<DIR>"],
      {
        "src/a.js": `/**
 * Adds.
 *
 * @param {number} x input
 * @returns {number} sum
 */
function add(x) {
  return x;
}
`,
      },
    );
    assert.equal(status, 0);
    assert.doesNotMatch(stdout, /no-@/);
  });

  it("needs no @returns for getters and parameterless functions", () => {
    const { status, stdout } = runTool(
      "jsdoc-scan.mjs",
      ["list", "<DIR>"],
      {
        "src/a.js": `/** Store. */
class C {
  get thing() {
    return 1;
  }
}
function none() {
  return 1;
}
`,
      },
    );
    assert.equal(status, 0);
    assert.doesNotMatch(stdout, /thing|none/);
  });

  it("hides function-nested declarations unless --all", () => {
    const fixtures = {
      "src/a.js": `function outer(k) {
  function inner(q) {
    return q;
  }
  return inner(k);
}
`,
    };
    let r = runTool("jsdoc-scan.mjs", ["list", "<DIR>"], fixtures);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /outer src\/a\.js:1\s+no-@param,no-@returns/);
    assert.doesNotMatch(r.stdout, /inner/);
    r = runTool("jsdoc-scan.mjs", ["--all", "list", "<DIR>"], fixtures);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /inner src\/a\.js:2\s+no-@param/);
  });

  it("summarizes totals per kind and per file", () => {
    const { status, stdout } = runTool(
      "jsdoc-scan.mjs",
      ["summary", "<DIR>"],
      { "src/a.js": NEEDY },
    );
    assert.equal(status, 1);
    assert.match(stdout, /files scanned: 1/);
    assert.match(stdout, /symbols missing types: 4/);
    assert.match(stdout, /function\s+2/);
    assert.match(stdout, /variable\s+2/);
    assert.match(stdout, /4\s+src\/a\.js/);
  });

  it("reports skipped files without hiding rows", () => {
    const { status, stdout } = runTool(
      "jsdoc-scan.mjs",
      ["list", "<DIR>"],
      { "src/a.js": NEEDY, "src/broken.js": "function broken( {\n" },
    );
    assert.equal(status, 1);
    assert.match(stdout, /parsed 1 of 2 files, 1 unparseable/);
    assert.match(stdout, /SKIPPED\s+src\/broken\.js/);
    assert.match(stdout, /undoc src\/a\.js/);
  });

  it("unions filters and accepts a single file", () => {
    const fixtures = { "src/a.js": NEEDY, "src/b.js": NEEDY };
    let r = runTool(
      "jsdoc-scan.mjs",
      ["list", "<DIR>", "a.js", "b.js"],
      fixtures,
    );
    assert.equal(r.status, 1);
    assert.match(r.stdout, /src\/a\.js/);
    assert.match(r.stdout, /src\/b\.js/);
    r = runTool("jsdoc-scan.mjs", ["list", "<DIR>/src/a.js"], fixtures);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^docd a\.js:4\s+no-@returns$/m);
    assert.doesNotMatch(r.stdout, /src\/b\.js/);
  });

  it("rejects bad flags, missing paths, empty trees and empty matches", () => {
    let r = runTool("jsdoc-scan.mjs", ["--bogus", "list", "<DIR>"], {});
    assert.equal(r.status, 2);
    assert.match(r.output, /unknown flag/);
    r = runTool("jsdoc-scan.mjs", ["list"], {});
    assert.equal(r.status, 2);
    assert.match(r.output, /missing path/);
    r = runTool("jsdoc-scan.mjs", ["list", "<DIR>/nope"], {});
    assert.equal(r.status, 2);
    assert.match(r.output, /no such file or directory/);
    r = runTool("jsdoc-scan.mjs", ["list", "<DIR>"], { "a.txt": "hi\n" });
    assert.equal(r.status, 1);
    assert.match(r.output, /no \.js files/);
    r = runTool("jsdoc-scan.mjs", ["list", "<DIR>", "zzz"], {
      "src/a.js": NEEDY,
    });
    assert.equal(r.status, 1);
    assert.match(r.output, /no file matched/);
  });
});

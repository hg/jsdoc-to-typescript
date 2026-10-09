import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { runTool } from "./helpers.mjs";

const CODE = "function f(x) { return x; }\n";

describe("tools/fp-emit.mjs", () => {
  it("counts same and changed files against the baseline", () => {
    const { status, stdout } = runTool(
      "fp-emit.mjs",
      ["<DIR>/before.json", "<DIR>/emit"],
      {
        "before.json": JSON.stringify({
          "a.js":
            "3e5cf7c2c7f86e0708af0e77e1a8cc76e0e837d7e45bae09f5b426793f4114a8",
          "b.js":
            "3e5cf7c2c7f86e0708af0e77e1a8cc76e0e837d7e45bae09f5b426793f4114a8",
        }),
        "emit/a.js": CODE,
        "emit/b.js": CODE.replace("x;", "x + 1;"),
      },
    );
    assert.equal(status, 0);
    assert.match(stdout, /same: 1/);
    assert.match(stdout, /diff: 1/);
    assert.match(stdout, /CHANGED b\.js/);
  });

  it("reports unparseable emit files without failing", () => {
    const { status, stdout } = runTool(
      "fp-emit.mjs",
      ["<DIR>/before.json", "<DIR>/emit"],
      {
        "before.json": JSON.stringify({
          "a.js":
            "3e5cf7c2c7f86e0708af0e77e1a8cc76e0e837d7e45bae09f5b426793f4114a8",
        }),
        "emit/a.js": "function broken( {\n",
      },
    );
    assert.equal(status, 0);
    assert.match(stdout, /unparse: 1/);
    assert.match(stdout, /UNPARSE a\.js/);
  });

  it("skips null entries and files outside the baseline", () => {
    const { status, stdout } = runTool(
      "fp-emit.mjs",
      ["<DIR>/before.json", "<DIR>/emit"],
      {
        "before.json": JSON.stringify({ "a.js": null }),
        "emit/a.js": CODE,
        "emit/extra.js": CODE,
      },
    );
    assert.equal(status, 0);
    assert.match(stdout, /same: 0/);
    assert.match(stdout, /diff: 0/);
    assert.match(stdout, /unparse: 0/);
  });

  it("rejects missing baselines and bad emitted roots", () => {
    let r = runTool("fp-emit.mjs", [], { "emit/a.js": CODE });
    assert.equal(r.status, 2);
    assert.match(r.output, /missing baseline/);
    r = runTool("fp-emit.mjs", ["<DIR>/before.json", "<DIR>/emit"], {
      "before.json": "{}",
      "emit/a.js": CODE,
    });
    assert.equal(r.status, 0);
    r = runTool("fp-emit.mjs", ["<DIR>/nope.json", "<DIR>/emit"], {
      "emit/a.js": CODE,
    });
    assert.equal(r.status, 2);
    assert.match(r.output, /cannot read baseline/);
    r = runTool("fp-emit.mjs", ["<DIR>/before.json", "<DIR>/nope"], {
      "before.json": "{}",
    });
    assert.equal(r.status, 2);
    assert.match(r.output, /no such file or directory/);
    r = runTool("fp-emit.mjs", ["<DIR>/before.json", "<DIR>/emit/a.js"], {
      "before.json": "{}",
      "emit/a.js": CODE,
    });
    assert.equal(r.status, 2);
    assert.match(r.output, /not a directory/);
  });
});

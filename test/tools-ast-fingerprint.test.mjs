import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { read, runTool, runToolIn } from "./helpers.mjs";

const CODE = "function f(x) { return x; }\n";

describe("tools/ast-fingerprint.mjs", () => {
  it("lists scanned paths and skips minified bundles", () => {
    const { status, stdout } = runTool(
      "ast-fingerprint.mjs",
      ["files", "<DIR>"],
      { "src/a.js": CODE, "src/b.min.js": CODE, "src/n.txt": "hi\n" },
    );
    assert.equal(status, 0);
    assert.match(stdout, /^src\/a\.js$/m);
    assert.doesNotMatch(stdout, /min\.js/);
    assert.doesNotMatch(stdout, /n\.txt/);
  });

  it("snapshots hashes and reports unparseable files as null", () => {
    const { status, stdout, dir } = runTool(
      "ast-fingerprint.mjs",
      ["snapshot", "<DIR>/src", "<DIR>/before.json"],
      { "src/a.js": CODE, "src/broken.js": "function broken( {\n" },
    );
    assert.equal(status, 1);
    assert.match(stdout, /snapshot: 2 files, 1 unparseable -> /);
    assert.match(stdout, /SKIPPED\s+broken\.js/);
    const snap = JSON.parse(read(dir, "before.json"));
    assert.match(snap["a.js"], /^[0-9a-f]{64}$/);
    assert.equal(snap["broken.js"], null);
  });

  it("passes a comment-only edit and fails a code edit", () => {
    const first = runTool(
      "ast-fingerprint.mjs",
      ["snapshot", "<DIR>/src", "<DIR>/before.json"],
      { "src/a.js": CODE },
    );
    assert.equal(first.status, 0);
    writeFileSync(
      join(first.dir, "src/a.js"),
      "/** touched docs */\n" + CODE,
    );
    let r = runToolIn("ast-fingerprint.mjs", [
      "diff",
      join(first.dir, "src"),
      join(first.dir, "before.json"),
    ]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /OK: AST code unchanged in all 1 files/);
    writeFileSync(join(first.dir, "src/a.js"), CODE.replace("x;", "x + 1;"));
    r = runToolIn("ast-fingerprint.mjs", [
      "diff",
      join(first.dir, "src"),
      join(first.dir, "before.json"),
    ]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /CHANGED\s+a\.js/);
  });

  it("reports new and recovered files", () => {
    const first = runTool(
      "ast-fingerprint.mjs",
      ["snapshot", "<DIR>/src", "<DIR>/before.json"],
      {
        "src/a.js": CODE,
        "src/gone.js": CODE,
        "src/broken.js": "function broken( {\n",
      },
    );
    writeFileSync(join(first.dir, "src/broken.js"), CODE);
    writeFileSync(join(first.dir, "src/fresh.js"), CODE);
    const r = runToolIn("ast-fingerprint.mjs", [
      "diff",
      join(first.dir, "src"),
      join(first.dir, "before.json"),
    ]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /RECOVERED broken\.js/);
    assert.match(r.stdout, /NEW\s+fresh\.js/);
  });

  it("reports deleted files", () => {
    const first = runTool(
      "ast-fingerprint.mjs",
      ["snapshot", "<DIR>/src", "<DIR>/before.json"],
      { "src/a.js": CODE, "src/gone.js": CODE },
    );
    assert.equal(first.status, 0);
    rmSync(join(first.dir, "src/gone.js"));
    const r = runToolIn("ast-fingerprint.mjs", [
      "diff",
      join(first.dir, "src"),
      join(first.dir, "before.json"),
    ]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /DELETED\s+gone\.js/);
  });

  it("filters diffs and errors on empty matches", () => {
    const first = runTool(
      "ast-fingerprint.mjs",
      ["snapshot", "<DIR>/src", "<DIR>/before.json"],
      { "src/a.js": CODE, "src/b.js": CODE },
    );
    assert.equal(first.status, 0);
    let r = runToolIn("ast-fingerprint.mjs", [
      "diff",
      join(first.dir, "src"),
      join(first.dir, "before.json"),
      "a.js",
    ]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /all 1 files \(filter: a\.js\)/);
    r = runToolIn("ast-fingerprint.mjs", [
      "diff",
      join(first.dir, "src"),
      join(first.dir, "before.json"),
      "zzz",
    ]);
    assert.equal(r.status, 1);
    assert.match(r.output, /no file matched/);
  });

  it("rejects bad commands, paths and baselines", () => {
    let r = runTool("ast-fingerprint.mjs", ["bogus", "<DIR>", "x"], {
      "src/a.js": CODE,
    });
    assert.equal(r.status, 2);
    assert.match(r.output, /unknown command/);
    r = runTool("ast-fingerprint.mjs", ["snapshot"], {
      "src/a.js": CODE,
    });
    assert.equal(r.status, 2);
    assert.match(r.output, /missing path/);
    r = runTool("ast-fingerprint.mjs", ["snapshot", "<DIR>", "<DIR>"], {
      "src/a.js": CODE,
    });
    assert.equal(r.status, 2);
    assert.match(r.output, /cannot write snapshot/);
    r = runTool(
      "ast-fingerprint.mjs",
      ["diff", "<DIR>", "<DIR>/nope.json"],
      { "src/a.js": CODE },
    );
    assert.equal(r.status, 2);
    assert.match(r.output, /cannot read baseline/);
    r = runTool(
      "ast-fingerprint.mjs",
      ["diff", "<DIR>/nope", "<DIR>/before.json"],
      { "src/a.js": CODE },
    );
    assert.equal(r.status, 2);
    assert.match(r.output, /no such file or directory/);
  });
});

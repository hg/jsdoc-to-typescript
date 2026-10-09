import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { join } from "node:path";
import { read, runTool, runToolIn } from "./helpers.mjs";

const NOTE =
  "// @ts-expect-error: намеренное переопределение: страницы грузят по одному скрипту, побеждает последнее определение";

describe("tools/tsdup.mjs", () => {
  it("inserts suppressions above duplicate sites", () => {
    const { status, stdout, dir } = runTool(
      "tsdup.mjs",
      ["<DIR>/tsc.log"],
      {
        "src/a.ts": "function f() {}\nfunction f() {}\n",
        "src/b.ts": "const x = 1;\nconst x = 2;\n",
        "tsc.log": `<DIR>/src/a.ts(2,1): error TS2393: Duplicate function implementation.
<DIR>/src/b.ts(2,7): error TS2451: Cannot redeclare block-scoped variable 'x'.
<DIR>/src/missing.ts(1,1): error TS2393: Duplicate function implementation.
noise without an error
`,
      },
    );
    assert.equal(status, 0);
    assert.match(stdout, /suppressed 2 duplicate sites in 2 files/);
    assert.equal(
      read(dir, "src/a.ts"),
      `function f() {}\n${NOTE}\nfunction f() {}\n`,
    );
    assert.equal(
      read(dir, "src/b.ts"),
      `const x = 1;\n${NOTE}\nconst x = 2;\n`,
    );
  });

  it("is idempotent across reruns", () => {
    const first = runTool(
      "tsdup.mjs",
      ["<DIR>/tsc.log"],
      {
        "src/a.ts": "function f() {}\nfunction f() {}\n",
        "tsc.log": "<DIR>/src/a.ts(2,1): error TS2393: Duplicate function implementation.\n",
      },
    );
    assert.equal(first.status, 0);
    assert.match(first.stdout, /suppressed 1 duplicate sites in 1 files/);
    const once = read(first.dir, "src/a.ts");
    const second = runToolIn("tsdup.mjs", [join(first.dir, "tsc.log")]);
    assert.equal(second.status, 0);
    assert.match(second.stdout, /suppressed 0 duplicate sites in 1 files/);
    assert.equal(read(first.dir, "src/a.ts"), once);
  });

  it("does nothing for clean logs", () => {
    const { status, stdout, dir } = runTool(
      "tsdup.mjs",
      ["<DIR>/tsc.log"],
      {
        "src/a.ts": "const x: number = 1;\n",
        "tsc.log": "",
      },
    );
    assert.equal(status, 0);
    assert.match(stdout, /suppressed 0 duplicate sites in 0 files/);
    assert.equal(read(dir, "src/a.ts"), "const x: number = 1;\n");
  });

  it("rejects missing and unreadable logs", () => {
    let r = runTool("tsdup.mjs", [], {});
    assert.equal(r.status, 2);
    assert.match(r.output, /missing path/);
    r = runTool("tsdup.mjs", ["<DIR>/nope.log"], {});
    assert.equal(r.status, 2);
    assert.match(r.output, /no such file or directory/);
  });
});

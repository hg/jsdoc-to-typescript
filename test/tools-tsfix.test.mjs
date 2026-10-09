import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { read, runTool } from "./helpers.mjs";

describe("tools/tsfix.mjs", () => {
  it("annotates untyped identifier, rest and pattern parameters", () => {
    const { status, stdout, dir } = runTool(
      "tsfix.mjs",
      ["<DIR>/tsc.log"],
      {
        "src/a.ts":
          "function g(x) { return x; }\nfunction h(...args) { return args; }\nfunction k({a, b}) { return a; }\n",
        "tsc.log": `<DIR>/src/a.ts(1,12): error TS7006: Parameter 'x' implicitly has an 'any' type.
<DIR>/src/a.ts(2,14): error TS7006: Parameter 'args' implicitly has an 'any' type.
<DIR>/src/a.ts(3,12): error TS7006: Parameter '{a, b}' implicitly has an 'any' type.
`,
      },
    );
    assert.equal(status, 0);
    assert.match(stdout, /"param": 3/);
    const out = read(dir, "src/a.ts");
    assert.match(out, /function g\(x: any\)/);
    assert.match(out, /\.\.\.args: any\[\]/);
    assert.match(out, /\}: any\)/);
  });

  it("routes bad annotated initializers through unknown", () => {
    const { status, stdout, dir } = runTool(
      "tsfix.mjs",
      ["<DIR>/tsc.log"],
      {
        "src/a.ts": "let s: string = 123;\n",
        "tsc.log": "<DIR>/src/a.ts(1,5): error TS2322: Type 'number' is not assignable to type 'string'.\n",
      },
    );
    assert.equal(status, 0);
    assert.match(stdout, /"init": 1/);
    assert.match(read(dir, "src/a.ts"), /let s: string = 123 as unknown as string;/);
  });

  it("annotates catch variables and deletes stale directives", () => {
    const { status, stdout, dir } = runTool(
      "tsfix.mjs",
      ["<DIR>/tsc.log"],
      {
        "src/a.ts":
          "try { f(); } catch (e) { console.log(e.message); }\n// @ts-expect-error: something\nconst ok = 1;\n",
        "tsc.log": `<DIR>/src/a.ts(1,38): error TS18046: 'e' is of type 'unknown'.
<DIR>/src/a.ts(2,1): error TS2578: Unused '@ts-expect-error' directive.
`,
      },
    );
    assert.equal(status, 0);
    assert.match(stdout, /"catch": 1/);
    assert.match(stdout, /"staleRemoved": 1/);
    const out = read(dir, "src/a.ts");
    assert.match(out, /catch \(e: any\)/);
    assert.doesNotMatch(out, /ts-expect-error/);
  });

  it("wraps cast-overlap errors via unknown", () => {
    const { status, stdout, dir } = runTool(
      "tsfix.mjs",
      ["<DIR>/tsc.log"],
      {
        "src/a.ts": "const v = get() as string;\n",
        "tsc.log": "<DIR>/src/a.ts(1,12): error TS2352: Conversion of type 'number' to type 'string' may be a mistake.\n",
      },
    );
    assert.equal(status, 0);
    assert.match(stdout, /"cast": 1/);
    assert.match(read(dir, "src/a.ts"), /get\(\) as unknown as string/);
  });

  it("collapses nested unknown casts", () => {
    const { status, stdout, dir } = runTool(
      "tsfix.mjs",
      ["<DIR>/tsc.log"],
      {
        "src/a.ts": "const v = (x as string) as unknown;\nfunction g(p) { return p; }\n",
        "tsc.log": "<DIR>/src/a.ts(2,12): error TS7006: Parameter 'p' implicitly has an 'any' type.\n",
      },
    );
    assert.equal(status, 0);
    assert.match(stdout, /"cast": 1/);
    assert.match(read(dir, "src/a.ts"), /const v = x as string;/);
  });

  it("adjusts error positions below deleted directives", () => {
    const { status, stdout, dir } = runTool(
      "tsfix.mjs",
      ["<DIR>/tsc.log"],
      {
        "src/a.ts":
          "// @ts-expect-error: stale\nfunction g(p) { return p; }\n",
        "tsc.log": `<DIR>/src/a.ts(1,1): error TS2578: Unused '@ts-expect-error' directive.
<DIR>/src/a.ts(2,12): error TS7006: Parameter 'p' implicitly has an 'any' type.
`,
      },
    );
    assert.equal(status, 0);
    assert.match(stdout, /"staleRemoved": 1/);
    assert.match(stdout, /"param": 1/);
    assert.equal(
      read(dir, "src/a.ts"),
      "function g(p: any) {\n  return p;\n}\n",
    );
  });

  it("records unplaceable errors in skip", () => {
    const { status, stdout, dir } = runTool(
      "tsfix.mjs",
      ["<DIR>/tsc.log"],
      {
        "src/a.ts": "function g(p) { return p; }\n",
        "tsc.log": "<DIR>/src/a.ts(9,99): error TS7006: nope.\n",
      },
    );
    assert.equal(status, 0);
    assert.match(stdout, /param not placed/);
    assert.equal(read(dir, "src/a.ts"), "function g(p) { return p; }\n");
  });

  it("tolerates empty logs, garbage and unparseable files", () => {
    let r = runTool("tsfix.mjs", ["<DIR>/tsc.log"], {
      "src/a.ts": "const x = 1;\n",
      "tsc.log": "",
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"param": 0/);
    r = runTool("tsfix.mjs", ["<DIR>/tsc.log"], {
      "src/a.ts": "const x = 1;\n",
      "tsc.log": "garbage\n",
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"skip": \[\]/);
    r = runTool("tsfix.mjs", ["<DIR>/tsc.log"], {
      "src/a.ts": "function broken( {\n",
      "tsc.log": "<DIR>/src/a.ts(1,12): error TS7006: nope.\n",
    });
    assert.equal(r.status, 0);
    assert.equal(read(r.dir, "src/a.ts"), "function broken( {\n");
  });

  it("rejects missing and unreadable logs", () => {
    let r = runTool("tsfix.mjs", [], {});
    assert.equal(r.status, 2);
    assert.match(r.output, /missing path/);
    r = runTool("tsfix.mjs", ["<DIR>/nope.log"], {});
    assert.equal(r.status, 2);
    assert.match(r.output, /no such file or directory/);
  });
});

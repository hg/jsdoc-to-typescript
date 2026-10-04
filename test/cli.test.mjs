import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { read, run, runIn } from "./helpers.mjs";

const BASIC = `/**
 * Adds two numbers.
 *
 * @param {number} x first
 * @param {number} [y=1] second
 * @returns {number} sum
 */
export function add(x, y = 1) {
  return x + y;
}
`;

describe("cli", () => {
  it("check lists pending annotations and touches nothing", () => {
    const { status, stdout, dir } = run(["check", "<DIR>"], {
      "src/a.ts": BASIC,
    });
    assert.equal(status, 1);
    assert.match(stdout, /param x: number/);
    assert.match(stdout, /param y: number/);
    assert.match(stdout, /returns number/);
    assert.match(stdout, /annotations pending: 3/);
    assert.equal(read(dir, "src/a.ts"), BASIC);
  });

  it("convert annotates, keeps prose, and is idempotent", () => {
    const first = run(["convert", "<DIR>"], { "src/a.ts": BASIC });
    assert.equal(first.status, 0);
    const out = read(first.dir, "src/a.ts");
    assert.match(out, /function add\(x: number, y: number = 1\): number/);
    assert.match(out, /@param x first/);
    const second = runIn(["check", first.dir]);
    assert.equal(second.status, 0);
    assert.match(second.stdout, /annotations pending: 0/);
  });

  it("converts a nameless single @param", () => {
    const { status, dir } = run(["convert", "<DIR>"], {
      "src/a.ts": `/**
 * @param {{ id: number }}
 * @returns {void}
 */
(item) => {
  console.log(item);
}
`,
    });
    assert.equal(status, 0);
    assert.match(read(dir, "src/a.ts"), /\(item: \{ id: number \}\): void =>/);
  });

  it("leaves typedefs, casts, bad types and stale names in place", () => {
    const { status, stdout } = run(["check", "<DIR>"], {
      "src/a.ts": `/**
 * @typedef {Record<string, number>} Scores
 */
/**
 * @param {string} oldName stale
 * @returns {void}
 */
export function f(actual) {
  return /** @type {string} */ (actual);
}
/**
 * @returns {Record<string, function>} handlers
 */
export function g() {
  return {};
}
`,
    });
    assert.equal(status, 1);
    assert.match(stdout, /invalid-type\s+1/);
    assert.match(stdout, /no-match\s+1/);
  });

  it("files lists scannable files and skips the rest", () => {
    const { status, stdout } = run(["files", "<DIR>"], {
      "src/a.ts": BASIC,
      "src/nested/b.mts": BASIC,
      "src/skip.d.ts": "export declare const x: number;\n",
      "src/skip.min.ts": "var x=1;\n",
      "src/notes.txt": "hi\n",
    });
    assert.equal(status, 0);
    assert.match(stdout, /a\.ts/);
    assert.match(stdout, /b\.mts/);
    assert.doesNotMatch(stdout, /skip\.d\.ts/);
    assert.doesNotMatch(stdout, /skip\.min\.ts/);
    assert.doesNotMatch(stdout, /notes\.txt/);
  });

  it("accepts a single file as target", () => {
    const { status, stdout, dir } = run(["check", "<DIR>/src/a.ts"], {
      "src/a.ts": BASIC,
      "src/b.ts": BASIC,
    });
    assert.equal(status, 1);
    assert.match(stdout, /files scanned: 1/);
    assert.match(stdout, /^a\.ts:8/m);
    void dir;
  });

  it("unions filters and errors on empty matches", () => {
    const fixtures = { "src/a.ts": BASIC, "src/b.ts": BASIC };
    let r = run(["check", "<DIR>", "a.ts", "b.ts"], fixtures);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /files scanned: 2/);
    r = run(["check", "<DIR>", "zzz-no-such"], fixtures);
    assert.equal(r.status, 1);
    assert.match(r.output, /FAIL: no file matched/);
  });

  it("rejects bad commands, missing and unreadable paths", () => {
    let r = run(["bogus", "<DIR>"], {});
    assert.equal(r.status, 2);
    assert.match(r.output, /usage:/);
    r = run(["check"], {});
    assert.equal(r.status, 2);
    assert.match(r.output, /missing path/);
    r = runIn(["check", "/definitely/not/here-12345"]);
    assert.equal(r.status, 2);
    assert.match(r.output, /no such file or directory/);
  });

  it("rejects targets with no scannable files", () => {
    let r = run(["check", "<DIR>"], { "a.txt": "hi\n" });
    assert.equal(r.status, 1);
    assert.match(r.output, /no \.ts\/\.mts files/);
    r = run(["check", "<DIR>/a.txt"], { "a.txt": "hi\n" });
    assert.equal(r.status, 1);
    assert.match(r.output, /no \.ts\/\.mts files/);
  });

  it("tolerates a lone -- separator", () => {
    const { status, stdout } = run(["check", "--", "<DIR>"], {
      "src/a.ts": BASIC,
    });
    assert.equal(status, 1);
    assert.match(stdout, /annotations pending: 3/);
  });

  it("reports unparsable files without touching them", () => {
    const broken = `export function broken( {\n  console.log(1);\n}\n`;
    const { status, stdout, dir } = run(["convert", "<DIR>"], {
      "src/a.ts": broken,
    });
    assert.equal(status, 1);
    assert.match(stdout, /SKIPPED\s+src\/a\.ts/);
    assert.equal(read(dir, "src/a.ts"), broken);
  });
});

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { assertConverted, run } from "./helpers.mjs";

describe("destructured patterns", () => {
  it("annotates patterns with object literals verbatim", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @param {{ url: string, retry?: number }} opts settings
 * @returns {void}
 */
export function f({ url, retry = 3 }) {
  console.log(url, retry);
}
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `/**
 * @param opts settings
 */
export function f({ url, retry = 3 }: { url: string, retry?: number }): void {
  console.log(url, retry);
}
`,
    );
  });

  it("never annotates patterns with bare object", () => {
    const { status, stdout } = run(["check", "<DIR>"], {
      "a.ts": `/**
 * @param {object} opts settings
 * @returns {void}
 */
export function f({ url }) {
  console.log(url);
}
`,
    });
    assert.match(stdout, /bare-object-pattern\s+1/);
    assert.doesNotMatch(stdout, /param pattern/);
    void status;
  });

  it("synthesizes object types from sub-tags", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * Loads.
 *
 * @param {object} opts settings
 * @param {string} opts.url address
 * @param {number} [opts.retry=3] attempts
 * @param {string} [opts.method] verb
 * @returns {void}
 */
export function f({ url, retry = 3, method }) {
  console.log(url, retry, method);
}
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `/**
 * Loads.
 *
 * @param opts settings
 * @param opts.url address
 * @param opts.retry attempts
 * @param opts.method verb
 */
export function f({ url, retry = 3, method }: { url: string, retry?: number, method?: string }): void {
  console.log(url, retry, method);
}
`,
    );
  });

  it("forces optionals under a pattern-level default", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @param {object} opts settings
 * @param {string} opts.url address
 * @returns {void}
 */
export function f({ url } = {}) {
  console.log(url);
}
`,
    });
    // `{ url: string } = {}` would reject its own default
    assertConverted(
      dir,
      "a.ts",
      `/**
 * @param opts settings
 * @param opts.url address
 */
export function f({ url }: { url?: string } = {}): void {
  console.log(url);
}
`,
    );
  });

  it("gathers rest elements under an index signature", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @param {object} opts settings
 * @param {string} opts.known documented
 * @returns {void}
 */
export function f({ known, ...rest }) {
  console.log(known, rest);
}
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `/**
 * @param opts settings
 * @param opts.known documented
 */
export function f({ known, ...rest }: { known: string, [key: string]: unknown }): void {
  console.log(known, rest);
}
`,
    );
  });

  it("skips patterns with unresolved keys instead of breaking them", () => {
    const { status, stdout } = run(["check", "<DIR>"], {
      "a.ts": `/**
 * @param {object} opts settings
 * @param {string} opts.url address
 * @returns {void}
 */
export function f({ url, missing }) {
  console.log(url, missing);
}
`,
    });
    assert.match(stdout, /pattern-incomplete\s+1/);
    assert.doesNotMatch(stdout, /param pattern/);
    void status;
  });

  it("skips nested and computed pattern props", () => {
    const { status, stdout } = run(["check", "<DIR>"], {
      "a.ts": `/**
 * @param {object} opts settings
 * @param {string} opts.a first
 * @returns {void}
 */
export function f({ a: { b } }) {
  console.log(b);
}
`,
    });
    assert.match(stdout, /unsupported-pattern-prop\s*1/);
    void status;
  });

  it("annotates array patterns with tuples verbatim", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @param {[string, number]} pair values
 * @returns {void}
 */
export function f([name, count]) {
  console.log(name, count);
}
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `/**
 * @param pair values
 */
export function f([name, count]: [string, number]): void {
  console.log(name, count);
}
`,
    );
  });

  it("synthesizes shapes for plain parameters from sub-tags", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @param {object} [options] settings
 * @param {boolean} [options.loading=false] spinner
 * @returns {void}
 */
export function f(url, options = {}) {
  console.log(url, options);
}
`,
    });
    // `url` stays untyped (undocumented); `object` alone would reject
    // every `options.*` access, so the shape comes from the sub-tags
    assertConverted(
      dir,
      "a.ts",
      `/**
 * @param options settings
 * @param options.loading spinner
 */
export function f(url, options: { loading?: boolean } = {}): void {
  console.log(url, options);
}
`,
    );
  });

  it("prefers named types over sub-tags for plain parameters", () => {
    const { dir } = run(["convert", "<DIR>"], {
      "a.ts": `/**
 * @param {Settings} options settings
 * @param {string} options.url address
 * @returns {void}
 */
export function f(options) {
  console.log(options);
}
`,
    });
    assertConverted(
      dir,
      "a.ts",
      `/**
 * @param options settings
 * @param {string} options.url address
 */
export function f(options: Settings): void {
  console.log(options);
}
`,
    );
  });
});

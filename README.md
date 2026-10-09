# jsdoc-to-typescript

What you have: JavaScript project with type annotations stored in JSDoc, already checked by TypeScript with `allowJs` + `checkJs`.

What you want: TypeScript with native type annotations.

This script partially moves you from the first goalpost to the second one by removing JSDoc type annotations and moving them into native TypeScript. Whatever remains can be ported manually or with LLMs.

For example:

```js
/**
 * @param {{ text: string, id: string }}
 * @returns {void}
 */
(item) => {
```

becomes

```ts
(item: { text: string, id: string }): void => {
```

Comments are kept, if they exist.

Fully vibed, no promises. Saved me countless hours during real migrations, though.

Usage:

```sh
# install dependencies
pnpm install

# preview what is going to change change under ./src (dry run)
./jsdoc-to-ts.mjs check ./src

# narrow to matching files: repeat queries to union them
./jsdoc-to-ts.mjs check ./src http-client.ts number-utils.ts

# list scanned .ts/.mts files
./jsdoc-to-ts.mjs files ./src

# rewrite one file in place
./jsdoc-to-ts.mjs convert ./src/number-utils.ts

# rewrite a whole tree, then typecheck the result
./jsdoc-to-ts.mjs convert ./src
tsc --noEmit -p tsconfig.json
```

Notes:

- `path` accepts a directory (walked recursively) or a single `.ts`/`.mts` file
- `*.d.ts` and `*.min.ts` files are skipped
- `convert` is idempotent, running it twice changes nothing the second time.
- types copied verbatim from JSDoc: run your formatter afterwards
- anything the script cannot move stays in JSDoc and is counted in the summary (`left in place`)

## Helper tools

### tools/jsdoc-scan.mjs — what still needs JSDoc

Parses every `.js` file (skips `*.min.js`) and reports symbols whose JSDoc
is missing the annotations their kind needs: one `@param` per parameter
plus `@returns` for functions/methods with parameters, `@type` for
variables/fields where TypeScript cannot infer it, the block itself for
classes. Used before conversion to see where to add JSDoc first.

```sh
# everything missing types under ./src
./tools/jsdoc-scan.mjs list ./src

# one file, locals inside functions included
./tools/jsdoc-scan.mjs --all list ./src/http-client.js

# narrow to matching files
./tools/jsdoc-scan.mjs list ./src http-client.js modal.js

# totals per kind plus the top-40 files
./tools/jsdoc-scan.mjs summary ./src
```

### tools/any-scan.mjs — where `any` leaks in

Parses every `.js` file and counts `any` inside JSDoc type braces, grouped
by tag kind (`@param` / `@type` / `@returns` / other). Used to measure
`any`-debt and to pick the next file to tighten up.

```sh
# totals plus the top-40 files
./tools/any-scan.mjs summary ./src

# narrow to matching files
./tools/any-scan.mjs summary ./src http-client.js modal.js

# machine-readable per-file counts, sorted by count
./tools/any-scan.mjs detail ./src modal.js
```

### tools/ast-fingerprint.mjs — prove only comments changed

Parses each `.js` file (skips `*.min.js`), strips all comments, prints the
AST back and takes its sha256. Reformats and comment edits keep the
fingerprint; renames and statement changes alter it. Workflow: snapshot the
tree, run a comment-only pass, diff against the baseline.

```sh
# record the baseline
./tools/ast-fingerprint.mjs snapshot ./src /tmp/ast-before.json

# after the pass: exit 0 means code is identical, exit 1 means it changed
./tools/ast-fingerprint.mjs diff ./src /tmp/ast-before.json

# verify only some files (filters are relative to <path>)
./tools/ast-fingerprint.mjs diff ./src /tmp/ast-before.json Role/ edit.js

# list scanned files
./tools/ast-fingerprint.mjs files ./src
```

### tools/fp-emit.mjs — prove the emit matches the sources

Compares fingerprints of compiled JS against a source baseline snapshot:
types erase, so the executable-code AST of the emit must match the sources.
Only files with intended manual edits (new parameters, initializers) may
differ. Both paths come from args: the baseline JSON and the emitted root.

```sh
./tools/ast-fingerprint.mjs snapshot ./src /tmp/ast-before.json
# ...conversion...
./node_modules/.bin/tsc -p /tmp/emit.json   # outDir outside the repo
./tools/fp-emit.mjs /tmp/ast-before.json /tmp/emit-out
```

### tools/js2ts.mjs — one-shot promoter for browser scripts

An older, batch-style promoter for classic browser scripts: reads sources
already renamed to `.ts` paths (content still JS), promotes JSDoc type tags
to TS syntax, keeps prose, rewrites the file. Mechanical only: anything it
cannot map stays JSDoc and is reported as a `WARN` line for the manual
pass. Each `path` is a `.ts`/`.mts` file or a directory walked recursively
(same scannable set as the main script).

```sh
# convert one file in place
./tools/js2ts.mjs ./src/number-utils.ts

# convert a whole tree in place
./tools/js2ts.mjs ./src
```

### tools/tsdup.mjs — suppress duplicate page globals

Pages load one domain script each, so same-name globals in different files
never collide in the browser, while tsc merges every file into one program
and answers TS2393/TS2394/TS2451. Reads a tsc log (path from args), inserts
a `// @ts-expect-error` line above each reported site, prints stats.
Idempotent: already suppressed sites are skipped.

```sh
./node_modules/.bin/tsc --noEmit > tsc.log
./tools/tsdup.mjs tsc.log
```

### tools/tsfix.mjs — mechanical tsc fixes to a fixpoint

Reads a tsc log (path from args), patches converted files, prints JSON
stats. Repeat `tsc` + `tsfix` until the counters hit zero. All fixes are
behavior-preserving (types only): TS2352 casts go via `unknown`, TS2322
bad annotated initializers go via `unknown`, TS7006 untyped parameters get
`: any` (`...args` gets `: any[]`), catch variables get `: any`, TS2578
stale suppressions are deleted, plus `(X as T) as unknown` collapses. The
rest lands in `skip` for the manual pass.

```sh
./node_modules/.bin/tsc --noEmit > tsc.log
./tools/tsfix.mjs tsc.log   # repeat until counters hit zero
```

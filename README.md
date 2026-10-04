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

Fully vibed (except for this readme), no promises. Saved me countless hours during real migrations, though.

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

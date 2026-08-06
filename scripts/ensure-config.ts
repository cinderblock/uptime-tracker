#!/usr/bin/env bun
/**
 * Seed `src/config.ts` from the example if it doesn't exist.
 *
 * `src/config.ts` is gitignored — it holds your hostnames — but `src/index.ts`
 * imports it unconditionally, so a fresh clone can't typecheck or run its tests
 * until the file exists. Rather than make that a documented manual step people
 * discover via a confusing module-not-found error, create it on demand.
 *
 * Never overwrites: if you already have a config, this does nothing.
 */

const target = new URL('../src/config.ts', import.meta.url);
const example = new URL('../src/config.example.ts', import.meta.url);

if (await Bun.file(target).exists()) {
  process.exit(0);
}

await Bun.write(target, await Bun.file(example).text());
console.log('Created src/config.ts from src/config.example.ts — edit it to list your services.');

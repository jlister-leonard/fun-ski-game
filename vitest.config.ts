import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration.
 *
 * ## Why this file exists
 *
 * Until now every test in the repo lived beside `src/lib/algorithms` and used
 * relative imports, so Vitest's defaults were enough. Component tests cannot:
 * everything under `src/app` and `src/components` imports through the `@/*`
 * path alias declared in `tsconfig.json`, and Vitest does not read TypeScript
 * path mappings on its own.
 *
 * So this maps `@/*` to `src/*`, exactly as `tsconfig.json` does. It adds no
 * dependency, changes no existing test, and is the smallest thing that lets a
 * component be tested at all.
 *
 * **Ownership note:** created by the nutrition-diary agent (node S2), which
 * owns `src/app/nutrition/**` and `src/components/nutrition/**`. This root
 * config was not on that list; it is added because the alternative was either
 * an untested screen or a screen written in a different import style from the
 * rest of the app. Flagged in `docs/kg/channel/093-nutrition-diary.md` — if the
 * orchestrator would rather it lived elsewhere, moving it is a one-line change.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // Test discovery is deliberately left at Vitest's defaults. This file adds
  // one thing — the path alias — and changing what counts as a test file would
  // silently alter every other agent's suite.
});

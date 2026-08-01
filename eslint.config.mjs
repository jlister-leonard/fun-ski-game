import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "dist/**",
    ".wrangler/**",
    "build/**",
    "next-env.d.ts",
    // Reference implementations and research artifacts. These are a staging
    // area — algorithms are reviewed here, then moved into src/lib/ where they
    // are linted, typechecked and tested for real.
    "docs/**",
    // Throwaway browser-driving scripts. Gitignored already; linting them just
    // produces noise about unused variables in code that is deleted the moment
    // it has answered its question.
    ".smoke-*.mjs",
  ]),
]);

export default eslintConfig;

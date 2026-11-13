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
    "build/**",
    "next-env.d.ts",
  ]),
  // A destructuring where only some names are reassigned may stay `let`.
  // No `files`: this also turns prefer-const on for .js/.mjs scripts.
  {
    rules: {
      "prefer-const": ["error", { destructuring: "all" }],
      // An async client component fails at runtime; no hits today.
      "@next/next/no-async-client-component": "error",
    },
  },
]);

export default eslintConfig;

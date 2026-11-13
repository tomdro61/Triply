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
  // One-off analysis scripts for the blog engine: loose typing is accepted there.
  {
    files: ["scripts/blog-engine/reports/**"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  // A destructuring where only some names are reassigned may stay `let`.
  {
    rules: { "prefer-const": ["error", { destructuring: "all" }] },
  },
]);

export default eslintConfig;

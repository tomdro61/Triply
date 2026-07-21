import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  // Resolves the `@/` alias these modules use throughout.
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Must run before any import — several modules build their SDK client at
    // module scope and would throw on a missing key.
    setupFiles: ["./vitest.setup.ts"],
    // The booking engine is the money path; it should never be flaky-slow.
    testTimeout: 10_000,
  },
});

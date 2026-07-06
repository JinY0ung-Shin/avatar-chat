import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: [".claude/**", "dist/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // index.ts/main.ts are process/browser entrypoints; types.ts is types-only.
      exclude: ["src/server/index.ts", "src/server/types.ts", "src/client/src/main.ts"],
      reporter: ["text", "text-summary"],
      // Regression floor, a hair under the achieved coverage (2026-07: ~91/79/91/90).
      // Raise as coverage grows; don't lower to admit untested code.
      thresholds: { lines: 90, branches: 77, functions: 90, statements: 88 },
    },
  },
});

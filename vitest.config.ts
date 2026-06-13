import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: [".claude/**", "dist/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // index.ts is the process entrypoint; types.ts is types-only.
      exclude: ["src/server/index.ts", "src/server/types.ts"],
      reporter: ["text", "text-summary"],
    },
  },
});

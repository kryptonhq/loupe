import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // src-tauri holds Rust; its tests run under cargo.
    exclude: ["node_modules/**", "src-tauri/**", "dist/**"],
    coverage: {
      provider: "v8",
      // lcov for Codecov, text for whoever is reading the terminal.
      reporter: ["text", "lcov"],
      // Report on everything, not just files a test happened to import.
      // Otherwise adding a test to one file can *lower* the number by
      // pulling its untested imports into scope, which makes the metric
      // move for reasons unrelated to the change.
      all: true,
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/test/**",
        // Demo fixtures for browser dev, stripped from production builds.
        "src/dev/**",
        "src/main.tsx",
        "src/vite-env.d.ts",
      ],
    },
  },
});

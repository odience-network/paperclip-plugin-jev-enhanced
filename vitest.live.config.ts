import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// L3 live smoke (`pnpm test:live`). Developer machines only: tokens come from
// a gitignored local `.env` (see `.env.example`) and CI never sets them, so
// every live suite skips there. Never add this config to CI.
if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  test: {
    include: ["tests/live/**/*.live.ts"],
    environment: "node",
    testTimeout: 60_000,
  },
});

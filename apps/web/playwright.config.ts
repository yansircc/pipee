import { defineConfig } from "@playwright/test"

const baseURL = process.env.PI_WEB_E2E_BASE_URL
if (baseURL === undefined) throw new Error("Run Playwright through pnpm test:e2e so it owns an isolated server")

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./test-results/playwright",
  use: { baseURL },
})

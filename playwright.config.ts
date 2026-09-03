import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.CUSTENT_E2E_BASE_URL;
if (baseURL === undefined || baseURL.length === 0) {
  throw new Error(
    "CUSTENT_E2E_BASE_URL is required; run Playwright through pnpm e2e",
  );
}

export default defineConfig({
  testDir: "./e2e/specs",
  testMatch: "**/*.e2e.ts",
  outputDir: "./test-results",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 45_000,
  expect: {
    timeout: 12_000,
  },
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    screenshot: "only-on-failure",
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
});

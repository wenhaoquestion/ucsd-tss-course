import { defineConfig } from "@playwright/test";
const port = process.env.PORT || "4175";
const baseURL = "http://127.0.0.1:" + port + "/ucsd-tss-course/";
export default defineConfig({
  testDir: "./tests/browser",
  timeout: 45000,
  workers: 1,
  reporter: "line",
  use: {
    baseURL,
    headless: true,
    launchOptions: {
      executablePath: process.env.PW_CHROMIUM_EXECUTABLE_PATH || undefined,
    },
  },
  webServer: {
    command: "node scripts/preview.mjs",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
  },
});

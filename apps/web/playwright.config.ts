import { defineConfig } from "@playwright/test";

const port = 4321;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "../../artifacts/playwright",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 6_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: "chromium",
    channel: "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run build:all && npm run start --workspace @yurupager/server",
    cwd: "../..",
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      WEB_ORIGIN: `http://127.0.0.1:${port}`,
    },
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});

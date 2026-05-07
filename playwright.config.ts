import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  reporter: process.env.CI ? "list" : [["list"], ["html", { open: "never" }]],
  fullyParallel: false,
  workers: undefined,
  use: {
    headless: true,
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});

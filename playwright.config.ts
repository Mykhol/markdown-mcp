import { defineConfig } from "@playwright/test";

// Suites that start a server in-process must own it: joining the shared viewer
// would let a clear_viewer test wipe the developer's real pages, and winning the
// election would leave the suite hosting them. Opting out here rather than in
// each beforeAll means a new spec file is safe by default.
process.env.MDV_PORT ??= "0";

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

import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 45000,
  expect: { timeout: 8000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4175',
    headless: true,
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'npm run test:server',
      cwd: '../backend',
      url: 'http://127.0.0.1:3003/health',
      reuseExistingServer: false,
      timeout: 30000,
    },
    {
      command: 'npm run dev -- --port 4175',
      url: 'http://127.0.0.1:4175/editor',
      env: { VITE_API_BASE_URL: 'http://127.0.0.1:3003' },
      reuseExistingServer: false,
      timeout: 30000,
    },
  ],
});

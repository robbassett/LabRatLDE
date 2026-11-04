import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  use: {
    baseURL: process.env.LABRAT_URL ?? 'http://localhost:8080',
  },
  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

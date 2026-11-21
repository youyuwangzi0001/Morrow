import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './scripts',
  testMatch: 'pair-panel-render.spec.ts',
  timeout: 5 * 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'tmp/pair-shot-results',
  use: { trace: 'off', screenshot: 'off' }
})

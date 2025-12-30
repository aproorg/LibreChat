/**
 * Playwright Configuration for Infrastructure Validation Tests
 *
 * This config is specifically for testing deployed AWS infrastructure.
 * It does NOT start a local server - it tests against deployed environments.
 *
 * Usage:
 *   TEST_ENV=dev npx playwright test -c tests/infrastructure/playwright.config.ts
 *   TEST_ENV=prod npx playwright test -c tests/infrastructure/playwright.config.ts --grep=@prod
 */

import { defineConfig } from '@playwright/test';

// Environment configuration
const ENV_CONFIG: Record<string, string> = {
  dev: 'https://lambda-test.sandbox.data.apro.is',
  staging: process.env.STAGING_URL || 'https://staging.example.com',
  prod: process.env.PROD_URL || 'https://chat.example.com',
};

const currentEnv = process.env.TEST_ENV || 'dev';
const baseURL = process.env.BASE_URL || ENV_CONFIG[currentEnv] || ENV_CONFIG.dev;

export default defineConfig({
  testDir: './',
  outputDir: '.test-results',

  // Infrastructure tests should run sequentially to avoid rate limiting
  fullyParallel: false,

  // Don't fail on test.only in source code
  forbidOnly: !!process.env.CI,

  // Retry once on failure (cold starts can cause flakiness)
  retries: 1,

  // Single worker for infrastructure tests
  workers: 1,

  // Timeout for each test (30 seconds for cold start scenarios)
  timeout: 60000,

  // Reporter configuration
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],

  // Test options
  use: {
    baseURL,
    // Infrastructure tests are API-only, no browser needed
    ignoreHTTPSErrors: true,
    // Longer timeout for API requests (Lambda cold start)
    actionTimeout: 30000,
    // Trace on failure for debugging
    trace: 'on-first-retry',
  },

  expect: {
    // Longer timeout for assertions
    timeout: 15000,
  },

  // No browser needed for API tests - use only the default project
  projects: [
    {
      name: 'infrastructure',
      testMatch: '**/*.spec.ts',
    },
  ],

  // NO webServer - we test against deployed infrastructure
});

/**
 * Infrastructure Validation Tests for AWS Serverless Deployment
 *
 * These tests validate the serverless infrastructure after Terraform apply.
 * Run automatically via PostToolUse hook when `task apply:<env>` completes.
 *
 * Usage:
 *   npx playwright test tests/infrastructure/serverless.spec.ts --grep=@dev
 *   npx playwright test tests/infrastructure/serverless.spec.ts --grep=@prod
 *
 * Environment variables:
 *   TEST_ENV - Environment name (dev, staging, prod)
 *   BASE_URL - Override the base URL for testing
 */

import { test, expect, type Page } from '@playwright/test';

// Environment configuration
const ENV_CONFIG: Record<string, { baseUrl: string; apiUrl: string }> = {
  dev: {
    baseUrl: 'https://lambda-test.sandbox.data.apro.is',
    apiUrl: 'https://lambda-test.sandbox.data.apro.is/api',
  },
  staging: {
    baseUrl: process.env.STAGING_URL || 'https://staging.example.com',
    apiUrl: process.env.STAGING_API_URL || 'https://staging.example.com/api',
  },
  prod: {
    baseUrl: process.env.PROD_URL || 'https://chat.example.com',
    apiUrl: process.env.PROD_API_URL || 'https://chat.example.com/api',
  },
};

// Get current environment from TEST_ENV or default to 'dev'
const currentEnv = process.env.TEST_ENV || 'dev';
const config = ENV_CONFIG[currentEnv] || ENV_CONFIG.dev;

// Override with BASE_URL if provided
const BASE_URL = process.env.BASE_URL || config.baseUrl;
const API_URL = process.env.API_URL || config.apiUrl;

test.describe(`Infrastructure Validation @${currentEnv}`, () => {
  test.describe('CloudFront & Frontend', () => {
    test('frontend is accessible via CloudFront @dev @staging @prod', async ({ request }) => {
      const response = await request.get(BASE_URL, {
        headers: {
          Accept: 'text/html',
        },
      });

      expect(response.ok()).toBeTruthy();
      expect(response.status()).toBe(200);

      // Verify CloudFront headers
      const headers = response.headers();
      expect(headers['x-cache']).toBeDefined();
    });

    test('static assets are served from S3 via CloudFront @dev @staging @prod', async ({
      request,
    }) => {
      // Try to fetch a common static asset
      const response = await request.get(`${BASE_URL}/favicon.ico`, {
        failOnStatusCode: false,
      });

      // Should either succeed or return 404 (not 5xx)
      expect(response.status()).toBeLessThan(500);
    });

    test('SPA routing returns index.html for unknown routes @dev @staging @prod', async ({
      request,
    }) => {
      const response = await request.get(`${BASE_URL}/some/random/path`, {
        headers: {
          Accept: 'text/html',
        },
      });

      // CloudFront custom error response should return 200 with index.html
      expect(response.ok()).toBeTruthy();
      const body = await response.text();
      expect(body).toContain('<!DOCTYPE html>');
    });
  });

  test.describe('API Gateway & Lambda', () => {
    test('API health endpoint responds @dev @staging @prod', async ({ request }) => {
      const response = await request.get(`${API_URL}/health`, {
        failOnStatusCode: false,
      });

      // Health endpoint should return 200 or at least not error
      expect(response.status()).toBeLessThan(500);
    });

    test('API root endpoint responds @dev @staging @prod', async ({ request }) => {
      const response = await request.get(API_URL, {
        failOnStatusCode: false,
      });

      // Should get a response from Lambda (not 502/503/504)
      expect(response.status()).toBeLessThan(500);
    });

    test('CORS headers are present @dev @staging @prod', async ({ request }) => {
      const response = await request.fetch(`${API_URL}/health`, {
        method: 'OPTIONS',
        headers: {
          Origin: BASE_URL,
          'Access-Control-Request-Method': 'GET',
        },
      });

      const headers = response.headers();
      expect(headers['access-control-allow-origin']).toBeDefined();
      expect(headers['access-control-allow-methods']).toBeDefined();
    });

    test('API returns JSON content type @dev @staging @prod', async ({ request }) => {
      const response = await request.get(`${API_URL}/health`, {
        failOnStatusCode: false,
      });

      if (response.ok()) {
        const contentType = response.headers()['content-type'];
        expect(contentType).toContain('application/json');
      }
    });
  });

  test.describe('Lambda Response Streaming', () => {
    test('streaming endpoint accepts requests @dev @staging @prod', async ({ request }) => {
      // Test that the streaming-enabled endpoint is reachable
      // Note: This doesn't test actual streaming, just that the endpoint works
      const response = await request.post(`${API_URL}/ask/openAI`, {
        headers: {
          'Content-Type': 'application/json',
        },
        data: {},
        failOnStatusCode: false,
      });

      // Should get a response (even if 401 unauthorized, not 502/503)
      expect(response.status()).toBeLessThan(500);
    });

    test('chat endpoint accepts requests @dev @staging @prod', async ({ request }) => {
      const response = await request.post(`${API_URL}/chat`, {
        headers: {
          'Content-Type': 'application/json',
        },
        data: {},
        failOnStatusCode: false,
      });

      // Should get a response (even if 401 unauthorized)
      expect(response.status()).toBeLessThan(500);
    });
  });

  test.describe('Infrastructure Connectivity', () => {
    test('CloudFront routes /api/* to API Gateway @dev @staging @prod', async ({ request }) => {
      // Verify that /api requests go to Lambda, not S3
      const response = await request.get(`${BASE_URL}/api/health`, {
        failOnStatusCode: false,
      });

      // Should not return HTML (S3 404 page)
      const contentType = response.headers()['content-type'] || '';
      if (response.ok()) {
        expect(contentType).not.toContain('text/html');
      }
    });

    test('response times are acceptable @dev @staging @prod', async ({ request }) => {
      const startTime = Date.now();

      await request.get(BASE_URL, {
        timeout: 10000,
      });

      const responseTime = Date.now() - startTime;

      // Frontend should respond within 5 seconds (CloudFront cached)
      expect(responseTime).toBeLessThan(5000);
    });

    test('API response times are acceptable @dev @staging @prod', async ({ request }) => {
      const startTime = Date.now();

      await request.get(`${API_URL}/health`, {
        timeout: 30000,
        failOnStatusCode: false,
      });

      const responseTime = Date.now() - startTime;

      // API cold start can take up to 15 seconds, but should be under 30
      expect(responseTime).toBeLessThan(30000);
    });
  });
});

// Dev-specific tests
test.describe('Dev Environment Specific @dev', () => {
  test.skip(currentEnv !== 'dev', 'Skipping dev-specific tests');

  test('dev domain is accessible', async ({ request }) => {
    const response = await request.get('https://lambda-test.sandbox.data.apro.is');
    expect(response.ok()).toBeTruthy();
  });
});

// Production-specific tests
test.describe('Production Environment Specific @prod', () => {
  test.skip(currentEnv !== 'prod', 'Skipping prod-specific tests');

  test('SSL certificate is valid', async ({ request }) => {
    // Playwright will fail if SSL is invalid
    const response = await request.get(BASE_URL);
    expect(response.ok()).toBeTruthy();
  });
});

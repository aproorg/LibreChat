#!/usr/bin/env node

/**
 * Script to build the client with tenant-specific styling
 * Usage: node build-tenant.mjs <tenant-name>
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { generateTenantCSS } from './generateTenantCSS.mjs';

// Get tenant name from command line arguments
const tenant = process.argv[2];

if (!tenant) {
  console.error('Error: Tenant name is required');
  console.error('Usage: node build-tenant.mjs <tenant-name>');
  process.exit(1);
}

// Check if tenant configuration exists
const configRepoPath = path.resolve(process.cwd(), '../../librechat-config');
const tenantConfigPath = path.join(configRepoPath, 'tenant-styles', tenant, 'theme.json');
const tenantCssPath = path.join(configRepoPath, 'tenant-styles', tenant, 'css', `${tenant}.css`);

if (!fs.existsSync(tenantConfigPath)) {
  console.error(`Error: Tenant configuration not found for ${tenant}`);
  console.error(`Expected path: ${tenantConfigPath}`);
  process.exit(1);
}

if (!fs.existsSync(tenantCssPath)) {
  console.error(`Error: Tenant CSS file not found for ${tenant}`);
  console.error(`Expected path: ${tenantCssPath}`);
  process.exit(1);
}

console.log(`Building client for tenant: ${tenant}`);

// Create tenant-specific CSS file directory and copy CSS from librechat-config
const tenantStylesDir = path.resolve(process.cwd(), 'src/tenant-styles');
if (!fs.existsSync(tenantStylesDir)) {
  fs.mkdirSync(tenantStylesDir, { recursive: true });
}
generateTenantCSS(tenant, tenantStylesDir);

// Set environment variables
const env = {
  ...process.env,
  TENANT: tenant,
  POSTCSS_CONFIG_PATH: './scripts/tenant-styling/postcss.config.wrapper.js'
};

// Run the build command
const buildProcess = spawn('npm', ['run', 'build'], {
  env,
  stdio: 'inherit',
  cwd: path.resolve(process.cwd())
});

buildProcess.on('close', (code) => {
  if (code === 0) {
    console.log(`Successfully built client for tenant: ${tenant}`);
    console.log(`Output directory: ./dist/${tenant}`);
  } else {
    console.error(`Error: Build failed with code ${code}`);
  }
});

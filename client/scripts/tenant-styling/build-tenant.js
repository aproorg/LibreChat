#!/usr/bin/env node

/**
 * Script to build the client with tenant-specific styling
 * Usage: node build-tenant.js <tenant-name>
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

// Get tenant name from command line arguments
const tenant = process.argv[2];

if (!tenant) {
  console.error('Error: Tenant name is required');
  console.error('Usage: node build-tenant.js <tenant-name>');
  process.exit(1);
}

// Check if tenant configuration exists
const configRepoPath = path.resolve(process.cwd(), '../../librechat-config');
const tenantConfigPath = path.join(configRepoPath, 'tenant-styles', tenant, 'theme.json');

if (!fs.existsSync(tenantConfigPath)) {
  console.error(`Error: Tenant configuration not found for ${tenant}`);
  console.error(`Expected path: ${tenantConfigPath}`);
  process.exit(1);
}

console.log(`Building client for tenant: ${tenant}`);

// Set environment variables
const env = {
  ...process.env,
  TENANT: tenant,
  VITE_CONFIG_PATH: './scripts/tenant-styling/vite.config.wrapper.js'
};

// Run the build command
const buildProcess = spawn('npm', ['run', 'build'], {
  env,
  stdio: 'inherit',
  cwd: path.resolve(process.cwd(), '..')
});

buildProcess.on('close', (code) => {
  if (code === 0) {
    console.log(`Successfully built client for tenant: ${tenant}`);
    console.log(`Output directory: ./dist/${tenant}`);
  } else {
    console.error(`Error: Build failed with code ${code}`);
  }
});

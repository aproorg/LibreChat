#!/usr/bin/env node

/**
 * Script to run the dev server with custom styling
 * Usage: node run-dev.mjs <config-id>
 * 
 * This script sets the CONFIG_ID environment variable and runs the dev server
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

// Get configuration ID from command line arguments
const configId = process.argv[2];

if (!configId) {
  console.error('Error: Configuration ID is required');
  console.error('Usage: node run-dev.mjs <config-id>');
  process.exit(1);
}

// Check if configuration exists
const configRepoPath = path.resolve(process.cwd(), '../../librechat-config');
const tailwindConfigPath = path.join(configRepoPath, 'custom-styles', configId, 'tailwind.config.mjs');
const cssPath = path.join(configRepoPath, 'custom-styles', configId, 'css', 'style.css');

if (!fs.existsSync(tailwindConfigPath)) {
  console.error(`Error: Tailwind configuration not found for ID: ${configId}`);
  console.error(`Expected path: ${tailwindConfigPath}`);
  process.exit(1);
}

if (!fs.existsSync(cssPath)) {
  console.error(`Error: CSS file not found for ID: ${configId}`);
  console.error(`Expected path: ${cssPath}`);
  process.exit(1);
}

console.log(`Starting dev server with configuration ID: ${configId}`);

// Create custom-styles directory if it doesn't exist
const stylesDir = path.resolve(process.cwd(), 'src/custom-styles');
if (!fs.existsSync(stylesDir)) {
  fs.mkdirSync(stylesDir, { recursive: true });
}

// Create a CSS file that imports the configuration-specific CSS
const customCssPath = path.join(stylesDir, `${configId}.css`);
const cssContent = `@config "../../../librechat-config/custom-styles/${configId}/tailwind.config.mjs";

@tailwind base;
@tailwind components;
@tailwind utilities;

/* Import base styles */
@import "../style.css";

/* Import configuration-specific styles */
@import "../../../librechat-config/custom-styles/${configId}/css/style.css";
`;

fs.writeFileSync(customCssPath, cssContent);
console.log(`Created custom CSS file for configuration ID: ${configId}`);

// Set environment variables
const env = {
  ...process.env,
  CONFIG_ID: configId,
  POSTCSS_CONFIG_PATH: './scripts/custom-styling/postcss.config.wrapper.js'
};

// Run the dev server
const devProcess = spawn('npm', ['run', 'dev'], {
  env,
  stdio: 'inherit',
  shell: true
});

devProcess.on('error', (error) => {
  console.error(`Error starting dev server: ${error.message}`);
  process.exit(1);
});

devProcess.on('close', (code) => {
  console.log(`Dev server exited with code ${code}`);
});

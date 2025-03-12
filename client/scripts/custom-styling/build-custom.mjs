#!/usr/bin/env node

/**
 * Script to build the client with custom styling
 * Usage: node build-custom.mjs <config-id>
 * 
 * This script is used in CI to build the client with custom styling.
 * The config-id is used to locate the styling configuration in the librechat-config repo.
 * No organization-specific information is stored in the LibreChat repo.
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

// Get config ID from command line arguments
const configId = process.argv[2];

if (!configId) {
  console.error('Error: Configuration ID is required');
  console.error('Usage: node build-custom.mjs <config-id>');
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
  console.error(`Error: CSS file not found for configuration ID: ${configId}`);
  console.error(`Expected path: ${cssPath}`);
  process.exit(1);
}

console.log(`Building client with configuration ID: ${configId}`);

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

// Run the build command
const buildProcess = spawn('npm', ['run', 'build'], {
  env,
  stdio: 'inherit',
  cwd: path.resolve(process.cwd())
});

buildProcess.on('close', (code) => {
  if (code === 0) {
    console.log(`Successfully built client with configuration ID: ${configId}`);
    console.log(`Output directory: ./dist/${configId}`);
  } else {
    console.error(`Error: Build failed with code ${code}`);
  }
});

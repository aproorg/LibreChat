import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

// Get configuration ID from environment variable or command line argument
const configId = process.argv[2] || process.env.CONFIG_ID || 'default';
const mode = process.argv[3] || 'build'; // Default to 'build' if not specified

// Verify configuration exists in librechat-config repository
const configPath = path.resolve(process.cwd(), '../librechat-config/custom-styles', configId);
if (!fs.existsSync(configPath)) {
  console.error(`Error: Configuration '${configId}' not found at ${configPath}`);
  console.error(`Please create the configuration directory in librechat-config/custom-styles/`);
  process.exit(1);
}

// Verify CSS file exists in librechat-config repository
const cssPath = path.resolve(configPath, 'css/style.css');
if (!fs.existsSync(cssPath)) {
  console.error(`Error: CSS file not found at ${cssPath}`);
  console.error(
    `Please create the CSS file in librechat-config/custom-styles/${configId}/css/style.css`,
  );
  process.exit(1);
}

// Set environment variables
process.env.CONFIG_ID = configId;
process.env.POSTCSS_CONFIG_PATH = './scripts/custom-styling/postcss.config.wrapper.js';

const command = mode === 'dev' ? './scripts/run.sh' : 'npm';
const args = mode === 'dev' ? ['frontend'] : ['run', 'frontend'];

console.log(`Running with configuration: ${configId}`);

const child = spawn(command, args, {
  stdio: 'inherit',
  env: process.env,
});

child.on('error', (error) => {
  console.error(`Error running ${script}:`, error);
  process.exit(1);
});

child.on('exit', (code) => {
  process.exit(code || 0);
});

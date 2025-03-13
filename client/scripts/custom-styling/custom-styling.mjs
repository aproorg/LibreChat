import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

// Get configuration ID from environment variable or command line argument
const configId = process.argv[2] || process.env.CONFIG_ID || 'default';
const isDev = process.argv[3] === 'dev';
// Default path is relative to the current working directory (client)
const configRepoPath = process.env.LIBRECHAT_CONFIG_PATH || '../../librechat-config';

// Verify configuration exists in librechat-config repository
let configPath = path.resolve(process.cwd(), configRepoPath, 'custom-styles', configId);
console.log(`Looking for configuration at: ${configPath}`);
if (!fs.existsSync(configPath)) {
  // Try tenant-styles directory for backward compatibility
  const legacyPath = path.resolve(process.cwd(), configRepoPath, 'tenant-styles', configId);
  console.log(`Configuration not found, trying legacy path: ${legacyPath}`);
  
  if (fs.existsSync(legacyPath)) {
    console.log(`Using legacy configuration from: ${legacyPath}`);
    // Use the legacy path instead
    configPath = legacyPath;
  } else {
    console.error(`Error: Configuration '${configId}' not found at ${configPath}`);
    console.error(`Please create the configuration directory in ${configRepoPath}/custom-styles/ or ${configRepoPath}/tenant-styles/`);
    process.exit(1);
  }
}

// Copy librechat-config files to node_modules for CSS imports
const nodeModulesPath = path.resolve(process.cwd(), 'node_modules/@librechat-config');
const configRepoFullPath = path.resolve(process.cwd(), configRepoPath);
console.log(`Config repo path: ${configRepoFullPath}`);

if (!fs.existsSync(nodeModulesPath)) {
  console.log(`Creating @librechat-config in node_modules...`);
  try {
    // Create directory if it doesn't exist
    fs.mkdirSync(nodeModulesPath, { recursive: true });
    
    // Create custom-styles directory
    const customStylesPath = path.resolve(nodeModulesPath, 'custom-styles');
    fs.mkdirSync(customStylesPath, { recursive: true });
    
    // Copy configuration files
    const configDirs = fs.readdirSync(path.resolve(configRepoFullPath, 'custom-styles'));
    console.log(`Found configurations: ${configDirs.join(', ')}`);
    
    configDirs.forEach(dir => {
      if (fs.statSync(path.resolve(configRepoFullPath, 'custom-styles', dir)).isDirectory()) {
        console.log(`Copying configuration: ${dir}`);
        fs.mkdirSync(path.resolve(customStylesPath, dir), { recursive: true });
        
        // Copy CSS directory
        const cssDir = path.resolve(configRepoFullPath, 'custom-styles', dir, 'css');
        if (fs.existsSync(cssDir)) {
          fs.mkdirSync(path.resolve(customStylesPath, dir, 'css'), { recursive: true });
          
          // Copy CSS files
          const cssFiles = fs.readdirSync(cssDir);
          cssFiles.forEach(file => {
            const srcPath = path.resolve(cssDir, file);
            const destPath = path.resolve(customStylesPath, dir, 'css', file);
            fs.copyFileSync(srcPath, destPath);
            console.log(`Copied: ${srcPath} -> ${destPath}`);
          });
        }
      }
    });
    
    console.log(`Configuration files copied to: ${customStylesPath}`);
  } catch (error) {
    console.error(`Error copying configuration files: ${error.message}`);
    // Continue even if copy fails
  }
}

// Verify CSS file exists in librechat-config repository
let cssPath = path.resolve(configPath, 'css/style.css');
if (!fs.existsSync(cssPath)) {
  // Try legacy CSS file naming convention
  const legacyCssPath = path.resolve(configPath, 'css', `${configId}.css`);
  console.log(`CSS file not found at ${cssPath}, trying legacy path: ${legacyCssPath}`);
  
  if (fs.existsSync(legacyCssPath)) {
    console.log(`Using legacy CSS file from: ${legacyCssPath}`);
    cssPath = legacyCssPath;
  } else {
    console.error(`Error: CSS file not found at ${cssPath} or ${legacyCssPath}`);
    console.error(`Please create the CSS file in ${configRepoPath}/custom-styles/${configId}/css/style.css`);
    process.exit(1);
  }
}

// Set environment variables
process.env.CONFIG_ID = configId;
process.env.POSTCSS_CONFIG_PATH = './scripts/custom-styling/postcss.config.wrapper.js';

// Run the appropriate npm script
const script = isDev ? 'dev' : 'build';
console.log(`Running ${script} with configuration: ${configId}`);

const child = spawn('npm', ['run', script], {
  stdio: 'inherit',
  env: process.env
});

child.on('error', (error) => {
  console.error(`Error running ${script}:`, error);
  process.exit(1);
});

child.on('exit', (code) => {
  process.exit(code || 0);
});

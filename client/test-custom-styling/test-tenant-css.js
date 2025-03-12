import fs from 'fs';
import path from 'path';

// Test config CSS files in librechat-config
const testConfigCSS = (config) => {
  console.log(`\n=== Testing ${config} config CSS ===`);
  
  // Path to config's CSS file in librechat-config
  const configRepoPath = path.resolve(process.cwd(), '../../../librechat-config');
  const configCssPath = path.join(configRepoPath, 'config-styles', config, 'css', `${config}.css`);
  
  console.log(`Checking for CSS file at: ${configCssPath}`);
  if (fs.existsSync(configCssPath)) {
    console.log(`Found config CSS file for ${config}`);
    return true;
  } else {
    console.error(`Config CSS file not found for ${config}`);
    return false;
  }
};

// Run tests
const runTests = () => {
  const configs = ['default', 'apro', 'byko'];
  let allPassed = true;
  
  for (const config of configs) {
    const passed = testConfigCSS(config);
    if (!passed) allPassed = false;
  }
  
  console.log(`\nTest results: ${allPassed ? 'All tests passed' : 'Some tests failed'}`);
};

runTests();

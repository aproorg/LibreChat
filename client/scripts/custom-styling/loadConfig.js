import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Loads custom styling configuration
 * @param {string} configId - The configuration ID
 * @returns {Object} The configuration or default if not found
 */
const loadConfig = (configId) => {
  if (!configId) {
    console.log('No CONFIG_ID specified, using default styling');
    return null;
  }

  try {
    // Determine the path to the librechat-config repository
    // This assumes the librechat-config repo is at the same level as LibreChat
    const configRepoPath = path.resolve(process.cwd(), '../../librechat-config');
    const configPath = path.join(configRepoPath, 'custom-styles', configId, 'theme.json');
    
    // Check if configuration exists
    if (!fs.existsSync(configPath)) {
      console.warn(`Configuration not found for ID: ${configId}, using default styling`);
      return null;
    }

    // Load and parse the configuration
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    console.log(`Loaded configuration for ID: ${configId}`);
    return config;
  } catch (error) {
    console.error(`Error loading configuration: ${error.message}`);
    return null;
  }
};

export default loadConfig;

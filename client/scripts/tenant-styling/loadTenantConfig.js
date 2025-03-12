import fs from 'fs';
import path from 'path';

/**
 * Loads tenant-specific styling configuration
 * @param {string} tenant - The tenant name
 * @returns {Object} The tenant configuration or default if not found
 */
const loadTenantConfig = (tenant) => {
  if (!tenant) {
    console.log('No TENANT specified, using default styling');
    return null;
  }

  try {
    // Determine the path to the librechat-config repository
    // This assumes the librechat-config repo is at the same level as LibreChat
    const configRepoPath = path.resolve(process.cwd(), '../../librechat-config');
    const tenantConfigPath = path.join(configRepoPath, 'tenant-styles', tenant, 'theme.json');
    
    // Check if tenant config exists
    if (!fs.existsSync(tenantConfigPath)) {
      console.warn(`Tenant configuration not found for ${tenant}, using default styling`);
      return null;
    }

    // Load and parse the tenant configuration
    const tenantConfig = JSON.parse(fs.readFileSync(tenantConfigPath, 'utf8'));
    console.log(`Loaded tenant configuration for ${tenant}`);
    return tenantConfig;
  } catch (error) {
    console.error(`Error loading tenant configuration: ${error.message}`);
    return null;
  }
};

export default loadTenantConfig;

import path from 'path';
import loadTenantConfig from './loadTenantConfig.js';
import vitePluginTenantStyling from './vitePluginTenantStyling.js';

/**
 * Configures Vite for tenant-specific builds
 * @param {Object} viteConfig - The original Vite configuration
 * @returns {Object} Modified Vite configuration
 */
const configureTenantBuild = (viteConfig) => {
  const tenant = process.env.TENANT || '';
  
  if (!tenant) {
    return viteConfig;
  }
  
  const tenantConfig = loadTenantConfig(tenant);
  
  if (!tenantConfig) {
    return viteConfig;
  }
  
  // Clone the config to avoid modifying the original
  const config = { ...viteConfig };
  
  // Add tenant styling plugin
  config.plugins = [...(config.plugins || []), vitePluginTenantStyling()];
  
  // Modify build output directory to include tenant name
  if (config.build && tenant) {
    config.build.outDir = path.join(config.build.outDir || 'dist', tenant);
  }
  
  // Add tenant as a define for use in the client code
  config.define = {
    ...(config.define || {}),
    'import.meta.env.VITE_TENANT': JSON.stringify(tenant)
  };
  
  return config;
};

export default configureTenantBuild;

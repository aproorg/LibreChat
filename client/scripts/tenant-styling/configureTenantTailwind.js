import loadTenantConfig from './loadTenantConfig.js';

/**
 * Configures Tailwind for tenant-specific styling
 * @param {Object} tailwindConfig - The original Tailwind configuration
 * @returns {Object} Modified Tailwind configuration
 */
const configureTenantTailwind = (tailwindConfig) => {
  const tenant = process.env.TENANT || '';
  
  if (!tenant) {
    return tailwindConfig;
  }
  
  const tenantConfig = loadTenantConfig(tenant);
  
  if (!tenantConfig || !tenantConfig.tailwindExtensions) {
    return tailwindConfig;
  }
  
  // Clone the config to avoid modifying the original
  const config = JSON.parse(JSON.stringify(tailwindConfig));
  
  // Apply tenant-specific Tailwind extensions
  if (tenantConfig.tailwindExtensions) {
    // Merge theme extensions
    if (tenantConfig.tailwindExtensions.theme) {
      config.theme = config.theme || {};
      config.theme.extend = config.theme.extend || {};
      
      for (const [key, value] of Object.entries(tenantConfig.tailwindExtensions.theme)) {
        config.theme.extend[key] = {
          ...(config.theme.extend[key] || {}),
          ...value
        };
      }
    }
    
    // Add tenant-specific plugins
    if (tenantConfig.tailwindExtensions.plugins) {
      config.plugins = [...(config.plugins || []), ...tenantConfig.tailwindExtensions.plugins];
    }
  }
  
  return config;
};

export default configureTenantTailwind;

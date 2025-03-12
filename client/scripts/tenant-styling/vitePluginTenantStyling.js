import fs from 'fs';
import path from 'path';
import { generateTenantCSS } from './generateTenantCSS.mjs';

/**
 * Vite plugin for applying tenant-specific styling with @config directive
 * @param {Object} options - Plugin options
 * @returns {Object} Vite plugin
 */
const vitePluginTenantStyling = (options = {}) => {
  const tenant = process.env.TENANT || '';
  
  return {
    name: 'vite-plugin-tenant-styling',
    
    configResolved(config) {
      console.log(`Building client for tenant: ${tenant || 'default'}`);
      
      // Copy tenant-specific CSS file from librechat-config
      if (tenant) {
        const tenantStylesDir = path.resolve(process.cwd(), 'src/tenant-styles');
        
        // Create directory if it doesn't exist
        if (!fs.existsSync(tenantStylesDir)) {
          fs.mkdirSync(tenantStylesDir, { recursive: true });
        }
        
        // Copy CSS file from librechat-config
        generateTenantCSS(tenant, tenantStylesDir);
      }
    },
    
    transformIndexHtml(html) {
      if (!tenant) {
        return html;
      }
      
      // Add a tenant-specific class to the html element
      return html.replace('<html', `<html data-tenant="${tenant}"`);
    },
    
    config(config) {
      if (!tenant) {
        return config;
      }
      
      // Update the CSS entry point to use tenant-specific CSS
      const tenantCssPath = path.resolve(process.cwd(), `src/tenant-styles/${tenant}.css`);
      
      if (fs.existsSync(tenantCssPath)) {
        // Replace the main CSS entry with the tenant-specific one
        return {
          ...config,
          css: {
            ...config.css,
            preprocessorOptions: {
              ...config.css?.preprocessorOptions,
              scss: {
                ...config.css?.preprocessorOptions?.scss,
                additionalData: `@import "${tenantCssPath}";`
              }
            }
          }
        };
      }
      
      return config;
    }
  };
};

export default vitePluginTenantStyling;

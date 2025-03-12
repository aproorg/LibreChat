import fs from 'fs';
import path from 'path';
import { generateTenantCSS } from './generateTenantCSS.js';

/**
 * Vite plugin for applying tenant-specific styling
 * @param {Object} options - Plugin options
 * @returns {Object} Vite plugin
 */
const vitePluginTenantStyling = (options = {}) => {
  const tenant = process.env.TENANT || '';
  
  return {
    name: 'vite-plugin-tenant-styling',
    
    configResolved(config) {
      console.log(`Building client for tenant: ${tenant || 'default'}`);
    },
    
    transformIndexHtml(html) {
      if (!tenant) {
        return html;
      }
      
      // Add a tenant-specific class to the html element
      return html.replace('<html', `<html data-tenant="${tenant}"`);
    },
    
    generateBundle(options, bundle) {
      const cssContent = generateTenantCSS(tenant);
      
      if (!cssContent) {
        return;
      }
      
      // Add tenant CSS to the bundle
      this.emitFile({
        type: 'asset',
        fileName: 'tenant-styles.css',
        source: cssContent
      });
      
      // Find the main CSS file in the bundle
      const mainCssFile = Object.keys(bundle).find(
        fileName => fileName.endsWith('.css') && bundle[fileName].isEntry
      );
      
      if (mainCssFile && bundle[mainCssFile]) {
        // Append tenant CSS to the main CSS file
        bundle[mainCssFile].source += `\n/* Tenant-specific styles for ${tenant} */\n${cssContent}`;
      }
    }
  };
};

export default vitePluginTenantStyling;

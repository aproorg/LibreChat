import fs from 'fs';
import path from 'path';
import loadTenantConfig from './loadTenantConfig.js';

/**
 * Generates CSS variables from tenant configuration
 * @param {string} tenant - The tenant name
 * @returns {string} CSS content with tenant-specific variables
 */
const generateTenantCSS = (tenant) => {
  const tenantConfig = loadTenantConfig(tenant);
  
  if (!tenantConfig || !tenantConfig.cssVariables) {
    return '';
  }

  // Generate CSS variables
  let cssContent = `:root {\n`;
  
  for (const [variable, value] of Object.entries(tenantConfig.cssVariables)) {
    cssContent += `  ${variable}: ${value};\n`;
  }
  
  cssContent += `}\n`;
  
  return cssContent;
};

/**
 * Writes tenant CSS to a file
 * @param {string} tenant - The tenant name
 * @param {string} outputPath - Path to write the CSS file
 */
const writeTenantCSS = (tenant, outputPath) => {
  const cssContent = generateTenantCSS(tenant);
  
  if (!cssContent) {
    console.log('No tenant CSS variables to write');
    return;
  }
  
  try {
    fs.writeFileSync(outputPath, cssContent);
    console.log(`Tenant CSS written to ${outputPath}`);
  } catch (error) {
    console.error(`Error writing tenant CSS: ${error.message}`);
  }
};

export { generateTenantCSS, writeTenantCSS };

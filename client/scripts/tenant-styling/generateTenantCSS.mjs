import fs from 'fs';
import path from 'path';
import loadTenantConfig from './loadTenantConfig.js';

/**
 * Generates or copies tenant-specific CSS file with @config directive
 * @param {string} tenant - The tenant name
 * @param {string} outputDir - Directory to write the CSS file
 */
const generateTenantCSS = (tenant, outputDir) => {
  if (!tenant) {
    console.log('No TENANT specified, using default styling');
    return;
  }
  
  // Path to tenant's CSS file in librechat-config
  const configRepoPath = path.resolve(process.cwd(), '../../librechat-config');
  const tenantCssPath = path.join(configRepoPath, 'tenant-styles', tenant, 'css', `${tenant}.css`);
  
  // Check if tenant CSS exists in librechat-config
  if (fs.existsSync(tenantCssPath)) {
    // Copy CSS file to output directory
    const outputPath = path.join(outputDir, `${tenant}.css`);
    fs.copyFileSync(tenantCssPath, outputPath);
    console.log(`Copied CSS file for tenant ${tenant} from ${tenantCssPath} to ${outputPath}`);
    return;
  }
  
  // If CSS file doesn't exist in librechat-config, generate it from theme.json
  const tenantConfig = loadTenantConfig(tenant);
  
  if (!tenantConfig) {
    console.warn(`Tenant configuration not found for ${tenant}, using default styling`);
    return;
  }
  
  // Path to tenant's Tailwind config
  const tailwindConfigPath = path.relative(
    outputDir,
    path.join(configRepoPath, 'tenant-styles', tenant, 'tailwind.config.mjs')
  );
  
  // Generate CSS content
  let cssContent = `@config "${tailwindConfigPath}";\n\n`;
  cssContent += `@tailwind base;\n`;
  cssContent += `@tailwind components;\n`;
  cssContent += `@tailwind utilities;\n\n`;
  cssContent += `/* Import base styles */\n`;
  cssContent += `@import "../style.css";\n\n`;
  cssContent += `/* Tenant-specific styles */\n`;
  cssContent += `:root {\n`;
  
  // Add CSS variables from theme.json
  if (tenantConfig.cssVariables) {
    for (const [variable, value] of Object.entries(tenantConfig.cssVariables)) {
      cssContent += `  ${variable}: ${value};\n`;
    }
  }
  
  cssContent += `}\n\n`;
  cssContent += `/* Additional tenant-specific styles */\n`;
  cssContent += `.tenant-${tenant} {\n`;
  cssContent += `  /* Custom styles for ${tenant} tenant */\n`;
  cssContent += `}\n`;
  
  // Write CSS file
  const outputPath = path.join(outputDir, `${tenant}.css`);
  fs.writeFileSync(outputPath, cssContent);
  console.log(`Generated CSS file for tenant ${tenant}: ${outputPath}`);
};

export { generateTenantCSS };

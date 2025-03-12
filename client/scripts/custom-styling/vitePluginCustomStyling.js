import fs from 'fs';
import path from 'path';

/**
 * Vite plugin for applying custom styling with @config directive
 * @param {Object} options - Plugin options
 * @returns {Object} Vite plugin
 */
const vitePluginCustomStyling = (options = {}) => {
  const configId = process.env.CONFIG_ID || '';
  const isDev = process.env.NODE_ENV !== 'production';
  
  return {
    name: 'vite-plugin-custom-styling',
    
    configResolved(config) {
      console.log(`${isDev ? 'Running' : 'Building'} client for configuration: ${configId || 'default'}`);
      
      // In development mode, ensure the custom CSS file exists
      if (isDev && configId) {
        const stylesDir = path.resolve(process.cwd(), 'src/custom-styles');
        const customCssPath = path.join(stylesDir, `${configId}.css`);
        
        // Create the CSS file if it doesn't exist
        if (!fs.existsSync(customCssPath)) {
          if (!fs.existsSync(stylesDir)) {
            fs.mkdirSync(stylesDir, { recursive: true });
          }
          
          const cssContent = `@config "../../../librechat-config/custom-styles/${configId}/tailwind.config.mjs";

@tailwind base;
@tailwind components;
@tailwind utilities;

/* Import base styles */
@import "../style.css";

/* Import configuration-specific styles */
@import "../../../librechat-config/custom-styles/${configId}/css/style.css";
`;
          
          fs.writeFileSync(customCssPath, cssContent);
          console.log(`Created custom CSS file for development: ${customCssPath}`);
        }
      }
    },
    
    config(config) {
      // Add alias for librechat-config repository and base Tailwind preset
      return {
        ...config,
        resolve: {
          ...config.resolve,
          alias: {
            ...config.resolve?.alias,
            '@librechat-config': path.resolve(process.cwd(), '../../librechat-config'),
            '@librechat-tailwind-preset': path.resolve(process.cwd(), './tailwind.preset.cjs'),
          },
        },
      };
    },
    
    transformIndexHtml(html) {
      if (!configId) {
        return html;
      }
      
      // Add a configuration-specific class to the html element
      return html.replace('<html', `<html data-config="${configId}"`);
    }
  };
};

export default vitePluginCustomStyling;

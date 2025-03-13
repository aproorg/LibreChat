import path from 'path';

/**
 * Vite plugin for applying custom styling
 * @param {Object} options - Plugin options
 * @returns {Object} Vite plugin
 */
const vitePluginCustomStyling = (options = {}) => {
  const configId = process.env.CONFIG_ID || 'default';
  const isDev = process.env.NODE_ENV !== 'production';
  
  return {
    name: 'vite-plugin-custom-styling',
    
    configResolved(config) {
      console.log(`${isDev ? 'Running' : 'Building'} client for configuration: ${configId}`);
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
      // Add a configuration-specific class and CSS variable to the html element
      return html.replace('<html', `<html data-config="${configId}" style="--config-id: ${configId}"`);
    }
  };
};

export default vitePluginCustomStyling;

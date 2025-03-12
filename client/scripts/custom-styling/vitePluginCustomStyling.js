import path from 'path';

/**
 * Vite plugin for applying custom styling with @config directive
 * @param {Object} options - Plugin options
 * @returns {Object} Vite plugin
 */
const vitePluginCustomStyling = (_options = {}) => {
  const configId = process.env.CONFIG_ID || '';

  return {
    name: 'vite-plugin-custom-styling',

    configResolved(_config) {
      console.log(`Building client for configuration: ${configId || 'default'}`);
    },

    config(config) {
      // Add alias for librechat-config repository
      return {
        ...config,
        resolve: {
          ...config.resolve,
          alias: {
            ...config.resolve?.alias,
            '@librechat-config': path.resolve(process.cwd(), '../../librechat-config'),
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
    },
  };
};

export default vitePluginCustomStyling;

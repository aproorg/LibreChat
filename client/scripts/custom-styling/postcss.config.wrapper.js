/**
 * PostCSS configuration wrapper for @config directive support
 * This wrapper adds the necessary plugins to support the @config directive
 * without modifying the original PostCSS configuration
 */
const originalConfig = require('../../postcss.config.cjs');

module.exports = {
  ...originalConfig,
  plugins: [
    require('postcss-import'),
    require('postcss-preset-env')({
      features: {
        'nesting-rules': true,
      },
    }),
    require('tailwindcss'),
    require('autoprefixer'),
  ],
};

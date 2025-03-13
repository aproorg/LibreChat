/**
 * PostCSS configuration wrapper for custom styling
 */
const originalConfig = require('../../postcss.config.cjs');

module.exports = {
  ...originalConfig,
  plugins: [
    require('postcss-import'),
    require('postcss-preset-env')({
      features: {
        'nesting-rules': true,
        'custom-properties': {
          preserve: true,
        },
      },
    }),
    require('tailwindcss'),
    require('autoprefixer'),
  ],
};

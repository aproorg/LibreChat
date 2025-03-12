/**
 * Wrapper for postcss.config.cjs that adds support for @config directive
 * Usage:
 * - Import this file instead of the original postcss.config.cjs
 * - Set CONFIG_ID environment variable before building
 */

// Import the original PostCSS config
const originalPostCSSConfig = require('../../postcss.config.cjs');

// Add tailwindcss/nesting plugin for @config directive support
module.exports = {
  ...originalPostCSSConfig,
  plugins: [
    require('postcss-import'),
    require('postcss-preset-env'),
    require('tailwindcss/nesting'),
    ...(originalPostCSSConfig.plugins || []).filter(
      plugin => 
        plugin !== require('postcss-import') && 
        plugin !== require('postcss-preset-env') && 
        plugin !== require('tailwindcss/nesting')
    )
  ]
};

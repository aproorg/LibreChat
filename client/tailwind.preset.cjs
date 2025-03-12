// Export the base Tailwind configuration as a preset
const baseConfig = require('./tailwind.config.cjs');

// Remove content property as it will be defined in the extending config
const { content, ...presetConfig } = baseConfig;

module.exports = presetConfig;

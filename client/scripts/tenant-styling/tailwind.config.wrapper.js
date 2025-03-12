/**
 * Wrapper for tailwind.config.cjs that applies tenant-specific configuration
 * Usage:
 * - Import this file instead of the original tailwind.config.cjs
 * - Set TENANT environment variable before building
 */

// Import the original tailwind config
const originalTailwindConfig = require('../../tailwind.config.cjs');

// Import the tenant configuration function
const { configureTenantTailwind } = require('./index.js');

// Apply tenant-specific configuration
module.exports = configureTenantTailwind(originalTailwindConfig);

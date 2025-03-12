import { defineConfig } from 'vite';
import originalViteConfig from '../../vite.config.ts';
import { configureTenantBuild } from './index.js';

/**
 * Wrapper for vite.config.ts that applies tenant-specific configuration
 * Usage: 
 * - Import this file instead of the original vite.config.ts
 * - Set TENANT environment variable before building
 */
export default defineConfig((env) => {
  // Get the original configuration
  const originalConfig = typeof originalViteConfig === 'function' 
    ? originalViteConfig(env) 
    : originalViteConfig;
  
  // Apply tenant-specific configuration
  return configureTenantBuild(originalConfig);
});

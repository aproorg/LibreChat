# Multi-Tenant Styling

This directory contains scripts for implementing multi-tenant styling configuration in LibreChat. These scripts allow developers to use a `TENANT` environment variable to extend and override the LibreChat client styling config.

## Scripts

- `loadTenantConfig.js`: Loads tenant-specific styling configuration from the librechat-config repository
- `generateTenantCSS.js`: Generates CSS variables from tenant configuration
- `vitePluginTenantStyling.js`: Vite plugin for applying tenant styling during the build process
- `configureTenantBuild.js`: Modifies the Vite configuration for tenant-specific builds
- `configureTenantTailwind.js`: Updates the Tailwind configuration for tenant-specific extensions

## Usage

To use these scripts, import them in your Vite and Tailwind configuration files:

```javascript
// vite.config.ts
import { configureTenantBuild } from './scripts/tenant-styling';

export default defineConfig((env) => {
  const config = {
    // Your existing Vite configuration
  };
  
  return configureTenantBuild(config);
});
```

```javascript
// tailwind.config.cjs
const { configureTenantTailwind } = require('./scripts/tenant-styling');

const config = {
  // Your existing Tailwind configuration
};

module.exports = configureTenantTailwind(config);
```

Then, set the `TENANT` environment variable before building the client:

```bash
export TENANT=your-tenant-name
npm run build
```

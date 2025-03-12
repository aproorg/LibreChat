# Multi-Tenant Styling

This directory contains scripts for implementing multi-tenant styling configuration in LibreChat. These scripts allow developers to use a `TENANT` environment variable to extend and override the LibreChat client styling config.

## Scripts

- `loadTenantConfig.js`: Loads tenant-specific styling configuration from the librechat-config repository
- `generateTenantCSS.js`: Generates CSS variables from tenant configuration
- `vitePluginTenantStyling.js`: Vite plugin for applying tenant styling during the build process
- `configureTenantBuild.js`: Modifies the Vite configuration for tenant-specific builds
- `configureTenantTailwind.js`: Updates the Tailwind configuration for tenant-specific extensions
- `vite.config.wrapper.js`: Wrapper for vite.config.ts that applies tenant-specific configuration
- `tailwind.config.wrapper.js`: Wrapper for tailwind.config.cjs that applies tenant-specific configuration
- `build-tenant.js`: Script to build the client with tenant-specific styling

## Usage

To use these scripts without modifying the original configuration files, you can use the wrapper files:

### Option 1: Use wrapper files directly

```bash
# Set the TENANT environment variable
export TENANT=your-tenant-name

# Build using the wrapper configuration files
VITE_CONFIG_PATH=./scripts/tenant-styling/vite.config.wrapper.js npm run build
```

### Option 2: Create npm scripts in package.json

Add these scripts to your package.json:

```json
"scripts": {
  "build:tenant": "VITE_CONFIG_PATH=./scripts/tenant-styling/vite.config.wrapper.js npm run build",
  "dev:tenant": "VITE_CONFIG_PATH=./scripts/tenant-styling/vite.config.wrapper.js npm run dev"
}
```

Then run:

```bash
# Set the TENANT environment variable
export TENANT=your-tenant-name

# Build using the tenant configuration
npm run build:tenant
```

### Option 3: Use the build-tenant.js script

```bash
# Run the build script with the tenant name
node ./scripts/tenant-styling/build-tenant.js your-tenant-name
```

### Option 4: Modify the original configuration files (not recommended)

If you prefer to modify the original configuration files, you can import the tenant styling functions:

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

# Multi-Tenant Styling with @config Directive

This directory contains scripts for implementing multi-tenant styling configuration in LibreChat using Tailwind's @config directive. These scripts allow developers to use a `TENANT` environment variable to extend and override the LibreChat client styling config.

## How It Works

The multi-tenant styling system uses Tailwind's @config directive to specify different Tailwind configurations per tenant. Each tenant has its own CSS file that imports the base styles and applies tenant-specific customizations.

## Scripts

- `loadTenantConfig.js`: Loads tenant-specific styling configuration from the librechat-config repository
- `generateTenantCSS.mjs`: Generates tenant-specific CSS files with @config directive
- `vitePluginTenantStyling.js`: Vite plugin for applying tenant styling during the build process
- `configureTenantBuild.js`: Modifies the Vite configuration for tenant-specific builds
- `configureTenantTailwind.js`: Updates the Tailwind configuration for tenant-specific extensions
- `postcss.config.wrapper.js`: Wrapper for postcss.config.cjs that adds support for @config directive
- `vite.config.wrapper.js`: Wrapper for vite.config.ts that applies tenant-specific configuration
- `tailwind.config.wrapper.js`: Wrapper for tailwind.config.cjs that applies tenant-specific configuration
- `build-tenant.mjs`: Script to build the client with tenant-specific styling

## Directory Structure

```
librechat-config/tenant-styles/
├── default/
│   ├── theme.json
│   └── tailwind.config.mjs
├── apro/
│   ├── theme.json
│   └── tailwind.config.mjs
└── byko/
    ├── theme.json
    └── tailwind.config.mjs
```

## Configuration Format

The `theme.json` file contains CSS variable overrides and Tailwind extensions:

```json
{
  "cssVariables": {
    "--text-primary": "#123456",
    "--surface-primary": "#654321"
  },
  "tailwindExtensions": {
    "theme": {
      "extend": {
        "colors": {
          "custom-color": "#abcdef"
        },
        "fontFamily": {
          "custom": ["CustomFont", "sans-serif"]
        }
      }
    }
  }
}
```

The `tailwind.config.mjs` file extends the base Tailwind configuration with tenant-specific customizations.

## Usage

### Option 1: Use the build-tenant.mjs script (Recommended)

```bash
# Run the build script with the tenant name
node ./scripts/tenant-styling/build-tenant.mjs your-tenant-name
```

This will generate a tenant-specific CSS file with the @config directive and build the client with the tenant's styling.

### Option 2: Use wrapper files directly

```bash
# Set the TENANT environment variable
export TENANT=your-tenant-name

# Build using the wrapper configuration files
POSTCSS_CONFIG_PATH=./scripts/tenant-styling/postcss.config.wrapper.js VITE_CONFIG_PATH=./scripts/tenant-styling/vite.config.wrapper.js npm run build
```

### Option 3: Create npm scripts in package.json

Add these scripts to your package.json:

```json
"scripts": {
  "build:tenant": "POSTCSS_CONFIG_PATH=./scripts/tenant-styling/postcss.config.wrapper.js VITE_CONFIG_PATH=./scripts/tenant-styling/vite.config.wrapper.js npm run build",
  "dev:tenant": "POSTCSS_CONFIG_PATH=./scripts/tenant-styling/postcss.config.wrapper.js VITE_CONFIG_PATH=./scripts/tenant-styling/vite.config.wrapper.js npm run dev"
}
```

Then run:

```bash
# Set the TENANT environment variable
export TENANT=your-tenant-name

# Build using the tenant configuration
npm run build:tenant
```

## Benefits of @config Directive

The @config directive approach offers several benefits:

1. **Declarative Configuration**: Each CSS file explicitly declares which Tailwind configuration to use.

2. **Simplified Build Process**: No need to programmatically modify configurations at build time.

3. **Better Separation of Concerns**: Tenant-specific styles are clearly separated from the core application styles.

4. **Improved Developer Experience**: More intuitive and follows modern best practices for CSS and Tailwind configuration.

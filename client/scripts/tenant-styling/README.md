# Multi-Tenant Styling with @config Directive

This directory contains scripts for implementing multi-tenant styling configuration in LibreChat using Tailwind's @config directive. These scripts allow developers to use a `TENANT` environment variable to extend and override the LibreChat client styling config.

## How It Works

The multi-tenant styling system uses Tailwind's @config directive to specify different Tailwind configurations per tenant. Each tenant has its own CSS file that imports the base styles and applies tenant-specific customizations.

## Scripts

- `loadTenantConfig.js`: Loads tenant-specific styling configuration from the librechat-config repository
- `postcss.config.wrapper.js`: Wrapper for postcss.config.cjs that adds support for @config directive
- `build-tenant.mjs`: Script to build the client with tenant-specific styling

## Directory Structure

```
librechat-config/tenant-styles/
├── default/
│   ├── theme.json
│   ├── tailwind.config.mjs
│   └── css/
│       └── default.css
├── apro/
│   ├── theme.json
│   ├── tailwind.config.mjs
│   └── css/
│       └── apro.css
└── byko/
    ├── theme.json
    ├── tailwind.config.mjs
    └── css/
        └── byko.css
```

## CSS File Format

Each tenant's CSS file should use the @config directive to specify which Tailwind configuration to use:

```css
@config "../../../librechat-config/tenant-styles/tenant-name/tailwind.config.mjs";

@tailwind base;
@tailwind components;
@tailwind utilities;

/* Import base styles */
@import "../style.css";

/* Tenant-specific styles */
:root {
  /* CSS variables from theme.json */
  --text-primary: #123456;
  --surface-primary: #654321;
}

/* Additional tenant-specific styles */
.tenant-name {
  /* Custom styles for this tenant */
}
```

## Usage

### Development

```bash
# Set the TENANT environment variable
export TENANT=your-tenant-name

# Copy the tenant CSS file to the client
mkdir -p client/src/tenant-styles
cp librechat-config/tenant-styles/your-tenant-name/css/your-tenant-name.css client/src/tenant-styles/

# Build using the PostCSS wrapper
POSTCSS_CONFIG_PATH=./scripts/tenant-styling/postcss.config.wrapper.js npm run build
```

### Using the build-tenant.mjs script

```bash
# Run the build script with the tenant name
node ./scripts/tenant-styling/build-tenant.mjs your-tenant-name
```

This will copy the tenant-specific CSS file from librechat-config and build the client with the tenant's styling.

## Benefits of @config Directive

The @config directive approach offers several benefits:

1. **Declarative Configuration**: Each CSS file explicitly declares which Tailwind configuration to use.

2. **Simplified Build Process**: No need to programmatically modify configurations at build time.

3. **Better Separation of Concerns**: Tenant-specific styles are clearly separated from the core application styles.

4. **Improved Developer Experience**: More intuitive and follows modern best practices for CSS and Tailwind configuration.

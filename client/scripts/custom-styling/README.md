# Custom Styling with @config Directive

This directory contains scripts for implementing custom styling configuration in LibreChat using Tailwind's @config directive. These scripts allow developers to use a `CONFIG_ID` environment variable to extend and override the LibreChat client styling config.

## How It Works

The custom styling system uses Tailwind's @config directive to specify different Tailwind configurations. Each configuration has its own CSS file that imports the base styles and applies customizations.

## Scripts

- `loadConfig.js`: Loads custom styling configuration from the librechat-config repository
- `postcss.config.wrapper.js`: Wrapper for postcss.config.cjs that adds support for @config directive
- `build-custom.mjs`: Script to build the client with custom styling

## Directory Structure in librechat-config

```
librechat-config/custom-styles/
├── default/
│   ├── theme.json
│   ├── tailwind.config.mjs
│   └── css/
│       └── default.css
├── config1/
│   ├── theme.json
│   ├── tailwind.config.mjs
│   └── css/
│       └── config1.css
└── config2/
    ├── theme.json
    ├── tailwind.config.mjs
    └── css/
        └── config2.css
```

## CSS File Format

Each configuration's CSS file should use the @config directive to specify which Tailwind configuration to use:

```css
@config "../../../librechat-config/custom-styles/config-id/tailwind.config.mjs";

@tailwind base;
@tailwind components;
@tailwind utilities;

/* Import base styles */
@import "../style.css";

/* Custom styles */
:root {
  /* CSS variables from theme.json */
  --text-primary: #123456;
  --surface-primary: #654321;
}

/* Additional custom styles */
.custom-style {
  /* Custom styles for this configuration */
}
```

## Usage

### Development

```bash
# Set the CONFIG_ID environment variable
export CONFIG_ID=your-config-id

# Copy the CSS file to the client
mkdir -p client/src/styles
cp librechat-config/custom-styles/your-config-id/css/your-config-id.css client/src/styles/custom.css

# Build using the PostCSS wrapper
POSTCSS_CONFIG_PATH=./scripts/custom-styling/postcss.config.wrapper.js npm run build
```

### Using the build-custom.mjs script

```bash
# Run the build script with the configuration ID
node ./scripts/custom-styling/build-custom.mjs your-config-id
```

This will copy the custom CSS file from librechat-config and build the client with the custom styling.

## Benefits of @config Directive

The @config directive approach offers several benefits:

1. **Declarative Configuration**: Each CSS file explicitly declares which Tailwind configuration to use.

2. **Simplified Build Process**: No need to programmatically modify configurations at build time.

3. **Better Separation of Concerns**: Custom styles are clearly separated from the core application styles.

4. **Improved Developer Experience**: More intuitive and follows modern best practices for CSS and Tailwind configuration.

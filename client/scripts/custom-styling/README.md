# Custom Styling with @config Directive

This directory contains scripts for implementing custom styling configuration in LibreChat using Tailwind's @config directive. These scripts allow developers to use a `CONFIG_ID` environment variable to extend and override the LibreChat client styling config.

## How It Works

The custom styling system uses Tailwind's @config directive to specify different Tailwind configurations. Each configuration has its own CSS file that imports the base styles and applies customizations.

## Extension Mechanism

The custom styling system supports extending LibreChat's base Tailwind configuration and CSS files:

1. **Tailwind Configuration Extension**: Each configuration in librechat-config can extend LibreChat's base Tailwind configuration using the `presets` feature.

2. **CSS Extension**: Each configuration's CSS file imports LibreChat's base styles and can override specific properties.

## Scripts

- `loadConfig.js`: Loads custom styling configuration from the librechat-config repository
- `postcss.config.wrapper.js`: Wrapper for postcss.config.cjs that adds support for @config directive
- `build-custom.mjs`: Script to build the client with custom styling

## Directory Structure in librechat-config

```
librechat-config/custom-styles/
├── default/
│   ├── tailwind.config.mjs
│   └── css/
│       └── style.css
├── config1/
│   ├── tailwind.config.mjs
│   └── css/
│       └── style.css
└── config2/
    ├── tailwind.config.mjs
    └── css/
        └── style.css
```

## Tailwind Configuration Format

Each configuration's tailwind.config.mjs file should extend the base LibreChat configuration:

```javascript
/** @type {import('tailwindcss').Config} */
export default {
  // Use LibreChat's base configuration as a preset
  presets: [require('@librechat-tailwind-preset')],
  content: ['./src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#38B2AC',
          dark: '#2C7A7B',
          light: '#4FD1C5',
        },
        // Add more custom colors or override existing ones
      },
    },
  },
  plugins: [],
};
```

## CSS File Format

Each configuration's CSS file should use the @config directive to specify which Tailwind configuration to use and import the base styles:

```css
@config "../tailwind.config.mjs";

@tailwind base;
@tailwind components;
@tailwind utilities;

/* Import base styles */
@import "../style.css";

/* Custom styles */
:root {
  /* CSS variables */
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

# Build using the PostCSS wrapper
POSTCSS_CONFIG_PATH=./scripts/custom-styling/postcss.config.wrapper.js npm run build
```

### Using the build-custom.mjs script

```bash
# Run the build script with the configuration ID
node ./scripts/custom-styling/build-custom.mjs your-config-id
```

This will create a CSS file that imports the configuration-specific CSS using the @config directive and build the client with the custom styling.

### Development Server

To use custom styling with the development server:

```bash
# Set the CONFIG_ID environment variable
export CONFIG_ID=your-config-id

# Run the development server with the PostCSS wrapper
POSTCSS_CONFIG_PATH=./scripts/custom-styling/postcss.config.wrapper.js npm run frontend:dev
```

Alternatively, you can use the run-dev.mjs script:

```bash
# Run the dev server script with the configuration ID
node ./scripts/custom-styling/run-dev.mjs your-config-id
```

This will create a CSS file that imports the configuration-specific CSS using the @config directive and start the development server with the custom styling.

## Benefits of Extension Mechanism

The extension mechanism offers several benefits:

1. **Single Source of Truth**: LibreChat's base configuration remains the single source of truth.

2. **Simplified Maintenance**: Changes to the base configuration are automatically reflected in all extended configurations.

3. **Reduced Duplication**: No need to duplicate common configuration properties.

4. **Cleaner Overrides**: Only override the specific properties that need to be customized.

5. **Better Separation of Concerns**: Custom styles are clearly separated from the core application styles.

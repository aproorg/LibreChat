# Custom Styling Configuration

This directory contains scripts for implementing custom styling configuration in LibreChat. These scripts allow developers to use a `CONFIG_ID` environment variable to extend and override the LibreChat client styling config.

## How It Works

The custom styling system uses CSS layers and imports to apply configuration-specific styles. Each configuration has its own CSS file that defines custom variables and styles.

## Git Submodule

The librechat-config repository is included as a git submodule, providing direct access to configuration files without complex path resolution or copying files between repositories. This approach ensures version control consistency and simplifies the build process.

To clone the repository with the submodule:
```bash
git clone --recurse-submodules https://github.com/aproorg/LibreChat.git
```

## Extension Mechanism

The custom styling system supports extending LibreChat's base styles:

1. **CSS Extension**: Each configuration's CSS file can override specific CSS variables and add custom styles.

2. **Tailwind Configuration Extension**: Each configuration in librechat-config can extend LibreChat's base Tailwind configuration using the `presets` feature.

## Scripts

- `custom-styling.mjs`: Script to build or run the development server with custom styling
- `postcss.config.wrapper.js`: Wrapper for postcss.config.cjs that adds support for CSS nesting and custom properties
- `vitePluginCustomStyling.js`: Vite plugin that adds aliases and injects configuration ID as a CSS variable

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

Each configuration's CSS file should contain custom variables and styles that override the base styles:

```css
/* Custom styles for a specific configuration */
:root {
  /* CSS variables */
  --text-primary: #123456;
  --surface-primary: #654321;
}

/* Additional custom styles */
.custom-style {
  /* Custom styles for this configuration */
}

/* Dark mode overrides */
.dark {
  --text-primary: #E2E8F0;
  --text-secondary: #CBD5E0;
  --text-tertiary: #A0AEC0;
}
```

## Usage

### Building with Custom Styling

```bash
# Build with a specific configuration
node ./scripts/custom-styling/custom-styling.mjs your-config-id

# Run development server with a specific configuration
node ./scripts/custom-styling/custom-styling.mjs your-config-id dev
```

The script will verify that the configuration exists in the librechat-config repository before running the build or development server. It injects the configuration ID as a CSS variable that is used by the CSS layers to import the appropriate styles.

## Benefits of Extension Mechanism

The extension mechanism offers several benefits:

1. **Single Source of Truth**: LibreChat's base configuration remains the single source of truth.

2. **Simplified Maintenance**: Changes to the base configuration are automatically reflected in all extended configurations.

3. **Reduced Duplication**: No need to duplicate common configuration properties.

4. **Cleaner Overrides**: Only override the specific properties that need to be customized.

5. **Better Separation of Concerns**: Custom styles are clearly separated from the core application styles.

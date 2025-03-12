# LibreChat Client Scripts

This directory contains scripts for extending and customizing the LibreChat client.

## Multi-Tenant Styling

The `custom-styling` directory contains scripts for implementing custom styling configuration. These scripts allow developers to use a `CONFIG_ID` environment variable to extend and override the LibreChat client styling config.

### Usage

1. Set the `CONFIG_ID` environment variable to the name of your configuration:
   ```bash
   export CONFIG_ID=your-config-name
   ```

2. Run the build with the configuration-specific styling:
   ```bash
   npm run build
   ```

The build process will automatically load the configuration-specific styling configuration from the `librechat-config` repository's `custom-styles/{config-name}/theme.json` file and apply it to the client build.

### Configuration

Tenant-specific styling configurations should be placed in the `librechat-config` repository with the following structure:

```
librechat-config/
└── custom-styles/
    ├── default/
    │   └── theme.json
    └── your-config-name/
        └── theme.json
```

The `theme.json` file should contain CSS variable overrides and other styling configurations:

```json
{
  "cssVariables": {
    "--text-primary": "#123456",
    "--surface-primary": "#654321"
    // Add more CSS variables as needed
  },
  "tailwindExtensions": {
    // Optional Tailwind CSS extensions
  }
}
```

# LibreChat Client Scripts

This directory contains scripts for extending and customizing the LibreChat client.

## Multi-Tenant Styling

The `tenant-styling` directory contains scripts for implementing multi-tenant styling configuration. These scripts allow developers to use a `TENANT` environment variable to extend and override the LibreChat client styling config.

### Usage

1. Set the `TENANT` environment variable to the name of your tenant:

   ```bash
   export TENANT=your-tenant-name
   ```

2. Run the build with the tenant-specific styling:

   ```bash
   npm run build
   ```

The build process will automatically load the tenant-specific styling configuration from the `librechat-config` repository's `tenant-styles/{tenant-name}/theme.json` file and apply it to the client build.

### Configuration

Tenant-specific styling configurations should be placed in the `librechat-config` repository with the following structure:

```
librechat-config/
└── tenant-styles/
    ├── default/
    │   └── theme.json
    └── your-tenant-name/
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

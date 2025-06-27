# Icon Files

This directory contains the icon files for the FE Deploy extension.

## SVG Files (Source)

- `icon.svg` - Main extension icon (128x128)
- `icon-dark.svg` - Dark theme version of the main icon
- `icon-small.svg` - Small icon for context menu (16x16)
- `icon-small-dark.svg` - Dark theme version of the small icon

## PNG Files (Required for VSCode)

VSCode requires PNG format for icons. You need to convert the SVG files to PNG:

1. Use the `npm run convert-icons` script (requires additional setup)
2. Or manually convert using an online tool like https://svgtopng.com/

Required PNG files:

- `icon.png` - Main extension icon (128x128)
- `icon-small.png` - Light theme icon for context menu
- `icon-small-dark.png` - Dark theme icon for context menu

## Icon Design

The icon represents:
- A package box (frontend build output)
- An upload arrow (deployment)
- SSH connection lines (remote deployment)
- Terminal symbol (build process)

Colors follow Material Design guidelines:
- Primary: Blue (#2196F3 / #1976D2 for dark theme)
- Secondary: Green (#4CAF50 / #69F0AE for dark theme)
- Accent: Yellow (#FFEB3B / #FFF59D for dark theme) 
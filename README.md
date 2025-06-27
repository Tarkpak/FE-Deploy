# FE Deploy

A VSCode extension that allows you to build your frontend project and deploy it to a specified directory with a simple right-click on package.json.

## Features

- Right-click on package.json to build and deploy your project
- Progress notifications during build and deployment
- Configurable build command and target directory
- Automatically handles common build output folders (dist, build, out, public)
- Deploy locally or via SSH to a remote server

## Usage

You can trigger the build and deploy operation in several ways:

1. Right-click on package.json file in the Explorer view
2. Right-click inside the package.json file when it's open in the editor
3. Click on the deploy icon in the editor title bar when package.json is open
4. Right-click on a folder in Explorer and select "Build and Deploy" (will look for package.json in that folder)

The extension will run your build command and deploy the output to the target directory according to your configuration.

## Configuration

You can configure the extension in two ways:

### 1. VSCode Settings

Open VSCode settings and search for "FE Deploy" to configure:

- `feDeploy.buildCommand`: Command to execute for building the project (default: "npm run build")
- `feDeploy.deployMode`: Deployment method ("copy" for local, "ssh" for remote server)
- `feDeploy.buildOutputDir`: Specific build output directory (e.g., "dist", "build"). Leave empty to auto-detect

#### Local Deployment Settings
- `feDeploy.targetDirectory`: Directory where the build output will be deployed
- `feDeploy.excludeFiles`: Files or directories to exclude from deployment

#### SSH Deployment Settings
- `feDeploy.ssh.host`: SSH server hostname or IP address
- `feDeploy.ssh.port`: SSH server port (default: 22)
- `feDeploy.ssh.username`: SSH username
- `feDeploy.ssh.password`: SSH password (leave empty if using private key)
- `feDeploy.ssh.privateKeyPath`: Path to SSH private key file (leave empty if using password)
- `feDeploy.ssh.passphrase`: Passphrase for SSH private key (if required)
- `feDeploy.ssh.remotePath`: Remote directory path where files will be uploaded

### 2. Local Configuration File

You can also create a `deploy-config.json` file in the extension directory:

```json
{
  "buildCommand": "npm run build",
  "targetDirectory": "D:/deploy-target",
  "deployMode": "copy",
  "excludeFiles": [
    "node_modules",
    ".git"
  ],
  "buildOutputDir": "dist",
  "ssh": {
    "host": "example.com",
    "port": 22,
    "username": "user",
    "password": "",
    "privateKeyPath": "C:/Users/user/.ssh/id_rsa",
    "passphrase": "",
    "remotePath": "/var/www/html"
  }
}
```

Note: VSCode settings will take precedence over the local configuration file.

## Authentication Methods

For SSH deployment, you can choose between two authentication methods:

1. **Password Authentication**: Set the `password` field in your configuration.
2. **Private Key Authentication**: Set the `privateKeyPath` field to point to your private key file. If your key is protected with a passphrase, also set the `passphrase` field.

## Installation

### Local Development

1. Clone this repository
2. Run `npm install`
3. Press F5 to open a new window with your extension loaded
4. Right-click on package.json in the test project
5. Select "Build and Deploy" from the context menu

### Manual Installation

1. Run `vsce package` to create a VSIX file
2. Install the extension in VSCode using "Extensions: Install from VSIX..."

## Requirements

- VSCode 1.60.0 or higher 
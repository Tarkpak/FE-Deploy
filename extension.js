const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const { Client } = require('ssh2');
const copyFile = promisify(fs.copyFile);
const mkdir = promisify(fs.mkdir);
const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);
const readFile = promisify(fs.readFile);

const outputChannel = vscode.window.createOutputChannel("FE Deploy");

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    console.log('FE Deploy extension is now active');

    let disposable = vscode.commands.registerCommand('fe-deploy.buildAndDeploy', async (fileUri) => {
        if (!fileUri) {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                fileUri = editor.document.uri;
            }
        }

        if (!fileUri) {
            vscode.window.showErrorMessage('No package.json file selected');
            return;
        }

        // Get the folder containing the package.json
        const projectFolder = path.dirname(fileUri.fsPath);
        
        try {
            // Load configuration - first from settings, then fall back to file
            const config = getConfiguration();
            outputChannel.appendLine('deploy config: ' + JSON.stringify(config));
            
            // Show progress during build
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Building project",
                cancellable: true
            }, async (progress, token) => {
                return new Promise((resolve, reject) => {
                    progress.report({ message: "Running build command..." });
                    
                    // Execute build command in the project folder
                    const buildProcess = exec(config.buildCommand, { cwd: projectFolder });
                    
                    buildProcess.stdout.on('data', (data) => {
                        outputChannel.appendLine(`Build stdout: ${data}`);
                    });
                    
                    buildProcess.stderr.on('data', (data) => {
                        outputChannel.appendLine(`Build stderr: ${data}`);
                    });
                    
                    buildProcess.on('error', (error) => {
                        vscode.window.showErrorMessage(`Build failed: ${error.message}`);
                        reject(error);
                    });
                    
                    buildProcess.on('close', (code) => {
                        if (code === 0) {
                            progress.report({ message: "Build completed successfully" });
                            resolve();
                        } else {
                            vscode.window.showErrorMessage(`Build process exited with code ${code}`);
                            reject(new Error(`Build process exited with code ${code}`));
                        }
                    });
                    
                    token.onCancellationRequested(() => {
                        buildProcess.kill();
                        vscode.window.showWarningMessage('Build cancelled');
                        reject(new Error('Build cancelled'));
                    });
                });
            });
            
            // Find the build output directory
            let buildFolder;
            
            if (config.buildOutputDir) {
                // Use specified build output directory
                buildFolder = path.join(projectFolder, config.buildOutputDir);
                if (!fs.existsSync(buildFolder)) {
                    vscode.window.showErrorMessage(`Build output directory "${config.buildOutputDir}" not found. Check your configuration.`);
                    return;
                }
            } else {
                // Try to automatically detect build output folder
                buildFolder = path.join(projectFolder, 'dist');
                
                if (!fs.existsSync(buildFolder)) {
                    // Try common build output folders if dist doesn't exist
                    const alternativeFolders = ['build', 'out', 'public'];
                    let folderFound = false;
                    
                    for (const folder of alternativeFolders) {
                        const altPath = path.join(projectFolder, folder);
                        if (fs.existsSync(altPath)) {
                            folderFound = true;
                            buildFolder = altPath;
                            break;
                        }
                    }
                    
                    if (!folderFound) {
                        vscode.window.showErrorMessage('Could not find build output folder. Please specify it in settings.');
                        return;
                    }
                }
            }

            // Show progress during deployment
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Deploying project",
                cancellable: true
            }, async (progress, token) => {
                // Check deployment mode and execute appropriate deployment method
                if (config.deployMode === 'ssh') {
                    // Validate SSH configuration
                    if (!config.ssh || !config.ssh.host || !config.ssh.username) {
                        vscode.window.showErrorMessage('SSH configuration is incomplete. Please check your settings.');
                        return;
                    }
                    
                    // Check if either password or private key is provided
                    if (!config.ssh.password && !config.ssh.privateKeyPath) {
                        vscode.window.showErrorMessage('SSH authentication is not configured. Please provide either a password or a private key path.');
                        return;
                    }
                    
                    // Deploy via SSH
                    await deployViaSSH(buildFolder, config.ssh, config.excludeFiles, progress, token);
                    vscode.window.showInformationMessage(`Successfully deployed to ${config.ssh.host}:${config.ssh.remotePath}`);
                } else {
                    // Local deployment (copy)
                    // Check if target directory exists, if not create it
                    try {
                        await stat(config.targetDirectory);
                    } catch (err) {
                        await mkdir(config.targetDirectory, { recursive: true });
                        vscode.window.showInformationMessage(`Created target directory: ${config.targetDirectory}`);
                    }
                    
                    // Perform local deployment
                    await copyDirectory(buildFolder, config.targetDirectory, config.excludeFiles, progress, token);
                    vscode.window.showInformationMessage(`Successfully deployed to ${config.targetDirectory}`);
                }
            });
            
        } catch (error) {
            vscode.window.showErrorMessage(`Deployment failed: ${error.message}`);
        }
    });

    context.subscriptions.push(disposable);
}

function getConfiguration() {
    const config = vscode.workspace.getConfiguration('feDeploy');
    const defaultConfig = {
        buildCommand: 'npm run build',
        targetDirectory: 'D:/deploy-target',
        deployMode: 'copy',
        excludeFiles: ['node_modules', '.git'],
        buildOutputDir: '',
        ssh: {
            host: '',
            port: 22,
            username: '',
            password: '',
            privateKeyPath: '',
            passphrase: '',
            remotePath: '/var/www/html'
        }
    };
    
    // Try to load from local config file first
    let fileConfig = {};
    try {
        const configPath = path.join(__dirname, 'deploy-config.json');
        if (fs.existsSync(configPath)) {
            fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
    } catch (err) {
        outputChannel.appendLine('Error loading configuration file: ' + err);
    }
    
    // Merge configurations with VSCode settings taking precedence
    const sshConfig = {
        host: config.get('ssh.host') || (fileConfig.ssh && fileConfig.ssh.host) || defaultConfig.ssh.host,
        port: config.get('ssh.port') || (fileConfig.ssh && fileConfig.ssh.port) || defaultConfig.ssh.port,
        username: config.get('ssh.username') || (fileConfig.ssh && fileConfig.ssh.username) || defaultConfig.ssh.username,
        password: config.get('ssh.password') || (fileConfig.ssh && fileConfig.ssh.password) || defaultConfig.ssh.password,
        privateKeyPath: config.get('ssh.privateKeyPath') || (fileConfig.ssh && fileConfig.ssh.privateKeyPath) || defaultConfig.ssh.privateKeyPath,
        passphrase: config.get('ssh.passphrase') || (fileConfig.ssh && fileConfig.ssh.passphrase) || defaultConfig.ssh.passphrase,
        remotePath: config.get('ssh.remotePath') || (fileConfig.ssh && fileConfig.ssh.remotePath) || defaultConfig.ssh.remotePath
    };
    
    return {
        buildCommand: config.get('buildCommand') || fileConfig.buildCommand || defaultConfig.buildCommand,
        targetDirectory: config.get('targetDirectory') || fileConfig.targetDirectory || defaultConfig.targetDirectory,
        deployMode: config.get('deployMode') || fileConfig.deployMode || defaultConfig.deployMode,
        excludeFiles: config.get('excludeFiles') || fileConfig.excludeFiles || defaultConfig.excludeFiles,
        buildOutputDir: config.get('buildOutputDir') || fileConfig.buildOutputDir || defaultConfig.buildOutputDir,
        ssh: sshConfig
    };
}

async function copyDirectory(source, target, excludeFiles, progress, token) {
    // Create target directory if it doesn't exist
    if (!fs.existsSync(target)) {
        await mkdir(target, { recursive: true });
    }
    
    const entries = await readdir(source, { withFileTypes: true });
    
    let processed = 0;
    const total = entries.length;
    
    for (const entry of entries) {
        if (token.isCancellationRequested) {
            throw new Error('Deployment cancelled');
        }
        
        const sourcePath = path.join(source, entry.name);
        const targetPath = path.join(target, entry.name);
        
        // Skip excluded files/folders
        if (excludeFiles && excludeFiles.includes(entry.name)) {
            continue;
        }
        
        if (entry.isDirectory()) {
            await copyDirectory(sourcePath, targetPath, excludeFiles, progress, token);
        } else {
            await copyFile(sourcePath, targetPath);
        }
        
        processed++;
        progress.report({ 
            message: `Copying files... (${processed}/${total})`,
            increment: (1 / total) * 100
        });
    }
}

async function deployViaSSH(sourceDir, sshConfig, excludeFiles, progress, token) {
    return new Promise((resolve, reject) => {
        const conn = new Client();
        
        // Prepare authentication
        const authConfig = {
            host: sshConfig.host,
            port: sshConfig.port,
            username: sshConfig.username
        };
        
        // Use either password or private key
        if (sshConfig.password) {
            authConfig.password = sshConfig.password;
        } else if (sshConfig.privateKeyPath) {
            readFile(sshConfig.privateKeyPath)
                .then(privateKey => {
                    authConfig.privateKey = privateKey;
                    if (sshConfig.passphrase) {
                        authConfig.passphrase = sshConfig.passphrase;
                    }
                    // Connect after reading the key
                    tryConnect();
                })
                .catch(err => {
                    reject(new Error(`Failed to read private key: ${err.message}`));
                });
            return; // Return early and connect in the then() callback
        }
        
        // If we're using password auth, connect immediately
        tryConnect();
        
        function tryConnect() {
            conn.on('ready', () => {
                outputChannel.appendLine('SSH connection established');
                progress.report({ message: 'SSH connection established' });
                
                // Get all files to upload
                collectFiles(sourceDir, '', excludeFiles)
                    .then(filesToUpload => {
                        const total = filesToUpload.length;
                        let processed = 0;
                        
                        // Create SFTP session
                        conn.sftp((err, sftp) => {
                            if (err) {
                                conn.end();
                                reject(new Error(`SFTP error: ${err.message}`));
                                return;
                            }
                            
                            // Create a queue to process files sequentially
                            const processQueue = () => {
                                if (filesToUpload.length === 0) {
                                    conn.end();
                                    resolve();
                                    return;
                                }
                                
                                if (token.isCancellationRequested) {
                                    conn.end();
                                    reject(new Error('Deployment cancelled'));
                                    return;
                                }
                                
                                const file = filesToUpload.shift();
                                const localPath = path.join(sourceDir, file.relativePath);
                                const remotePath = path.posix.join(sshConfig.remotePath, file.relativePath.replace(/\\/g, '/'));
                                
                                if (file.isDirectory) {
                                    // Create remote directory
                                    sftp.mkdir(remotePath, (mkdirErr) => {
                                        if (mkdirErr && mkdirErr.code !== 4) { // Code 4 is "Failure" which often means directory already exists
                                            outputChannel.appendLine(`Error creating directory ${remotePath}: ${mkdirErr.message}`);
                                        }
                                        
                                        processed++;
                                        progress.report({
                                            message: `Creating directories... (${processed}/${total})`,
                                            increment: (1 / total) * 100
                                        });
                                        
                                        // Continue with next file
                                        processQueue();
                                    });
                                } else {
                                    // Ensure remote directory exists
                                    const remoteDir = path.posix.dirname(remotePath);
                                    ensureRemoteDirectory(sftp, remoteDir, () => {
                                        // Upload file
                                        sftp.fastPut(localPath, remotePath, (putErr) => {
                                            if (putErr) {
                                                outputChannel.appendLine(`Error uploading ${localPath}: ${putErr.message}`);
                                            } else {
                                                outputChannel.appendLine(`Uploaded: ${remotePath}`);
                                            }
                                            
                                            processed++;
                                            progress.report({
                                                message: `Uploading files... (${processed}/${total})`,
                                                increment: (1 / total) * 100
                                            });
                                            
                                            // Continue with next file
                                            processQueue();
                                        });
                                    });
                                }
                            };
                            
                            // Start processing the queue
                            processQueue();
                        });
                    })
                    .catch(error => {
                        conn.end();
                        reject(error);
                    });
            });
            
            conn.on('error', (err) => {
                outputChannel.appendLine(`SSH connection error: ${err.message}`);
                reject(new Error(`SSH connection error: ${err.message}`));
            });
            
            conn.on('end', () => {
                outputChannel.appendLine('SSH connection ended');
            });
            
            // Connect to the server
            try {
                conn.connect(authConfig);
            } catch (err) {
                reject(new Error(`SSH connection failed: ${err.message}`));
            }
        }
    });
}

// Recursively ensure remote directories exist
function ensureRemoteDirectory(sftp, remotePath, callback) {
    sftp.mkdir(remotePath, (err) => {
        if (!err || err.code === 4) { // Code 4 is "Failure" which often means directory already exists
            callback();
        } else if (err.code === 2) { // Code 2 is "No such file" which means parent directory doesn't exist
            const parentPath = path.posix.dirname(remotePath);
            ensureRemoteDirectory(sftp, parentPath, () => {
                sftp.mkdir(remotePath, () => {
                    callback(); // Continue even if there's an error, we'll handle file upload errors separately
                });
            });
        } else {
            callback(); // Continue with other errors, we'll handle file upload errors separately
        }
    });
}

// Collect all files and directories to upload
async function collectFiles(baseDir, relativePath = '', excludeFiles = []) {
    const fullPath = path.join(baseDir, relativePath);
    const entries = await readdir(fullPath, { withFileTypes: true });
    let result = [];
    
    // Add the current directory if it's not the base directory
    if (relativePath) {
        result.push({
            relativePath: relativePath,
            isDirectory: true
        });
    }
    
    for (const entry of entries) {
        // Skip excluded files/folders
        if (excludeFiles && excludeFiles.includes(entry.name)) {
            continue;
        }
        
        const entryRelativePath = path.join(relativePath, entry.name);
        
        if (entry.isDirectory()) {
            // Recursively collect files from subdirectory
            const subDirFiles = await collectFiles(baseDir, entryRelativePath, excludeFiles);
            result = result.concat(subDirFiles);
        } else {
            // Add file to the result
            result.push({
                relativePath: entryRelativePath,
                isDirectory: false
            });
        }
    }
    
    return result;
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
}; 
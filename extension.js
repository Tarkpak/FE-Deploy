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
    outputChannel.show();
    outputChannel.appendLine('===============================================');
    outputChannel.appendLine(`FE Deploy 扩展激活 - ${new Date().toLocaleString()}`);
    outputChannel.appendLine('===============================================');

    let disposable = vscode.commands.registerCommand('feDeploy.buildAndDeploy', async (fileUri) => {
        // 确保在每次执行命令时都显示输出通道
        outputChannel.show();
        outputChannel.appendLine('===============================================');
        outputChannel.appendLine(`开始构建和部署任务 - ${new Date().toLocaleString()}`);
        outputChannel.appendLine('===============================================');

        // If called from the editor context menu, fileUri might be undefined
        if (!fileUri) {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const fileName = path.basename(editor.document.uri.fsPath);
                outputChannel.appendLine(`当前活动编辑器文件: ${fileName}`);
                if (fileName.toLowerCase() === 'package.json') {
                    fileUri = editor.document.uri;
                    outputChannel.appendLine(`从编辑器选择的package.json: ${fileUri.fsPath}`);
                } else {
                    outputChannel.appendLine(`错误: 文件 ${fileName} 不是 package.json`);
                    vscode.window.showErrorMessage('This command can only be used with package.json files');
                    return;
                }
            } else {
                outputChannel.appendLine('错误: 没有活动的编辑器');
                vscode.window.showErrorMessage('No package.json file selected or open in editor');
                return;
            }
        } else {
            // If called from explorer context menu, check if it's a package.json file or folder
            outputChannel.appendLine(`从资源管理器选择的文件/文件夹: ${fileUri.fsPath}`);
            const fileStat = await vscode.workspace.fs.stat(fileUri);
            if (fileStat.type === vscode.FileType.Directory) {
                // It's a directory, check if it contains package.json
                outputChannel.appendLine(`选择的是目录，检查是否包含package.json`);
                const packageJsonUri = vscode.Uri.joinPath(fileUri, 'package.json');
                try {
                    await vscode.workspace.fs.stat(packageJsonUri);
                    // package.json exists, use it
                    fileUri = packageJsonUri;
                    outputChannel.appendLine(`找到package.json: ${fileUri.fsPath}`);
                } catch (e) {
                    // No package.json in the directory
                    outputChannel.appendLine(`错误: 目录中没有package.json: ${e.message}`);
                    vscode.window.showErrorMessage('No package.json found in the selected directory');
                    return;
                }
            } else {
                // It's a file, check if it's package.json
                const fileName = path.basename(fileUri.fsPath);
                outputChannel.appendLine(`选择的是文件: ${fileName}`);
                if (fileName.toLowerCase() !== 'package.json') {
                    outputChannel.appendLine(`错误: 选择的文件不是package.json`);
                    vscode.window.showErrorMessage('This command can only be used with package.json files');
                    return;
                }
            }
        }

        // Get the folder containing the package.json
        const projectFolder = path.dirname(fileUri.fsPath);
        outputChannel.appendLine(`项目文件夹路径: ${projectFolder}`);
        
        // Show a status bar message
        const projectName = path.basename(projectFolder);
        outputChannel.appendLine(`项目名称: ${projectName}`);
        const statusBarMessage = vscode.window.setStatusBarMessage(`Starting build and deploy for ${projectName}...`);
        
        try {
            // Load configuration - first from settings, then fall back to file
            outputChannel.appendLine('正在加载配置...');
            const config = getConfiguration();
            outputChannel.appendLine('配置加载完成:');
            outputChannel.appendLine(`- 构建命令: ${config.buildCommand}`);
            outputChannel.appendLine(`- 目标目录: ${config.targetDirectory}`);
            outputChannel.appendLine(`- 部署模式: ${config.deployMode}`);
            outputChannel.appendLine(`- 构建输出目录: ${config.buildOutputDir || '自动检测'}`);
            if (config.deployMode === 'ssh') {
                outputChannel.appendLine(`- SSH主机: ${config.ssh.host}:${config.ssh.port}`);
                outputChannel.appendLine(`- SSH用户: ${config.ssh.username}`);
                outputChannel.appendLine(`- SSH远程路径: ${config.ssh.remotePath}`);
                outputChannel.appendLine(`- SSH认证方式: ${config.ssh.privateKeyPath ? '私钥' : '密码'}`);
            }
            outputChannel.appendLine('deploy config: ' + JSON.stringify(config));
            
            // Show progress during build
            outputChannel.appendLine('开始构建项目...');
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Building project",
                cancellable: true
            }, async (progress, token) => {
                return new Promise((resolve, reject) => {
                    progress.report({ message: "Running build command..." });
                    outputChannel.appendLine(`执行构建命令: ${config.buildCommand}`);
                    outputChannel.appendLine(`工作目录: ${projectFolder}`);
                    
                    // Execute build command in the project folder
                    const buildProcess = exec(config.buildCommand, { cwd: projectFolder });
                    
                    buildProcess.stdout.on('data', (data) => {
                        outputChannel.appendLine(`Build stdout: ${data}`);
                    });
                    
                    buildProcess.stderr.on('data', (data) => {
                        outputChannel.appendLine(`Build stderr: ${data}`);
                    });
                    
                    buildProcess.on('error', (error) => {
                        outputChannel.appendLine(`构建出错: ${error.message}`);
                        vscode.window.showErrorMessage(`Build failed: ${error.message}`);
                        reject(error);
                    });
                    
                    buildProcess.on('close', (code) => {
                        if (code === 0) {
                            outputChannel.appendLine('构建完成，退出码: 0');
                            progress.report({ message: "Build completed successfully" });
                            resolve();
                        } else {
                            outputChannel.appendLine(`构建失败，退出码: ${code}`);
                            vscode.window.showErrorMessage(`Build process exited with code ${code}`);
                            reject(new Error(`Build process exited with code ${code}`));
                        }
                    });
                    
                    token.onCancellationRequested(() => {
                        outputChannel.appendLine('构建被用户取消');
                        buildProcess.kill();
                        vscode.window.showWarningMessage('Build cancelled');
                        reject(new Error('Build cancelled'));
                    });
                });
            });
            
            // Find the build output directory
            outputChannel.appendLine('查找构建输出目录...');
            let buildFolder;
            
            if (config.buildOutputDir) {
                // Use specified build output directory
                buildFolder = path.join(projectFolder, config.buildOutputDir);
                outputChannel.appendLine(`使用配置中指定的构建输出目录: ${buildFolder}`);
                if (!fs.existsSync(buildFolder)) {
                    outputChannel.appendLine(`错误: 指定的构建输出目录不存在: ${buildFolder}`);
                    vscode.window.showErrorMessage(`Build output directory "${config.buildOutputDir}" not found. Check your configuration.`);
                    return;
                }
            } else {
                // Try to automatically detect build output folder
                outputChannel.appendLine('未指定构建输出目录，尝试自动检测...');
                buildFolder = path.join(projectFolder, 'dist');
                outputChannel.appendLine(`尝试找dist目录: ${buildFolder}`);
                
                if (!fs.existsSync(buildFolder)) {
                    // Try common build output folders if dist doesn't exist
                    outputChannel.appendLine('dist目录不存在，尝试其他常用目录...');
                    const alternativeFolders = ['build', 'out', 'public'];
                    let folderFound = false;
                    
                    for (const folder of alternativeFolders) {
                        const altPath = path.join(projectFolder, folder);
                        outputChannel.appendLine(`检查目录: ${altPath}`);
                        if (fs.existsSync(altPath)) {
                            folderFound = true;
                            buildFolder = altPath;
                            outputChannel.appendLine(`找到输出目录: ${buildFolder}`);
                            break;
                        }
                    }
                    
                    if (!folderFound) {
                        outputChannel.appendLine('错误: 未找到任何可能的构建输出目录');
                        vscode.window.showErrorMessage('Could not find build output folder. Please specify it in settings.');
                        return;
                    }
                } else {
                    outputChannel.appendLine(`找到dist目录: ${buildFolder}`);
                }
            }

            // Show progress during deployment
            outputChannel.appendLine('开始部署项目...');
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Deploying project",
                cancellable: true
            }, async (progress, token) => {
                // Check deployment mode and execute appropriate deployment method
                if (config.deployMode === 'ssh') {
                    outputChannel.appendLine('使用SSH方式部署');
                    // Validate SSH configuration
                    if (!config.ssh || !config.ssh.host || !config.ssh.username) {
                        outputChannel.appendLine('错误: SSH配置不完整');
                        vscode.window.showErrorMessage('SSH configuration is incomplete. Please check your settings.');
                        return;
                    }
                    
                    // Check if either password or private key is provided
                    if (!config.ssh.password && !config.ssh.privateKeyPath) {
                        outputChannel.appendLine('错误: 未提供SSH认证方式(密码或私钥)');
                        vscode.window.showErrorMessage('SSH authentication is not configured. Please provide either a password or a private key path.');
                        return;
                    }
                    
                    // Deploy via SSH
                    outputChannel.appendLine(`开始通过SSH部署到: ${config.ssh.host}:${config.ssh.remotePath}`);
                    await deployViaSSH(buildFolder, config.ssh, config.excludeFiles, progress, token);
                    outputChannel.appendLine('SSH部署完成');
                    vscode.window.showInformationMessage(`Successfully deployed to ${config.ssh.host}:${config.ssh.remotePath}`);
                } else {
                    outputChannel.appendLine('使用本地复制方式部署');
                    // Local deployment (copy)
                    // Check if target directory exists, if not create it
                    try {
                        outputChannel.appendLine(`检查目标目录是否存在: ${config.targetDirectory}`);
                        await stat(config.targetDirectory);
                        outputChannel.appendLine('目标目录已存在');
                    } catch (err) {
                        outputChannel.appendLine(`目标目录不存在，正在创建: ${config.targetDirectory}`);
                        await mkdir(config.targetDirectory, { recursive: true });
                        outputChannel.appendLine(`目标目录创建成功: ${config.targetDirectory}`);
                        vscode.window.showInformationMessage(`Created target directory: ${config.targetDirectory}`);
                    }
                    
                    // Perform local deployment
                    outputChannel.appendLine(`开始将文件从 "${buildFolder}" 复制到 "${config.targetDirectory}"`);
                    await copyDirectory(buildFolder, config.targetDirectory, config.excludeFiles, progress, token);
                    outputChannel.appendLine('本地部署完成');
                    vscode.window.showInformationMessage(`Successfully deployed to ${config.targetDirectory}`);
                }
            });
            
            // Dispose of the status bar message
            statusBarMessage.dispose();
            outputChannel.appendLine('===============================================');
            outputChannel.appendLine(`部署任务完成 - ${new Date().toLocaleString()}`);
            outputChannel.appendLine('===============================================');
            
        } catch (error) {
            // Dispose of the status bar message on error
            statusBarMessage.dispose();
            outputChannel.appendLine(`错误: 部署失败 - ${error.message}`);
            outputChannel.appendLine(`错误堆栈: ${error.stack}`);
            outputChannel.appendLine('===============================================');
            outputChannel.appendLine(`部署任务失败 - ${new Date().toLocaleString()}`);
            outputChannel.appendLine('===============================================');
            vscode.window.showErrorMessage(`Deployment failed: ${error.message}`);
        }
    });

    context.subscriptions.push(disposable);
}

function getConfiguration() {
    outputChannel.appendLine('加载配置...');
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
        outputChannel.appendLine(`尝试从文件加载配置: ${configPath}`);
        if (fs.existsSync(configPath)) {
            fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            outputChannel.appendLine('成功从配置文件加载设置');
        } else {
            outputChannel.appendLine('配置文件不存在，使用默认配置或VSCode设置');
        }
    } catch (err) {
        outputChannel.appendLine('Error loading configuration file: ' + err);
    }
    
    // Merge configurations with VSCode settings taking precedence
    outputChannel.appendLine('合并配置...');
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
        outputChannel.appendLine(`创建目标目录: ${target}`);
        await mkdir(target, { recursive: true });
    }
    
    outputChannel.appendLine(`读取源目录内容: ${source}`);
    const entries = await readdir(source, { withFileTypes: true });
    
    let processed = 0;
    const total = entries.length;
    outputChannel.appendLine(`需要处理的文件/目录数: ${total}`);
    
    for (const entry of entries) {
        if (token.isCancellationRequested) {
            outputChannel.appendLine('复制操作被用户取消');
            throw new Error('Deployment cancelled');
        }
        
        const sourcePath = path.join(source, entry.name);
        const targetPath = path.join(target, entry.name);
        
        // Skip excluded files/folders
        if (excludeFiles && excludeFiles.includes(entry.name)) {
            outputChannel.appendLine(`跳过排除的文件/目录: ${entry.name}`);
            continue;
        }
        
        if (entry.isDirectory()) {
            outputChannel.appendLine(`处理子目录: ${entry.name}`);
            await copyDirectory(sourcePath, targetPath, excludeFiles, progress, token);
        } else {
            outputChannel.appendLine(`复制文件: ${sourcePath} -> ${targetPath}`);
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
    outputChannel.appendLine('开始SSH部署...');
    return new Promise((resolve, reject) => {
        const conn = new Client();
        
        // Prepare authentication
        outputChannel.appendLine('准备SSH认证...');
        const authConfig = {
            host: sshConfig.host,
            port: sshConfig.port,
            username: sshConfig.username
        };
        
        // Use either password or private key
        if (sshConfig.password) {
            outputChannel.appendLine('使用密码认证');
            authConfig.password = sshConfig.password;
        } else if (sshConfig.privateKeyPath) {
            outputChannel.appendLine(`使用私钥认证，读取私钥: ${sshConfig.privateKeyPath}`);
            readFile(sshConfig.privateKeyPath)
                .then(privateKey => {
                    authConfig.privateKey = privateKey;
                    if (sshConfig.passphrase) {
                        outputChannel.appendLine('私钥有密码保护');
                        authConfig.passphrase = sshConfig.passphrase;
                    }
                    // Connect after reading the key
                    outputChannel.appendLine('私钥读取成功，开始连接');
                    tryConnect();
                })
                .catch(err => {
                    outputChannel.appendLine(`读取私钥失败: ${err.message}`);
                    reject(new Error(`Failed to read private key: ${err.message}`));
                });
            return; // Return early and connect in the then() callback
        }
        
        // If we're using password auth, connect immediately
        tryConnect();
        
        function tryConnect() {
            outputChannel.appendLine(`正在连接到 ${sshConfig.host}:${sshConfig.port}...`);
            
            conn.on('ready', () => {
                outputChannel.appendLine('SSH connection established');
                progress.report({ message: 'SSH connection established' });
                
                // Get all files to upload
                outputChannel.appendLine('收集需要上传的文件...');
                collectFiles(sourceDir, '', excludeFiles)
                    .then(filesToUpload => {
                        const total = filesToUpload.length;
                        outputChannel.appendLine(`共有 ${total} 个文件/目录需要上传`);
                        let processed = 0;
                        
                        // Create SFTP session
                        outputChannel.appendLine('创建SFTP会话');
                        conn.sftp((err, sftp) => {
                            if (err) {
                                outputChannel.appendLine(`创建SFTP会话失败: ${err.message}`);
                                conn.end();
                                reject(new Error(`SFTP error: ${err.message}`));
                                return;
                            }
                            
                            // Create a queue to process files sequentially
                            const processQueue = () => {
                                if (filesToUpload.length === 0) {
                                    outputChannel.appendLine('所有文件处理完成，关闭连接');
                                    conn.end();
                                    resolve();
                                    return;
                                }
                                
                                if (token.isCancellationRequested) {
                                    outputChannel.appendLine('上传操作被用户取消');
                                    conn.end();
                                    reject(new Error('Deployment cancelled'));
                                    return;
                                }
                                
                                const file = filesToUpload.shift();
                                const localPath = path.join(sourceDir, file.relativePath);
                                const remotePath = path.posix.join(sshConfig.remotePath, file.relativePath.replace(/\\/g, '/'));
                                
                                if (file.isDirectory) {
                                    // Create remote directory
                                    outputChannel.appendLine(`创建远程目录: ${remotePath}`);
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
                                    outputChannel.appendLine(`确保远程目录存在: ${remoteDir}`);
                                    ensureRemoteDirectory(sftp, remoteDir, () => {
                                        // Upload file
                                        outputChannel.appendLine(`上传文件: ${localPath} -> ${remotePath}`);
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
                            outputChannel.appendLine('开始处理文件队列');
                            processQueue();
                        });
                    })
                    .catch(error => {
                        outputChannel.appendLine(`收集文件时出错: ${error.message}`);
                        conn.end();
                        reject(error);
                    });
            });
            
            conn.on('error', (err) => {
                outputChannel.appendLine(`SSH连接错误: ${err.message}`);
                reject(new Error(`SSH connection error: ${err.message}`));
            });
            
            conn.on('end', () => {
                outputChannel.appendLine('SSH连接结束');
            });
            
            // Connect to the server
            try {
                conn.connect(authConfig);
            } catch (err) {
                outputChannel.appendLine(`SSH连接失败: ${err.message}`);
                reject(new Error(`SSH connection failed: ${err.message}`));
            }
        }
    });
}

// Recursively ensure remote directories exist
function ensureRemoteDirectory(sftp, remotePath, callback) {
    outputChannel.appendLine(`确认远程目录: ${remotePath}`);
    sftp.mkdir(remotePath, (err) => {
        if (!err || err.code === 4) { // Code 4 is "Failure" which often means directory already exists
            outputChannel.appendLine(`目录已存在或创建成功: ${remotePath}`);
            callback();
        } else if (err.code === 2) { // Code 2 is "No such file" which means parent directory doesn't exist
            outputChannel.appendLine(`父目录不存在，递归创建: ${remotePath}`);
            const parentPath = path.posix.dirname(remotePath);
            ensureRemoteDirectory(sftp, parentPath, () => {
                sftp.mkdir(remotePath, (mkdirErr) => {
                    if (mkdirErr) {
                        outputChannel.appendLine(`创建目录出错: ${mkdirErr.message}`);
                    } else {
                        outputChannel.appendLine(`创建目录成功: ${remotePath}`);
                    }
                    callback(); // Continue even if there's an error, we'll handle file upload errors separately
                });
            });
        } else {
            outputChannel.appendLine(`创建目录时出错: ${err.message}`);
            callback(); // Continue with other errors, we'll handle file upload errors separately
        }
    });
}

// Collect all files and directories to upload
async function collectFiles(baseDir, relativePath = '', excludeFiles = []) {
    const fullPath = path.join(baseDir, relativePath);
    outputChannel.appendLine(`收集文件及目录: ${fullPath}`);
    const entries = await readdir(fullPath, { withFileTypes: true });
    let result = [];
    
    // Add the current directory if it's not the base directory
    if (relativePath) {
        outputChannel.appendLine(`添加目录: ${relativePath}`);
        result.push({
            relativePath: relativePath,
            isDirectory: true
        });
    }
    
    for (const entry of entries) {
        // Skip excluded files/folders
        if (excludeFiles && excludeFiles.includes(entry.name)) {
            outputChannel.appendLine(`跳过排除的文件/目录: ${entry.name}`);
            continue;
        }
        
        const entryRelativePath = path.join(relativePath, entry.name);
        
        if (entry.isDirectory()) {
            // Recursively collect files from subdirectory
            outputChannel.appendLine(`收集子目录: ${entryRelativePath}`);
            const subDirFiles = await collectFiles(baseDir, entryRelativePath, excludeFiles);
            result = result.concat(subDirFiles);
        } else {
            // Add file to the result
            outputChannel.appendLine(`添加文件: ${entryRelativePath}`);
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
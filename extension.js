const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const { Client } = require('ssh2');
const os = require('os');
const ftp = require('basic-ftp');
const archiver = require('archiver');

// Promisify filesystem operations
const copyFile = promisify(fs.copyFile);
const mkdir = promisify(fs.mkdir);
const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const chmod = promisify(fs.chmod);
const unlink = promisify(fs.unlink);
const execPromise = promisify(exec);

// Create output channel for logging
const outputChannel = vscode.window.createOutputChannel("FE Deploy");

// Log utility functions
const logger = {
  log: (message) => {
    outputChannel.appendLine(message);
  },
  error: (message, error) => {
    outputChannel.appendLine(`错误: ${message}`);
    if (error && error.message) {
      outputChannel.appendLine(`错误详情: ${error.message}`);
      if (error.stack) outputChannel.appendLine(`错误堆栈: ${error.stack}`);
    }
  },
  section: (title) => {
    outputChannel.appendLine('===============================================');
    outputChannel.appendLine(`${title} - ${new Date().toLocaleString()}`);
    outputChannel.appendLine('===============================================');
  }
};

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    console.log('FE Deploy extension is now active');
    outputChannel.show();
    logger.section('FE Deploy 扩展激活');

    // Register the build and deploy command
    let buildAndDeployCommand = vscode.commands.registerCommand('feDeploy.buildAndDeploy', async (fileUri) => {
        outputChannel.show();
        logger.section('开始构建和部署任务');

        try {
            // Validate and resolve package.json file
            fileUri = await resolvePackageJsonUri(fileUri);
            if (!fileUri) return;

            // Get the folder containing the package.json
            const projectFolder = path.dirname(fileUri.fsPath);
            const projectName = path.basename(projectFolder);
            logger.log(`项目文件夹路径: ${projectFolder}`);
            logger.log(`项目名称: ${projectName}`);
            
            // Show a status bar message
            const statusBarMessage = vscode.window.setStatusBarMessage(`Starting build and deploy for ${projectName}...`);

            try {
                // Load configuration
                logger.log('正在加载配置...');
                const config = getConfiguration();
                logConfiguration(config);

                // Build the project
                await buildProject(projectFolder, config);
                
                // Find the build output directory
                const buildFolder = await findBuildOutputDir(projectFolder, config);
                if (!buildFolder) return;

                // Deploy the build output
                await deployBuild(buildFolder, config);

                // Complete the deployment
                statusBarMessage.dispose();
                logger.section('部署任务完成');
                vscode.window.showInformationMessage(`${projectName} has been successfully built and deployed.`);
            } catch (error) {
                statusBarMessage.dispose();
                throw error;
            }
        } catch (error) {
            logger.error('部署失败', error);
            logger.section('部署任务失败');
            vscode.window.showErrorMessage(`Deployment failed: ${error.message}`);
        }
    });

    // Register the standalone deploy command
    let deployOnlyCommand = vscode.commands.registerCommand('feDeploy.deployOnly', async () => {
        outputChannel.show();
        logger.section('开始独立部署任务');

        try {
            // Load configuration
            const config = getConfiguration();
            logger.log('配置加载完成');

            // Ask user to select a directory to deploy
            const folders = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: 'Select Folder to Deploy',
                title: 'Select the build folder to deploy'
            });

            if (!folders || folders.length === 0) {
                logger.log('用户取消了部署文件夹选择');
                return;
            }

            const buildFolder = folders[0].fsPath;
            logger.log(`用户选择的部署文件夹: ${buildFolder}`);

            // Show status bar message
            const folderName = path.basename(buildFolder);
            const statusBarMessage = vscode.window.setStatusBarMessage(`Deploying ${folderName}...`);

            try {
                // Deploy the selected folder
                await deployBuild(buildFolder, config);

                // Clean up and show completion message
                statusBarMessage.dispose();
                logger.section('独立部署任务完成');
                vscode.window.showInformationMessage(`${folderName} has been successfully deployed.`);
            } catch (error) {
                statusBarMessage.dispose();
                throw error;
            }
        } catch (error) {
            logger.error('部署失败', error);
            logger.section('独立部署任务失败');
            vscode.window.showErrorMessage(`Deployment failed: ${error.message}`);
        }
    });

    context.subscriptions.push(buildAndDeployCommand, deployOnlyCommand);
}

/**
 * Validate and resolve a package.json file URI from different contexts
 */
async function resolvePackageJsonUri(fileUri) {
    // If called from the editor context menu, fileUri might be undefined
    if (!fileUri) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            logger.log('错误: 没有活动的编辑器');
            vscode.window.showErrorMessage('No package.json file selected or open in editor');
            return null;
        }
        
        const fileName = path.basename(editor.document.uri.fsPath);
        logger.log(`当前活动编辑器文件: ${fileName}`);
        
        if (fileName.toLowerCase() !== 'package.json') {
            logger.log(`错误: 文件 ${fileName} 不是 package.json`);
            vscode.window.showErrorMessage('This command can only be used with package.json files');
            return null;
        }
        
        return editor.document.uri;
    } 
    
    // If called from explorer context menu, check if it's a package.json file or folder
    logger.log(`从资源管理器选择的文件/文件夹: ${fileUri.fsPath}`);
    const fileStat = await vscode.workspace.fs.stat(fileUri);
    
    if (fileStat.type === vscode.FileType.Directory) {
        // It's a directory, check if it contains package.json
        logger.log(`选择的是目录，检查是否包含package.json`);
        const packageJsonUri = vscode.Uri.joinPath(fileUri, 'package.json');
        
        try {
            await vscode.workspace.fs.stat(packageJsonUri);
            // package.json exists, use it
            logger.log(`找到package.json: ${packageJsonUri.fsPath}`);
            return packageJsonUri;
        } catch (e) {
            // No package.json in the directory
            logger.error('目录中没有package.json', e);
            vscode.window.showErrorMessage('No package.json found in the selected directory');
            return null;
        }
    } else {
        // It's a file, check if it's package.json
        const fileName = path.basename(fileUri.fsPath);
        logger.log(`选择的是文件: ${fileName}`);
        
        if (fileName.toLowerCase() !== 'package.json') {
            logger.log(`错误: 选择的文件不是package.json`);
            vscode.window.showErrorMessage('This command can only be used with package.json files');
            return null;
        }
        
        return fileUri;
    }
}

/**
 * Build the project
 */
async function buildProject(projectFolder, config) {
    logger.log('开始构建项目...');
    
    return await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Building project",
        cancellable: true
    }, async (progress, token) => {
        return new Promise((resolve, reject) => {
            progress.report({ message: "Running build command..." });
            logger.log(`执行构建命令: ${config.buildCommand}`);
            logger.log(`工作目录: ${projectFolder}`);

            // Execute build command in the project folder
            const buildProcess = exec(config.buildCommand, { cwd: projectFolder });

            buildProcess.stdout.on('data', (data) => {
                logger.log(`Build stdout: ${data}`);
            });

            buildProcess.stderr.on('data', (data) => {
                logger.log(`Build stderr: ${data}`);
            });

            buildProcess.on('error', (error) => {
                logger.error('构建出错', error);
                vscode.window.showErrorMessage(`Build failed: ${error.message}`);
                reject(error);
            });

            buildProcess.on('close', (code) => {
                if (code === 0) {
                    logger.log('构建完成，退出码: 0');
                    progress.report({ message: "Build completed successfully" });
                    resolve();
                } else {
                    logger.log(`构建失败，退出码: ${code}`);
                    vscode.window.showErrorMessage(`Build process exited with code ${code}`);
                    reject(new Error(`Build process exited with code ${code}`));
                }
            });

            token.onCancellationRequested(() => {
                logger.log('构建被用户取消');
                buildProcess.kill();
                vscode.window.showWarningMessage('Build cancelled');
                reject(new Error('Build cancelled'));
            });
        });
    });
}

/**
 * Find the build output directory
 */
async function findBuildOutputDir(projectFolder, config) {
    logger.log('查找构建输出目录...');
    let buildFolder;

    if (config.buildOutputDir) {
        // Use specified build output directory
        buildFolder = path.join(projectFolder, config.buildOutputDir);
        logger.log(`使用配置中指定的构建输出目录: ${buildFolder}`);
        
        if (!fs.existsSync(buildFolder)) {
            logger.log(`错误: 指定的构建输出目录不存在: ${buildFolder}`);
            vscode.window.showErrorMessage(`Build output directory "${config.buildOutputDir}" not found. Check your configuration.`);
            return null;
        }
    } else {
        // Try to automatically detect build output folder
        logger.log('未指定构建输出目录，尝试自动检测...');
        const commonOutputDirs = ['dist', 'build', 'out', 'public'];
        let folderFound = false;

        for (const folder of commonOutputDirs) {
            const possiblePath = path.join(projectFolder, folder);
            logger.log(`检查目录: ${possiblePath}`);
            
            if (fs.existsSync(possiblePath)) {
                folderFound = true;
                buildFolder = possiblePath;
                logger.log(`找到输出目录: ${buildFolder}`);
                break;
            }
        }

        if (!folderFound) {
            logger.log('错误: 未找到任何可能的构建输出目录');
            vscode.window.showErrorMessage('Could not find build output folder. Please specify it in settings.');
            return null;
        }
    }
    
    return buildFolder;
}

/**
 * Log configuration details to output channel
 */
function logConfiguration(config) {
    logger.log('配置加载完成:');
    logger.log(`- 构建命令: ${config.buildCommand}`);
    logger.log(`- 目标目录: ${config.targetDirectory}`);
    logger.log(`- 部署模式: ${config.deployMode}`);
    logger.log(`- 构建输出目录: ${config.buildOutputDir || '自动检测'}`);
    
    if (config.deployMode === 'ssh') {
        logger.log(`- SSH主机: ${config.ssh.host}:${config.ssh.port}`);
        logger.log(`- SSH用户: ${config.ssh.username}`);
        logger.log(`- SSH远程路径: ${config.ssh.remotePath}`);
        logger.log(`- SSH认证方式: ${config.ssh.privateKeyPath ? '私钥' : '密码'}`);
    } else if (config.deployMode === 'ftp') {
        logger.log(`- FTP主机: ${config.ftp.host}:${config.ftp.port}`);
        logger.log(`- FTP用户: ${config.ftp.username}`);
        logger.log(`- FTP远程路径: ${config.ftp.remotePath}`);
        logger.log(`- FTP安全连接: ${config.ftp.secure ? '是' : '否'}`);
    }
    
    logger.log('完整配置: ' + JSON.stringify(config, null, 2));
}

/**
 * Get extension configuration from VSCode settings and local config file
 */
function getConfiguration() {
    logger.log('加载配置...');
    const config = vscode.workspace.getConfiguration('feDeploy');
    
    // Default configuration
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
        },
        ftp: {
            host: '',
            port: 21,
            username: '',
            password: '',
            remotePath: '/',
            secure: false
        }
    };

    // Try to load from local config file
    let fileConfig = {};
    try {
        const configPath = path.join(__dirname, 'deploy-config.json');
        logger.log(`尝试从文件加载配置: ${configPath}`);
        
        if (fs.existsSync(configPath)) {
            fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            logger.log('成功从配置文件加载设置');
        } else {
            logger.log('配置文件不存在，使用默认配置或VSCode设置');
        }
    } catch (err) {
        logger.error('加载配置文件失败', err);
    }

    // Helper function to get configuration with fallbacks
    const getConfigValue = (key, subKey) => {
        if (subKey) {
            return config.get(`${key}.${subKey}`) || 
                   (fileConfig[key] && fileConfig[key][subKey]) || 
                   defaultConfig[key][subKey];
        }
        return config.get(key) || fileConfig[key] || defaultConfig[key];
    };

    // Build configuration object
    logger.log('合并配置...');
    return {
        buildCommand: getConfigValue('buildCommand'),
        targetDirectory: getConfigValue('targetDirectory'),
        deployMode: getConfigValue('deployMode'),
        excludeFiles: getConfigValue('excludeFiles'),
        buildOutputDir: getConfigValue('buildOutputDir'),
        ssh: {
            host: getConfigValue('ssh', 'host'),
            port: getConfigValue('ssh', 'port'),
            username: getConfigValue('ssh', 'username'),
            password: getConfigValue('ssh', 'password'),
            privateKeyPath: getConfigValue('ssh', 'privateKeyPath'),
            passphrase: getConfigValue('ssh', 'passphrase'),
            remotePath: getConfigValue('ssh', 'remotePath')
        },
        ftp: {
            host: getConfigValue('ftp', 'host'),
            port: getConfigValue('ftp', 'port'),
            username: getConfigValue('ftp', 'username'),
            password: getConfigValue('ftp', 'password'),
            remotePath: getConfigValue('ftp', 'remotePath'),
            secure: getConfigValue('ftp', 'secure')
        }
    };
}

/**
 * Copy directory recursively from source to target
 */
async function copyDirectory(source, target, excludeFiles, progress, token) {
    // Create target directory if it doesn't exist
    if (!fs.existsSync(target)) {
        logger.log(`创建目标目录: ${target}`);
        await mkdir(target, { recursive: true });
    }

    logger.log(`读取源目录内容: ${source}`);
    const entries = await readdir(source, { withFileTypes: true });

    let processed = 0;
    const total = entries.length;
    logger.log(`需要处理的文件/目录数: ${total}`);

    for (const entry of entries) {
        if (token.isCancellationRequested) {
            logger.log('复制操作被用户取消');
            throw new Error('Deployment cancelled');
        }

        const sourcePath = path.join(source, entry.name);
        const targetPath = path.join(target, entry.name);

        // Skip excluded files/folders
        if (excludeFiles && excludeFiles.includes(entry.name)) {
            logger.log(`跳过排除的文件/目录: ${entry.name}`);
            continue;
        }

        if (entry.isDirectory()) {
            logger.log(`处理子目录: ${entry.name}`);
            await copyDirectory(sourcePath, targetPath, excludeFiles, progress, token);
        } else {
            logger.log(`复制文件: ${sourcePath} -> ${targetPath}`);
            await copyFile(sourcePath, targetPath);
        }

        processed++;
        progress.report({
            message: `Copying files... (${processed}/${total})`,
            increment: (1 / total) * 100
        });
    }
}

/**
 * Main deployment function that chooses the appropriate deployment method
 */
async function deployBuild(buildFolder, config) {
    // Show progress during deployment
    logger.log('开始部署项目...');
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Deploying project",
        cancellable: true
    }, async (progress, token) => {
        // Check deployment mode and execute appropriate deployment method
        if (config.deployMode === 'ssh') {
            logger.log('使用SSH方式部署');
            // Validate SSH configuration
            if (!config.ssh || !config.ssh.host || !config.ssh.username) {
                logger.log('错误: SSH配置不完整');
                vscode.window.showErrorMessage('SSH configuration is incomplete. Please check your settings.');
                return;
            }

            // Check if either password or private key is provided
            if (!config.ssh.password && !config.ssh.privateKeyPath) {
                logger.log('错误: 未提供SSH认证方式(密码或私钥)');
                vscode.window.showErrorMessage('SSH authentication is not configured. Please provide either a password or a private key path.');
                return;
            }

            // Deploy via SSH
            logger.log(`开始通过SSH部署到: ${config.ssh.host}:${config.ssh.remotePath}`);
            await deployViaSSH(buildFolder, config.ssh, config.excludeFiles, progress, token);
            logger.log('SSH部署完成');
            vscode.window.showInformationMessage(`Successfully deployed to ${config.ssh.host}:${config.ssh.remotePath}`);
        } else if (config.deployMode === 'ftp') {
            logger.log('使用FTP方式部署');
            // Validate FTP configuration
            if (!config.ftp || !config.ftp.host || !config.ftp.username || !config.ftp.password) {
                logger.log('错误: FTP配置不完整');
                vscode.window.showErrorMessage('FTP configuration is incomplete. Please check your settings.');
                return;
            }

            // Deploy via FTP
            logger.log(`开始通过FTP部署到: ${config.ftp.host}:${config.ftp.remotePath}`);
            await deployViaFTP(buildFolder, config.ftp, config.excludeFiles, progress, token);
            logger.log('FTP部署完成');
            vscode.window.showInformationMessage(`Successfully deployed to ${config.ftp.host}:${config.ftp.remotePath}`);
        } else {
            logger.log('使用本地复制方式部署');
            // Local deployment (copy)
            // Check if target directory exists, if not create it
            try {
                logger.log(`检查目标目录是否存在: ${config.targetDirectory}`);
                await stat(config.targetDirectory);
                logger.log('目标目录已存在');
            } catch (err) {
                logger.log(`目标目录不存在，正在创建: ${config.targetDirectory}`);
                await mkdir(config.targetDirectory, { recursive: true });
                logger.log(`目标目录创建成功: ${config.targetDirectory}`);
                vscode.window.showInformationMessage(`Created target directory: ${config.targetDirectory}`);
            }

            // Perform local deployment
            logger.log(`开始将文件从 "${buildFolder}" 复制到 "${config.targetDirectory}"`);
            await copyDirectory(buildFolder, config.targetDirectory, config.excludeFiles, progress, token);
            logger.log('本地部署完成');
            vscode.window.showInformationMessage(`Successfully deployed to ${config.targetDirectory}`);
        }
    });
}

/**
 * Deploy via SSH using SCP and ZIP compression
 */
async function deployViaSSH(sourceDir, sshConfig, excludeFiles, progress, token) {
    logger.log('开始SSH部署(使用SCP压缩包上传方式)...');
    return new Promise((resolve, reject) => {
        (async () => {
            try {
                // Create a temporary zip file
                const tempDir = path.join(os.tmpdir(), 'fe-deploy-temp');
                const zipFileName = `deploy-${Date.now()}.zip`;
                const localZipPath = path.join(tempDir, zipFileName);
                const remoteZipPath = path.posix.join(sshConfig.remotePath, zipFileName);
                
                logger.log(`创建临时目录: ${tempDir}`);
                if (!fs.existsSync(tempDir)) {
                    await mkdir(tempDir, { recursive: true });
                }
                
                // Create zip file using archiver
                logger.log(`创建压缩包: ${localZipPath}`);
                progress.report({ message: 'Creating zip archive...' });
                
                // Create output stream
                const output = fs.createWriteStream(localZipPath);
                const archive = archiver('zip', {
                    zlib: { level: 9 } // Maximum compression
                });
                
                // Listen for all archive data to be written
                const closePromise = new Promise((resolveClose, rejectClose) => {
                    output.on('close', () => {
                        const fileSize = archive.pointer();
                        logger.log(`压缩完成，文件大小: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);
                        resolveClose();
                    });
                    
                    archive.on('error', (err) => {
                        logger.error('压缩过程出错', err);
                        rejectClose(err);
                    });
                });
                
                // Pipe archive data to the file
                archive.pipe(output);
                
                // Add files to the archive
                logger.log('添加文件到压缩包...');
                const entries = await readdir(sourceDir, { withFileTypes: true });
                
                for (const entry of entries) {
                    if (token.isCancellationRequested) {
                        logger.log('压缩操作被用户取消');
                        throw new Error('Deployment cancelled');
                    }
                    
                    // Skip excluded files/folders
                    if (excludeFiles && excludeFiles.includes(entry.name)) {
                        logger.log(`跳过排除的文件/目录: ${entry.name}`);
                        continue;
                    }
                    
                    const entryPath = path.join(sourceDir, entry.name);
                    
                    if (entry.isDirectory()) {
                        logger.log(`添加目录到压缩包: ${entry.name}`);
                        archive.directory(entryPath, entry.name);
                    } else {
                        logger.log(`添加文件到压缩包: ${entry.name}`);
                        archive.file(entryPath, { name: entry.name });
                    }
                }
                
                // Finalize the archive
                await archive.finalize();
                await closePromise;
                
                // Connect to SSH
                logger.log('准备SSH连接...');
                progress.report({ message: 'Connecting to SSH server...' });
                
                const conn = new Client();
                
                // Prepare authentication
                const authConfig = {
                    host: sshConfig.host,
                    port: sshConfig.port,
                    username: sshConfig.username
                };
                
                // Use either password or private key
                if (sshConfig.password) {
                    logger.log('使用密码认证');
                    authConfig.password = sshConfig.password;
                } else if (sshConfig.privateKeyPath) {
                    logger.log(`使用私钥认证，读取私钥: ${sshConfig.privateKeyPath}`);
                    const privateKey = await readFile(sshConfig.privateKeyPath);
                    authConfig.privateKey = privateKey;
                    if (sshConfig.passphrase) {
                        logger.log('私钥有密码保护');
                        authConfig.passphrase = sshConfig.passphrase;
                    }
                }
                
                // Connect to SSH server
                await new Promise((resolveConn, rejectConn) => {
                    conn.on('ready', () => {
                        logger.log('SSH连接成功');
                        resolveConn();
                    });
                    
                    conn.on('error', (err) => {
                        logger.error('SSH连接错误', err);
                        rejectConn(err);
                    });
                    
                    conn.connect(authConfig);
                });
                
                // Ensure remote directory exists before upload
                logger.log(`确保远程目录存在: ${sshConfig.remotePath}`);
                progress.report({ message: 'Checking remote directory...' });
                
                try {
                    await new Promise((resolveDir, rejectDir) => {
                        // Create directory with parents (-p)
                        conn.exec(`mkdir -p ${sshConfig.remotePath}`, (err, stream) => {
                            if (err) {
                                logger.error('创建远程目录失败', err);
                                rejectDir(err);
                                return;
                            }
                            
                            stream.on('data', (data) => {
                                logger.log(`目录创建输出: ${data}`);
                            });
                            
                            stream.stderr.on('data', (data) => {
                                logger.log(`目录创建错误: ${data}`);
                            });
                            
                            stream.on('close', (code) => {
                                if (code === 0) {
                                    logger.log('远程目录创建/确认成功');
                                    resolveDir();
                                } else {
                                    const errorMsg = `目录创建命令退出码: ${code}`;
                                    logger.log(errorMsg);
                                    rejectDir(new Error(errorMsg));
                                }
                            });
                        });
                    });
                } catch (dirErr) {
                    logger.error('创建远程目录出错', dirErr);
                    throw new Error(`Failed to create remote directory: ${dirErr.message}`);
                }
                
                // Upload file using SCP
                logger.log(`使用SCP命令行上传压缩包到服务器: ${localZipPath} -> ${remoteZipPath}`);
                progress.report({ message: 'Uploading zip archive via SCP command...' });
                
                // Build SCP command - without sshpass
                let scpCommand = '';
                let expectScriptPath = '';
                
                if (sshConfig.privateKeyPath) {
                    // Use private key authentication
                    scpCommand = `scp -P ${sshConfig.port} -i "${sshConfig.privateKeyPath}" -o "StrictHostKeyChecking=no" "${localZipPath}" ${sshConfig.username}@${sshConfig.host}:${remoteZipPath}`;
                } else {
                    // Password-based auth without sshpass - will prompt for password
                    // Create an expect script to handle the password prompt
                    expectScriptPath = path.join(tempDir, 'scp_script.exp');
                    const expectScript = `#!/usr/bin/expect -f
spawn scp -P ${sshConfig.port} -o "StrictHostKeyChecking=no" "${localZipPath}" ${sshConfig.username}@${sshConfig.host}:${remoteZipPath}
expect "password:"
send "${sshConfig.password}\\r"
expect eof
`;
                    
                    try {
                        // Check if expect is installed
                        await execPromise('expect -v');
                        
                        // Write the expect script
                        await writeFile(expectScriptPath, expectScript);
                        await chmod(expectScriptPath, '755');
                        
                        // Use expect script
                        scpCommand = expectScriptPath;
                        logger.log('使用expect脚本处理密码认证');
                    } catch (expectErr) {
                        // Expect is not installed, use basic scp command
                        logger.log('expect未安装，使用基本SCP命令，可能需要手动输入密码');
                        scpCommand = `scp -P ${sshConfig.port} -o "StrictHostKeyChecking=no" "${localZipPath}" ${sshConfig.username}@${sshConfig.host}:${remoteZipPath}`;
                        vscode.window.showWarningMessage('SCP will prompt for password. Please enter it in the terminal when prompted.');
                    }
                }
                
                const redactedCommand = scpCommand.includes('expect') ? 
                    'Using expect script for password authentication' : 
                    scpCommand.replace(sshConfig.password || '', '******');
                logger.log(`执行SCP命令: ${redactedCommand}`);
                
                try {
                    const { stdout, stderr } = await execPromise(scpCommand);
                    if (stdout) logger.log(`SCP输出: ${stdout}`);
                    if (stderr) logger.log(`SCP错误: ${stderr}`);
                    logger.log('压缩包上传成功');
                    
                    // Clean up expect script if used
                    if (expectScriptPath && fs.existsSync(expectScriptPath)) {
                        await unlink(expectScriptPath);
                    }
                } catch (scpErr) {
                    logger.error('SCP上传失败', scpErr);
                    if (expectScriptPath && fs.existsSync(expectScriptPath)) {
                        await unlink(expectScriptPath);
                    }
                    throw scpErr;
                }
                
                // Extract zip file on remote server
                logger.log('在服务器上解压文件...');
                progress.report({ message: 'Extracting files on server...' });
                
                await new Promise((resolveExtract, rejectExtract) => {
                    let command = `cd ${sshConfig.remotePath} && unzip -o ${zipFileName}`;
                    
                    // Add cleanup of zip file at the end
                    command += ` && rm ${zipFileName}`;

                    conn.exec(command, (err, stream) => {
                        if (err) {
                            logger.error('执行解压命令失败', err);
                            rejectExtract(err);
                            return;
                        }
                        
                        stream.on('data', (data) => {
                            logger.log(`解压输出: ${data}`);
                        });
                        
                        stream.stderr.on('data', (data) => {
                            logger.log(`解压错误: ${data}`);
                        });
                        
                        stream.on('close', (code) => {
                            if (code === 0) {
                                logger.log('文件解压成功');
                                resolveExtract();
                            } else {
                                const errorMsg = `解压命令退出码: ${code}`;
                                logger.log(errorMsg);
                                rejectExtract(new Error(errorMsg));
                            }
                        });
                    });
                });
                
                // Clean up local temp file
                logger.log(`清理本地临时文件: ${localZipPath}`);
                await unlink(localZipPath);
                
                // Close SSH connection
                conn.end();
                logger.log('SSH部署完成');
                resolve();
                
            } catch (error) {
                logger.error('SSH部署失败', error);
                reject(error);
            }
        })();
    });
}

/**
 * Deploy via FTP
 */
async function deployViaFTP(sourceDir, ftpConfig, excludeFiles, progress, token) {
    logger.log('开始FTP部署...');
    return new Promise((resolve, reject) => {
        (async () => {
            try {
                // Create a temporary zip file
                const tempDir = path.join(os.tmpdir(), 'fe-deploy-temp');
                const zipFileName = `deploy-${Date.now()}.zip`;
                const localZipPath = path.join(tempDir, zipFileName);
                const remoteZipPath = path.posix.join(ftpConfig.remotePath, zipFileName);

                logger.log(`创建临时目录: ${tempDir}`);
                if (!fs.existsSync(tempDir)) {
                    await mkdir(tempDir, { recursive: true });
                }

                // Create zip file using archiver
                logger.log(`创建压缩包: ${localZipPath}`);
                progress.report({ message: 'Creating zip archive...' });

                // Create output stream
                const output = fs.createWriteStream(localZipPath);
                const archive = archiver('zip', {
                    zlib: { level: 9 } // Maximum compression
                });

                // Listen for all archive data to be written
                const closePromise = new Promise((resolveClose, rejectClose) => {
                    output.on('close', () => {
                        const fileSize = archive.pointer();
                        logger.log(`压缩完成，文件大小: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);
                        resolveClose();
                    });

                    archive.on('error', (err) => {
                        logger.error('压缩过程出错', err);
                        rejectClose(err);
                    });
                });

                // Pipe archive data to the file
                archive.pipe(output);

                // Add files to the archive
                logger.log('添加文件到压缩包...');
                const entries = await readdir(sourceDir, { withFileTypes: true });

                for (const entry of entries) {
                    if (token.isCancellationRequested) {
                        logger.log('压缩操作被用户取消');
                        throw new Error('Deployment cancelled');
                    }

                    // Skip excluded files/folders
                    if (excludeFiles && excludeFiles.includes(entry.name)) {
                        logger.log(`跳过排除的文件/目录: ${entry.name}`);
                        continue;
                    }

                    const entryPath = path.join(sourceDir, entry.name);

                    if (entry.isDirectory()) {
                        logger.log(`添加目录到压缩包: ${entry.name}`);
                        archive.directory(entryPath, entry.name);
                    } else {
                        logger.log(`添加文件到压缩包: ${entry.name}`);
                        archive.file(entryPath, { name: entry.name });
                    }
                }

                // Finalize the archive
                await archive.finalize();
                await closePromise;

                // Connect to FTP server and upload zip file
                logger.log('准备FTP连接...');
                progress.report({ message: 'Connecting to FTP server...' });

                const client = new ftp.Client();
                client.ftp.verbose = true; // Enable verbose logging

                try {
                    // Set connection timeout
                    client.setTimeout(30000); // 30 seconds

                    // Configure connection
                    if (ftpConfig.secure) {
                        logger.log('使用安全FTP连接 (FTPS)');
                        await client.access({
                            host: ftpConfig.host,
                            port: ftpConfig.port,
                            user: ftpConfig.username,
                            password: ftpConfig.password,
                            secure: true,
                            secureOptions: { rejectUnauthorized: false } // Accept self-signed certificates
                        });
                    } else {
                        logger.log('使用标准FTP连接');
                        await client.access({
                            host: ftpConfig.host,
                            port: ftpConfig.port,
                            user: ftpConfig.username,
                            password: ftpConfig.password
                        });
                    }

                    logger.log('FTP连接成功');

                    // Navigate to remote directory
                    logger.log(`切换到远程目录: ${ftpConfig.remotePath}`);
                    await client.ensureDir(ftpConfig.remotePath);

                    // Upload zip file
                    logger.log(`上传压缩包到FTP服务器: ${localZipPath} -> ${remoteZipPath}`);
                    progress.report({ message: 'Uploading zip archive via FTP...' });
                    await client.uploadFrom(localZipPath, zipFileName);

                    logger.log('压缩包上传成功');

                    // Note about manual extraction
                    logger.log('警告: FTP方式上传仅上传压缩包，无法自动解压。请在服务器手动解压，或考虑上传未压缩文件。');
                    vscode.window.showWarningMessage('FTP upload completed. The zip file must be manually extracted on the server.');

                    // Close FTP connection
                    client.close();
                    logger.log('FTP连接已关闭');

                } catch (ftpErr) {
                    logger.error('FTP操作失败', ftpErr);
                    if (client.closed !== true) {
                        client.close();
                        logger.log('FTP连接已关闭');
                    }
                    throw ftpErr;
                }

                // Clean up local temp file
                logger.log(`清理本地临时文件: ${localZipPath}`);
                await unlink(localZipPath);

                logger.log('FTP部署完成');
                resolve();

            } catch (error) {
                logger.error('FTP部署失败', error);
                reject(error);
            }
        })();
    });
}

function deactivate() { }

module.exports = {
    activate,
    deactivate
}; 
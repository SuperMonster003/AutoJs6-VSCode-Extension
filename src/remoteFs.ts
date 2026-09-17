import * as path from 'path';
import * as vscode from 'vscode';
import { Device, DeviceError, Devices } from './device';
import { FEATURE, FS_CHUNK_SIZE, joinRemotePath, remoteBasename, remoteDirname, RemoteEntry, RemoteRoots, RemoteStat } from './protocol';
import { logDebug, logError } from './logger';
import { formatSize, formatTimestamp } from './util';
import { confirm, promptInput, showPick } from './ui';
import { t } from './i18n';

export const REMOTE_SCHEME = 'autojs6fs';

/** Build an `autojs6fs://<deviceId>/<path>` URI. zh-CN: 构造远程文件 URI. */
export function remoteUri(device: Device, remotePath: string): vscode.Uri {
    return vscode.Uri.from({ scheme: REMOTE_SCHEME, authority: encodeURIComponent(device.deviceId), path: remotePath.startsWith('/') ? remotePath : '/' + remotePath });
}

export function deviceIdOfUri(uri: vscode.Uri): string {
    return decodeURIComponent(uri.authority);
}

/**
 * Exposes device storage as a VSCode file system so remote files open, edit and save in place (roadmap 5.4).
 * zh-CN: 将设备存储暴露为 VSCode 文件系统, 远程文件可直接打开, 编辑并保存 (roadmap 5.4).
 */
export class RemoteFileSystemProvider implements vscode.FileSystemProvider {

    private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this.emitter.event;

    constructor(private readonly devices: Devices) {
    }

    fireChanged(uri: vscode.Uri, type: vscode.FileChangeType = vscode.FileChangeType.Changed) {
        this.emitter.fire([ { type, uri } ]);
    }

    private device(uri: vscode.Uri): Device {
        const id = deviceIdOfUri(uri);
        const device = this.devices.getDevice(id);
        if (!device || !device.isConnected) {
            throw vscode.FileSystemError.Unavailable(t('Device not connected: {0}', id));
        }
        if (!device.supportsRequests) {
            throw vscode.FileSystemError.Unavailable(t('AutoJs6 {0} does not support remote file management; please upgrade AutoJs6', device.versionName));
        }
        return device;
    }

    private static translate(e: any, uri: vscode.Uri): Error {
        if (e instanceof vscode.FileSystemError) return e;
        const message = String(e?.message || e);
        if (/not found|no such|不存在/i.test(message)) return vscode.FileSystemError.FileNotFound(uri);
        if (/exists|已存在/i.test(message)) return vscode.FileSystemError.FileExists(uri);
        if (/is a directory|是目录/i.test(message)) return vscode.FileSystemError.FileIsADirectory(uri);
        if (/not a directory|不是目录/i.test(message)) return vscode.FileSystemError.FileNotADirectory(uri);
        if (/denied|拒绝/i.test(message)) return vscode.FileSystemError.NoPermissions(uri);
        return vscode.FileSystemError.Unavailable(message);
    }

    watch(): vscode.Disposable {
        return new vscode.Disposable(() => { /* Polling is not supported. zh-CN: 不支持轮询监听. */ });
    }

    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        const device = this.device(uri);
        try {
            const stat = await device.request<RemoteStat>('fs.stat', { path: uri.path });
            if (!stat.exists) {
                throw vscode.FileSystemError.FileNotFound(uri);
            }
            return {
                type: stat.type === 'directory' ? vscode.FileType.Directory : vscode.FileType.File,
                ctime: stat.mtime || 0,
                mtime: stat.mtime || 0,
                size: stat.size || 0,
            };
        } catch (e) {
            throw RemoteFileSystemProvider.translate(e, uri);
        }
    }

    async readDirectory(uri: vscode.Uri): Promise<[ string, vscode.FileType ][]> {
        const device = this.device(uri);
        try {
            const result = await device.request<{ entries: RemoteEntry[] }>('fs.list', { path: uri.path });
            return result.entries.map(e => [ e.name, e.type === 'directory' ? vscode.FileType.Directory : vscode.FileType.File ]);
        } catch (e) {
            throw RemoteFileSystemProvider.translate(e, uri);
        }
    }

    async createDirectory(uri: vscode.Uri): Promise<void> {
        const device = this.device(uri);
        try {
            await device.request('fs.mkdir', { path: uri.path });
            this.fireChanged(uri, vscode.FileChangeType.Created);
        } catch (e) {
            throw RemoteFileSystemProvider.translate(e, uri);
        }
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const device = this.device(uri);
        try {
            if (device.hasFeature(FEATURE.FS_CHUNKED)) {
                const stat = await device.request<{ size: number }>('fs.stat', { path: uri.path });
                if (stat.size > FS_CHUNK_SIZE) {
                    return await this.readChunked(device, uri, stat.size);
                }
            }
            const result = await device.request<{ content: string; encoding: string }>('fs.read', { path: uri.path, encoding: 'base64' }, 120_000);
            return Buffer.from(result.content || '', result.encoding === 'base64' ? 'base64' : 'utf8');
        } catch (e) {
            throw RemoteFileSystemProvider.translate(e, uri);
        }
    }

    /**
     * Read a large file in `FS_CHUNK_SIZE` pieces with a cancellable progress notification (roadmap 5.8).
     * zh-CN: 以 `FS_CHUNK_SIZE` 为单位分块读取大文件, 带可取消的进度提示 (roadmap 5.8).
     */
    private async readChunked(device: Device, uri: vscode.Uri, size: number): Promise<Uint8Array> {
        const name = remoteBasename(uri.path);
        const title = t('Reading {0} from {1} ({2})', name, device.name, formatSize(size));
        return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, token) => {
            const chunks: Buffer[] = [];
            let offset = 0;
            let reported = 0;
            while (offset < size) {
                if (token.isCancellationRequested) {
                    throw new DeviceError(t('Reading {0} was cancelled', name), device);
                }
                const result = await device.request<{ content: string; encoding: string; eof?: boolean }>('fs.read', { path: uri.path, encoding: 'base64', offset, length: FS_CHUNK_SIZE }, 120_000);
                const chunk = Buffer.from(result.content || '', result.encoding === 'base64' ? 'base64' : 'utf8');
                if (chunk.length === 0) {
                    break;
                }
                chunks.push(chunk);
                offset += chunk.length;
                const percent = Math.min(100, Math.floor(offset * 100 / size));
                progress.report({ message: `${percent}%`, increment: percent - reported });
                reported = percent;
                if (result.eof) {
                    break;
                }
            }
            return Buffer.concat(chunks);
        });
    }

    async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
        const device = this.device(uri);
        try {
            if (content.length > FS_CHUNK_SIZE && device.hasFeature(FEATURE.FS_CHUNKED)) {
                await this.writeChunked(device, uri, Buffer.from(content), options);
            } else {
                await device.request('fs.write', {
                    path: uri.path,
                    content: Buffer.from(content).toString('base64'),
                    encoding: 'base64',
                    create: options.create,
                    overwrite: options.overwrite,
                    mkdirs: true,
                }, 120_000);
            }
            this.fireChanged(uri);
        } catch (e) {
            throw RemoteFileSystemProvider.translate(e, uri);
        }
    }

    /**
     * Write a large file in pieces: the first piece replaces the file, the following ones append (roadmap 5.8).
     * zh-CN: 分块写入大文件: 首块覆盖文件, 后续块追加 (roadmap 5.8).
     */
    private async writeChunked(device: Device, uri: vscode.Uri, content: Buffer, options: { create: boolean; overwrite: boolean }): Promise<void> {
        const name = remoteBasename(uri.path);
        const title = t('Writing {0} to {1} ({2})', name, device.name, formatSize(content.length));
        return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, token) => {
            let reported = 0;
            for (let offset = 0; offset < content.length; offset += FS_CHUNK_SIZE) {
                if (token.isCancellationRequested) {
                    throw new DeviceError(t('Writing {0} was cancelled (the file on the device may be incomplete)', name), device);
                }
                const chunk = content.subarray(offset, Math.min(content.length, offset + FS_CHUNK_SIZE));
                await device.request('fs.write', {
                    path: uri.path,
                    content: chunk.toString('base64'),
                    encoding: 'base64',
                    create: options.create,
                    overwrite: options.overwrite,
                    mkdirs: true,
                    append: offset > 0,
                }, 120_000);
                const percent = Math.min(100, Math.floor((offset + chunk.length) * 100 / content.length));
                progress.report({ message: `${percent}%`, increment: percent - reported });
                reported = percent;
            }
        });
    }

    async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
        const device = this.device(uri);
        try {
            await device.request('fs.delete', { path: uri.path, recursive: options.recursive });
            this.fireChanged(uri, vscode.FileChangeType.Deleted);
        } catch (e) {
            throw RemoteFileSystemProvider.translate(e, uri);
        }
    }

    async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
        const device = this.device(oldUri);
        if (deviceIdOfUri(oldUri) !== deviceIdOfUri(newUri)) {
            throw vscode.FileSystemError.NoPermissions(t('Moving files between devices is not supported'));
        }
        try {
            await device.request('fs.rename', { path: oldUri.path, newPath: newUri.path, overwrite: options.overwrite });
            this.emitter.fire([
                { type: vscode.FileChangeType.Deleted, uri: oldUri },
                { type: vscode.FileChangeType.Created, uri: newUri },
            ]);
        } catch (e) {
            throw RemoteFileSystemProvider.translate(e, oldUri);
        }
    }
}

/* Tree views. zh-CN: 树视图. */

export type TreeNode = DeviceNode | RootNode | EntryNode;

export class DeviceNode {
    readonly kind = 'device';

    constructor(readonly device: Device) {
    }
}

export class RootNode {
    readonly kind = 'root';

    constructor(readonly device: Device, readonly name: string, readonly path: string) {
    }
}

export class EntryNode {
    readonly kind = 'entry';

    constructor(readonly device: Device, readonly entry: RemoteEntry) {
    }

    get path(): string {
        return this.entry.path;
    }

    get isDirectory(): boolean {
        return this.entry.type === 'directory';
    }
}

/**
 * "Devices" view: connected devices with version and address.
 * zh-CN: "设备" 视图: 已连接设备及其版本与地址.
 */
export class DevicesTreeProvider implements vscode.TreeDataProvider<DeviceNode> {

    private readonly emitter = new vscode.EventEmitter<DeviceNode | undefined>();
    readonly onDidChangeTreeData = this.emitter.event;

    constructor(private readonly devices: Devices) {
        devices.on('changed', () => this.refresh());
    }

    refresh() {
        this.emitter.fire(undefined);
    }

    getTreeItem(node: DeviceNode): vscode.TreeItem {
        const device = node.device;
        const item = new vscode.TreeItem(device.name, vscode.TreeItemCollapsibleState.None);
        item.id = `device:${device.deviceId}`;
        item.description = `${device.versionName} | ${device.toString().replace(/^.*\((.*)\)$/, '$1')}`;
        item.tooltip = [
            t('Device: {0}', device.name),
            t('Device ID: {0}', device.deviceId),
            `AutoJs6: ${device.versionName} (${device.versionCode})`,
            t('Protocol version: {0}', device.protocolVersion),
            t('Connected at: {0}', formatTimestamp(device.connectedAt)),
        ].join('\n');
        item.iconPath = new vscode.ThemeIcon(device.supportsRequests ? 'device-mobile' : 'device-mobile', new vscode.ThemeColor(device.supportsRequests ? 'charts.green' : 'charts.yellow'));
        item.contextValue = device.supportsRequests ? 'device.v2' : 'device.v1';
        return item;
    }

    getChildren(node?: DeviceNode): DeviceNode[] {
        if (node) return [];
        return this.devices.devices.map(d => new DeviceNode(d));
    }
}

/**
 * "Device Files" view: browse storage of each connected device.
 * zh-CN: "设备文件" 视图: 浏览每个已连接设备的存储.
 */
export class DeviceFilesTreeProvider implements vscode.TreeDataProvider<TreeNode> {

    private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
    readonly onDidChangeTreeData = this.emitter.event;
    private readonly rootsCache = new Map<string, RemoteRoots>();

    constructor(private readonly devices: Devices, private readonly fsProvider: RemoteFileSystemProvider) {
        devices.on('changed', () => this.refresh());
        devices.on('detach_device', (device: Device) => this.rootsCache.delete(device.deviceId));
        fsProvider.onDidChangeFile(() => this.refresh());
    }

    refresh(node?: TreeNode) {
        this.emitter.fire(node);
    }

    getTreeItem(node: TreeNode): vscode.TreeItem {
        if (node.kind === 'device') {
            const item = new vscode.TreeItem(node.device.name, vscode.TreeItemCollapsibleState.Collapsed);
            item.id = `files:${node.device.deviceId}`;
            item.description = node.device.supportsRequests ? node.device.versionName : `${node.device.versionName} (${t('no remote files')})`;
            item.iconPath = new vscode.ThemeIcon('device-mobile');
            item.contextValue = 'fs.device';
            return item;
        }
        if (node.kind === 'root') {
            const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
            item.id = `root:${node.device.deviceId}:${node.path}`;
            item.description = node.path;
            item.resourceUri = remoteUri(node.device, node.path);
            item.iconPath = vscode.ThemeIcon.Folder;
            item.contextValue = 'fs.root';
            return item;
        }
        const entry = node.entry;
        const item = new vscode.TreeItem(entry.name, node.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        item.id = `entry:${node.device.deviceId}:${entry.path}`;
        item.resourceUri = remoteUri(node.device, entry.path);
        item.tooltip = `${entry.path}\n${node.isDirectory ? t('Directory') : formatSize(entry.size)} | ${formatTimestamp(entry.mtime)}`;
        if (node.isDirectory) {
            item.iconPath = vscode.ThemeIcon.Folder;
            item.contextValue = 'fs.directory';
        } else {
            item.description = formatSize(entry.size);
            item.contextValue = /\.(js|mjs|cjs|ts|auto)$/i.test(entry.name) ? 'fs.script' : 'fs.file';
            item.command = { command: 'vscode.open', title: t('Open'), arguments: [ item.resourceUri ] };
        }
        return item;
    }

    async getChildren(node?: TreeNode): Promise<TreeNode[]> {
        if (!node) {
            return this.devices.devices.map(d => new DeviceNode(d));
        }
        if (!node.device.isConnected) {
            return [];
        }
        try {
            if (node.kind === 'device') {
                if (!node.device.supportsRequests) {
                    return [];
                }
                let roots = this.rootsCache.get(node.device.deviceId);
                if (!roots) {
                    roots = await node.device.request<RemoteRoots>('fs.roots');
                    this.rootsCache.set(node.device.deviceId, roots);
                }
                return roots.roots.map(r => new RootNode(node.device, r.name, r.path));
            }
            const result = await node.device.request<{ entries: RemoteEntry[] }>('fs.list', { path: node.path });
            return result.entries
                .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1))
                .map(e => new EntryNode(node.device, e));
        } catch (e) {
            logError('failed to list remote files:', e);
            vscode.window.showErrorMessage(t('Failed to read the device file: {0}', (e as Error).message));
            return [];
        }
    }

    getParent(): TreeNode | undefined {
        return undefined;
    }
}

/**
 * Commands operating on tree nodes. zh-CN: 作用于树节点的命令.
 */
export class RemoteFileCommands {

    constructor(
        private readonly devices: Devices,
        private readonly fsProvider: RemoteFileSystemProvider,
        private readonly tree: DeviceFilesTreeProvider,
    ) {
    }

    register(context: vscode.ExtensionContext) {
        const reg = (command: string, handler: (...args: any[]) => any) => {
            context.subscriptions.push(vscode.commands.registerCommand(command, async (...args: any[]) => {
                try {
                    await handler(...args);
                } catch (e) {
                    logError(`${command} failed:`, e);
                    vscode.window.showErrorMessage(`${(e as Error).message}`);
                }
            }));
        };
        reg('extension.remoteFiles.refresh', (node?: TreeNode) => this.tree.refresh(node && node.kind !== 'entry' ? node : undefined));
        reg('extension.remoteFiles.open', (node: EntryNode) => this.open(node));
        reg('extension.remoteFiles.run', (node: EntryNode | RootNode) => this.run(node));
        reg('extension.remoteFiles.delete', (node: EntryNode) => this.delete(node));
        reg('extension.remoteFiles.rename', (node: EntryNode) => this.rename(node));
        reg('extension.remoteFiles.newFolder', (node: EntryNode | RootNode) => this.newFolder(node));
        reg('extension.remoteFiles.newFile', (node: EntryNode | RootNode) => this.newFile(node));
        reg('extension.remoteFiles.uploadCurrentFile', (node: EntryNode | RootNode) => this.uploadCurrentFile(node));
        reg('extension.remoteFiles.uploadFiles', (node: EntryNode | RootNode) => this.uploadFiles(node));
        reg('extension.remoteFiles.download', (node: EntryNode) => this.download(node));
        reg('extension.remoteFiles.copyPath', (node: EntryNode | RootNode) => vscode.env.clipboard.writeText(node.path));
        reg('extension.remoteFiles.browse', () => this.browse());
    }

    private dirOf(node: EntryNode | RootNode): string {
        return node.kind === 'root' ? node.path : (node.isDirectory ? node.path : remoteDirname(node.path));
    }

    private async open(node: EntryNode) {
        if (node.isDirectory) return;
        await vscode.commands.executeCommand('vscode.open', remoteUri(node.device, node.path));
    }

    private async run(node: EntryNode | RootNode) {
        if (node.kind === 'entry' && node.isDirectory) {
            throw new DeviceError(t('Pick a script file'));
        }
        if (node.kind === 'root') {
            throw new DeviceError(t('Pick a script file'));
        }
        await node.device.request('script.run', { path: node.path });
        vscode.window.showInformationMessage(t('Running {0} on {1}', remoteBasename(node.path), String(node.device)));
    }

    private async delete(node: EntryNode) {
        const ok = await confirm(t('Delete "{0}" on {1}?', node.path, String(node.device)), node.isDirectory ? t('The folder and its contents will be deleted') : t('The file will be deleted'));
        if (!ok) return;
        await this.fsProvider.delete(remoteUri(node.device, node.path), { recursive: true });
    }

    private async rename(node: EntryNode) {
        const name = await promptInput({ prompt: t('New name'), value: node.entry.name, validateInput: v => /[\\/]/.test(v) ? t('The name cannot contain path separators') : (v.trim() ? null : t('The name cannot be empty')) });
        if (!name || name === node.entry.name) return;
        const newPath = joinRemotePath(remoteDirname(node.path), name);
        await this.fsProvider.rename(remoteUri(node.device, node.path), remoteUri(node.device, newPath), { overwrite: false });
    }

    private async newFolder(node: EntryNode | RootNode) {
        const name = await promptInput({ prompt: t('Folder name'), validateInput: v => /[\\/]/.test(v) ? t('The name cannot contain path separators') : (v.trim() ? null : t('The name cannot be empty')) });
        if (!name) return;
        await this.fsProvider.createDirectory(remoteUri(node.device, joinRemotePath(this.dirOf(node), name)));
    }

    private async newFile(node: EntryNode | RootNode) {
        const name = await promptInput({ prompt: t('File name'), value: 'untitled.js', validateInput: v => /[\\/]/.test(v) ? t('The name cannot contain path separators') : (v.trim() ? null : t('The name cannot be empty')) });
        if (!name) return;
        const uri = remoteUri(node.device, joinRemotePath(this.dirOf(node), name));
        await this.fsProvider.writeFile(uri, new Uint8Array(0), { create: true, overwrite: false });
        await vscode.commands.executeCommand('vscode.open', uri);
    }

    private async uploadCurrentFile(node: EntryNode | RootNode) {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme === REMOTE_SCHEME) {
            throw new DeviceError(t('Use this command in an open local file editor'));
        }
        const name = editor.document.isUntitled ? 'untitled.js' : path.basename(editor.document.fileName);
        const uri = remoteUri(node.device, joinRemotePath(this.dirOf(node), name));
        await this.fsProvider.writeFile(uri, Buffer.from(editor.document.getText(), 'utf8'), { create: true, overwrite: true });
        vscode.window.showInformationMessage(t('Uploaded to {0}: {1}', String(node.device), uri.path));
    }

    private async uploadFiles(node: EntryNode | RootNode) {
        const uris = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFolders: false, openLabel: t('Upload') });
        if (!uris || uris.length === 0) return;
        const dir = this.dirOf(node);
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Uploading to {0}', String(node.device)) }, async (progress) => {
            for (let i = 0; i < uris.length; i++) {
                const local = uris[i];
                progress.report({ message: `${i + 1}/${uris.length} ${path.basename(local.fsPath)}`, increment: 100 / uris.length });
                const content = await vscode.workspace.fs.readFile(local);
                await this.fsProvider.writeFile(remoteUri(node.device, joinRemotePath(dir, path.basename(local.fsPath))), content, { create: true, overwrite: true });
            }
        });
    }

    private async download(node: EntryNode) {
        if (node.isDirectory) {
            throw new DeviceError(t('Downloading folders is not supported yet'));
        }
        const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', node.entry.name)) });
        if (!target) return;
        const content = await this.fsProvider.readFile(remoteUri(node.device, node.path));
        await vscode.workspace.fs.writeFile(target, content);
        vscode.window.showInformationMessage(t('Downloaded to {0}', target.fsPath));
    }

    /** Open a device root folder in the explorer as a workspace folder. zh-CN: 将设备目录作为工作区文件夹打开. */
    private async browse() {
        const candidates = this.devices.devices.filter(d => d.supportsRequests);
        if (candidates.length === 0) {
            throw new DeviceError(t('No connected device supports remote file management'));
        }
        const picked = await showPick({
            title: t('Pick a Device'),
            placeholder: t('Pick the device whose files to browse'),
            items: candidates.map(d => ({ label: d.toString(), description: d.versionName, device: d })),
        });
        if (typeof picked !== 'object') return;
        const device = picked.device;
        const roots = await device.request<RemoteRoots>('fs.roots');
        const root = await showPick({
            title: t('Pick a folder on {0}', String(device)),
            items: roots.roots.map(r => ({ label: r.name, description: r.path, path: r.path })),
        });
        if (typeof root !== 'object') return;
        const uri = remoteUri(device, root.path);
        const folders = vscode.workspace.workspaceFolders || [];
        if (folders.some(f => f.uri.toString() === uri.toString())) {
            vscode.window.showInformationMessage(t('This folder is already in the workspace'));
            return;
        }
        vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri, name: `${device.name} / ${root.label}` });
    }
}

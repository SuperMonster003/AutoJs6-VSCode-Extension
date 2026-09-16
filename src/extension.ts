'use strict';

import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Memento, TextEditor, Uri } from 'vscode';
import * as tinyPinyin from 'tiny-pinyin';

import * as util from './util';
import { Adb, AdbDeviceInfo, AdbNotFoundError } from './adb';
import { CLOSE_REASON, ConnectionTarget, ConnectionType, describeTarget, Device, DeviceCommandParam, DeviceError, Devices, ProjectCommand, ReconnectSession, targetKey } from './device';
import { DeviceChannels, initLogger, logDebug, logError } from './logger';
import { Project, ProjectTemplate, resolveProjectDir } from './project';
import { parseEndpoint, toPosixPath } from './protocol';
import { QrCodePanel } from './qrcode';
import { DeviceFilesTreeProvider, DevicesTreeProvider, REMOTE_SCHEME, RemoteFileCommands, RemoteFileSystemProvider } from './remoteFs';
import { Settings } from './settings';
import { confirm, pickNetworkInterface, showErrorWithAction, showMultiPick, showPick } from './ui';

const EXTENSION_NAME = 'AutoJs6 VSCode Extension';
const IP_LOOP_BACK = '127.0.0.1';
const IP_UNIVERSAL = '0.0.0.0';
const STORAGE_KEY_RECORDS = 'autojs6.devices';
const STORAGE_KEY_TARGETS = 'autojs6.lastTargets';
const STORAGE_IP_BLACKLIST = [ IP_LOOP_BACK, IP_UNIVERSAL ];

const PREFIX = {
    connect: '[ 连接 ]',
    clear: '[ 清理 ]',
    record: '[ 记录 ]',
    optional: '[ 可选 ]',
};

const LABEL = {
    ajClientLan: `${PREFIX.connect} - 服务端模式 (Server) | 局域网 (LAN)`,
    ajClientQr: `${PREFIX.connect} - 服务端模式 (Server) | 二维码 (QR Code)`,
    ajServerLan: `${PREFIX.connect} - 客户端模式 (Client) | 局域网 (LAN)`,
    ajServerAdb: `${PREFIX.connect} - 客户端模式 (Client) | 安卓调试桥 (ADB)`,
    recordClear: `${PREFIX.clear} - IP 地址记录 (IP Address Records)`,
};

/** Commands the device may ask the extension to run. zh-CN: 设备可请求插件执行的命令白名单. */
const DEVICE_TRIGGERABLE_COMMANDS = new Set([
    'viewDocument', 'connect', 'disconnectAll', 'run', 'runOnDevice', 'stop', 'stopAll', 'rerun',
    'save', 'saveToDevice', 'newUntitledFile', 'newProject', 'runProject', 'saveProject', 'showQrCode',
]);

interface IpRecord {
    ip: string;
    ts: number;
}

/** A connection the extension initiated, persisted so it can be restored on startup. zh-CN: 插件主动建立的连接, 持久化以便启动时恢复. */
interface SavedTarget {
    type: ConnectionType;
    host: string;
    port: number;
    adbDeviceId?: string;
    label?: string;
    ts: number;
}

interface ScriptPayload {
    id: string;
    name: string;
    path?: string;
    script: string;
}

/**
 * Local HTTP bridge so external tools can trigger commands, e.g. `http://127.0.0.1:10347/exec?cmd=run&path=...` (issue #6).
 * zh-CN: 本地 HTTP 命令桥, 供外部工具触发命令 (issue #6).
 */
class CommandHttpServer implements vscode.Disposable {

    private server: http.Server | null = null;

    constructor(private readonly onCommand: (cmd: string, path?: string) => void) {
    }

    start(host: string, port: number): Promise<void> {
        this.stop();
        return new Promise((resolve, reject) => {
            const server = http.createServer((request, response) => {
                const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
                if (url.pathname !== '/exec') {
                    response.writeHead(404);
                    response.end();
                    return;
                }
                const cmd = url.searchParams.get('cmd') || '';
                const filePath = url.searchParams.get('path') || undefined;
                response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
                response.end(`command: ${cmd}${filePath ? ` --> ${filePath}` : ''}`);
                this.onCommand(cmd, filePath);
            });
            server.on('error', (e: NodeJS.ErrnoException) => {
                logError('HTTP server error:', e);
                if (this.server !== server) reject(e);
            });
            server.listen(port, host, () => {
                this.server = server;
                logDebug(`HTTP server listening on ${host}:${port}`);
                resolve();
            });
        });
    }

    stop() {
        this.server?.close();
        this.server = null;
    }

    dispose() {
        this.stop();
    }
}

export class Extension implements vscode.Disposable {

    static readonly commands: Array<keyof Extension> = [
        'viewDocument', 'connect', 'disconnectAll', 'disconnectDevice', 'selectDevice', 'showQrCode',
        'run', 'runWithoutArguments', 'runOnDevice', 'stop', 'stopAll', 'rerun',
        'save', 'saveToDevice', 'newUntitledFile', 'newProject',
        'runProject', 'runProjectWithoutArguments', 'saveProject', 'saveProjectWithoutArguments', 'resyncProject',
        'reconnect', 'cancelReconnect',
    ];

    readonly devices = new Devices(() => Settings.connectionOptions);
    private readonly adb: Adb;
    private readonly storage: Memento;
    private readonly channels = new DeviceChannels(name => vscode.window.createOutputChannel(name), () => Settings.disposeChannelOnDisconnect);
    private readonly httpServer: CommandHttpServer;
    private readonly statusBar: vscode.StatusBarItem;
    private readonly disposables: vscode.Disposable[] = [];
    private lastActiveEditor: TextEditor | undefined;
    private project: Project | null = null;
    private readonly adbForwards = new Map<string, number[]>();

    constructor(private readonly context: vscode.ExtensionContext) {
        this.storage = context.globalState;
        this.adb = new Adb(path.join(context.extensionPath, 'tools'), () => Settings.adbPath);
        this.httpServer = new CommandHttpServer((cmd, p) => this.onHttpCommand(cmd, p));
        this.statusBar = vscode.window.createStatusBarItem('autojs6.devices', vscode.StatusBarAlignment.Left, 100);
        this.statusBar.name = 'AutoJs6 Devices';
        this.statusBar.command = 'extension.selectDevice';

        this.initActiveEditor();
        this.initDevices();
        this.registerCommands();
        this.initViews();
        this.updateStatusBar();

        this.disposables.push(this.channels, this.httpServer, this.statusBar);
        this.disposables.push(Settings.onDidChange(() => this.onSettingsChanged()));

        this.startServers();
        this.restoreConnections();
    }

    /* Lifecycle. zh-CN: 生命周期. */

    private startServers() {
        const port = Settings.serverPort;
        this.devices.startServer(port).then(() => this.updateStatusBar()).catch((e: NodeJS.ErrnoException) => {
            const hint = e.code === 'EADDRINUSE'
                ? `端口 ${port} 已被占用 (可能是另一个 VSCode 窗口). 客户端模式 (AutoJs6 主动连接) 在本窗口不可用, 其他连接方式仍可使用.`
                : `无法监听端口 ${port}: ${e.message}`;
            showErrorWithAction(`AutoJs6: ${hint}`, '修改端口', () => vscode.commands.executeCommand('workbench.action.openSettings', 'autojs6.server.port'));
            this.updateStatusBar();
        });
        if (Settings.httpEnabled) {
            this.httpServer.start(Settings.httpHost, Settings.httpPort).catch((e: NodeJS.ErrnoException) => {
                logError(`HTTP command server unavailable on ${Settings.httpHost}:${Settings.httpPort}:`, e);
            });
        }
    }

    private onSettingsChanged() {
        this.adb.invalidate();
        if (this.devices.listeningPort !== Settings.serverPort || (!Settings.httpEnabled)) {
            this.httpServer.stop();
            this.startServers();
        }
        QrCodePanel.refresh(Settings.serverPort);
    }

    dispose() {
        this.devices.dispose();
        this.project?.dispose();
        this.adbForwards.forEach((ports, deviceId) => ports.forEach(p => this.adb.removeForward(deviceId, p)));
        this.disposables.forEach(d => d.dispose());
    }

    private initActiveEditor() {
        this.lastActiveEditor = vscode.window.activeTextEditor;
        this.disposables.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor && editor.document.uri.scheme !== 'output') {
                this.lastActiveEditor = editor;
            }
        }));
    }

    private initDevices() {
        this.devices
            .on('new_device', (device: Device) => this.onNewDevice(device))
            .on('detach_device', (device: Device, reason: string) => this.onDetachDevice(device, reason))
            .on('log', (device: Device, text: string) => this.channels.append(device.deviceId, text))
            .on('command', (device: Device, param: DeviceCommandParam) => this.onDeviceCommand(device, param))
            .on('reject', (device: Device, message: string) => {
                showErrorWithAction(message, '查看所有项目版本', () => vscode.env.openExternal(Uri.parse('https://github.com/SuperMonster003/AutoJs6/releases/')));
            })
            .on('reconnecting', () => this.updateStatusBar())
            .on('reconnected', (device: Device, session: ReconnectSession) => {
                logDebug(`reconnected to ${device} after ${session.attempts} attempt(s)`);
            })
            .on('reconnect_failed', (target: ConnectionTarget, lastError: string, session: ReconnectSession) => this.onReconnectFailed(target, lastError, session))
            .on('reconnect_cancelled', () => this.updateStatusBar())
            .on('changed', () => this.updateStatusBar());
    }

    private onDetachDevice(device: Device, reason: string) {
        const willReconnect = this.devices.shouldReconnect(device, reason);
        const silent = reason === CLOSE_REASON.SHUTDOWN || reason === CLOSE_REASON.REPLACED;
        if (!silent) {
            const detail = reason && reason !== CLOSE_REASON.USER ? ` (${reason})` : '';
            vscode.window.showInformationMessage(`AutoJs6 设备断开: ${device}${detail}${willReconnect ? ', 将自动重连' : ''}`);
        }
        this.channels.onDisconnect(device.deviceId, device.toString());
        this.releaseAdbForward(device);
        // An explicit disconnect on either side must not be restored later (respect the user's intent).
        // zh-CN: 任一侧显式断开的连接不再恢复 (尊重用户意愿).
        if (device.connectionTarget && (reason === CLOSE_REASON.USER || device.peerByeReason === 'user' || reason.includes('版本'))) {
            this.forgetTarget(device.connectionTarget);
        }
        this.updateStatusBar();
    }

    private onReconnectFailed(target: ConnectionTarget, lastError: string, session: ReconnectSession) {
        const name = describeTarget(target);
        const retry = '重试';
        const forget = '不再自动恢复';
        vscode.window.showWarningMessage(`AutoJs6: 无法重新连接 ${name} (已尝试 ${session.attempts} 次, 最近错误: ${lastError || '未知'}), 已停止重试`, retry, forget).then((choice) => {
            if (choice === retry) {
                this.devices.startReconnect(target, '', true);
            } else if (choice === forget) {
                this.forgetTarget(target);
            }
        });
        this.updateStatusBar();
    }

    private onNewDevice(device: Device) {
        this.rememberIp(device);
        if (device.connectionTarget) {
            this.rememberTarget(device.connectionTarget);
        }
        const channel = this.channels.getOrCreate(device.deviceId, device.toString());
        channel.appendLine(`--- ${device} connected (AutoJs6 ${device.versionName}, protocol v${device.protocolVersion}) ---`);
        if (Settings.showChannelOnConnect) {
            channel.show(true);
        }
        vscode.window.showInformationMessage(`AutoJs6 设备接入: ${device}`);
        this.updateStatusBar();
    }

    private onDeviceCommand(device: Device, param: DeviceCommandParam) {
        const cmd = param?.['\xa0cmd\xa0'];
        if (!DEVICE_TRIGGERABLE_COMMANDS.has(cmd)) {
            vscode.window.showErrorMessage(`接收到未知指令 "${cmd}" (来自 ${device})`);
            return;
        }
        vscode.window.showInformationMessage(`执行来自 ${device} 的指令 "${cmd}"`);
        vscode.commands.executeCommand(`extension.${cmd}`, param.path);
    }

    private onHttpCommand(cmd: string, filePath?: string) {
        logDebug(`HTTP command: ${cmd} ${filePath || ''}`);
        if (cmd === 'rerunProject') {
            this.stopAll();
            setTimeout(() => this.runProject(filePath), 1000);
            return;
        }
        if (!DEVICE_TRIGGERABLE_COMMANDS.has(cmd)) {
            vscode.window.showErrorMessage(`接收到未知的 HTTP 指令 "${cmd}"`);
            return;
        }
        vscode.commands.executeCommand(`extension.${cmd}`, filePath);
    }

    private registerCommands() {
        Extension.commands.forEach((command) => {
            const fn = this[command];
            if (typeof fn !== 'function') {
                throw Error(`Invalid command: ${command}`);
            }
            this.context.subscriptions.push(vscode.commands.registerCommand(`extension.${command}`, (...args: any[]) => {
                try {
                    const result = (fn as Function).apply(this, args);
                    if (result && typeof result.then === 'function') {
                        result.catch((e: Error) => this.reportError(command, e));
                    }
                } catch (e) {
                    this.reportError(command, e as Error);
                }
            }));
        });
    }

    private reportError(command: string, e: Error) {
        logError(`command ${command} failed:`, e);
        vscode.window.showErrorMessage(e instanceof DeviceError ? e.message : `AutoJs6: ${e.message || e}`);
    }

    private initViews() {
        const fsProvider = new RemoteFileSystemProvider(this.devices);
        const devicesTree = new DevicesTreeProvider(this.devices);
        const filesTree = new DeviceFilesTreeProvider(this.devices, fsProvider);
        this.context.subscriptions.push(
            vscode.workspace.registerFileSystemProvider(REMOTE_SCHEME, fsProvider, { isCaseSensitive: true }),
            vscode.window.createTreeView('autojs6.devices', { treeDataProvider: devicesTree, showCollapseAll: false }),
            vscode.window.createTreeView('autojs6.deviceFiles', { treeDataProvider: filesTree, showCollapseAll: true }),
        );
        new RemoteFileCommands(this.devices, fsProvider, filesTree).register(this.context);
    }

    private updateStatusBar() {
        const count = this.devices.devices.length;
        const sessions = this.devices.reconnectSessions;
        const lines: string[] = [];
        if (count === 0) {
            this.statusBar.text = sessions.length > 0 ? `$(sync~spin) AutoJs6: 重连中 (${sessions.length})` : '$(device-mobile) AutoJs6: 无设备';
            lines.push(this.devices.isListening
                ? `AutoJs6: 未连接设备. 正在监听端口 ${this.devices.listeningPort}. 点击建立连接.`
                : `AutoJs6: 未连接设备. 端口 ${Settings.serverPort} 监听失败. 点击建立连接.`);
        } else {
            this.statusBar.text = sessions.length > 0 ? `$(sync~spin) AutoJs6: ${count}` : `$(device-mobile) AutoJs6: ${count}`;
            lines.push('AutoJs6 已连接设备:', ...this.devices.devices.map(d => `- ${d} [${d.versionName}]`));
        }
        if (sessions.length > 0) {
            lines.push('正在重连:', ...sessions.map(s => `- ${describeTarget(s.target)} (第 ${s.attempts + 1} 次${s.lastError ? `, ${s.lastError}` : ''})`));
        }
        this.statusBar.tooltip = lines.join('\n');
        this.statusBar.show();
        vscode.commands.executeCommand('setContext', 'autojs6.connected', count > 0);
        vscode.commands.executeCommand('setContext', 'autojs6.reconnecting', sessions.length > 0);
    }

    /* IP records. zh-CN: IP 地址记录. */

    private loadRecords(): IpRecord[] {
        const raw = this.storage.get<string[]>(STORAGE_KEY_RECORDS, []);
        const records: IpRecord[] = [];
        const seen = new Set<string>();
        for (const item of raw) {
            if (typeof item !== 'string') continue;
            let [ ip, ts ] = item.split('|');
            ip = (ip || '').replace(/^\[ [^\]]+ ] - /, '').trim();
            if (!ip || STORAGE_IP_BLACKLIST.includes(ip) || seen.has(ip)) continue;
            seen.add(ip);
            records.push({ ip, ts: parseInt(ts || '', 10) || 0 });
        }
        return records;
    }

    private saveRecords(records: IpRecord[]) {
        this.storage.update(STORAGE_KEY_RECORDS, records.map(r => `${r.ip}|${r.ts}`));
    }

    /* Restorable targets (roadmap 3.9). zh-CN: 可恢复的连接目标 (roadmap 3.9). */

    private loadTargets(): SavedTarget[] {
        const raw = this.storage.get<SavedTarget[]>(STORAGE_KEY_TARGETS, []);
        return Array.isArray(raw) ? raw.filter(t => t && typeof t.host === 'string' && typeof t.port === 'number') : [];
    }

    private saveTargets(targets: SavedTarget[]) {
        this.storage.update(STORAGE_KEY_TARGETS, targets.slice(0, 20));
    }

    private static savedKey(t: SavedTarget): string {
        return targetKey({ type: t.type, host: t.host, port: t.port, adbDeviceId: t.adbDeviceId });
    }

    private rememberTarget(target: ConnectionTarget) {
        if (target.type === ConnectionType.CLIENT_LAN) return;
        const key = targetKey(target);
        const targets = this.loadTargets().filter(t => Extension.savedKey(t) !== key);
        const saved: SavedTarget = { type: target.type, host: target.host, port: target.port, ts: Date.now() };
        if (target.type === ConnectionType.SERVER_ADB) {
            saved.adbDeviceId = target.adbDeviceId;
            saved.label = target.label;
            saved.host = IP_LOOP_BACK;
            saved.port = 0;
        }
        targets.unshift(saved);
        this.saveTargets(targets);
    }

    private forgetTarget(target: ConnectionTarget) {
        const key = targetKey(target);
        const targets = this.loadTargets();
        const kept = targets.filter(t => Extension.savedKey(t) !== key);
        if (kept.length !== targets.length) {
            this.saveTargets(kept);
            logDebug(`forgot target ${key}`);
        }
    }

    private toConnectionTarget(saved: SavedTarget): ConnectionTarget {
        return saved.type === ConnectionType.SERVER_ADB && saved.adbDeviceId
            ? this.createAdbTarget(saved.adbDeviceId, saved.label)
            : this.createLanTarget(saved.host, saved.port);
    }

    /**
     * Reconnect to the targets that were connected when VSCode closed (opt-out via `autojs6.connection.restoreOnStartup`).
     * zh-CN: 恢复 VSCode 关闭时仍连接的目标 (可通过 `autojs6.connection.restoreOnStartup` 关闭).
     */
    private restoreConnections() {
        if (!Settings.restoreOnStartup) return;
        const targets = this.loadTargets();
        if (targets.length === 0) return;
        logDebug(`restoring ${targets.length} connection(s):`, targets);
        targets.forEach((saved) => {
            try {
                this.devices.startReconnect(this.toConnectionTarget(saved), '恢复上次连接', true);
            } catch (e) {
                logError('failed to restore connection:', e);
            }
        });
    }

    private rememberIp(device: Device) {
        const ip = device.remoteAddress;
        if (!ip || STORAGE_IP_BLACKLIST.includes(ip) || device.connectionTarget?.adbDeviceId) {
            return;
        }
        const records = this.loadRecords().filter(r => r.ip !== ip);
        records.unshift({ ip, ts: Date.now() });
        this.saveRecords(records.slice(0, 50));
    }

    /* Script helpers. zh-CN: 脚本辅助. */

    private static extensionForLanguage(languageId: string): string {
        const map: { [lang: string]: string } = {
            bat: 'bat', c: 'c', css: 'css', go: 'go', html: 'html', java: 'java', javascript: 'js', javascriptreact: 'jsx',
            json: 'json', lua: 'lua', markdown: 'md', php: 'php', plaintext: 'txt', powershell: 'ps1', python: 'py', r: 'r',
            shellscript: 'sh', sql: 'sql', typescript: 'ts', typescriptreact: 'tsx', vue: 'vue', xml: 'xml', xsl: 'xsl', yaml: 'yaml',
        };
        return map[languageId] || 'js';
    }

    private static editorFileName(editor: TextEditor): string {
        const fileName = editor.document.fileName;
        return editor.document.isUntitled ? `${fileName}.${Extension.extensionForLanguage(editor.document.languageId)}` : fileName;
    }

    /** Path relative to the containing workspace folder (POSIX), or `undefined`. zh-CN: 相对工作区目录的路径. */
    private static relativeWorkspacePath(uri: Uri): string | undefined {
        if (uri.scheme !== 'file') return undefined;
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (!folder) return undefined;
        const rel = path.relative(folder.uri.fsPath, uri.fsPath);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
        return toPosixPath(rel);
    }

    private payloadFromEditor(editor: TextEditor): ScriptPayload {
        const fileName = Extension.editorFileName(editor);
        const payload: ScriptPayload = {
            id: editor.document.fileName,
            name: path.basename(fileName),
            script: editor.document.getText(),
        };
        if (Settings.saveKeepRelativePath) {
            payload.path = Extension.relativeWorkspacePath(editor.document.uri);
        }
        return payload;
    }

    private payloadFromFile(fsPath: string): ScriptPayload {
        const payload: ScriptPayload = {
            id: fsPath,
            name: path.basename(fsPath),
            script: fs.readFileSync(fsPath, 'utf8'),
        };
        if (Settings.saveKeepRelativePath) {
            payload.path = Extension.relativeWorkspacePath(Uri.file(fsPath));
        }
        return payload;
    }

    private static refinePath(urlOrUri?: string | Uri | { fsPath?: string }): string | undefined {
        if (!urlOrUri) return undefined;
        if (typeof urlOrUri === 'string') {
            const s = urlOrUri.trim();
            if (!s) return undefined;
            if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
                try {
                    return Uri.parse(s).fsPath;
                } catch (e) {
                    return s;
                }
            }
            return s;
        }
        if (typeof (urlOrUri as any).fsPath === 'string') {
            return (urlOrUri as Uri).fsPath;
        }
        return undefined;
    }

    private currentEditorOrThrow(): TextEditor {
        const editor = this.lastActiveEditor;
        if (!editor || editor.document.uri.scheme === 'output') {
            throw new DeviceError('需在正在编辑的文件窗口中使用此命令');
        }
        return editor;
    }

    private connectedDevicesOrThrow(): Device[] {
        if (!this.devices.hasDevices()) {
            throw new DeviceError('未发现已连接的设备');
        }
        return this.devices.devices;
    }

    private async pickDevices(title: string): Promise<Device[] | undefined> {
        const devices = this.connectedDevicesOrThrow();
        if (devices.length === 1) {
            return devices;
        }
        const picked = await showMultiPick({
            title,
            placeholder: '勾选一个或多个设备, 按回车 (Enter) 键确认',
            items: devices.map(d => ({ label: d.toString(), description: `AutoJs6 ${d.versionName}`, device: d })),
        });
        return picked?.map(p => p.device);
    }

    private runOn(devices: Device[], fsPath?: string) {
        const payload = fsPath ? this.payloadFromFile(fsPath) : this.payloadFromEditor(this.currentEditorOrThrow());
        if (this.lastActiveEditor?.document.uri.scheme === REMOTE_SCHEME && !fsPath) {
            // Remote file: run it in place on its own device. zh-CN: 远程文件直接在所属设备上运行.
            const uri = this.lastActiveEditor.document.uri;
            const device = this.devices.getDevice(decodeURIComponent(uri.authority));
            if (device) {
                device.request('script.run', { path: uri.path }).catch(e => this.reportError('run', e));
                return;
            }
        }
        const count = this.devices.sendCommand('run', payload, devices);
        logDebug(`run "${payload.name}" on ${count} device(s)`);
    }

    private saveOn(devices: Device[]) {
        const editor = this.currentEditorOrThrow();
        if (editor.document.uri.scheme === REMOTE_SCHEME) {
            throw new DeviceError('远程文件请直接使用 VSCode 的保存功能');
        }
        const payload = this.payloadFromEditor(editor);
        const count = this.devices.sendCommand('save', payload, devices);
        vscode.window.showInformationMessage(`已发送 "${payload.path || payload.name}" 到 ${count} 台设备`);
    }

    /* Connection. zh-CN: 连接. */

    async connect() {
        const interfaces = util.getBasicNetworkInterfaces();
        const title = interfaces.length > 0 ? `当前活动 IP: ${interfaces.map(o => o.ip4).join(', ')}` : '未找到可用的局域网 IP 地址';
        const picked = await showPick({
            title,
            placeholder: '输入或选择连接建立方式',
            items: [
                { label: LABEL.ajClientLan, detail: 'AutoJs6 (客户端模式) 主动连接至本机 (输入本机 IP 地址)' },
                { label: LABEL.ajClientQr, detail: 'AutoJs6 (客户端模式) 扫描二维码后自动连接至本机' },
                { label: LABEL.ajServerLan, detail: '本机主动连接至 AutoJs6 (服务端模式), 输入设备 IP 地址或域名' },
                { label: LABEL.ajServerAdb, detail: '本机通过 USB (ADB) 连接至 AutoJs6 (服务端模式)' },
            ],
        });
        if (typeof picked !== 'object') return;
        switch (picked.label) {
            case LABEL.ajClientLan:
                return this.connectToLocalHint(interfaces);
            case LABEL.ajClientQr:
                return this.showQrCode();
            case LABEL.ajServerLan:
                return this.connectToServerLanFlow();
            case LABEL.ajServerAdb:
                return this.connectByAdb();
        }
    }

    private async connectToLocalHint(interfaces: util.NIDetails[]) {
        if (!this.devices.isListening) {
            throw new DeviceError(`端口 ${Settings.serverPort} 未在监听 (可能被其他窗口占用), 请修改 autojs6.server.port 或使用其他连接方式`);
        }
        if (interfaces.length === 0) {
            throw new DeviceError('未找到可用的局域网 IP 地址');
        }
        const ni = await pickNetworkInterface(interfaces);
        if (ni) {
            vscode.window.showInformationMessage(`在 AutoJs6 侧拉菜单开启客户端模式并连接至 ${ni.ip4}:${this.devices.listeningPort}`, '显示二维码')
                .then(choice => choice && this.showQrCode(ni.ip4));
        }
    }

    async showQrCode(preferredIp?: string) {
        if (!this.devices.isListening) {
            throw new DeviceError(`端口 ${Settings.serverPort} 未在监听 (可能被其他窗口占用), 请修改 autojs6.server.port 或使用其他连接方式`);
        }
        await QrCodePanel.show(this.context, this.devices.listeningPort, util.getBasicNetworkInterfaces(), typeof preferredIp === 'string' ? preferredIp : undefined);
    }

    private async connectToServerLanFlow() {
        const records = this.loadRecords();
        const items: vscode.QuickPickItem[] = records.map(r => ({
            label: `${PREFIX.record} - ${r.ip}`,
            detail: r.ts ? `最近连接: ${util.formatTimestamp(r.ts)}` : undefined,
        }));
        if (records.length > 0) {
            items.push({ label: LABEL.recordClear, detail: '清除保存在本地的全部 IP 地址记录' });
        }
        const picked = await showPick({
            title: '连接到 AutoJs6 服务端',
            placeholder: `输入 IP 地址或域名 (可带端口, 默认 ${Settings.clientPort}), 按回车 (Enter) 键建立连接`,
            items,
            acceptInput: true,
        });
        if (picked === undefined) return;
        if (typeof picked === 'object') {
            if (picked.label === LABEL.recordClear) {
                if (await confirm('确认清除所有已保存的记录吗')) {
                    this.saveRecords([]);
                    vscode.window.showInformationMessage(`清理完成, 共计 ${records.length} 项`);
                }
                return;
            }
            return this.connectToServerLan(picked.label.replace(`${PREFIX.record} - `, ''));
        }
        return this.connectToServerLan(picked);
    }

    async connectToServerLan(input: string) {
        const endpoint = parseEndpoint(input, Settings.clientPort);
        if (!endpoint) {
            throw new DeviceError(`连接 AutoJs6 服务端失败, 无法解析地址 "${input}"`);
        }
        const target = this.createLanTarget(endpoint.host, endpoint.port);
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `正在连接至 AutoJs6 服务端 (${endpoint.host}:${endpoint.port})...` }, async () => {
            try {
                await this.devices.connectTo(target);
            } catch (e) {
                if (e instanceof DeviceError && e.device) {
                    vscode.window.showWarningMessage(e.message);
                    return;
                }
                logError(e);
                showErrorWithAction(`无法连接至 AutoJs6 服务端 (${endpoint.host}:${endpoint.port}): ${(e as Error).message}`, '查看解决方案', () => {
                    vscode.window.showInformationMessage('AutoJs6 服务端连接诊断', {
                        modal: true,
                        detail: [
                            '检查 AutoJs6 主页侧拉抽屉是否已开启 "服务端模式"',
                            '检查两端设备是否位于同一局域网',
                            `检查 AutoJs6 所在设备的防火墙是否允许 ${endpoint.port} 端口通信`,
                            '尝试使用其他方式 (如 ADB 或二维码) 建立连接',
                        ].map(s => `- ${s}`).join('\n'),
                    });
                });
            }
        });
    }

    private createLanTarget(host: string, port: number): ConnectionTarget {
        return { type: ConnectionType.SERVER_LAN, host, port };
    }

    private createAdbTarget(adbDeviceId: string, label?: string): ConnectionTarget {
        return {
            type: ConnectionType.SERVER_ADB,
            host: IP_LOOP_BACK,
            port: 0,
            adbDeviceId,
            label,
            prepare: async () => {
                // Fail fast (and cheaply) while the device is unplugged or unauthorized. zh-CN: 设备未连接/未授权时快速失败.
                const info = this.adb.listDevices().find(d => d.id === adbDeviceId);
                if (!info) {
                    throw new DeviceError(`ADB 设备 ${adbDeviceId} 未连接`);
                }
                if (info.state !== 'device') {
                    throw new DeviceError(`ADB 设备 ${adbDeviceId} 状态为 ${info.state}`);
                }
                this.releaseAdbForwardById(adbDeviceId);
                const localPort = await findFreePort();
                this.adb.forward(adbDeviceId, localPort, Settings.clientPort);
                this.adbForwards.set(adbDeviceId, [ localPort ]);
                return { host: IP_LOOP_BACK, port: localPort };
            },
            cleanup: () => this.releaseAdbForwardById(adbDeviceId),
        };
    }

    private async connectByAdb() {
        let devices: AdbDeviceInfo[];
        try {
            devices = this.adb.listDevices();
        } catch (e) {
            if (e instanceof AdbNotFoundError) {
                showErrorWithAction('ADB 可能未安装或未被正确配置, 可在设置 autojs6.adb.path 中指定 adb 路径', '打开设置', () => {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'autojs6.adb.path');
                });
                return;
            }
            throw e;
        }
        const online = devices.filter(d => d.state === 'device');
        if (online.length === 0) {
            const offline = devices.filter(d => d.state !== 'device');
            throw new DeviceError(offline.length > 0
                ? `未发现可用的 ADB 设备 (${offline.map(d => `${d.id}: ${d.state}`).join(', ')}), 请在设备上确认 USB 调试授权`
                : '未发现通过 ADB 连接的设备');
        }
        const picked = await showPick({
            title: '连接到 AutoJs6 服务端 (ADB)',
            placeholder: '选择需要连接的设备, 按回车 (Enter) 键建立连接',
            items: online.map(d => ({ label: d.name, detail: `型号: ${d.model}, 产品名称: ${d.product}`, adb: d })),
        });
        if (typeof picked !== 'object') return;
        const dev = picked.adb;
        const target = this.createAdbTarget(dev.id, dev.name);
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `正在通过 ADB 连接至 ${dev.name}...` }, async () => {
            try {
                await this.devices.connectTo(target);
            } catch (e) {
                if (e instanceof DeviceError && e.device) {
                    vscode.window.showWarningMessage(e.message);
                    return;
                }
                logError(e);
                vscode.window.showErrorMessage(`无法通过 ADB 连接至 ${dev.name}: ${(e as Error).message}. 请确认 AutoJs6 侧拉菜单已开启 "服务端模式 (Server mode)"`);
            }
        });
    }

    private releaseAdbForward(device: Device) {
        const id = device.connectionTarget?.adbDeviceId;
        if (id) this.releaseAdbForwardById(id);
    }

    private releaseAdbForwardById(adbDeviceId: string) {
        const ports = this.adbForwards.get(adbDeviceId);
        if (!ports) return;
        this.adbForwards.delete(adbDeviceId);
        ports.forEach(p => this.adb.removeForward(adbDeviceId, p));
    }

    /* Commands. zh-CN: 命令. */

    viewDocument() {
        vscode.env.openExternal(Uri.parse('https://docs.autojs6.com/'));
    }

    disconnectAll() {
        const count = this.devices.devices.length;
        const reconnecting = this.devices.reconnectSessions.length;
        this.devices.devices.forEach(d => d.connectionTarget && this.forgetTarget(d.connectionTarget));
        this.devices.reconnectSessions.forEach(s => this.forgetTarget(s.target));
        this.devices.disconnectAll('user');
        vscode.window.showInformationMessage(count > 0 || reconnecting > 0
            ? `AutoJs6 已断开所有连接 (${count})${reconnecting > 0 ? `, 并停止 ${reconnecting} 个重连` : ''}`
            : 'AutoJs6 当前没有已建立的连接');
    }

    /** Retry pending reconnects now, or restore the last targets when nothing is pending. zh-CN: 立即重试重连, 无重连时恢复上次连接. */
    reconnect() {
        const sessions = this.devices.reconnectSessions;
        if (sessions.length > 0) {
            sessions.forEach(s => this.devices.retryNow(s.key));
            vscode.window.showInformationMessage(`AutoJs6: 正在重试 ${sessions.map(s => describeTarget(s.target)).join(', ')}`);
            return;
        }
        const targets = this.loadTargets().filter(t => !this.devices.hasTarget(this.toConnectionTarget(t)));
        if (targets.length === 0) {
            vscode.window.showInformationMessage('AutoJs6: 没有可恢复的连接记录');
            return;
        }
        targets.forEach(t => this.devices.startReconnect(this.toConnectionTarget(t), '手动恢复', true));
        vscode.window.showInformationMessage(`AutoJs6: 正在重新连接 ${targets.map(t => describeTarget(this.toConnectionTarget(t))).join(', ')}`);
    }

    cancelReconnect() {
        const sessions = this.devices.reconnectSessions;
        if (sessions.length === 0) {
            vscode.window.showInformationMessage('AutoJs6: 当前没有进行中的重连');
            return;
        }
        this.devices.cancelReconnect();
        vscode.window.showInformationMessage(`AutoJs6: 已停止重连 ${sessions.map(s => describeTarget(s.target)).join(', ')}`);
    }

    async disconnectDevice(arg?: { device?: Device }) {
        let targets: Device[] | undefined;
        if (arg && arg.device instanceof Device) {
            targets = [ arg.device ];
        } else {
            targets = await this.pickDevices('选择需要断开的设备');
        }
        targets?.forEach(d => d.disconnect());
    }

    async selectDevice() {
        const devices = this.devices.devices;
        const sessions = this.devices.reconnectSessions;
        if (devices.length === 0 && sessions.length === 0) {
            return this.connect();
        }
        type Item = vscode.QuickPickItem & { device?: Device; session?: ReconnectSession; action?: string };
        const items: Item[] = devices.map(d => ({ label: d.toString(), description: `AutoJs6 ${d.versionName} | 协议 v${d.protocolVersion}`, device: d }));
        sessions.forEach(s => items.push({
            label: `$(sync~spin) 重连中: ${describeTarget(s.target)}`,
            description: `第 ${s.attempts + 1} 次${s.lastError ? ` | ${s.lastError}` : ''}`,
            session: s,
        }));
        items.push({ label: '$(add) 建立新连接', action: 'connect' });
        const picked = await showPick<Item>({
            title: 'AutoJs6 设备',
            placeholder: '选择设备以查看操作',
            items,
        });
        if (typeof picked !== 'object') return;
        if (picked.action === 'connect') {
            return this.connect();
        }
        if (picked.session) {
            const session = picked.session;
            const choice = await showPick({
                title: describeTarget(session.target),
                items: [
                    { label: '$(refresh) 立即重试', action: 'retry' },
                    { label: '$(close) 停止重连', action: 'cancel' },
                ],
            });
            if (typeof choice !== 'object') return;
            if (choice.action === 'retry') {
                this.devices.retryNow(session.key);
            } else {
                this.devices.cancelReconnect(session.key);
            }
            return;
        }
        const device = picked.device!;
        const action = await showPick({
            title: device.toString(),
            items: [
                { label: '$(output) 显示日志', action: 'log' },
                { label: '$(play) 运行当前脚本', action: 'run' },
                { label: '$(save) 保存当前脚本到此设备', action: 'save' },
                { label: '$(folder) 浏览设备文件', action: 'browse' },
                { label: '$(debug-disconnect) 断开连接', action: 'disconnect' },
            ],
        });
        if (typeof action !== 'object') return;
        switch (action.action) {
            case 'log':
                this.channels.get(device.deviceId)?.show(true);
                break;
            case 'run':
                this.runOn([ device ]);
                break;
            case 'save':
                this.saveOn([ device ]);
                break;
            case 'browse':
                await vscode.commands.executeCommand('extension.remoteFiles.browse');
                break;
            case 'disconnect':
                device.disconnect();
                break;
        }
    }

    run(urlOrArgs?: string | Uri) {
        this.runOn(this.connectedDevicesOrThrow(), Extension.refinePath(urlOrArgs));
    }

    runWithoutArguments() {
        this.run(undefined);
    }

    async runOnDevice(urlOrArgs?: string | Uri) {
        const devices = await this.pickDevices('选择运行脚本的设备');
        if (devices) this.runOn(devices, Extension.refinePath(urlOrArgs));
    }

    stop(urlOrArgs?: string | Uri) {
        const fsPath = Extension.refinePath(urlOrArgs);
        const id = fsPath || this.lastActiveEditor?.document.fileName;
        if (!id) {
            throw new DeviceError('需在正在编辑的文件窗口中使用此命令');
        }
        this.devices.sendCommand('stop', { id }, this.connectedDevicesOrThrow());
    }

    stopAll() {
        this.devices.sendCommand('stopAll', {}, this.connectedDevicesOrThrow());
    }

    rerun(urlOrArgs?: string | Uri) {
        this.stop(urlOrArgs);
        setTimeout(() => {
            try {
                this.run(urlOrArgs);
            } catch (e) {
                this.reportError('rerun', e as Error);
            }
        }, 300);
    }

    save() {
        this.saveOn(this.connectedDevicesOrThrow());
    }

    async saveToDevice() {
        const devices = await this.pickDevices('选择保存脚本的设备');
        if (devices) this.saveOn(devices);
    }

    newUntitledFile() {
        vscode.commands.executeCommand('workbench.action.files.newUntitledFile');
    }

    async newProject(urlOrArgs?: string | Uri) {
        let target = Extension.refinePath(urlOrArgs);
        if (!target || !fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
            const uris = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, openLabel: '选择项目目录' });
            if (!uris || uris.length === 0) return;
            target = uris[0].fsPath;
        }
        const template = path.join(this.context.extensionPath, 'assets', 'template');
        const outUri = new ProjectTemplate(Uri.file(template), Uri.file(target)).build();
        this.replacePlaceholders(outUri);
        vscode.commands.executeCommand('vscode.openFolder', outUri, { forceNewWindow: true });
    }

    private replacePlaceholders(uri: Uri) {
        try {
            const baseName = path.basename(uri.fsPath);
            const projectJsonPath = path.join(uri.fsPath, 'project.json');
            const content = fs.readFileSync(projectJsonPath, 'utf8')
                .replace(/%PROJECT_NAME_PLACEHOLDER%/g, baseName)
                .replace(/%PACKAGE_SUFFIX_PLACEHOLDER%/g, Extension.packageNameSuffix(baseName));
            fs.writeFileSync(projectJsonPath, content, 'utf8');
        } catch (e) {
            logError('failed to replace placeholders:', e);
        }
    }

    static packageNameSuffix(name: string): string {
        if (/[一-鿿]/.test(name)) {
            name = tinyPinyin.convertToPinyin(name, '', true);
        }
        name = name.replace(/\W+/g, '_').replace(/^_+|_+$/g, '');
        if (!name) name = 'app';
        if (/^\d/.test(name)) name = `app_${name}`;
        return name.toLowerCase();
    }

    private async sendProjectCommand(command: ProjectCommand, urlOrArgs?: string | Uri, force = false) {
        let folder = Extension.refinePath(urlOrArgs);
        if (!folder) {
            const editorUri = this.lastActiveEditor?.document.uri;
            const workspaceFolder = (editorUri && vscode.workspace.getWorkspaceFolder(editorUri)) || vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                throw new DeviceError('需要一个已打开的 AutoJs6 项目');
            }
            folder = workspaceFolder.uri.fsPath;
        }
        const resolved = resolveProjectDir(folder);
        if (resolved.error) {
            throw new DeviceError(resolved.error);
        }
        folder = resolved.dir;
        if (!this.project || this.project.projectDir !== folder) {
            this.project?.dispose();
            this.project = new Project(folder);
            this.devices.setProjectFilter(this.project.fileFilter);
        }
        const devices = this.connectedDevicesOrThrow();
        const count = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `AutoJs6: 同步项目 ${path.basename(folder)}` },
            () => this.devices.sendProjectCommand(folder!, command, devices, force));
        logDebug(`${command} "${folder}" sent to ${count} device(s)`);
    }

    runProject(urlOrArgs?: string | Uri) {
        return this.sendProjectCommand('run_project', urlOrArgs);
    }

    runProjectWithoutArguments() {
        return this.runProject(undefined);
    }

    saveProject(urlOrArgs?: string | Uri) {
        return this.sendProjectCommand('save_project', urlOrArgs);
    }

    saveProjectWithoutArguments() {
        return this.saveProject(undefined);
    }

    /** Force a full re-upload, e.g. after files were removed on the device (issue #29). zh-CN: 强制全量重新同步 (issue #29). */
    async resyncProject(urlOrArgs?: string | Uri) {
        if (await confirm('确认重新完整同步项目吗', '将向设备发送项目全部文件并覆盖同名文件')) {
            return this.sendProjectCommand('save_project', urlOrArgs, true);
        }
    }
}

function findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, IP_LOOP_BACK, () => {
            const port = (server.address() as net.AddressInfo).port;
            server.close(() => resolve(port));
        });
    });
}

let extension: Extension | null = null;

// noinspection JSUnusedGlobalSymbols
export function activate(context: vscode.ExtensionContext) {
    const debugChannel = vscode.window.createOutputChannel('AutoJs6 VSCode Extension Debug');
    context.subscriptions.push(debugChannel);
    initLogger(debugChannel, () => Settings.debugLog);
    logDebug(`extension "${EXTENSION_NAME}" is activating on ${os.platform()} ${os.release()}`);
    extension = new Extension(context);
    context.subscriptions.push(extension);
    logDebug(`extension "${EXTENSION_NAME}" is now active`);
}

// noinspection JSUnusedGlobalSymbols
export function deactivate() {
    extension?.dispose();
    extension = null;
}

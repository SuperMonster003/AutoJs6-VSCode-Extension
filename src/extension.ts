'use strict';

import * as crypto from 'crypto';
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
import { CLOSE_REASON, ConnectionTarget, ConnectionType, describeTarget, Device, DeviceCommandParam, DeviceError, Devices, PairingHandler, PairingVerdict, ProjectCommand, ReconnectSession, targetKey } from './device';
import { DeviceDiscovery } from './discovery';
import { DeviceChannels, initLogger, logDebug, logError } from './logger';
import { Project, ProjectTemplate, resolveProjectDir } from './project';
import { applyPull, pickChanges } from './pull';
import { planPull } from './pullCore';
import { parseEndpoint, toPosixPath } from './protocol';
import { QrCodePanel } from './qrcode';
import { DeviceFilesTreeProvider, DevicesTreeProvider, REMOTE_SCHEME, RemoteFileCommands, RemoteFileSystemProvider, remoteUri } from './remoteFs';
import { Settings } from './settings';
import { confirm, pickNetworkInterface, showErrorWithAction, showMultiPick, showPick } from './ui';
import { setLanguage, t } from './i18n';

const EXTENSION_NAME = 'AutoJs6 VSCode Extension';
const IP_LOOP_BACK = '127.0.0.1';
const IP_UNIVERSAL = '0.0.0.0';
const STORAGE_KEY_RECORDS = 'autojs6.devices';
const STORAGE_KEY_TARGETS = 'autojs6.lastTargets';
const STORAGE_KEY_TRUSTED = 'autojs6.trustedDevices';
/** Lifetime of a QR pairing token. zh-CN: 二维码配对令牌有效期. */
const QR_TOKEN_TTL_MS = 10 * 60_000;
/** No answer to the pairing prompt counts as deny. zh-CN: 配对提示超时视为拒绝. */
const PAIRING_PROMPT_TIMEOUT_MS = 90_000;
/** How long the LAN picker shows the busy indicator while browsing mDNS. zh-CN: 局域网选择器显示搜索状态的时长. */
const DISCOVERY_BUSY_MS = 8_000;
const STORAGE_IP_BLACKLIST = [ IP_LOOP_BACK, IP_UNIVERSAL ];

const PREFIX = {
    connect: `[ ${t('Connect')} ]`,
    discovered: `[ ${t('Found')} ]`,
    clear: `[ ${t('Clear')} ]`,
    record: `[ ${t('History')} ]`,
    optional: `[ ${t('Optional')} ]`,
};

const LABEL = {
    ajClientLan: `${PREFIX.connect} - ${t('Server mode | LAN')}`,
    ajClientQr: `${PREFIX.connect} - ${t('Server mode | QR code')}`,
    ajServerLan: `${PREFIX.connect} - ${t('Client mode | LAN')}`,
    ajServerAdb: `${PREFIX.connect} - ${t('Client mode | ADB')}`,
    recordClear: `${PREFIX.clear} - ${t('IP address history')}`,
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
/** A device the person chose to remember (roadmap 4.4). zh-CN: 用户选择记住的设备 (roadmap 4.4). */
interface TrustedDevice {
    name: string;
    ts: number;
}

interface LanPickItem extends vscode.QuickPickItem {
    endpoint?: string;
    clear?: boolean;
}

function lanItemMatches(item: vscode.QuickPickItem, value: string): boolean {
    const v = value.toLowerCase();
    return [ item.label, item.description, item.detail ].some(s => !!s && s.toLowerCase().includes(v));
}

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

export class Extension implements vscode.Disposable, PairingHandler {

    static readonly commands: Array<keyof Extension> = [
        'viewDocument', 'connect', 'disconnectAll', 'disconnectDevice', 'selectDevice', 'showQrCode',
        'run', 'runWithoutArguments', 'runOnDevice', 'stop', 'stopAll', 'rerun',
        'save', 'saveToDevice', 'newUntitledFile', 'newProject',
        'runProject', 'runProjectWithoutArguments', 'saveProject', 'saveProjectWithoutArguments', 'resyncProject', 'pullProject',
        'reconnect', 'cancelReconnect', 'manageTrustedDevices',
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
        this.devices.pairing = this;
        this.restoreConnections();
    }

    /* Lifecycle. zh-CN: 生命周期. */

    private startServers() {
        const port = Settings.serverPort;
        this.devices.startServer(port).then(() => this.updateStatusBar()).catch((e: NodeJS.ErrnoException) => {
            const hint = e.code === 'EADDRINUSE'
                ? t('Port {0} is already in use (probably another VSCode window). AutoJs6 client mode cannot connect to this window; the other connection methods still work.', port)
                : t('Cannot listen on port {0}: {1}', port, e.message);
            showErrorWithAction(`AutoJs6: ${hint}`, t('Change Port'), () => vscode.commands.executeCommand('workbench.action.openSettings', 'autojs6.server.port'));
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
        if (setLanguage(Settings.language)) {
            // Strings computed at activation (view titles, pick prefixes) only follow after a reload.
            // zh-CN: 激活时已计算的字符串 (视图标题, 选择项前缀) 需重新加载窗口后才会切换.
            vscode.window.showInformationMessage(
                t('The display language of the AutoJs6 extension has changed. Reload the window to apply it everywhere.'),
                t('Reload Window'),
            ).then((choice) => {
                if (choice) {
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
                }
            });
        }
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
                if (device.rejectKind === 'version') {
                    showErrorWithAction(message, t('View Releases'), () => vscode.env.openExternal(Uri.parse('https://github.com/SuperMonster003/AutoJs6/releases/')));
                } else {
                    vscode.window.showWarningMessage(message);
                }
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
        const willReconnect = this.devices.shouldReconnect(device);
        const silent = reason === CLOSE_REASON.SHUTDOWN || reason === CLOSE_REASON.REPLACED;
        if (!silent) {
            const detail = reason && reason !== CLOSE_REASON.USER ? ` (${reason})` : '';
            vscode.window.showInformationMessage(t('AutoJs6 device disconnected: {0}{1}{2}', String(device), detail, willReconnect ? t(', reconnecting automatically') : ''));
        }
        this.channels.onDisconnect(device.deviceId, device.toString());
        this.releaseAdbForward(device);
        // An explicit disconnect on either side must not be restored later (respect the user's intent).
        // zh-CN: 任一侧显式断开的连接不再恢复 (尊重用户意愿).
        if (device.connectionTarget && (reason === CLOSE_REASON.USER || device.peerByeReason === 'user' || device.rejectKind === 'version')) {
            this.forgetTarget(device.connectionTarget);
        }
        this.updateStatusBar();
    }

    private onReconnectFailed(target: ConnectionTarget, lastError: string, session: ReconnectSession) {
        const name = describeTarget(target);
        const retry = t('Retry');
        const forget = t('Stop Restoring');
        vscode.window.showWarningMessage(t('AutoJs6: could not reconnect to {0} (tried {1} times, last error: {2}); giving up', name, session.attempts, lastError || t('unknown')), retry, forget).then((choice) => {
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
        vscode.window.showInformationMessage(t('AutoJs6 device connected: {0}', String(device)));
        this.updateStatusBar();
    }

    private onDeviceCommand(device: Device, param: DeviceCommandParam) {
        const cmd = param?.['\xa0cmd\xa0'];
        if (!DEVICE_TRIGGERABLE_COMMANDS.has(cmd)) {
            vscode.window.showErrorMessage(t('Unknown command "{0}" from {1}', cmd, String(device)));
            return;
        }
        vscode.window.showInformationMessage(t('Running command "{0}" from {1}', cmd, String(device)));
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
            vscode.window.showErrorMessage(t('Unknown HTTP command "{0}"', cmd));
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
        const fsProvider = this.fsProvider = new RemoteFileSystemProvider(this.devices);
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
            this.statusBar.text = sessions.length > 0 ? `$(sync~spin) ${t('AutoJs6: reconnecting ({0})', sessions.length)}` : `$(device-mobile) ${t('AutoJs6: no device')}`;
            lines.push(this.devices.isListening
                ? t('AutoJs6: no device connected. Listening on port {0}. Click to connect.', this.devices.listeningPort)
                : t('AutoJs6: no device connected. Port {0} is not listening. Click to connect.', Settings.serverPort));
        } else {
            this.statusBar.text = sessions.length > 0 ? `$(sync~spin) AutoJs6: ${count}` : `$(device-mobile) AutoJs6: ${count}`;
            lines.push(t('AutoJs6 connected devices:'), ...this.devices.devices.map(d => `- ${d} [${d.versionName}]`));
        }
        if (sessions.length > 0) {
            lines.push(t('Reconnecting:'), ...sessions.map(s => `- ${describeTarget(s.target)} (${t('attempt {0}', s.attempts + 1)}${s.lastError ? `, ${s.lastError}` : ''})`));
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
        return Array.isArray(raw) ? raw.filter(target => target && typeof target.host === 'string' && typeof target.port === 'number') : [];
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
        const targets = this.loadTargets().filter(target => Extension.savedKey(target) !== key);
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
        const kept = targets.filter(target => Extension.savedKey(target) !== key);
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
                this.devices.startReconnect(this.toConnectionTarget(saved), t('restore last connection'), true);
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
            throw new DeviceError(t('Use this command in an open editor'));
        }
        return editor;
    }

    private fsProvider!: RemoteFileSystemProvider;

    private connectedDevicesOrThrow(): Device[] {
        if (!this.devices.hasDevices()) {
            throw new DeviceError(t('No connected device'));
        }
        return this.devices.devices;
    }

    private async pickDevice(title: string): Promise<Device | undefined> {
        const devices = this.connectedDevicesOrThrow();
        if (devices.length === 1) {
            return devices[0];
        }
        const picked = await showPick({
            title,
            placeholder: t('Pick a device'),
            items: devices.map(d => ({ label: d.toString(), description: `AutoJs6 ${d.versionName}`, device: d })),
        });
        return picked && typeof picked === 'object' ? picked.device : undefined;
    }

    private async pickDevices(title: string): Promise<Device[] | undefined> {
        const devices = this.connectedDevicesOrThrow();
        if (devices.length === 1) {
            return devices;
        }
        const picked = await showMultiPick({
            title,
            placeholder: t('Check one or more devices, then press Enter'),
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
            throw new DeviceError(t('Save remote files with the regular VSCode save command'));
        }
        const payload = this.payloadFromEditor(editor);
        const count = this.devices.sendCommand('save', payload, devices);
        vscode.window.showInformationMessage(t('Sent "{0}" to {1} device(s)', payload.path || payload.name, count));
    }

    /* Connection. zh-CN: 连接. */

    async connect() {
        const interfaces = util.getBasicNetworkInterfaces();
        const title = interfaces.length > 0 ? t('Active IP: {0}', interfaces.map(o => o.ip4).join(', ')) : t('No usable LAN IP address found');
        const picked = await showPick({
            title,
            placeholder: t('Type or pick how to connect'),
            items: [
                { label: LABEL.ajClientLan, detail: t('AutoJs6 (client mode) connects to this PC; enter the IP address of this PC in AutoJs6') },
                { label: LABEL.ajClientQr, detail: t('AutoJs6 (client mode) scans a QR code and connects to this PC') },
                { label: LABEL.ajServerLan, detail: t('This PC connects to AutoJs6 (server mode); enter the device IP address or host name') },
                { label: LABEL.ajServerAdb, detail: t('This PC connects to AutoJs6 (server mode) over USB (ADB)') },
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
            throw new DeviceError(t('Port {0} is not listening (probably taken by another window); change autojs6.server.port or use another connection method', Settings.serverPort));
        }
        if (interfaces.length === 0) {
            throw new DeviceError(t('No usable LAN IP address found'));
        }
        const ni = await pickNetworkInterface(interfaces);
        if (ni) {
            vscode.window.showInformationMessage(t('Enable client mode in the AutoJs6 drawer and connect to {0}', `${ni.ip4}:${this.devices.listeningPort}`), t('Show QR Code'))
                .then(choice => choice && this.showQrCode(ni.ip4));
        }
    }

    async showQrCode(preferredIp?: string) {
        if (!this.devices.isListening) {
            throw new DeviceError(t('Port {0} is not listening (probably taken by another window); change autojs6.server.port or use another connection method', Settings.serverPort));
        }
        await QrCodePanel.show(this.context, this.devices.listeningPort, util.getBasicNetworkInterfaces(), typeof preferredIp === 'string' ? preferredIp : undefined, () => this.issueQrToken());
    }

    /**
     * LAN connect picker: devices discovered via mDNS (roadmap 3.10) first, then saved records; typed input is
     * accepted as `host[:port]`.
     * zh-CN: 局域网连接选择器: 先列出 mDNS 发现的设备 (roadmap 3.10), 再列出历史记录; 也接受手动输入 `host[:port]`.
     */
    private async connectToServerLanFlow() {
        const records = this.loadRecords();
        const recordItems: LanPickItem[] = records.map(r => ({
            label: `${PREFIX.record} - ${r.ip}`,
            detail: r.ts ? t('Last connected: {0}', util.formatTimestamp(r.ts)) : undefined,
            endpoint: r.ip,
        }));
        if (records.length > 0) {
            recordItems.push({ label: LABEL.recordClear, detail: t('Remove all locally saved IP addresses'), clear: true });
        }
        const discovery = Settings.discoveryEnabled ? new DeviceDiscovery() : null;
        const searching: LanPickItem = {
            label: `$(search) ${t('Searching for AutoJs6 devices on the LAN...')}`,
            detail: t('Needs AutoJs6 6.8.0+ with server mode and its "LAN discovery" option enabled; an address can also be typed'),
            alwaysShow: true,
        };
        const pick = vscode.window.createQuickPick<LanPickItem>();
        pick.title = t('Connect to AutoJs6 Server');
        pick.placeholder = t('Type an IP address or host name (optionally with a port, default {0}), then press Enter to connect', Settings.clientPort);
        pick.matchOnDescription = true;
        pick.matchOnDetail = true;
        pick.ignoreFocusOut = true;
        const build = () => {
            const found = discovery ? discovery.list() : [];
            const items: LanPickItem[] = found.map(d => ({
                label: `${PREFIX.discovered} - ${d.name}`,
                description: `${d.host}:${d.port}`,
                detail: `${t('Found on the LAN (mDNS)')}${d.version ? `, AutoJs6 ${d.version}` : ''}`,
                endpoint: `${d.host}:${d.port}`,
            }));
            if (discovery && found.length === 0 && pick.busy) {
                items.push(searching);
            }
            pick.items = items.concat(recordItems);
        };
        pick.busy = !!discovery;
        build();
        discovery?.start(() => build());
        const busyTimer = setTimeout(() => {
            pick.busy = false;
            build();
        }, DISCOVERY_BUSY_MS);
        const picked = await new Promise<LanPickItem | string | undefined>((resolve) => {
            pick.onDidAccept(() => {
                const value = pick.value.trim();
                const selected = pick.selectedItems[0];
                if (value && (!selected || !lanItemMatches(selected, value))) {
                    resolve(value);
                } else if (selected && selected !== searching) {
                    resolve(selected);
                }
            });
            pick.onDidHide(() => resolve(undefined));
            pick.show();
        });
        clearTimeout(busyTimer);
        discovery?.stop();
        pick.dispose();
        if (picked === undefined) return;
        if (typeof picked === 'string') return this.connectToServerLan(picked);
        if (picked.clear) {
            if (await confirm(t('Clear all saved records?'))) {
                this.saveRecords([]);
                vscode.window.showInformationMessage(t('Cleared {0} record(s)', records.length));
            }
            return;
        }
        if (picked.endpoint) return this.connectToServerLan(picked.endpoint);
    }

    async connectToServerLan(input: string) {
        const endpoint = parseEndpoint(input, Settings.clientPort);
        if (!endpoint) {
            throw new DeviceError(t('Cannot connect to the AutoJs6 server: invalid address "{0}"', input));
        }
        const target = this.createLanTarget(endpoint.host, endpoint.port);
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Connecting to the AutoJs6 server ({0})...', `${endpoint.host}:${endpoint.port}`) }, async () => {
            try {
                await this.devices.connectTo(target);
            } catch (e) {
                if (e instanceof DeviceError && e.device) {
                    vscode.window.showWarningMessage(e.message);
                    return;
                }
                logError(e);
                showErrorWithAction(t('Cannot connect to the AutoJs6 server ({0}): {1}', `${endpoint.host}:${endpoint.port}`, (e as Error).message), t('Troubleshoot'), () => {
                    vscode.window.showInformationMessage(t('AutoJs6 server connection diagnostics'), {
                        modal: true,
                        detail: [
                            t('Check that "Server mode" is enabled in the AutoJs6 drawer'),
                            t('Check that both devices are on the same LAN'),
                            t('Check that the firewall on the AutoJs6 device allows TCP port {0}', endpoint.port),
                            t('Try another connection method (ADB or QR code)'),
                        ].map(s => `- ${s}`).join('\n'),
                    });
                });
            }
        });
    }

    /* Pairing (roadmap 4.4): QR tokens, trusted devices and the confirmation prompt. zh-CN: 配对: 二维码令牌 / 已信任设备 / 确认提示. */

    private readonly qrTokens = new Map<string, number>();

    /** Issue a one-time token for the connection QR code. zh-CN: 为连接二维码签发一次性令牌. */
    issueQrToken(): string {
        this.pruneQrTokens();
        const token = crypto.randomBytes(9).toString('base64url');
        this.qrTokens.set(token, Date.now() + QR_TOKEN_TTL_MS);
        return token;
    }

    private pruneQrTokens() {
        const now = Date.now();
        for (const [ token, expiry ] of this.qrTokens) {
            if (expiry <= now) {
                this.qrTokens.delete(token);
            }
        }
    }

    consumeToken(token: string, device: Device): boolean {
        this.pruneQrTokens();
        if (!this.qrTokens.has(token)) {
            logDebug(`unknown or expired QR token from ${device}`);
            return false;
        }
        this.qrTokens.delete(token);
        logDebug(`QR token accepted from ${device}`);
        return true;
    }

    private loadTrusted(): Record<string, TrustedDevice> {
        return this.context.globalState.get<Record<string, TrustedDevice>>(STORAGE_KEY_TRUSTED, {}) || {};
    }

    isTrusted(device: Device): boolean {
        return !!device.deviceId && !!this.loadTrusted()[device.deviceId];
    }

    remember(device: Device): void {
        if (!device.deviceId) return;
        const trusted = this.loadTrusted();
        trusted[device.deviceId] = { name: device.name, ts: Date.now() };
        this.context.globalState.update(STORAGE_KEY_TRUSTED, trusted);
    }

    /**
     * Ask the person whether an unknown device may connect; dismissing the prompt or ignoring it for
     * `PAIRING_PROMPT_TIMEOUT_MS` counts as deny.
     * zh-CN: 询问用户是否允许未知设备连接; 关闭提示或超时未响应视为拒绝.
     */
    confirm(device: Device): Promise<PairingVerdict> {
        if (!Settings.confirmUnknownDevices) {
            return Promise.resolve('allow');
        }
        const trust = t('Allow and Remember');
        const once = t('Allow Once');
        const deny = t('Deny');
        return new Promise<PairingVerdict>((resolve) => {
            let settled = false;
            const finish = (verdict: PairingVerdict) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(verdict);
            };
            const timer = setTimeout(() => finish('deny'), PAIRING_PROMPT_TIMEOUT_MS);
            const message = t('AutoJs6 device "{0}" ({1}) wants to connect to this PC ({2}, ID {3}). Devices that scan the QR code do not need approval.', device.name, device.remoteAddress, device.versionName || t('unknown version'), device.deviceId.slice(0, 8) || '?');
            vscode.window.showInformationMessage(message, trust, once, deny).then(
                (choice) => finish(choice === trust ? 'trust' : choice === once ? 'allow' : 'deny'),
                () => finish('deny'),
            );
        });
    }

    /** List trusted devices and remove the selected ones. zh-CN: 列出已信任设备并移除所选项. */
    async manageTrustedDevices() {
        const trusted = this.loadTrusted();
        const ids = Object.keys(trusted).sort((a, b) => (trusted[b].ts || 0) - (trusted[a].ts || 0));
        if (ids.length === 0) {
            vscode.window.showInformationMessage(t('No trusted AutoJs6 device yet (devices that scanned the QR code or were allowed with "Allow and Remember" appear here)'));
            return;
        }
        const picked = await showMultiPick({
            title: t('Trusted AutoJs6 Devices'),
            placeholder: t('Check the devices to remove, then press Enter'),
            items: ids.map(id => ({ label: trusted[id].name || id, description: id, detail: t('Trusted since: {0}', util.formatTimestamp(trusted[id].ts)) })),
        });
        if (!picked || picked.length === 0) return;
        picked.forEach(item => delete trusted[item.description || '']);
        await this.context.globalState.update(STORAGE_KEY_TRUSTED, trusted);
        vscode.window.showInformationMessage(t('Removed trust from {0} device(s); they will be asked again next time', picked.length));
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
                    throw new DeviceError(t('ADB device {0} is not connected', adbDeviceId));
                }
                if (info.state !== 'device') {
                    throw new DeviceError(t('ADB device {0} is in state {1}', adbDeviceId, info.state));
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
                showErrorWithAction(t('adb seems to be missing or misconfigured; set its path in autojs6.adb.path'), t('Open Settings'), () => {
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
                ? t('No usable ADB device ({0}); confirm the USB debugging prompt on the device', offline.map(d => `${d.id}: ${d.state}`).join(', '))
                : t('No device connected over ADB'));
        }
        const picked = await showPick({
            title: t('Connect to AutoJs6 Server (ADB)'),
            placeholder: t('Pick the device to connect, then press Enter'),
            items: online.map(d => ({ label: d.name, detail: t('Model: {0}, product: {1}', d.model, d.product), adb: d })),
        });
        if (typeof picked !== 'object') return;
        const dev = picked.adb;
        const target = this.createAdbTarget(dev.id, dev.name);
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Connecting to {0} over ADB...', dev.name) }, async () => {
            try {
                await this.devices.connectTo(target);
            } catch (e) {
                if (e instanceof DeviceError && e.device) {
                    vscode.window.showWarningMessage(e.message);
                    return;
                }
                logError(e);
                vscode.window.showErrorMessage(t('Cannot connect to {0} over ADB: {1}. Make sure "Server mode" is enabled in the AutoJs6 drawer', dev.name, (e as Error).message));
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
            ? `${t('AutoJs6: disconnected all connections ({0})', count)}${reconnecting > 0 ? t(', stopped {0} reconnect session(s)', reconnecting) : ''}`
            : t('AutoJs6: no active connection'));
    }

    /** Retry pending reconnects now, or restore the last targets when nothing is pending. zh-CN: 立即重试重连, 无重连时恢复上次连接. */
    reconnect() {
        const sessions = this.devices.reconnectSessions;
        if (sessions.length > 0) {
            sessions.forEach(s => this.devices.retryNow(s.key));
            vscode.window.showInformationMessage(t('AutoJs6: retrying {0}', sessions.map(s => describeTarget(s.target)).join(', ')));
            return;
        }
        const targets = this.loadTargets().filter(target => !this.devices.hasTarget(this.toConnectionTarget(target)));
        if (targets.length === 0) {
            vscode.window.showInformationMessage(t('AutoJs6: no connection to restore'));
            return;
        }
        targets.forEach(target => this.devices.startReconnect(this.toConnectionTarget(target), t('manual restore'), true));
        vscode.window.showInformationMessage(t('AutoJs6: reconnecting to {0}', targets.map(target => describeTarget(this.toConnectionTarget(target))).join(', ')));
    }

    cancelReconnect() {
        const sessions = this.devices.reconnectSessions;
        if (sessions.length === 0) {
            vscode.window.showInformationMessage(t('AutoJs6: no reconnect in progress'));
            return;
        }
        this.devices.cancelReconnect();
        vscode.window.showInformationMessage(t('AutoJs6: stopped reconnecting to {0}', sessions.map(s => describeTarget(s.target)).join(', ')));
    }

    async disconnectDevice(arg?: { device?: Device }) {
        let targets: Device[] | undefined;
        if (arg && arg.device instanceof Device) {
            targets = [ arg.device ];
        } else {
            targets = await this.pickDevices(t('Pick the devices to disconnect'));
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
        const items: Item[] = devices.map(d => ({ label: d.toString(), description: `AutoJs6 ${d.versionName} | ${t('protocol v{0}', d.protocolVersion)}`, device: d }));
        sessions.forEach(s => items.push({
            label: `$(sync~spin) ${t('Reconnecting: {0}', describeTarget(s.target))}`,
            description: `${t('attempt {0}', s.attempts + 1)}${s.lastError ? ` | ${s.lastError}` : ''}`,
            session: s,
        }));
        items.push({ label: `$(add) ${t('New Connection')}`, action: 'connect' });
        const picked = await showPick<Item>({
            title: t('AutoJs6 Devices'),
            placeholder: t('Pick a device to see its actions'),
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
                    { label: `$(refresh) ${t('Retry Now')}`, action: 'retry' },
                    { label: `$(close) ${t('Stop Reconnecting')}`, action: 'cancel' },
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
                { label: `$(output) ${t('Show Log')}`, action: 'log' },
                { label: `$(play) ${t('Run Current Script')}`, action: 'run' },
                { label: `$(save) ${t('Save Current Script to This Device')}`, action: 'save' },
                { label: `$(folder) ${t('Browse Device Files')}`, action: 'browse' },
                { label: `$(debug-disconnect) ${t('Disconnect')}`, action: 'disconnect' },
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
        const devices = await this.pickDevices(t('Pick the devices to run the script on'));
        if (devices) this.runOn(devices, Extension.refinePath(urlOrArgs));
    }

    stop(urlOrArgs?: string | Uri) {
        const fsPath = Extension.refinePath(urlOrArgs);
        const id = fsPath || this.lastActiveEditor?.document.fileName;
        if (!id) {
            throw new DeviceError(t('Use this command in an open editor'));
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
        const devices = await this.pickDevices(t('Pick the devices to save the script to'));
        if (devices) this.saveOn(devices);
    }

    newUntitledFile() {
        vscode.commands.executeCommand('workbench.action.files.newUntitledFile');
    }

    async newProject(urlOrArgs?: string | Uri) {
        let target = Extension.refinePath(urlOrArgs);
        if (!target || !fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
            const uris = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, openLabel: t('Select Project Folder') });
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

    /** Resolve the project folder of a command and (re)load its `project.json`. zh-CN: 解析命令对应的项目目录并 (重新) 加载 project.json. */
    private prepareProject(urlOrArgs?: string | Uri): string {
        let folder = Extension.refinePath(urlOrArgs);
        if (!folder) {
            const editorUri = this.lastActiveEditor?.document.uri;
            const workspaceFolder = (editorUri && vscode.workspace.getWorkspaceFolder(editorUri)) || vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                throw new DeviceError(t('An open AutoJs6 project is required'));
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
        return folder;
    }

    private async sendProjectCommand(command: ProjectCommand, urlOrArgs?: string | Uri, force = false) {
        const folder = this.prepareProject(urlOrArgs);
        const devices = this.connectedDevicesOrThrow();
        const count = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: t('AutoJs6: syncing project {0}', path.basename(folder)) },
            () => this.devices.sendProjectCommand(folder, command, devices, force));
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
        if (await confirm(t('Resync the whole project?'), t('All project files will be sent to the device, overwriting files with the same name'))) {
            return this.sendProjectCommand('save_project', urlOrArgs, true);
        }
    }

    /**
     * Pull files added or modified on the device back into the local project, with a per-file diff preview
     * (roadmap 5.7). Files that only exist locally are reported, never deleted.
     * zh-CN: 将设备端新增 / 修改的文件拉回本地项目, 支持逐文件差异预览 (roadmap 5.7). 仅本地存在的文件只做提示, 不会删除.
     */
    async pullProject(urlOrArgs?: string | Uri) {
        const folder = this.prepareProject(urlOrArgs);
        const name = path.basename(folder);
        const device = await this.pickDevice(t('Pick the device to pull changes of project {0} from', name));
        if (!device) return;
        const readRemote = (remotePath: string) => this.fsProvider.readFile(remoteUri(device, remotePath));
        const plan = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t('Comparing project {0} with its copy on {1}...', name, device.name) },
            () => planPull(device, folder, this.project?.fileFilter || null, readRemote),
        );
        const missing = plan.missingOnDevice.length > 0 ? t('; {0} local file(s) do not exist on the device (left untouched)', plan.missingOnDevice.length) : '';
        if (plan.changes.length === 0) {
            vscode.window.showInformationMessage(t('Project {0} on {1} matches the local copy ({2} file(s) compared{3})', name, device.name, plan.scanned, missing));
            return;
        }
        const picked = await pickChanges(device, folder, plan);
        if (!picked || picked.length === 0) return;
        const count = await applyPull(device, folder, picked, readRemote);
        vscode.window.showInformationMessage(t('Pulled {0} file(s) from {1} into project {2}{3}', count, device.name, name, missing));
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

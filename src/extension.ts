'use strict';

import * as net from 'net';
import * as path from 'path';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as util from './util';
import * as querystring from 'querystring';

import i18n from './i18n';

import { Adb } from './adb';
import { Memento, TextEditor, OutputChannel, Uri, Disposable, QuickInputButton, ThemeIcon } from 'vscode';
import { AddressInfo } from 'net';
import { awaiter } from './awaiter';
import { Devices, Device, DeviceInfo, LogData, HTTP_SERVER_PORT } from './device';
import { Project, ProjectTemplate } from './project';
import { SpawnSyncReturns } from 'child_process';
import { logDebug } from './util';
import * as http from 'http';
import * as url from 'url';
import EventEmitter = require('events');

let recentDevice = null;
let extension: Extension = null;

export let connectedServerAdb: Set<string> = new Set();
export let connectedServerLan: Set<string> = new Set();

const deviceChannel: { [prop: string]: OutputChannel } = {};
const regexIpAddress = /^((25[0-5]|(2[0-4]|1\d|[1-9]|)\d)\.?\b){4}(:\d+)?$/;
const storageIpAddressBlacklist = [
    '127.0.0.1',
    '0.0.0.0',
];

const LOOP_BACK: string = '127.0.0.1';
const EXTENSION_NAME: string = 'AutoJs6 VSCode Extension';
const DEFAULT_QUICK_PICK_PLACEHOLDER = '输入或选择连接建立方式';
const STRING_YES = '是 (Yes)';
const STRING_NO = '否 (No)';

export const CONNECTION_TYPE_CLIENT_LAN = 0;
export const CONNECTION_TYPE_SERVER_LAN = 1;
export const CONNECTION_TYPE_SERVER_ADB = 2;

const pickButtons: {
    close: QuickInputButton;
} = {
    close: {
        iconPath: new ThemeIcon('close'),
        tooltip: i18n.close,
    },
};

// @Reference to AutoX by SuperMonster003 on Jun 11, 2023.
class AJHttpServer extends EventEmitter {
    public isHttpServerStarted = false;
    private httpServer: http.Server;
    private port: number;

    constructor(port: number) {
        super();
        this.port = port;
        this.httpServer = http.createServer((request, response) => {
            console.log('Received request for ' + request.url);

            let urlObj = url.parse(request.url);
            let queryObjRaw = urlObj.query;
            let queryObj = querystring.parse(queryObjRaw);

            // let urlObj = new url.URL(request.url);
            // let queryObjRaw = urlObj.searchParams;
            // let queryObj: {[prop in keyof AJHttpServerParamList]: string} = {
            //     cmd: queryObjRaw.get('cmd'),
            //     path: queryObjRaw.get('path'),
            // };

            console.log(queryObj);
            console.log(urlObj.pathname);

            if (urlObj.pathname == '/exec') {
                response.writeHead(200);
                response.end('this command is:' + queryObj.cmd + '-->' + queryObj.path);
                this.emit('cmd', queryObj.cmd, queryObj.path);
                console.log(queryObj.cmd, queryObj.path);
            } else {
                response.writeHead(404);
                response.end();
            }
        });
        this.httpServer.listen(port, '0.0.0.0', () => {
            this.isHttpServerStarted = true;
            const address: any = this.httpServer.address();
            // var localAddress = this.getIPAddress();
            console.log(`server listening on port ${address.port}`);
            this.emit('connect');
        });
    }
}

export class Extension {
    private readonly context: vscode.ExtensionContext;
    private readonly storageKey: string = 'autojs6.devices';
    readonly picker = {
        operations: {
            connect: '连接',
            clear: '清理',
            record: '记录',
        },
        commands: {
            'empty': '',
            'c/s': 'AutoJs6 (客户端) > VSCode (服务端)',
            's/c': 'AutoJs6 (服务端) < VSCode (客户端)',
            'record': '本地 IP 地址记录',
        },
        agents: {
            'lan': '局域网',
            'adb/usb': 'ADB (USB)',
        },
    };
    private readonly picks: { [prop in string]: vscode.QuickPickItem } = {
        ajClientLan: this.newPicker('connect', 'c/s', 'lan', 'AutoJs6 作为客户端主动连接 VSCode (使用 IP 地址)'),
        ajServerLan: this.newPicker('connect', 's/c', 'lan', 'VSCode 主动连接作为服务端的 AutoJs6 (使用 IP 地址)'),
        ajServerAdb: this.newPicker('connect', 's/c', 'adb/usb', 'VSCode 主动连接作为服务端的 AutoJs6 (使用 USB 线缆)'),
        recordClear: this.newPicker('clear', 'record', null, '清除保存在本地的全部 IP 地址记录'),
        recordPrefix: this.newPicker('record', 'empty', null, 'VSCode 使用 IP 地址 %s 主动连接作为服务端的 AutoJs6'),
    };
    static readonly commands: Array<keyof Extension> = [
        'viewDocument', 'connect', 'disconnectAll', 'run', 'runOnDevice', 'stop',
        'stopAll', 'rerun', 'save', 'saveToDevice', 'newProject', 'runProject', 'saveProject',
    ];

    private adb: Adb;
    private client: Devices;
    private storage: Memento;
    private lastActiveEditor: TextEditor;

    constructor(context: vscode.ExtensionContext, extensionScope: any) {
        this.context = context;
        this.storage = this.getWrappedGlobalState();

        this.initActiveEditor();
        this.initAdb(context.extensionPath, 'tools');
        this.initClient();
        this.registerCommands();

        extensionScope.deactivate = this.disconnectAll.bind(this);
    }

    private static connectToLocalHint() {
        vscode.window.showInformationMessage(`在 AutoJs6 侧拉菜单开启客户端模式并连接至 ${util.getNicAddress()}`);
    }

    private newPicker(operation: string, command: string, agent: string, detail: string): vscode.QuickPickItem {
        let label = `[ ${this.picker.operations[operation]} ]`;

        if (typeof command === 'string') {
            label += ` - ${this.picker.commands[command]}`;
        }

        if (typeof agent === 'string') {
            label += ` | ${this.picker.agents[agent]}`;
        }

        return { label, detail };
    }

    private runFile(url?) {
        this.runFileOn(this.client, url);
    }

    private runFileOn(client: Devices, url?) {
        if (!client.hasDevices()) {
            vscode.window.showErrorMessage('未发现已连接的设备');
            return;
        }
        let fileName: string;
        let script: string;
        if (url == null) {
            let editor = this.lastActiveEditor;
            if (!editor) {
                vscode.window.showErrorMessage('需在正在编辑的文件窗口中使用运行命令');
                return;
            }
            fileName = editor.document.fileName;
            script = editor.document.getText();
        } else {
            try {
                fileName = Uri.parse(url).fsPath;
                script = fs.readFileSync(fileName, 'utf8');
            } catch (error) {
                logDebug(error);
            }
        }
        client.sendCommand('run', {
            id: fileName,
            name: fileName,
            script: script,
        });
    }

    private initActiveEditor() {
        this.lastActiveEditor = vscode.window.activeTextEditor;
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor && editor.document.uri.scheme !== 'output') {
                this.lastActiveEditor = editor;
            }
        });
    }

    private initAdb(...path: string[]) {
        this.adb = new Adb(path.join(...path));
    }

    private initClient() {
        this.client = new Devices()
            .on('new_device', (device: Device, type: number) => {
                let newDeviceIp = device.connection.remoteAddress?.replace(/.*?:?((\d+\.){3}\d+$)/, '$1');
                device.host = newDeviceIp;
                logDebug('new device host', newDeviceIp);

                let storageDataRaw = this.storage.get(this.storageKey, []);
                logDebug('storage data', storageDataRaw);
                let isUpdated = false;

                const prefixRecord = `[ ${this.picker.operations.record} ] - `;

                for (let i = 0; i < storageDataRaw.length; i += 1) {
                    let data = storageDataRaw[i];
                    let [ ip ] = data.split('|');
                    ip = ip.replace(prefixRecord, '');
                    if (ip === newDeviceIp) {
                        let newData = [ ip, Date.now() ].join('|');
                        storageDataRaw.splice(i, 1);
                        storageDataRaw.unshift(newData);
                        this.storage.update(this.storageKey, storageDataRaw);

                        isUpdated = true;

                        /* No break, for removing duplication. */
                        // break;
                    }
                }
                if (!isUpdated) {
                    if (!storageIpAddressBlacklist.includes(newDeviceIp)) {
                        storageDataRaw.unshift([ newDeviceIp, Date.now() ].join('|'));
                        this.storage.update(this.storageKey, storageDataRaw);
                    }
                }

                let devChn = deviceChannel[device.deviceId];
                if (!devChn) {
                    devChn = vscode.window.createOutputChannel(`Channel for (${device})`);
                    deviceChannel[device.deviceId] = devChn;
                }
                devChn.show(true);
                vscode.window.showInformationMessage(`AutoJs6 设备接入: ${device}`);
                if (type === CONNECTION_TYPE_SERVER_ADB) {
                    connectedServerAdb.add(device.adbDeviceId);
                } else if (type === CONNECTION_TYPE_SERVER_LAN) {
                    connectedServerLan.add(device.host);
                }
                logDebug(connectedServerAdb);
                logDebug(connectedServerLan);
            })
            .on('detach_device', (device: Device) => {
                vscode.window.showInformationMessage(`AutoJs6 设备断开: ${device}`);
                connectedServerAdb.delete(device.adbDeviceId);
                connectedServerLan.delete(device.host);
            })
            .on('log', (data: LogData) => {
                logDebug('## on log');
                let channel = deviceChannel[data.device.deviceId];
                if (channel) {
                    channel.appendLine(data.log);
                }
                logDebug('## channel output: ' + data.log);
            });
    }

    private registerCommands() {
        if (this.context === null) {
            throw Error('Extension context must be assigned first before accessing');
        }
        Extension.commands.forEach((command) => {
            let action = this.getBoundAction(command);
            this.context.subscriptions.push(vscode.commands.registerCommand(`extension.${command}`, action));
        });
    }

    private getWrappedGlobalState() {
        let globalState = this.context.globalState;
        let ipAddressRecordPrefix = this.picks.recordPrefix.label;
        let attach = function (addr: string) {
            let idx = addr.lastIndexOf(ipAddressRecordPrefix);
            return idx < 0 ? ipAddressRecordPrefix + addr : addr;
        };
        let detach = function (addr: string) {
            let idx = addr.lastIndexOf(ipAddressRecordPrefix);
            return idx < 0 ? addr : addr.slice(idx + ipAddressRecordPrefix.length);
        };
        let state: Memento = {
            keys(): readonly string[] {
                return globalState.keys();
            },
            get(key: string): string[] {
                return (globalState.get(key, []) as string[]).map(attach);
            },
            update(key: string, addresses: string[]): Thenable<void> {
                let deduped = Array.from(new Set(addresses.map(detach)));
                return globalState.update(key, deduped.filter(addr => addr && addr !== LOOP_BACK));
            },
        };
        return state;
    }

    private getBoundAction(command: keyof Extension) {
        let fn = this[command];
        if (typeof fn === 'function') {
            return fn.bind(this);
        }
        throw Error(`Invalid command: ${command}`);
    }

    private matchDevice(dev): DeviceInfo {
        let matched = /(\S+)\s+device\s(.+)/g.exec(dev);
        if (!matched || matched.length !== 3) {
            return null;
        }
        let n = matched[2];
        let o = { id: matched[1], brand: 'Unknown', model: 'Unknown', name: 'NoName' };

        for (let p = 0, i = n.indexOf(':'); i >= 0 && i < n.length;) {
            let k = i;
            i = n.indexOf(':', k + 1);
            if (i == -1) {
                i = n.length;
            }
            let j = n.lastIndexOf(' ', i);
            o[n.substring(p, k)] = j == -1 ? n.substring(k + 1, i) : n.substring(k + 1, j);
            p = j + 1;
        }
        let res = this.adb.exec([ '-s', o.id, 'shell', 'getprop', 'ro.product.brand' ]).stdout;
        if (res) {
            o.brand = res.toString().trim();
            o.name = `${o.brand} ${o.model} (${o.id})`;
        }
        return o;
    }

    private selectDevice(callback) {
        let devices = this.client.devices;
        if (devices.length === 0) {
            vscode.window.showErrorMessage('未发现已连接的设备');
            return false;
        }
        if (recentDevice) {
            let idx = devices.indexOf(recentDevice);
            if (idx > 0) {
                devices = devices.slice(0);
                devices[idx] = devices[0];
                devices[0] = recentDevice;
            }
        }
        let devs = devices.map(t => t.toString());
        vscode.window.showQuickPick(devs).then((idx) => {
            let dev = devices[devs.indexOf(idx)];
            recentDevice = dev;
            callback(dev);
        });
        return true;
    }

    private sendProjectCommand(command: ProjectCommands, url?: string) {
        let folder = null;
        if (!url) {
            let folders = vscode.workspace.workspaceFolders;
            if (!folders || folders.length === 0) {
                // vscode.window.showInformationMessage('An opened AutoJs6 project is needed');
                vscode.window.showInformationMessage('需要一个已打开的 AutoJs6 项目');
                return null;
            }
            folder = folders[0].uri;
        } else {
            folder = Uri.parse(url);
        }
        if (!this.client.project || this.client.project.folder !== folder) {
            this.client.project && this.client.project.dispose();
            this.client.project = new Project(folder);
        }
        if (!this.client.sendProjectCommand(folder.fsPath, command)) {
            vscode.window.showErrorMessage('未发现已连接的设备');
        }
    }

    private connectByAdb() {
        let devices = this.listAdbDevices();
        if (typeof devices !== 'object' || devices.size === 0) {
            vscode.window.showErrorMessage('未发现通过 ADB 连接的设备');
            return;
        }
        let commands = Array.from(devices.entries()).map((entry) => {
            let [ summary, deviceInfo ] = entry;
            return {
                label: summary.toString(),
                detail: `型号: ${deviceInfo.model}, 产品名称: ${deviceInfo['product']}`,
            };
        });
        this.showQuickPickForAjServerAdbConnecting(commands).then((cmd) => awaiter(function* () {
            if (typeof cmd !== 'string') {
                return;
            }
            let dev = devices.get(cmd);
            if (!dev) {
                return;
            }
            let ports = [ {
                src: yield this.findAvailPorts(),
                dst: Device.defaultClientPort,
            },
                {
                    src: yield this.findAvailPorts(),
                    dst: Device.defaultAdbServerPort,
                },
            ];

            try {
                logDebug(`adb device id: ${dev.id}`);
                ports.forEach((port) => {
                    logDebug(`got an adb source port: ${port.src}`);
                    this.adb.execOrThrow([ '-s', dev.id, 'forward', 'tcp:' + port.src, 'tcp:' + port.dst ]);
                });

                let idTimeout = setTimeout(() => this.onAdbDeviceConnectTimeout(dev), 5e3);

                this.client.connectTo(LOOP_BACK, ports[0].src, CONNECTION_TYPE_SERVER_ADB, dev.id)
                    .then(() => clearTimeout(idTimeout));
            } catch (e) {
                vscode.window.showErrorMessage(e.toString());
                return null;
            }
        }.bind(this)));
    }

    private listAdbDevices(): Map<string, DeviceInfo> {
        let res: SpawnSyncReturns<Buffer> = this.adb.exec([ 'devices', '-l' ]);
        if (res.pid === 0) {
            vscode.window.showErrorMessage('ADB 可能未安装或未被正确配置', '查看如何配置 ADB').then((choice) => {
                choice && vscode.env.openExternal(vscode.Uri.parse('https://segmentfault.com/a/1190000021822394'));
            });
            return null;
        }
        let map = new Map<string, DeviceInfo>();
        res.stdout.toString().split('\r\n').forEach((dev) => {
            let dev_info = this.matchDevice(dev);
            if (dev_info !== null) {
                map.set(dev_info.name, dev_info);
            }
        });
        logDebug('devices: ', map);
        return map;
    }

    private findAvailPorts() {
        let findPorts = function () {
            class Err extends Error {
                constructor(o) {
                    super(o + ' is locked');
                }
            }

            const cache = {
                old: new Set,
                young: new Set,
            };

            const parsePort = (port: number) => {
                return new Promise((resolve, reject) => {
                    let server = net.createServer();
                    server.unref();
                    server.on('error', reject);
                    server.listen(port, () => {
                        const { port: t } = server.address() as AddressInfo;
                        server.close(() => resolve(t));
                    });
                });
            };

            let itv_id;

            return async (port_info?) => {
                let ports;
                if (port_info) {
                    ports = typeof port_info.port === 'number' ? [ port_info.port ] : port_info.port;
                }
                if (itv_id === undefined) {
                    itv_id = setInterval(() => {
                        cache.old = cache.young;
                        cache.young = new Set;
                    }, 15e3);
                    itv_id.unref && itv_id.unref();
                }
                for (let port of function* $iiFe() {
                    if (ports) {
                        yield* ports;
                    }
                    yield 0;
                }()) {
                    try {
                        let parsed_port = await parsePort({ ...port_info, port: port });
                        while (cache.old.has(parsed_port) || cache.young.has(parsed_port)) {
                            if (port !== 0) {
                                // noinspection ExceptionCaughtLocallyJS
                                throw new Err(port);
                            }
                            parsed_port = await parsePort({ ...port_info, port: port });
                        }
                        cache.young.add(parsed_port);
                        return parsed_port;
                    } catch (t) {
                        if (![ 'EADDRINUSE', 'EACCES' ].includes(t.code) && !(t instanceof Err)) {
                            throw t;
                        }
                    }
                }
                throw new Error('No available ports found');
            };
        };

        return (this.findAvailPorts = findPorts.call(this))();
    }

    private onAdbDeviceConnectTimeout(device) {
        let res = this.adb.execOrThrow([
            '-s', device.id, 'shell', 'content', 'query',
            '--uri', 'content://org.autojs.autojs.debug.provider/debug-server',
        ]);
        let stdout = res.stdout.toString();
        let stderr = res.stderr.toString();
        let errEnsureServerModeOn = '请确认 AutoJs6 侧拉菜单已开启 "服务端模式 (Server mode)"';

        logDebug('query result: stdout = %s, stderr = %s, result = ', stdout, stderr, res);

        if ((stdout + stderr).includes('Could not find provider')) {
            vscode.window.showWarningMessage(errEnsureServerModeOn);
        } else {
            const matched = stdout.match(/state=(\d+)/);
            if (matched === null || parseInt(matched[1]) !== 2) {
                vscode.window.showErrorMessage(errEnsureServerModeOn);
            }
        }
    }

    private connectToNewDevice() {
        vscode.window.showInputBox({ prompt: '' }).then((input) => {
            if (input) {
                let port = Device.defaultClientPort;
                this.client.connectTo(input, port, CONNECTION_TYPE_SERVER_LAN)
                    .then(() => logDebug(`connected to ${input}:${port}`))
                    .catch(() => vscode.window.showErrorMessage(`连接 AutoJs6 服务端失败 (${input}) (AutoJs6 需启用服务端模式)`));
            }
        });
    }

    connect() {
        const prefixRecord = `[ ${this.picker.operations.record} ] - `;
        let ipAddressRecords = this.storage.get(this.storageKey, []);

        let isUpdated = false;

        for (let i = 0; i < ipAddressRecords.length; i += 1) {
            let data = ipAddressRecords[i];
            let [ ip ] = data.split('|');
            ip = ip.replace(prefixRecord, '');
            if (storageIpAddressBlacklist.includes(ip)) {
                ipAddressRecords.splice(i--, 1);
                isUpdated = true;
            }
        }

        if (isUpdated) {
            this.storage.update(this.storageKey, ipAddressRecords);
        }

        ipAddressRecords = ipAddressRecords.map((data: string) => {
            let [ ip, ts ] = data.split('|');
            let o: vscode.QuickPickItem = {
                label: ip.startsWith(prefixRecord) ? ip : `${prefixRecord}${ip}`,
            };
            if (ts && ts.match(/^\d+$/) !== null) {
                let date = new Date(Number(ts));

                let yyyy = date.getFullYear();
                let MM = String((date.getMonth() + 1)).padStart(2, '0');
                let dd = String(date.getDate()).padStart(2, '0');
                let HH = String(date.getHours()).padStart(2, '0');
                let mm = String(date.getMinutes()).padStart(2, '0');
                let ss = String(date.getSeconds()).padStart(2, '0');

                let dateString = `${yyyy}/${MM}/${dd} ${HH}:${mm}:${ss}`;
                o.detail = `最近连接: ${dateString}`;
            }
            return o;
        });
        const commands = [ this.picks.ajClientLan, this.picks.ajServerLan, this.picks.ajServerAdb ];

        this.showQuickPickForConnectionHomepage(commands).then((cmd) => {
            switch (cmd) {
                case undefined:
                    break;
                case this.picks.ajClientLan.label:
                    Extension.connectToLocalHint();
                    break;
                case this.picks.ajServerLan.label:
                    const records = ipAddressRecords.concat(ipAddressRecords.length > 0 ? this.picks.recordClear : []);
                    this.showQuickPickForAjServerLanConnecting(records).then((cmd) => {
                        switch (cmd) {
                            case this.picks.recordClear.label:
                                this.showAlternativePick(`确认清除所有已保存的记录吗`).then((s) => {
                                    if (s === STRING_YES) {
                                        let total = this.storage.get(this.storageKey, []).length;
                                        this.storage.update(this.storageKey, []);
                                        vscode.window.showInformationMessage(`清理完成, 共计 ${total} 项`);
                                    }
                                });
                                break;
                            default:
                                this.connectToServerLan(cmd);
                        }
                    });
                    break;
                case this.picks.ajServerAdb.label:
                    this.connectByAdb();
                    break;
                default: // Nothing to do so far.
            }
        });
    }

    connectToServerLan(cmd: any) {
        const prefixRecord = `[ ${this.picker.operations.record} ] - `;
        if (typeof cmd === 'string') {
            let port = Device.defaultClientPort;
            let host = cmd.trim().replace(prefixRecord, '');
            if (host.match(regexIpAddress) !== null) {
                if (host.includes(':')) {
                    let split = host.split(':');
                    let portInput = split[1];
                    if (portInput !== String(port)) {
                        vscode.window.showWarningMessage(`端口号 ${portInput} 已被忽略, 使用 ${port}`);
                    }
                    host = split[0];
                }
                this.client.connectTo(host, port, CONNECTION_TYPE_SERVER_LAN).catch((e) => {
                    logDebug(e);
                    vscode.window.showErrorMessage(`连接 AutoJs6 服务端失败 (${host}) (AutoJs6 需启用服务端模式)`);
                });
            } else {
                vscode.window.showErrorMessage(`连接 AutoJs6 服务端失败, 无法解析主机地址 ${cmd}`);
            }
        }
    }

    private async showQuickPickForConnectionHomepage<T extends vscode.QuickPickItem>(commands: T[]) {
        const disposables: Disposable[] = [];
        try {
            return await new Promise<string | T | T[] | undefined>((resolve, reject) => {
                const input = vscode.window.createQuickPick();
                input.title = `本机 IP: ${util.getNicAddress()}`;
                input.placeholder = DEFAULT_QUICK_PICK_PLACEHOLDER;
                input.items = commands;
                input.buttons = [
                    ...[],
                    ...[],
                    ...[],
                    ...[ pickButtons.close ],
                ];

                disposables.push(
                    // input.onDidAccept(() => {
                    //     logDebug(input.value)
                    // }),
                    input.onDidChangeSelection((items) => {
                        const item = items[0];
                        resolve(item.label);
                        input.hide();
                    }),
                    input.onDidHide(() => {
                        resolve(undefined);
                        input.dispose();
                    }),
                    // input.onDidChangeActive((quickItems) => {
                    //     const label = quickItems[0].label;
                    //     logDebug(label);
                    //     const prefixRecord = '[ 记录 ] - ';
                    //     const prefixDefault = DEFAULT_QUICK_PICK_PLACEHOLDER;
                    //     if (label.startsWith(prefixRecord)) {
                    //         input.placeholder = `使用局域网连接至 AutoJs6 服务端 (${label.slice(prefixRecord.length)})`;
                    //     } else {
                    //         input.placeholder = prefixDefault;
                    //     }
                    // }),
                    input.onDidTriggerButton((item) => {
                        if (item === pickButtons.close) {
                            input.hide();
                        }
                    }),
                );
                input.show();
            });
        } finally {
            disposables.forEach(d => d.dispose());
        }
    }

    private async showAlternativePick(title: string) {
        const disposables: Disposable[] = [];
        try {
            return await new Promise<string | undefined>((resolve, reject) => {
                const input = vscode.window.createQuickPick();
                input.title = title;
                input.placeholder = DEFAULT_QUICK_PICK_PLACEHOLDER;
                input.items = [ { label: STRING_YES }, { label: STRING_NO } ];
                input.buttons = [
                    ...[],
                    ...[],
                    ...[],
                    ...[ pickButtons.close ],
                ];

                disposables.push(
                    input.onDidChangeSelection((items) => {
                        const item = items[0];
                        resolve(item.label);
                        input.hide();
                    }),
                    input.onDidHide(() => {
                        resolve(undefined);
                        input.dispose();
                    }),
                    input.onDidTriggerButton((item) => {
                        if (item === pickButtons.close) {
                            input.hide();
                        }
                    }),
                );
                input.show();
            });
        } finally {
            disposables.forEach(d => d.dispose());
        }
    }

    private async showQuickPickForAjServerLanConnecting<T extends vscode.QuickPickItem>(commands: T[]) {
        const disposables: Disposable[] = [];
        try {
            return await new Promise<string | T | T[] | undefined>((resolve, reject) => {
                const input = vscode.window.createQuickPick();
                input.title = `连接到 AutoJs6 服务端`;
                input.placeholder = `输入或选择 AutoJs6 服务端 IP 地址, 按回车 (Enter) 键建立连接`;
                input.items = commands;
                input.buttons = [
                    ...[],
                    ...[],
                    ...[],
                    ...[ pickButtons.close ],
                ];

                disposables.push(
                    input.onDidAccept(() => {
                        this.connectToServerLan(input.value);
                        input.hide();
                    }),
                    input.onDidChangeSelection((items) => {
                        const item = items[0];
                        resolve(item.label);
                        input.hide();
                    }),
                    input.onDidHide(() => {
                        resolve(undefined);
                        input.dispose();
                    }),
                    input.onDidTriggerButton((item) => {
                        if (item === pickButtons.close) {
                            input.hide();
                        }
                    }),
                );
                input.show();
            });
        } finally {
            disposables.forEach(d => d.dispose());
        }
    }

    private async showQuickPickForAjServerAdbConnecting<T extends vscode.QuickPickItem>(commands: T[]) {
        const disposables: Disposable[] = [];
        try {
            return await new Promise<string | T | T[] | undefined>((resolve, reject) => {
                const input = vscode.window.createQuickPick();
                input.title = `连接到 AutoJs6 服务端`;
                input.placeholder = `输入或选择需要连接的设备, 按回车 (Enter) 键建立连接`;
                input.items = commands;
                input.buttons = [
                    ...[], // ...[QuickInputButtons.Back],
                    ...[],
                    ...[],
                    ...[ pickButtons.close ],
                ];

                disposables.push(
                    input.onDidAccept(() => {
                        resolve(input.value);
                        input.hide();
                    }),
                    input.onDidChangeSelection((items) => {
                        const item = items[0];
                        resolve(item.label);
                        input.hide();
                    }),
                    input.onDidHide(() => {
                        resolve(undefined);
                        input.dispose();
                    }),
                    input.onDidTriggerButton((item) => {
                        if (item === pickButtons.close) {
                            input.hide();
                        }
                    }),
                );
                input.show();
            });
        } finally {
            disposables.forEach(d => d.dispose());
        }
    }

    viewDocument() {
        vscode.env.openExternal(vscode.Uri.parse('https://docs.autojs6.com/'));
    }

    disconnectAll() {
        this.client.disconnect();
        vscode.window.showInformationMessage('AutoJs6 已断开所有连接');
        // vscode.window.showInformationMessage('All connections to AutoJs6 disconnected');
    }

    run(url?) {
        this.runFile(url);
    }

    stop() {
        this.client.sendCommand('stop', {
            id: vscode.window.activeTextEditor?.document.fileName,
        });
    }

    stopAll() {
        this.client.sendCommand('stopAll');
    }

    rerunProject(url?) {
        this.stopAll();
        setTimeout(() => this.runProject(url), 480);
    }

    rerun(url?) {
        this.stop();
        this.run(url);
    }

    runOnDevice() {
        this.selectDevice(dev => this.runFileOn(dev));
    }

    save() {
        this.saveTo(this.client);
    }

    saveToDevice() {
        this.selectDevice(dev => this.saveTo(dev));
    }

    saveTo(devices: Devices) {
        let editor = vscode.window.activeTextEditor;
        if (editor) {
            devices.sendCommand('save', {
                id: editor.document.fileName,
                name: editor.document.fileName,
                script: editor.document.getText(),
            });
        }
    }

    newProject() {
        vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
        }).then((uris) => {
            if ((uris || []).length > 0) {
                let template = path.join(this.context.extensionPath, 'assets', 'template');
                return new ProjectTemplate(vscode.Uri.file(template), uris[0]).build();
            }
        }).then((uri) => {
            if (uri) {
                vscode.commands.executeCommand('vscode.openFolder', uri, {
                    forceNewWindow: true,
                });
            }
        });
    }

    runProject(url?) {
        this.sendProjectCommand('run_project', url);
    }

    saveProject(url?) {
        this.sendProjectCommand('save_project', url);
    }
}

// noinspection JSUnusedGlobalSymbols
export function activate(context: vscode.ExtensionContext) {
    logDebug(`extension "${EXTENSION_NAME}" is activating`);
    extension = new Extension(context, this);
    logDebug(`extension "${EXTENSION_NAME}" is now active`);
}

export type ProjectCommands = 'run_project' | 'save_project';

export let httpServer = new AJHttpServer(HTTP_SERVER_PORT)
    .on('cmd', (cmd: keyof Extension, ...params) => {
        logDebug(`Received cmd: ${cmd}`);
        switch (cmd) {
            case 'rerunProject':
                extension.stopAll();
                setTimeout(() => extension.run(...params), 1e3);
                break;
            default:
                if (!Extension.commands.includes(cmd)) {
                    vscode.window.showErrorMessage(`接收到未知指令 "${cmd}"`);
                    return;
                }
                console.info(`执行接收到的指令 "${cmd}"`);
                extension[cmd]['call'](extension, ...params);
        }
    })
    .on('error', (e) => {
        logDebug(`HTTP server error: ${e}`);
    });

type AJHttpServerParamList = {
    cmd: string;
    path: string;
}
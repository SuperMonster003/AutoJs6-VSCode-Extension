'use strict';

import * as net from 'net';
import { AddressInfo } from 'net';
import * as path from 'path';
import * as vscode from 'vscode';
import { Disposable, Memento, OutputChannel, QuickInputButton, TextEditor, ThemeIcon, Uri } from 'vscode';
import * as fs from 'fs';
import * as util from './util';
import { logDebug } from './util';
import * as querystring from 'querystring';

import i18n from './i18n';

import { Adb } from './adb';
import { awaiter } from './awaiter';
import { Device, DeviceInfo, Devices, HTTP_SERVER_PORT, LogData } from './device';
import { Project, ProjectTemplate } from './project';
import { SpawnSyncReturns } from 'child_process';
import * as http from 'http';
import * as url from 'url';
import EventEmitter = require('events');

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

const commandsHierarchyPreset = {
    desc: {
        script: { zh: '脚本', en: 'Script' },
        project: { zh: '项目', en: 'Project' },
        file: { zh: '文件', en: 'File' },
        currentTask: { zh: '当前任务', en: 'Current Task' },
        allTasks: { zh: '全部任务', en: 'All Tasks' },
        viewWithVscBrowser: { zh: '使用 VSCode 内置浏览器', en: 'With VSCode Browser' },
        viewWithSysBrowser: { zh: '使用操作系统默认浏览器', en: 'With System Browser' },
    },
};

const commandsHierarchy: {
    grade: number | string;
    desc: string | { zh: string, en?: string };
    subs?: {
        grade: number | string;
        desc: string | { zh: string, en?: string };
        subs?: {
            grade: number | string;
            desc: string | { zh: string, en?: string };
            action?(): void;
        }[];
        action?(): void;
    }[];
    action?(): void;
}[] = [ {
    grade: 1,
    desc: { zh: '连接', en: 'Connect' },
    subs: [ {
        grade: 1,
        desc: { zh: '建立连接', en: 'Establish' },
        subs: [ {
            grade: 1,
            desc: `${extension.picker.commands.server} | ${extension.picker.agents.lan}`,
            action() {

            },
        }, {
            grade: 2,
            desc: `${extension.picker.commands.server} | ${extension.picker.agents.qr}`,
            action() {

            },
        }, {
            grade: 4,
            desc: `${extension.picker.commands.client} | ${extension.picker.agents.lan}`,
            action() {

            },
        }, {
            grade: 5,
            desc: `${extension.picker.commands.client} | ${extension.picker.agents.adb}`,
            action() {

            },
        } ],
    }, {
        grade: 0,
        desc: { zh: '断开连接', en: 'Disconnect' },
        subs: [ {
            grade: 1,
            desc: { zh: '全部设备', en: 'All Devices' },
            action() {

            },
        }, {
            grade: 2,
            desc: { zh: '指定设备', en: 'Specified Devices' },
            action() {

            },
        } ],
    } ],
}, {
    grade: 6,
    desc: { zh: '运行', en: 'Run' },
    subs: [ {
        grade: 1,
        desc: commandsHierarchyPreset.desc.script,
        subs: [ {
            grade: 1,
            desc: { zh: '全部设备', en: 'All Devices' },
            action() {

            },
        }, {
            grade: 2,
            desc: { zh: '指定设备', en: 'Specified Devices' },
            action() {

            },
        } ],
    }, {
        grade: 2,
        desc: commandsHierarchyPreset.desc.project,
        subs: [ {
            grade: 1,
            desc: { zh: '全部设备', en: 'All Devices' },
            action() {

            },
        }, {
            grade: 2,
            desc: { zh: '指定设备', en: 'Specified Devices' },
            action() {

            },
        } ],
    } ],
}, {
    grade: 5,
    desc: { zh: '保存', en: 'Save' },
    subs: [ {
        grade: 1,
        desc: commandsHierarchyPreset.desc.script,
        subs: [ {
            grade: 1,
            desc: { zh: '全部设备', en: 'All Devices' },
            action() {

            },
        }, {
            grade: 2,
            desc: { zh: '指定设备', en: 'Specified Devices' },
            action() {

            },
        } ],
    }, {
        grade: 2,
        desc: commandsHierarchyPreset.desc.project,
        subs: [ {
            grade: 1,
            desc: { zh: '全部设备', en: 'All Devices' },
            action() {

            },
        }, {
            grade: 2,
            desc: { zh: '指定设备', en: 'Specified Devices' },
            action() {

            },
        } ],
    } ],
}, {
    grade: 0,
    desc: { zh: '停止', en: 'Stop' },
    subs: [ {
        grade: 1,
        desc: commandsHierarchyPreset.desc.currentTask,
        subs: [ {
            grade: 1,
            desc: { zh: '全部设备', en: 'All Devices' },
            action() {

            },
        }, {
            grade: 2,
            desc: { zh: '指定设备', en: 'Specified Devices' },
            action() {

            },
        } ],
    }, {
        grade: 2,
        desc: commandsHierarchyPreset.desc.allTasks,
        subs: [ {
            grade: 1,
            desc: { zh: '全部设备', en: 'All Devices' },
            action() {

            },
        }, {
            grade: 2,
            desc: { zh: '指定设备', en: 'Specified Devices' },
            action() {

            },
        } ],
    } ],
}, {
    grade: 1,
    desc: { zh: '新建', en: 'New' },
    subs: [ {
        grade: 1,
        desc: commandsHierarchyPreset.desc.file,
        action() {

        },
    }, {
        grade: 2,
        desc: commandsHierarchyPreset.desc.project,
        action() {

        },
    } ],
}, {
    grade: 3,
    desc: { zh: '扩展', en: 'Extension' },
    subs: [ {
        grade: 1,
        desc: { zh: '查看在线文档', en: 'View Online Document' },
        subs: [ {
            grade: 1,
            desc: commandsHierarchyPreset.desc.viewWithVscBrowser,
            action() {

            },
        }, {
            grade: 2,
            desc: commandsHierarchyPreset.desc.viewWithSysBrowser,
            action() {

            },
        } ],
    } ],
}, {
    grade: '?',
    desc: { zh: '查看全部命令层级', en: 'View All Commands Hierarchy' },
    action() {

    },
} ];

// @Reference to AutoX by SuperMonster003 on Jun 11, 2023.
class AJHttpServer extends EventEmitter {
    public isHttpServerStarted = false;
    public port: number;

    private httpServer: http.Server;

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
            optional: '可选',
            removeOperation(s: string) {
                const regexPrefixOperation = /^\[ [\u4e00-\u9fff]+ ] - /;
                return s.replace(regexPrefixOperation, '');
            },
        },
        commands: {
            empty: '',
            server: '服务端模式 (Server)',
            client: '客户端模式 (Client)',
            record: 'IP 地址记录 (IP Address Records)',
        },
        agents: {
            lan: '局域网 (LAN)',
            adb: '安卓调试桥 (ADB)',
            qr: '二维码 (QR Code)',
        },
    };
    private readonly picks = {
        ajClientLan: this.newPicker('connect', 's/c', 'lan', 'AutoJs6 作为客户端连接至 VSCode 服务端 (使用 IP 地址)'),
        ajClientQr: this.newPicker('connect', 's/c', 'lan', 'AutoJs6 作为客户端连接至 VSCode 服务端 (使用 二维码)'),
        ajServerLan: this.newPicker('connect', 'c/s', 'lan', 'VSCode 作为客户端连接至 AutoJs6 服务端 (使用 IP 地址)'),
        ajServerAdb: this.newPicker('connect', 'c/s', 'adb', 'VSCode 作为客户端连接至 AutoJs6 服务端 (使用 ADB)'),
        recordClear: this.newPicker('clear', 'record', null, '清除保存在本地的全部客户端 IP 地址记录'),
        recordPrefix: this.newPicker('record', 'empty', null, 'VSCode 作为客户端使用 IP 地址 %s 连接至 AutoJs6 服务端'),
    };
    static readonly commands: Array<keyof Extension> = [
        'viewDocument', 'connect', 'disconnectAll', 'run', 'runOnDevice', 'stop',
        'stopAll', 'rerun', 'save', 'saveToDevice', 'newUntitledFile',
        'newProject', 'runProject', 'saveProject', 'commandsHierarchy',
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

    private static showLocalQrCode() {

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

    private runFile(url?: string) {
        this.runFileOn(this.client.devices, url);
    }

    private runFileOn(devices: Device[], url?: string) {
        if (devices.length === 0) {
            vscode.window.showErrorMessage('未发现已连接的设备');
            return;
        }
        if (url == null) {
            let editor = this.lastActiveEditor;
            if (!editor) {
                vscode.window.showErrorMessage('需在正在编辑的文件窗口中使用运行命令');
                return;
            }
            devices.forEach((device) => {
                device.sendCommand('run', {
                    id: editor.document.fileName,
                    name: this.getEditorFileName(editor),
                    script: editor.document.getText(),
                });
            });
            return;
        }
        try {
            let fileName = Uri.parse(url).fsPath;
            let script = fs.readFileSync(fileName, 'utf8');
            devices.forEach((device) => {
                device.sendCommand('run', {
                    id: fileName,
                    name: fileName,
                    script: script,
                });
            });
        } catch (error) {
            logDebug(error);
        }
    }

    private getEditorFileName(editor: vscode.TextEditor) {
        let fileName = editor.document.fileName;
        if (editor.document.isUntitled) {
            // noinspection SpellCheckingInspection
            switch (editor.document.languageId) {
                case 'bat':
                    return `${fileName}.bat`;
                case 'c':
                    return `${fileName}.c`;
                case 'css':
                    return `${fileName}.css`;
                case 'go':
                    return `${fileName}.go`;
                case 'html':
                    return `${fileName}.html`;
                case 'java':
                    return `${fileName}.java`;
                case 'javascript':
                    return `${fileName}.js`;
                case 'javascriptreact':
                    return `${fileName}.jsx`;
                case 'json':
                    return `${fileName}.json`;
                case 'lua':
                    return `${fileName}.lua`;
                case 'markdown':
                    return `${fileName}.md`;
                case 'php':
                    return `${fileName}.php`;
                case 'plaintext':
                    return `${fileName}.txt`;
                case 'powershell':
                    return `${fileName}.ps`;
                case 'python':
                    return `${fileName}.py`;
                case 'r':
                    return `${fileName}.r`;
                case 'shellscript':
                    return `${fileName}.sh`;
                case 'sql':
                    return `${fileName}.sql`;
                case 'typescript':
                    return `${fileName}.ts`;
                case 'typescriptreact':
                    return `${fileName}.tsx`;
                case 'vue':
                    return `${fileName}.vue`;
                case 'xml':
                    return `${fileName}.xml`;
                case 'xsl':
                    return `${fileName}.xsl`;
                case 'yaml':
                    return `${fileName}.yaml`;
            }
        }
        return fileName;
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

    private matchDevice(dev: string): DeviceInfo {
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

    private selectDevices(callback: (devices: Device[]) => void) {
        if (!this.client.hasDevices()) {
            vscode.window.showErrorMessage('未发现已连接的设备');
            return false;
        }
        let devices = this.client.devices;
        // if (recentDevice) {
        //     let idx = devices.indexOf(recentDevice);
        //     if (idx > 0) {
        //         devices = devices.slice(0);
        //         devices[idx] = devices[0];
        //         devices[0] = recentDevice;
        //         recentDevice = null
        //     }
        // }
        vscode.window.showQuickPick(devices.map(dev => dev.toString()), {
            canPickMany: true,
        }).then((selected) => {
            callback(devices.filter(dev => selected.includes(dev.toString())));
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
            let project = new Project(folder);
            if (Object.getPrototypeOf(project) === null) {
                return;
            }
            this.client.project = project;
        }
        if (!this.client.sendProjectCommand(folder.fsPath, command)) {
            vscode.window.showErrorMessage('未发现已连接的设备');
        }
    }

    private showCommandHierarchy() {
        // commandsHierarchy;
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
            }, {
                src: yield this.findAvailPorts(),
                dst: Device.defaultAdbServerPort,
            } ];

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

    findAvailPorts() {
        let findPorts = function () {
            class Err extends Error {
                constructor(o: string) {
                    super(o + ' is locked');
                }
            }

            const cache = {
                old: new Set,
                young: new Set,
            };

            const parsePort = (port: { port: number }) => {
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

            let itvId: NodeJS.Timeout;

            return async (portInfo?: { port: number | number[] }) => {
                if (itvId === undefined) {
                    itvId = setInterval(() => {
                        cache.old = cache.young;
                        cache.young = new Set;
                    }, 15e3);
                    itvId.unref && itvId.unref();
                }
                for (let port of function* $iiFe() {
                    if (portInfo) {
                        yield* (typeof portInfo.port === 'number' ? [ portInfo.port ] : portInfo.port);
                    }
                    yield 0;
                }()) {
                    try {
                        let parsedPort = await parsePort({ ...portInfo, port: port });
                        while (cache.old.has(parsedPort) || cache.young.has(parsedPort)) {
                            if (port !== 0) {
                                // noinspection ExceptionCaughtLocallyJS
                                throw new Err(String(port));
                            }
                            parsedPort = await parsePort({ ...portInfo, port: port });
                        }
                        cache.young.add(parsedPort);
                        return parsedPort;
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

    onAdbDeviceConnectTimeout(device: DeviceInfo) {
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
        const commands = [
            this.picks.ajClientLan,
            // this.picks.ajClientQr,
            this.picks.ajServerLan,
            this.picks.ajServerAdb,
        ];

        this.showQuickPickForConnectionHomepage(commands).then((cmd) => {
            switch (cmd) {
                case undefined:
                    break;
                case this.picks.ajClientQr.label:
                    Extension.showLocalQrCode();
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
        if (typeof cmd === 'string') {
            let port = Device.defaultClientPort;
            let host = this.picker.operations.removeOperation(cmd.trim());
            if (host.match(regexIpAddress) !== null) {
                if (host.includes(':')) {
                    let split = host.split(':');
                    let portInput = split[1];
                    if (portInput !== String(port)) {
                        vscode.window.showWarningMessage(`端口号 ${portInput} 已被忽略, 使用 ${port}`);
                    }
                    host = split[0];
                }
                vscode.window.showInformationMessage(`正在连接至 AutoJs6 服务端 (${host})...`);
                this.client.connectTo(host, port, CONNECTION_TYPE_SERVER_LAN).catch((e) => {
                    logDebug(e);
                    vscode.window.showErrorMessage(`无法连接至 AutoJs6 服务端 (${host})`, '查看解决方案').then((choice) => {
                        if (choice) {
                            const header = 'AutoJs6 服务端连接诊断';
                            vscode.window.showInformationMessage(header, {
                                detail: [
                                    `检查 AutoJs6 主页侧拉抽屉是否已开启 "服务端模式"`,
                                    `检查两端设备是否位于同一局域网`,
                                    `检查 VSCode 所在设备的防火墙是否允许 ${port} 端口通信`,
                                    `尝试使用其他方式 (如 ADB 等) 建立连接`,
                                ].map(s => `- ${s}`).join('\n'),
                                modal: true,
                            });
                        }
                    });
                });
            } else {
                vscode.window.showErrorMessage(`连接 AutoJs6 服务端失败, 无法解析地址 ${cmd}`);
            }
        }
    }

    private async showQuickPickForConnectionHomepage<T extends vscode.QuickPickItem>(commands: T[]) {
        const disposables: Disposable[] = [];
        try {
            return await new Promise<string | T | T[] | undefined>((resolve) => {
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
            return await new Promise<string | undefined>((resolve) => {
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

    private async showQuickPickForAjServerLanConnecting<T extends vscode.QuickPickItem>(commands: T[], options: { title?: string, placeholder?: string } = {}) {
        const disposables: Disposable[] = [];
        try {
            return await new Promise<string | T | T[] | undefined | Promise<any>>((resolve) => {
                const input = vscode.window.createQuickPick();
                input.title = options.title || `连接到 AutoJs6 服务端`;
                input.placeholder = options.placeholder || `输入或选择 AutoJs6 服务端 IP 地址, 按回车 (Enter) 键建立连接`;
                input.items = commands;
                input.buttons = [
                    ...[],
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
                        const pureLabel = this.picker.operations.removeOperation(item.label);
                        const isConflicted = regexIpAddress.test(input.value)
                            && pureLabel.includes(input.value)
                            && pureLabel !== input.value;
                        if (isConflicted) {
                            const prefixOptional = `[ ${this.picker.operations.optional} ] - `;
                            const optionalItem = { label: `${prefixOptional}${input.value}` };
                            resolve(this.showQuickPickForAjServerLanConnecting([ optionalItem, item ], {
                                title: `IP 地址出现歧义, 需进一步确认`,
                                placeholder: `选择一个 IP 地址, 按回车 (Enter) 键建立连接`,
                            }));
                        } else {
                            resolve(item.label);
                        }
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
            return await new Promise<string | T | T[] | undefined>((resolve) => {
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

    run(url?: string) {
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

    rerunProject(url?: string) {
        this.stopAll();
        setTimeout(() => this.runProject(url), 480);
    }

    rerun(url?: string) {
        this.stop();
        this.run(url);
    }

    runOnDevice() {
        this.selectDevices((devices: Device[]) => this.runFileOn(devices));
    }

    save() {
        this.saveTo(this.client.devices);
    }

    saveToDevice() {
        this.selectDevices((devices: Device[]) => this.saveTo(devices));
    }

    saveTo(devices: Device[]) {
        let editor = vscode.window.activeTextEditor;
        if (editor) {
            devices.forEach((device) => {
                device.sendCommand('save', {
                    id: editor.document.fileName,
                    name: this.getEditorFileName(editor),
                    script: editor.document.getText(),
                });
            });
        }
    }

    newUntitledFile() {
        vscode.commands.executeCommand('workbench.action.files.newUntitledFile');
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

    runProject(url?: string) {
        this.sendProjectCommand('run_project', url);
    }

    saveProject(url?: string) {
        this.sendProjectCommand('save_project', url);
    }

    commandsHierarchy() {
        this.showCommandHierarchy();
    }
}

// noinspection JSUnusedGlobalSymbols
export function activate(context: vscode.ExtensionContext) {
    logDebug(`extension "${EXTENSION_NAME}" is activating`);
    extension = new Extension(context, this);
    logDebug(`extension "${EXTENSION_NAME}" is now active`);
}

export type ProjectCommands = 'run_project' | 'save_project';

new AJHttpServer(HTTP_SERVER_PORT)
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
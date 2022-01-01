'use strict';

import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as vscode from 'vscode';
import * as util from './util';

import {Adb} from './adb';
import {Memento, TextEditor} from 'vscode';
import {AddressInfo} from 'net';
import {awaiter} from './awaiter';
import {Devices, Device, DeviceInfo, DeviceDataInfo} from './device';
import {Project, ProjectTemplate} from './project';
import {SpawnSyncReturns} from 'child_process';
import {logDebug} from './util';

const LOOP_BACK: string = '127.0.0.1';

let recentDevice = null;
let devices_channels = {};

export class Extension {
    private context: vscode.ExtensionContext;
    private instance: Extension = null;
    private adb: Adb;
    private storage_key: string = 'autojs6.devices';
    private storage: Memento;

    private readonly picks = {
        aj_client_lan: '[ 连接 ] - AutoJs6 (客户端) > VSCode (服务端) | 局域网',
        aj_server_lan: '[ 连接 ] - AutoJs6 (服务端) < VSCode (客户端) | 局域网',
        aj_server_adb: '[ 连接 ] - AutoJs6 (服务端) < VSCode (客户端) | ADB (USB)',
        record_clear: '[ 清理 ] - 本地 IP 地址记录',
        record_prefix: '[ 记录 ] - ',
    };

    readonly commands: Array<keyof Extension> = [
        'viewDocument', 'connect', 'disconnectAll', 'run', 'runOnDevice', 'stop',
        'stopAll', 'rerun', 'save', 'saveToDevice', 'newProject', 'runProject', 'saveProject',
    ];

    client: Devices;

    constructor(context?: vscode.ExtensionContext) {
        if (context) {
            this.setContext(context);
        }
        this.instance = this;
    }

    setContext(context: vscode.ExtensionContext) {
        this.context = context;
        this.storage = this.getWrappedGlobalState(context);
    }

    private getWrappedGlobalState(context: vscode.ExtensionContext) {
        let globalState = context.globalState;
        let prefix = this.picks.record_prefix;
        let attach = function (addr: string) {
            let idx = addr.lastIndexOf(prefix);
            return idx < 0 ? prefix + addr : addr;
        };
        let detach = function (addr: string) {
            let idx = addr.lastIndexOf(prefix);
            return idx < 0 ? addr : addr.slice(idx + prefix.length);
        };
        let state: Memento = {
            keys(): readonly string[] {
                return globalState.keys();
            },
            get(key: string): string[] {
                return (globalState.get(key) as string[]).map(attach);
            },
            update(key: string, addresses: string[]): Thenable<void> {
                let deduped = Array.from(new Set(addresses.map(detach)));
                return globalState.update(key, deduped.filter(addr => addr !== LOOP_BACK));
            },
        };
        return state;
    }

    setAdbInstance(adb: Adb) {
        this.adb = adb;
    }

    connect() {
        let commands = [this.picks.aj_client_lan, this.picks.aj_server_lan, this.picks.aj_server_adb]
            .concat(this.storage.get(this.storage_key, []))
            .concat(this.picks.record_clear);

        vscode.window.showQuickPick(commands, {
            title: '本机 IP: ' + util.getNicAddress(),
            placeHolder: '选择或键入一个操作命令',
        }).then((cmd) => {
            switch (cmd) {
                case undefined:
                    break;
                case this.picks.aj_client_lan:
                    Extension.connectToLocalHint();
                    break;
                case this.picks.aj_server_lan:
                    this.connectToNewDevice();
                    break;
                case this.picks.aj_server_adb:
                    this.connectByAdb();
                    break;
                case this.picks.record_clear:
                    this.storage.update(this.storage_key, []);
                    break;
                default:
                    let port = Device.defaultClientPort;
                    let host = cmd.replace(/.*?(?:.+:)*((?:\d+\.)+\d+)$/, '$1');
                    this.client.connectTo(host, port).catch(() => {
                        vscode.window.showErrorMessage(`连接 AutoJs6 服务端失败 (${host}) (AutoJs6 需开启服务端模式)`);
                    });
            }
        });
    }

    newClient() {
        this.client = new Devices()
            .on('new_device', (device: Device) => {
                let devs = this.storage.get(this.storage_key, []);
                logDebug('devs', devs);
                let addr = device.connection.remoteAddress?.replace(/.*?:?((\d+\.){3}\d+$)/, '$1');
                logDebug('addr', addr);
                if (!devs.includes(addr)) {
                    this.storage.update(this.storage_key, [addr].concat(devs));
                }
                let dev_chn = devices_channels[device.deviceId];
                if (!dev_chn) {
                    dev_chn = vscode.window.createOutputChannel(`Channel for (${device})`);
                    devices_channels[device.deviceId] = dev_chn;
                }
                dev_chn.show();
                vscode.window.showInformationMessage(`AutoJs6 设备接入: ${device}`);
            })
            .on('detach_device', (device: Device) => {
                vscode.window.showInformationMessage(`AutoJs6 设备断开: ${device}`);
            })
            .on('log', (data: DeviceDataInfo) => {
                logDebug('## on log');
                let channel = devices_channels[data.device.deviceId];
                if (channel) {
                    channel.appendLine(data.log);
                }
                logDebug('## channel output: ' + data);
            });
    }

    getBoundAction(command: keyof Extension) {
        let fn = this[command];
        if (typeof fn === 'function') {
            return fn.bind(this);
        }
        throw Error(`Invalid command: ${command}`);
    }

    connectByAdb() {
        let devices = this.listAdbDevices();
        if (typeof devices !== 'object' || devices.size === 0) {
            vscode.window.showErrorMessage('未发现通过 ADB 连接的设备');
            return;
        }
        let dev_keys = Array.from(devices.keys()).map(dev => dev.toString());
        vscode.window.showQuickPick(dev_keys, {
            title: '使用 ADB 建立连接 (需 AutoJs6 开启 "服务端模式")',
            placeHolder: '选择或键入一个需要连接的设备',
        }).then(sel_item => awaiter(function* () {
            if (!sel_item) {
                return;
            }
            let dev = devices.get(sel_item);
            if (!dev) {
                return;
            }
            let ports = [{
                src: yield this.findAvailPorts(),
                dst: Device.defaultClientPort,
            }, {
                src: yield this.findAvailPorts(),
                dst: Device.defaultHttpServerPort,
            }];

            try {
                ports.forEach((port) => {
                    logDebug(`got an adb source port: ${port.src}`);
                    this.adb.execOrThrow(['-s', dev.id, 'forward', 'tcp:' + port.src, 'tcp:' + port.dst]);
                });

                let tt_id = setTimeout(() => this.onAdbDeviceConnectTimeout(dev), 5e3);

                this.client.connectTo(LOOP_BACK, ports[0].src, dev.id, ports[1].src)
                    .then(() => clearTimeout(tt_id));
            } catch (e) {
                vscode.window.showErrorMessage(e.toString());
                return null;
            }
        }.bind(this)));
    }

    listAdbDevices(): Map<string, DeviceInfo> {
        let res: SpawnSyncReturns<Buffer> = this.adb.exec(['devices', '-l']);
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

    matchDevice(dev): DeviceInfo {
        let matched = /(\S+)\s+device\s(.+)/g.exec(dev);
        if (!matched || matched.length !== 3) {
            return null;
        }
        let n = matched[2];
        let o = {id: matched[1], brand: 'Unknown', model: 'Unknown', name: 'NoName'};

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
        let res = this.adb.exec(['-s', o.id, 'shell', 'getprop', 'ro.product.brand']).stdout;
        if (res) {
            o.brand = res.toString().trim();
            o.name = `${o.brand} ${o.model} (${o.id})`;
        }
        return o;
    }

    viewDocument() {
        vscode.env.openExternal(vscode.Uri.parse('http://docs.autojs.org/'));
    }

    disconnectAll() {
        this.client.disconnect();
        vscode.window.showInformationMessage('AutoJs6 已断开所有连接');
        // vscode.window.showInformationMessage('All connections to AutoJs6 disconnected');
    }

    run() {
        this.runFile();
    }

    stop() {
        this.client.sendCommand('stop', {
            id: vscode.window.activeTextEditor.document.fileName,
        });
    }

    stopAll() {
        this.client.sendCommand('stopAll');
    }

    rerun() {
        this.stop();
        this.run();
    }

    runOnDevice() {
        this.selectDevice(dev => this.runFileOn(dev));
    }

    selectDevice(callback) {
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

    save() {
        this.saveTo(this.client);
    }

    saveToDevice() {
        this.selectDevice(dev => this.saveTo(dev));
    }

    saveTo(devices: Devices) {
        let editor = vscode.window.activeTextEditor;
        devices.sendCommand('save', {
            id: editor.document.fileName,
            name: editor.document.fileName,
            script: editor.document.getText(),
        });
    }

    newProject() {
        vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            openLabel: '新建 (New)',
        }).then((uris) => {
            if (uris && uris.length > 0) {
                let template = path.join(this.context.extensionPath, 'assets', 'templates');
                return new ProjectTemplate(vscode.Uri.file(template), uris[0]).build();
            }
        }).then((uri) => {
            vscode.commands.executeCommand('vscode.openFolder', uri);
        });
    }

    runProject() {
        this.sendProjectCommand('run_project');
    }

    sendProjectCommand(command: string) {
        let folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            // vscode.window.showInformationMessage('An opened AutoJs6 project is needed');
            vscode.window.showInformationMessage('需要一个已打开的 AutoJs6 项目');
            return null;
        }
        let folder = folders[0].uri;
        if (!this.client.project || this.client.project.folder !== folder) {
            this.client.project && this.client.project.dispose();
            this.client.project = new Project(folder);
        }
        if (!this.client.sendProjectCommand(folder.fsPath, command)) {
            vscode.window.showErrorMessage('未发现已连接的设备');
        }
    }

    saveProject() {
        this.sendProjectCommand('save_project');
    }

    findAvailPorts() {
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
                        const {port: t} = server.address() as AddressInfo;
                        server.close(() => resolve(t));
                    });
                });
            };

            let itv_id;

            return async (port_info?) => {
                let ports;
                if (port_info) {
                    ports = typeof port_info.port === 'number' ? [port_info.port] : port_info.port;
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
                        let parsed_port = await parsePort({...port_info, port: port});
                        while (cache.old.has(parsed_port) || cache.young.has(parsed_port)) {
                            if (port !== 0) {
                                // noinspection ExceptionCaughtLocallyJS
                                throw new Err(port);
                            }
                            parsed_port = await parsePort({...port_info, port: port});
                        }
                        cache.young.add(parsed_port);
                        return parsed_port;
                    } catch (t) {
                        if (!['EADDRINUSE', 'EACCES'].includes(t.code) && !(t instanceof Err)) {
                            throw t;
                        }
                    }
                }
                throw new Error('No available ports found');
            };
        };

        return (this.findAvailPorts = findPorts.call(this))();
    }

    onAdbDeviceConnectTimeout(device) {
        let res = this.adb.execOrThrow([
            '-s', device.id, 'shell', 'content', 'query',
            '--uri', 'content://org.autojs.autojs.debug.provider/debug-server',
        ]);
        let stdout = res.stdout.toString();
        let stderr = res.stderr.toString();
        let switch_err = '检查 AutoJs6 侧拉菜单是否开启 "服务端模式 (Server mode)"';
        let release_uri = 'https://github.com/SuperMonster003/AutoJs6/releases/';

        logDebug('query result: stdout = %s, stderr = %s, result = ', stdout, stderr, res);

        if ((stdout + stderr).includes('Could not find provider')) {
            vscode.window.showWarningMessage(`${switch_err} 或使用 6.0.1 以上版本`, '查看所有项目版本')
                .then(choice => choice && vscode.env.openExternal(vscode.Uri.parse(release_uri)));
        } else {
            const matched = stdout.match(/state=(\d+)/);
            if (matched === null || parseInt(matched[1]) !== 2) {
                vscode.window.showErrorMessage(switch_err);
            }
        }
    }

    connectToNewDevice() {
        vscode.window.showInputBox({prompt: '输入 AutoJs6 服务端 IP 地址'}).then((input) => {
            if (input) {
                let port = Device.defaultClientPort;
                this.client.connectTo(input, port)
                    .then(() => logDebug(`connected to ${input}:${port}`))
                    .catch(() => vscode.window.showErrorMessage(`连接 AutoJs6 服务端失败 (${input}) (AutoJs6 需开启服务端模式)`));
            }
        });
    }

    private static isProject() {
        const t = vscode.workspace.workspaceFolders;
        if (t && t.length > 0) {
            const e = t[0];
            return fs.existsSync(path.join(e.uri.fsPath, 'project.json'));
        }
        return false;
    }

    private runFile() {
        this.runFileOn(this.client);
    }

    private runFileOn(client: Devices) {
        let editor = vscode.window.activeTextEditor;
        if (editor) {
            client.sendCommand('run', {
                id: editor.document.fileName,
                name: editor.document.fileName,
                script: editor.document.getText(),
            });
        } else {
            vscode.window.showErrorMessage('需在正在编辑的文件窗口中使用运行命令');
        }
    }

    private static connectToLocalHint() {
        vscode.window.showInformationMessage(`在 AutoJs6 侧拉菜单开启客户端模式 (IP: ${util.getNicAddress()})`);
    }
}

// noinspection JSUnusedGlobalSymbols
export function activate(context: vscode.ExtensionContext) {
    logDebug('extension "AutoJs6 VSCode Ext" is activating');

    let instance = new Extension();

    instance.setContext(context);
    instance.setAdbInstance(new Adb(path.join(context.extensionPath, 'tools')));
    instance.newClient();

    instance.commands.forEach((command) => {
        let action = instance.getBoundAction(command);
        context.subscriptions.push(vscode.commands.registerCommand('extension.' + command, action));
    });

    logDebug('extension "AutoJs6 VSCode Ext" is now active');

    // noinspection JSUnusedGlobalSymbols
    this.deactivate = () => instance.disconnectAll();
}
import * as events from 'events';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as project from './project';
import * as vscode from 'vscode';
import { Project, ProjectObserver } from './project';
import { Server, Socket } from 'net';
import { connectedServerAdb, connectedServerLan, ConnectionType, Extension, logDebug, ProjectCommands } from './extension';

let packageJson: string = fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8');
let projectPackage = JSON.parse(packageJson);

export const REQUIRED_AUTOJS6_VERSION_NAME = projectPackage['requiredClientVersionName'];
export const REQUIRED_AUTOJS6_VERSION_CODE = parseInt(projectPackage['requiredClientVersionCode']) || -1;

const HEADER_SIZE = 8;

const TYPE_JSON = 1;
const TYPE_BYTES = 2;

// Limit a single frame size to prevent memory explosion on desync.
// zh-CN: 限制单帧最大长度, 防止失步后内存膨胀.
const MAX_FRAME_SIZE = 64 * 1024 * 1024;

const LISTENING_PORT = 6347;
const CLIENT_PORT = 7347;
const CLIENT_ADB_SERVER_PORT = 20347;
export const HTTP_SERVER_PORT = 10347;
const HANDSHAKE_TIMEOUT = 5e3;

export class Device extends events.EventEmitter {

    private versionCode = 0;
    private versionName: string;
    private id = 1;
    private name: string;
    private isAttached = false;

    connection: Socket;
    deviceId: string;
    projectObserver: ProjectObserver;
    adbDeviceId: string = null;
    host: string = null;
    isNormallyClosed: boolean = false;

    static defaultClientPort: number = CLIENT_PORT;
    static defaultAdbServerPort: number = CLIENT_ADB_SERVER_PORT;

    constructor(connection: Socket) {
        super();

        this.connection = connection;
        this.read(connection);

        this.on('data:hello', (data: HelloData) => {
            logDebug('on server hello: ', data);

            this.isAttached = true;
            this.name = data.device_name || 'unknown device';
            this.versionName = data.app_version;
            this.versionCode = parseInt(data.app_version_code);
            logDebug(`AutoJs6 version: ${this.versionName} (${this.versionCode})`);
            logDebug(`Required AutoJs6 version: ${REQUIRED_AUTOJS6_VERSION_NAME} (${REQUIRED_AUTOJS6_VERSION_CODE})`);
            if (this.versionCode < REQUIRED_AUTOJS6_VERSION_CODE) {
                let releasesUrl = 'https://github.com/SuperMonster003/AutoJs6/releases/';
                let currentVerInfo = `${this.versionName} (${this.versionCode})`;
                let requiredVerInfo = `${REQUIRED_AUTOJS6_VERSION_NAME} (${REQUIRED_AUTOJS6_VERSION_CODE})`;
                let errMessage = `无法建立连接, AutoJs6 版本 ${currentVerInfo} 应不低于 ${requiredVerInfo}`;

                vscode.window.showErrorMessage(errMessage, '查看所有项目版本')
                    .then(choice => choice && vscode.env.openExternal(vscode.Uri.parse(releasesUrl)));

                this.sendHello(errMessage);
                this.connection.destroy();
                this.connection = null;

                return;
            }
            this.deviceId = data.device_id;

            this.sendHello();
            this.emit('attach', this);
        });

        setTimeout(() => {
            if (!this.isAttached) {
                logDebug('Handshake timed out');
                vscode.window.showErrorMessage('连接建立超时');
                this.connection.destroy();
                this.connection = null;
            }
        }, HANDSHAKE_TIMEOUT);
    }

    toString() {
        return `${this.name}${this.connection ? ` (${this.connectionToString()})` : ''}`;
    }

    sendJson(data: object) {
        logDebug('## [m] Device.sendUTF8');

        const payload = Buffer.from(JSON.stringify(data), 'utf-8');

        // Use int32BE header for deterministic framing.
        // zh-CN: 使用 int32BE 头实现确定性分帧.
        const header = Buffer.allocUnsafe(HEADER_SIZE);
        header.writeInt32BE(payload.length, 0);
        header.writeInt32BE(TYPE_JSON, 4);

        this.connection.write(header);
        this.connection.write(payload);

        logDebug('## Written json ok: ' + payload.toString('utf-8'));
        logDebug('## Written json length: ' + payload.length);
        logDebug('## Written json string length: ' + payload.toString('utf-8').length);
    }

    sendBytes(bytes: Buffer) {
        logDebug('## [m] Device.sendBytes');

        // Use int32BE header for deterministic framing.
        // zh-CN: 使用 int32BE 头实现确定性分帧.
        const header = Buffer.allocUnsafe(HEADER_SIZE);
        header.writeInt32BE(bytes.length, 0);
        header.writeInt32BE(TYPE_BYTES, 4);

        this.connection.write(header);
        this.connection.write(bytes);

        logDebug(bytes);
        logDebug('## Written bytes ok: ' + bytes.toString('utf-8'));
        logDebug('## Written bytes length: ' + bytes.length);
        logDebug('## Written bytes string length: ' + bytes.toString('utf-8').length);
    }

    sendHello(err?: string) {
        logDebug('## [m] Device.sendHello');

        let id = this.id++;
        let data = { extensionVersion: projectPackage.version };
        if (err) {
            data['errorMessage'] = err;
        }
        this.sendJson({ id: id, type: 'hello', data: data });
        return id;
    }

    sendCommand(command: keyof Extension, data = {}) {
        logDebug('## [m] Device.sendCommand');

        let id = this.id++;
        this.sendJson({ id: id, type: 'command', data: Object.assign(Object(data), { command }) });
        return id;
    }

    disconnect() {
        this.connection.destroy();
        this.isNormallyClosed = true;
    }

    connectionToString() {
        let remoteAddress = this.connection.remoteAddress?.replace(/.*?:?((\d+\.){3}\d+$)/, '$1') || 'Unknown';
        return remoteAddress == '127.0.0.1' ? `${remoteAddress}:${this.connection.remotePort}` : remoteAddress;
    }

    read(socket: Socket) {
        logDebug('## Device.read');

        // Accumulated unread bytes from TCP stream.
        // zh-CN: TCP 流的累积未解析字节.
        let buffer: Buffer = Buffer.alloc(0);

        socket
            .on('data', (chunk: Buffer) => {
                logDebug('on data');

                buffer = Buffer.concat([ buffer, chunk ]);

                while (buffer.length >= HEADER_SIZE) {
                    const dataLength = buffer.readInt32BE(0);
                    const dataType = buffer.readInt32BE(4);

                    logDebug(`dataLength: ${dataLength}, dataType: ${dataType}`);

                    // Validate header fields to detect desync early.
                    // zh-CN: 校验头部字段, 尽早发现失步.
                    const isTypeValid = dataType === TYPE_JSON || dataType === TYPE_BYTES;
                    const isLengthValid = dataLength >= 0 && dataLength <= MAX_FRAME_SIZE;
                    if (!isTypeValid || !isLengthValid) {
                        logDebug(`Invalid frame header, destroy socket: {len: ${dataLength}, type: ${dataType}}`);
                        socket.destroy();
                        buffer = Buffer.alloc(0);
                        return;
                    }

                    const frameTotalLen = HEADER_SIZE + dataLength;
                    if (buffer.length < frameTotalLen) {
                        // Not enough data yet, wait for next chunk.
                        // zh-CN: 数据不足, 等待下一个 chunk.
                        break;
                    }

                    const payload = buffer.slice(HEADER_SIZE, frameTotalLen);
                    buffer = buffer.slice(frameTotalLen);

                    this.onData(dataType, payload);
                }
            })
            .on('message', (message) => {
                logDebug('on message');
                logDebug('message: ', message);
                if (message.type == 'utf8') {
                    try {
                        let json = JSON.parse(message.utf8Data);
                        logDebug('json: ', json);
                        this.emit('message', json);
                        this.emit('data:' + json.type, json.data);
                    } catch (e) {
                        logDebug(e);
                    }
                }
            })
            .on('close', (had_error: boolean) => {
                logDebug('on close');
                logDebug(`closed: {device: ${this}, had_error: ${had_error}}`);
                this.connection = null;
                this.emit('disconnect');
            });
    }

    onData(dataType: number, data: Buffer) {
        logDebug('## Device.onData');
        logDebug(`onData: type = ${dataType}, length = ${data.length}, content = ${data}`);

        this.handleJsonData(data);
    }

    handleJsonData(data: Buffer) {
        logDebug('## Device.handleJsonData');
        logDebug('## json data buffer length: ' + data.length);

        try {
            let encoding: BufferEncoding = 'utf-8';
            let parsed = JSON.parse(data.toString(encoding));
            logDebug('json: ', parsed);
            this.emit('message', parsed);
            this.emit(`data:${parsed.type}`, parsed.data);
        } catch (e) {
            logDebug(e);
        }
    }
}

export class Devices extends events.EventEmitter {

    devices: Device[];
    project: Project;

    private recentDevice: null;
    private serverSocket: Server;
    private readonly fileFilter: (relativePath: string, absPath: string, stats: fs.Stats) => (boolean | any);

    constructor() {
        super();
        this.devices = [];
        this.project = null;
        this.recentDevice = null;
        this.fileFilter = (relativePath, absPath, stats) => {
            if (!this.project) {
                return true;
            }
            return this.project.fileFilter(relativePath, absPath, stats);
        };
        this.serverSocket = net.createServer((socket) => {
            this.accept(socket);
        });
        Devices.instance = this;
        this.serverSocket.listen(LISTENING_PORT, () => {
            logDebug(`server listening on port ${LISTENING_PORT}`);
        });
    }

    static instance: Devices = null;

    accept(socket: Socket) {
        logDebug('## Devices.accept');

        socket.on('error', (e) => {
            logDebug('connect error: ', e);
        });

        new Device(socket).on('attach', (dev) => {
            logDebug('## on attach (accept)');
            this.attachDevice(dev, ConnectionType.CLIENT_LAN);
            logDebug('## on attach (accept) end');
        });

        logDebug('## Devices.accept end');
    }

    connectTo(host: string, port: number, type: ConnectionType, adbDeviceId?: string) {
        logDebug('## Devices.connectTo');

        return new Promise((resolve, reject) => {
            logDebug(`connecting to ${host}:${port}`);

            if (type === ConnectionType.SERVER_LAN) {
                if (connectedServerLan.has(host)) {
                    vscode.window.showWarningMessage(`服务端设备 ${host} 已建立连接 (局域网), 无需重复连接`);
                    return resolve(true);
                }
            } else if (type === ConnectionType.SERVER_ADB) {
                if (connectedServerAdb.has(adbDeviceId)) {
                    vscode.window.showWarningMessage(`服务端设备 ${adbDeviceId} 已建立连接 (ADB), 无需重复连接`);
                    return resolve(true);
                }
            }

            let socket = new net.Socket();
            socket.connect(port, host, () => {
                let device = new Device(socket);
                if (typeof adbDeviceId !== 'undefined') {
                    device.adbDeviceId = adbDeviceId;
                }
                device.on('attach', () => {
                    logDebug('## on attach (connectTo)');
                    if (typeof adbDeviceId !== 'undefined') {
                        this.attachDevice(device, ConnectionType.SERVER_ADB);
                    } else {
                        this.attachDevice(device, ConnectionType.SERVER_LAN);
                    }
                    resolve(device);
                });
            });
            socket.on('error', (e) => {
                logDebug('connect error: ', e);
                reject(e);
            });
        });
    }

    sendProjectCommand(folder: string, command: ProjectCommands) {
        logDebug('## Devices.sendProjectCommand');

        this.devices.forEach((device) => {
            if (device.projectObserver == null || device.projectObserver.folder != folder) {
                device.projectObserver = new project.ProjectObserver(folder, this.fileFilter);
            }
            device.projectObserver.diff()
                .then((result) => {
                    device.sendBytes(result.buffer);
                    device.sendJson({
                        type: 'bytes_command',
                        md5: result.md5,
                        data: {
                            id: folder,
                            name: folder,
                            deletedFiles: result.deletedFiles,
                            override: result.full,
                            command: command,
                        },
                    });
                });
        });
        return this.devices.length > 0;
    }

    sendCommand(command: keyof Extension, data = {}) {
        logDebug('## Devices.sendCommand');

        this.devices.forEach(device => device.sendCommand(command, data));
    }

    disconnect() {
        logDebug('## Devices.disconnect');

        this.devices.forEach(dev => dev.disconnect());
        this.devices.splice(0);
        this.recentDevice = null;
    }

    getDevice(id: string): Device {
        logDebug('## Devices.getDevice');

        if (id === '[recent]') {
            if (this.recentDevice !== null) {
                return this.recentDevice;
            }
            return this.devices.length > 0 ? this.devices[this.devices.length - 1] : null;
        }
        return this.devices.find(device => device.deviceId === id);
    }

    attachDevice(device: Device, type: number) {
        logDebug('## Devices.attachDevice');
        logDebug('attaching device: ' + device);

        this.emit('new_device', device, type);
        this.devices.push(device);

        device.on('data:log', (info: LogData) => {
            logDebug('## on data:log');
            logDebug(info.log);
            this.emit('log', {
                log: info.log,
                device: device,
            });
        });
        device.on('data:command', (param: CommandParam) => {
            let cmd = param['\xa0cmd\xa0'];
            if (!Extension.commands.includes(cmd)) {
                vscode.window.showErrorMessage(`接收到未知指令 "${cmd}"`);
                return;
            }
            vscode.window.showInformationMessage(`执行接收到的指令 "${cmd}"`);
            vscode.commands.executeCommand(`extension.${cmd}`);
        });
        device.on('disconnect', this.detachDevice.bind(this, device));

        logDebug('## Devices.attachDevice end');
    }

    detachDevice(device: Device) {
        logDebug('## Devices.detachDevice');

        this.devices.splice(this.devices.indexOf(device), 1);
        if (this.recentDevice === device) {
            this.recentDevice = null;
        }
        logDebug('detachDevice: ' + device);
        this.emit('detach_device', device);
    }

    hasDevices() {
        return this.devices.length > 0;
    }
}

export interface DeviceInfo {
    id: string;
    brand: string;
    model: string;
    name: string;
}

export interface LogData {
    log: string;
    device: Device;
}

interface HelloData {
    device_id: string;
    device_name: string;
    app_version: string;
    app_version_code: string;
}

interface CommandParam {
    '\xa0cmd\xa0': 'viewDocument' | 'connect' | 'disconnectAll' | 'run' | 'runOnDevice' | 'stop' | 'stopAll' | 'rerun' | 'save' | 'saveToDevice' | 'newUntitledFile' | 'newProject' | 'runProject' | 'saveProject';
    path: string;
}
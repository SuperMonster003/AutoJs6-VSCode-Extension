import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { Server, Socket } from 'net';
import * as events from 'events';
import * as vscode from 'vscode';
import * as project from './project';
import { Project, ProjectObserver } from './project';
import { buffToString, logDebug } from './util';
import { CONNECTION_TYPE_CLIENT_LAN, CONNECTION_TYPE_SERVER_ADB, CONNECTION_TYPE_SERVER_LAN, Extension, ProjectCommands, connectedServerAdb, connectedServerLan } from './extension';

let packageJson: string = fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8');
let projectPackage = JSON.parse(packageJson);

export const REQUIRED_AUTOJS6_VERSION_NAME = projectPackage.requiredClientVersionName;
export const REQUIRED_AUTOJS6_VERSION_CODE = parseInt(projectPackage.requiredClientVersionCode) || -1;

const SERVER_HEADER_SIZE = 16;
const CLIENT_HEADER_SIZE = 8;

const TYPE_JSON = 1;
const TYPE_BYTES = 2;

const LISTENING_PORT = 6347;
const CLIENT_PORT = 7347;
const CLIENT_ADB_SERVER_PORT = 20347;
export const HTTP_SERVER_PORT = 10347;
const HANDSHAKE_TIMEOUT = 5e3;

export class Device extends events.EventEmitter {

    private versionCode = 0;
    private id = 1;
    private name: string;
    private version: string;
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
            this.version = data.app_version;
            this.versionCode = parseInt(data.app_version_code);
            if (this.versionCode < REQUIRED_AUTOJS6_VERSION_CODE) {
                let releasesUrl = 'https://github.com/SuperMonster003/AutoJs6/releases/';
                const errMessage = `无法建立连接, 请确认 AutoJs6 版本不低于 ${REQUIRED_AUTOJS6_VERSION_NAME}`;
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

        let bytes: Buffer = Buffer.from(JSON.stringify(data), 'utf-8');
        let string = buffToString(bytes);

        let headerBuffer = Buffer.allocUnsafe(SERVER_HEADER_SIZE);
        headerBuffer.write(String(string.length), 0);
        headerBuffer.write(String(TYPE_JSON), SERVER_HEADER_SIZE - 2);

        this.connection.write(headerBuffer);
        this.connection.write(string);
        // this.connection.write('\r\n');

        logDebug('## Written json ok: ' + string);
        logDebug('## Written json length: ' + bytes.length);
        logDebug('## Written json string length: ' + string.length);
    }

    sendBytes(bytes: Buffer) {
        logDebug('## [m] Device.sendBytes');

        let string = bytes.toString('latin1');

        let headerBuffer = Buffer.allocUnsafe(SERVER_HEADER_SIZE);
        headerBuffer.write(String(string.length), 0);
        headerBuffer.write(String(TYPE_BYTES), SERVER_HEADER_SIZE - 2);

        this.connection.write(headerBuffer);
        this.connection.write(string);
        // this.connection.write('\r\n');

        logDebug(bytes);
        logDebug('## Written bytes ok: ' + string);
        logDebug('## Written bytes length: ' + bytes.length);
        logDebug('## Written bytes string length: ' + string.length);
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

    sendCommand(command, data = {}) {
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

        let DEFAULT_DATA_LENGTH = -1;
        let DEFAULT_DATA_TYPE = -1;

        let _ = {
            isLastDataComplete: true,
            jointData: <Buffer>Buffer.allocUnsafe(0),
            parsedDataType: DEFAULT_DATA_TYPE,
            onData(chunk: Buffer, parser: (dataType: number, data: Buffer) => void) {
                let offset = 0;
                let expectedChunkLen = ( /* @IIFE */ () => {
                    if (this.isLastDataComplete) {
                        this.parseHeader(chunk);
                        offset += CLIENT_HEADER_SIZE;
                        return CLIENT_HEADER_SIZE + this.parsedDataLength;
                    }
                    return this.parsedDataLength - this.getJointDataLength();
                })();

                this.joinData(chunk.slice(offset, expectedChunkLen));

                if (chunk.length >= expectedChunkLen) {
                    this.isLastDataComplete = true;
                    this.parseFullData(parser);
                    this.reset();

                    if (chunk.length > expectedChunkLen) {
                        let remaining = chunk.slice(expectedChunkLen);
                        logDebug(`remaining len: ${remaining.length}`);
                        this.onData(remaining, parser);
                    }
                } else {
                    this.isLastDataComplete = false;
                }
            },
            getJointDataLength() {
                return this.jointData.length;
            },
            joinData(data: Buffer): void {
                logDebug(`length of data to be joint: ${data.length}`);
                this.jointData = Buffer.concat([ this.jointData, data ]);
            },
            parseHeader(chunk: Buffer) {
                this.parsedDataLength = chunk.readInt32BE(0);
                this.parsedDataType = chunk.readInt32BE(4);
                logDebug(`dataLength: ${this.parsedDataLength}, dataType: ${this.parsedDataType}`);
            },
            parseFullData(parser: (dataType: number, data: Buffer) => void) {
                logDebug(`parsing full data... (len: ${this.jointData.length})`);
                parser(this.parsedDataType, this.jointData);
            },
            reset() {
                this.jointData = <Buffer>Buffer.allocUnsafe(0);
                this.parsedDataLength = DEFAULT_DATA_LENGTH;
                this.parsedDataType = DEFAULT_DATA_TYPE;
            },
        };

        socket
            .on('data', (chunk: Buffer) => {
                logDebug('on data');
                _.onData(chunk, this.onData.bind(this));
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
                        console.error(e);
                    }
                }
            })
            .on('close', (had_error, description) => {
                logDebug('on close');
                logDebug(`closed: {device: ${this}, had_error: ${had_error}, desc: ${description}}`);
                this.connection = null;
                this.emit('disconnect');
            });
    }

    onData(dataType, data) {
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
            console.error(e);
        }
    }
}

export class Devices extends events.EventEmitter {

    devices: Device[];
    project: Project;

    private recentDevice: null;
    private serverSocket: Server;
    private readonly fileFilter: (relativePath, absPath, stats) => (boolean | any);

    isServerSocketNormallyClosed: boolean = false;

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
            console.error('connect error: ', e);
        });

        new Device(socket).on('attach', (dev) => {
            logDebug('## on attach (accept)');
            this.attachDevice(dev, CONNECTION_TYPE_CLIENT_LAN);
            logDebug('## on attach (accept) end');
        });

        logDebug('## Devices.accept end');
    }

    connectTo(host, port, type, adbDeviceId?) {
        logDebug('## Devices.connectTo');

        return new Promise((resolve, reject) => {
            logDebug(`connecting to ${host}:${port}`);

            if (type === CONNECTION_TYPE_SERVER_LAN) {
                if (connectedServerLan.has(host)) {
                    vscode.window.showWarningMessage(`服务端设备 ${host} 已建立连接 (局域网), 无需重复连接`);
                    return resolve(true);
                }
            } else if (type === CONNECTION_TYPE_SERVER_ADB) {
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
                        this.attachDevice(device, CONNECTION_TYPE_SERVER_ADB);
                    } else {
                        this.attachDevice(device, CONNECTION_TYPE_SERVER_LAN);
                    }
                    resolve(device);
                });
            });
            socket.on('error', (e) => {
                console.error('connect error: ', e);
                reject(e);
            });
        });
    }

    sendProjectCommand(folder, command: ProjectCommands) {
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

    sendCommand(command, data = {}) {
        logDebug('## Devices.sendCommand');

        this.devices.forEach(device => device.sendCommand(command, data));
    }

    disconnect() {
        logDebug('## Devices.disconnect');

        this.devices.forEach(dev => dev.disconnect());
        this.devices.splice(0);
        this.recentDevice = null;
    }

    getDevice(id) {
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

    detachDevice(device) {
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
    '\xa0cmd\xa0': 'viewDocument' | 'connect' | 'disconnectAll' | 'run' | 'runOnDevice' | 'stop' | 'stopAll' | 'rerun' | 'save' | 'saveToDevice' | 'newProject' | 'runProject' | 'saveProject';
    path: string;
}
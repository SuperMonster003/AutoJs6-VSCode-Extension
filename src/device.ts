import * as net from 'net';
import * as events from 'events';
import * as project from './project';
import * as zlib from 'zlib';
import * as vscode from 'vscode';

import {logDebug} from './util';
import {Server, Socket} from 'net';
import {Project, ProjectObserver} from './project';

const HEADER_SIZE = 8;
const TYPE_TEXT = 1;
const TYPE_BINARY = 2;
const TYPE_GZIP_TEXT = 3;
const TYPE_GZIP_BINARY = 4;
const LISTENING_PORT = 6347;
const CLIENT_PORT = 9317;
const HTTP_SERVER_PORT = 27139;
const HANDSHAKE_TIMEOUT = 10 * 1000;
const PROTOCOL_VERSION_4 = 4;
const PROTOCOL_VERSION = PROTOCOL_VERSION_4;

export class Device extends events.EventEmitter {
    private versionCode: number;
    private protocolVersion: number;
    private id: number;
    private name: string;
    private version: string;
    private isAttached: boolean;

    connection: Socket;
    deviceId: string;
    adbDeviceId: string;
    httpServerPort: number = Device.defaultHttpServerPort;
    projectObserver: ProjectObserver;

    static defaultHttpServerPort: number = HTTP_SERVER_PORT;
    static defaultClientPort: number = CLIENT_PORT;

    constructor(connection: Socket) {
        super();
        this.id = 1;
        this.versionCode = 0;
        this.protocolVersion = 0;
        this.isAttached = false;
        this.connection = connection;
        this.read(this.connection);
        this.toString = () => `${this.name}${this.connection ? ` (${this.connectionToString()})` : ''}`;
        this.on('data:hello', (data) => {
            logDebug('on server hello: ', data);

            this.isAttached = true;
            this.name = data['device_name'] || 'unknown device';
            this.version = data['app_version'];
            this.versionCode = data['app_version_code'];

            this.protocolVersion = data['server_version'];
            this.deviceId = data['device_id'];

            this.send('hello', {
                client_version: PROTOCOL_VERSION,
            });
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

    send(type: string, data: object) {
        logDebug('## Device.send');

        let id = this.id++;
        this.sendUTF8(JSON.stringify({
            id: id,
            type: type,
            data: data,
        }));
        return id;
    }

    sendUTF8(data: string) {
        logDebug('## Device.sendUTF8');
        logDebug('Protocol ver', PROTOCOL_VERSION_4);

        let bytes = Buffer.from(data, 'utf-8');

        if (this.protocolVersion >= PROTOCOL_VERSION_4) {
            zlib.gzip(bytes, (error, result) => {
                if (error) {
                    console.error(error);
                    return;
                }
                logDebug('Sending gzip bytes');
                logDebug('Gzip buffer str: ' + bytes.toString());
                logDebug('Gzip buffer str length: ' + bytes.toString().length);
                logDebug('Gzipped buffer str: ' + result.toString());
                logDebug('Gzipped buffer str length: ' + result.toString().length);
                this.sendBytesWithType(TYPE_GZIP_TEXT, result);
            });
        } else {
            logDebug('Sending text bytes');
            this.sendBytesWithType(TYPE_TEXT, bytes);
        }
    }

    sendBytesWithType(type: number, bytes: Buffer) {
        logDebug('## Device.sendBytesWithType');
        logDebug(`type: ${type}`);
        logDebug(`bytes: ${bytes.toString()}`);

        let buffer = Buffer.concat([Buffer.alloc(8), bytes]);
        buffer.writeInt32BE(bytes.length, 0);
        buffer.writeInt32BE(type, 4);
        logDebug('## writing...');
        logDebug('## bytes length: ' + bytes.length);
        logDebug('## buffer length: ' + buffer.length);

        if (this.protocolVersion >= PROTOCOL_VERSION_4) {
            this.connection.write(buffer);
        } else {
            this.connection.write(buffer.toString() + '\r\n');
        }
        logDebug('## written ok');
    }

    sendBytes(bytes: Buffer) {
        logDebug('## Device.sendBytes');

        if (this.protocolVersion >= PROTOCOL_VERSION_4) {
            zlib.gzip(bytes, (error, result) => {
                if (error) {
                    console.error(error);
                    return;
                }
                this.sendBytesWithType(TYPE_GZIP_BINARY, result);
            });
        } else {
            this.sendBytesWithType(TYPE_BINARY, bytes);
        }
    }

    sendBytesCommand(command, md5, data = {}) {
        logDebug('## Device.sendBytesCommand');

        data = Object(data);
        data['command'] = command;
        this.sendUTF8(JSON.stringify({
            type: 'bytes_command',
            md5: md5,
            data: data,
        }));
    }

    sendCommand(command, data = {}) {
        logDebug('## Device.sendCommand');

        return this.send('command', Object.assign(Object(data), {command}));
    }

    disconnect() {
        logDebug('## Device.disconnect');

        this.connection.destroy();
    }

    connectionToString() {
        logDebug('## Device.connectionToString');

        let remoteAddress = this.connection.remoteAddress.replace(/.*?:?((\d+\.){3}\d+$)/, '$1');

        return remoteAddress == '127.0.0.1' ? `${remoteAddress}:${this.connection.remotePort}` : remoteAddress;
    }

    read(socket: Socket) {
        logDebug('## Device.read');

        socket
            .on('data', (chunk: Buffer) => {
                let dataLength = null;
                let dataType = 0;
                let unified = Buffer.allocUnsafe(0);

                logDebug('on data');

                unified = Buffer.concat([unified, chunk]);

                while (unified.length >= HEADER_SIZE) {
                    dataLength = unified.readInt32BE(0);
                    dataType = unified.readInt32BE(4);
                    logDebug(`dataLength: ${dataLength}, dataType: ${dataType}`);

                    if (dataLength !== null) {
                        if (unified.length < dataLength + HEADER_SIZE) {
                            break;
                        }
                        let data = unified.slice(HEADER_SIZE, dataLength + HEADER_SIZE);
                        unified = unified.slice(dataLength + HEADER_SIZE);
                        this.onData(dataType, data);
                        dataLength = null;
                    }
                }
            })
            .on('message', message => {
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

        if (dataType == TYPE_TEXT) {
            this.handleJsonData(data);
            return;
        }
        if (dataType == TYPE_GZIP_TEXT) {
            try {
                zlib.gunzip(data, (error, buffer) => {
                    if (error) {
                        console.error(error);
                        return;
                    }
                    this.handleJsonData(buffer);
                });
            } catch (e) {
                console.error(e);
            }
            return;
        }
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
            logDebug('server listening at ' + LISTENING_PORT);
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
            this.emit('new_device', dev);
            this.attachDevice(dev);
            logDebug('## on attach (accept) end');
        });

        logDebug('## Devices.accept end');
    }

    connectTo(host, port, adbDeviceId?, httpServerPort?) {
        logDebug('## Devices.connectTo');

        return new Promise((resolve, reject) => {
            logDebug(`connecting to ${host}:${port}`);

            let socket = new net.Socket();
            socket.connect(port, host, () => {
                let device = new Device(socket);
                if (typeof adbDeviceId !== 'undefined') {
                    device.adbDeviceId = adbDeviceId;
                }
                if (typeof httpServerPort !== 'undefined') {
                    device.httpServerPort = httpServerPort;
                }
                device.on('attach', () => {
                    logDebug('## on attach (connectTo)');
                    this.emit('new_device', device);
                    this.attachDevice(device);
                    resolve(device);
                });
            });
            socket.on('error', (e) => {
                console.error('connect error: ', e);
                reject(e);
            });
        });
    }

    send(type, data) {
        logDebug('## Devices.send');

        this.devices.forEach(device => {
            device.send(type, data);
        });
    }

    sendBytes(data) {
        logDebug('## Devices.sendBytes');

        this.devices.forEach(device => {
            device.sendBytes(data);
        });
    }

    sendBytesCommand(command, md5, data = {}) {
        logDebug('## Devices.sendBytesCommand');

        this.devices.forEach(device => {
            device.sendBytesCommand(command, md5, data);
        });
    }

    sendProjectCommand(folder, command) {
        logDebug('## Devices.sendProjectCommand');

        if (this.devices.length === 0) {
            return false;
        }
        this.devices.forEach(device => {
            if (device.projectObserver == null || device.projectObserver.folder != folder) {
                device.projectObserver = new project.ProjectObserver(folder, this.fileFilter);
            }
            device.projectObserver.diff()
                .then(result => {
                    device.sendBytes(result.buffer);
                    device.sendBytesCommand(command, result.md5, {
                        'id': folder,
                        'name': folder,
                        'deletedFiles': result.deletedFiles,
                        'override': result.full,
                    });
                });
        });
        return true;
    }

    sendCommand(command, data = {}) {
        logDebug('## Devices.sendCommand');

        this.devices.forEach(dev => dev.sendCommand(command, data));
    }

    disconnect() {
        logDebug('## Devices.disconnect');

        this.devices.forEach(device => {
            device.disconnect();
        });
        this.devices = [];
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

    attachDevice(device: Device) {
        logDebug('## Devices.attachDevice');

        logDebug('attaching device: ' + device);

        this.devices.push(device);

        device.on('data:log', (info: DeviceDataInfo) => {
            logDebug('## on data:log');
            logDebug(info.log);
            this.emit('log', {
                log: info.log,
                device: device,
            });
        });
        device.on('disconnect', this.detachDevice.bind(this, device));

        logDebug('## Devices.attachDevice end');
    }

    detachDevice(device) {
        logDebug('## Devices.detachDevice');

        this.devices.splice(this.devices.indexOf(device), 1);
        if (device === this.recentDevice) {
            this.recentDevice = null;
        }
        logDebug('detachDevice: ' + device);
        this.emit('detach_device', device);
    }
}

export interface DeviceInfo {
    id: string;
    brand: string;
    model: string;
    name: string;
}

export interface DeviceDataInfo {
    log: string;
    device: Device;
}
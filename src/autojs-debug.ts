import * as net from 'net';
import * as readline from 'readline';
import { EventEmitter } from 'events';
import * as ws from 'websocket';
import * as http from 'http'
import * as fs from 'fs'
import * as jszip from 'jszip'
import { Project, ProjectObserser } from './project';

const DEBUG = false;

function logDebug(message?: any, ...optionalParams: any[]){
    if(DEBUG){
        console.log.apply(console, arguments);
    }
}


const HANDSHAKE_TIMEOUT = 10 * 1000;

export class Device extends EventEmitter {
    public name: string;
    private connection: ws.connection;
    private attached: boolean = false;
    public projectObserser: ProjectObserser;

    constructor(connection: ws.connection) {
        super();
        this.connection = connection;
        this.read(this.connection);
        this.on('data:hello', data => {
            logDebug("on client hello: ", data);
            this.attached = true;
            this.name = data['device_name'];
            this.send("hello", {
                "server_version": 2
            });
            this.emit("attach", this);
        });
        setTimeout(() => {
            if (!this.attached) {
                console.log("handshake timeout");
                this.connection.close();
                this.connection = null;
            }
        }, HANDSHAKE_TIMEOUT);
    }

    send(type: string, data: object): void {
        this.connection.sendUTF(JSON.stringify({
            type: type,
            data: data
        }));
    }

    sendBytes(bytes: Buffer): void {
        this.connection.sendBytes(bytes);
    }

    sendBytesCommand(command: string, md5: string, data: object = {}): void {
        data = Object(data);
        data['command'] = command;
        this.connection.sendUTF(JSON.stringify({
            type: 'bytes_command',
            md5: md5,
            data: data
        }));
    }

    sendCommand(command: string, data: object): void {
        data = Object(data);
        data['command'] = command;
        this.send('command', data);
    }

    public toString = (): string => {
        if (!this.connection) {
            return `${this.name}[Disconnected]`
        }
        if (!this.name) {
            return `Device (${this.connection.remoteAddress})`;
        }
        return `Device ${this.name}(${this.connection.remoteAddress})`;
    }

    private read(connection: ws.connection) {
        connection.on('message', message => {
            logDebug("message: ", message);
            if (message.type == 'utf8') {
                try {
                    let json = JSON.parse(message.utf8Data);
                    logDebug("json: ", json);
                    this.emit('message', json);
                    this.emit('data:' + json['type'], json['data']);
                } catch (e) {
                    console.error(e);
                }
            }
        });
        connection.on('close', (reasonCode, description) => {
            console.log(`close: device = ${this}, reason = ${reasonCode}, desc = ${description}`);
            this.connection = null;
            this.emit('disconnect');
        });
    }

}

export class AutoJsDebugServer extends EventEmitter {

    private httpServer: http.Server;
    private wsServer: ws.server;
    private port: number;
    public devices: Array<Device> = [];
    public project: Project = null;
    private fileFilter = (relativePath: string, absPath: string, stats: fs.Stats)=>{
        if(!this.project){
            return true;
        }
        return this.project.fileFilter(relativePath, absPath, stats);
    };

    constructor(port: number) {
        super();
        this.port = port;
        this.httpServer = http.createServer(function (request, response) {
            console.log(new Date() + ' Received request for ' + request.url);
            response.writeHead(404);
            response.end();
        });
        var wsServer = new ws.server({ httpServer: this.httpServer });
        wsServer.on('request', request => {
            logDebug('request: ', request);
            let connection = this.openConnection(request);
            if (!connection) {
                return;
            }
            let device = new Device(connection);
            device.on("attach", (device) => {
                this.attachDevice(device);
                this.emit('new_device', device);
            });
        });
    }

    openConnection(request: ws.request): ws.connection {
        return request.accept();
    }

    listen(): void {
        this.httpServer.on('error', (e) => {
            console.error('server error: ', e);
        });
        this.httpServer.listen(this.port, '0.0.0.0', () => {
            let address = this.httpServer.address();
            console.log(`server listening on ${address.address}':${address.port}`);
            this.emit("connect");
        });
    }

    send(type: string, data: object): void {
        this.devices.forEach(device => {
            device.send(type, data);
        });
    }

    sendBytes(data: Buffer): void {
        this.devices.forEach(device => {
            device.sendBytes(data);
        });
    }

    sendBytesCommand(command: string, md5: string, data: object = {}): void {
        this.devices.forEach(device => {
            device.sendBytesCommand(command, md5, data);
        });
    }

    sendProjectCommand(folder:string, command: string) {
        this.devices.forEach(device => {
            if(device.projectObserser == null || device.projectObserser.folder != folder){
                device.projectObserser = new ProjectObserser(folder, this.fileFilter);
            }
            device.projectObserser.diff()
                .then(result => {
                    device.sendBytes(result.buffer);
                    device.sendBytesCommand(command, result.md5, {
                        'id': folder,
                        'name': folder
                    });
                });
        });
    }

    sendCommand(command: string, data: object = {}): void {
        this.devices.forEach(device => {
            device.sendCommand(command, data);
        });
    }

    disconnect(): void {
        this.httpServer.close();
        this.emit("disconnect");
    }

    private attachDevice(device: Device): void {
        this.devices.push(device);
        device.on('data:log', data => {
            console.log(data['log']);
            this.emit('log', data['log']);
        });
        device.on('disconnect', this.detachDevice.bind(this, device));
    }

    private detachDevice(device: Device): void {
        this.devices.splice(this.devices.indexOf(device), 1);
        console.log("detachDevice: " + device);
    }

}

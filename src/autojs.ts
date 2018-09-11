import * as net from 'net';
import * as readline from 'readline';
import {EventEmitter} from 'events';
var JsonSocket = require('json-socket');

const HANDSHAKE_TIMEOUT = 10 * 1000;

export class Device extends EventEmitter {
    public name: string;
    private socket: net.Socket;
    private jsonSocket;
    private attached: boolean = false;

    constructor(socket:net.Socket){
        super();
        socket.setEncoding('utf-8');
        this.socket = socket;
        this.jsonSocket = new JsonSocket(socket);
        this.readFromSocket(this.jsonSocket);
        this.on('data:hello', data=>{
            console.log("on client hello: ", data);
            this.attached = true;
            this.name = data['device_name'];
            this.send("hello", {
                "server_version": 2
            });
            this.emit("attach", this);
        });
        setTimeout(()=>{
            if(!this.attached){
                console.log("handshake timeout");
                this.socket.destroy();
                this.socket = null;
                this.jsonSocket = null;
            }
        }, HANDSHAKE_TIMEOUT);
    }

    send(type: string, data: object): void {
        this.jsonSocket.sendMessage({
            type: type,
            data: data
        });
    }

    sendCommand(command: string, data: object): void {
        data = Object(data);
        data['command'] = command;
        this.jsonSocket.sendMessage({
            type: 'command',
            data: data
        });
    }

    public toString = () : string => {
        if(!this.socket){
            return `${this.name}[Disconnected]`
        }
        if(!this.name){
            return `Device (${this.socket.remoteAddress}:${this.socket.remotePort})`;
        }
        return `Device ${this.name}(${this.socket.remoteAddress}:${this.socket.remotePort})`;
    }

    private readFromSocket(socket){
        socket.on('message', message => {
            console.log("message: ", message);
            this.emit('message', message);
            this.emit('data:' + message['type'], message['data']);
        });
        socket.on('close', ()=>{
            this.socket = null;
            this.jsonSocket = null;
            this.emit('disconnect');
        });
    }

}

export class AutoJs extends EventEmitter{
    
    private server: net.Server;
    private port: number;
    public devices: Array<Device> = [];

    constructor(port:number){
        super();
        this.port = port;
        this.server = net.createServer(socket=>{
            let device = new Device(socket);
            device.on("attach", (device)=>{
                this.attachDevice(device);
                this.emit('new_device', device);
            });
        });
    }

    listen(): void {
        this.server.listen(this.port, '0.0.0.0', ()=>{
            let address = this.server.address();
            console.log(`server listening on ${address.address}':${address.port}`);
            this.emit("connect");
        });
    }

    send(type: string, data: object): void{
        this.devices.forEach(device => {
            device.send(type, data);
        });
    }

    sendCommand(command: string, data: object = {}): void{
        this.devices.forEach(device => {
            device.sendCommand(command, data);
        });
    }

    disconnect(): void{
        this.server.close();
        this.emit("disconnect");
    }

    private attachDevice(device:Device): void{
        this.devices.push(device);
        device.on('data:log', data=>{
            console.log(data['log']);
        });
        device.on('disconnect', this.detachDevice.bind(this, device));
    }

    private detachDevice(device:Device): void {
        this.devices.splice(this.devices.indexOf(device), 1);
        console.log("detachDevice" + device);
    }
    
}

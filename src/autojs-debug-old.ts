import * as net from 'net';
import * as readline from 'readline';
import {EventEmitter} from 'events';

export class Device extends EventEmitter{
    public name: string;
    private socket: net.Socket;

    constructor(socket:net.Socket){
        super();
        this.socket = socket;
        socket.setEncoding('utf-8');
        this.readFromSocket(socket);
        this.on('data:device_name', data=>{
            this.name = data['device_name'];
            console.log('device: ' + this);
        });
    }

    send(data: object): void {
        let json = JSON.stringify(data);
        this.socket.write(json);
        this.socket.write('\n');
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

    private readFromSocket(socket:net.Socket){
        let rl = readline.createInterface(socket);
        rl.on('line', line => {
            let jsonObj = JSON.parse(line);
            this.emit('data', jsonObj);
            this.emit('data:' + jsonObj['type'], jsonObj);
        });
        socket.on('close', ()=>{
            this.socket = null;
            this.emit('disconnect');
        });
    }

}

export class AutoJsDebugServer extends EventEmitter{
    
    private server: net.Server;
    private port: number;
    public devices: Array<Device> = [];

    constructor(port:number){
        super();
        this.port = port;
        this.server = net.createServer(socket=>{
            let device = new Device(socket);
            this.attachDevice(device);
            this.emit('new_device', device);
        });
    }

    listen(): void {
        this.server.listen(this.port, '0.0.0.0', ()=>{
            let address = this.server.address();
            console.log(`server listening on ${address.address}':${address.port}`);
            this.emit("connect");
        });
    }

    send(data: object): void{
        this.devices.forEach(device => {
            device.send(data);
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
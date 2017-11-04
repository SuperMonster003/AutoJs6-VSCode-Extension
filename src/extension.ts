'use strict';
import * as vscode from 'vscode';
import {AutoJs, Device} from './autojs';


var server = new AutoJs(1209);
var recentDevice = null;

server
    .on('connect', ()=>{
        vscode.window.showInformationMessage('Auto.js server running');    
    })
    .on('new_device', (device: Device)=>{
        var messageShown = false;
        var showMessage = () =>{
            if(messageShown)
                return;
            vscode.window.showInformationMessage('New device attached: ' + device);  
            messageShown = true;
        };
        setTimeout(showMessage, 1000);
        device.on('data:device_name', showMessage);
    });

class Extension {
    
    startServer(){
        server.listen();
    }
    
    stopServer(){
        server.disconnect();
        vscode.window.showInformationMessage('Auto.js server stopped');
    }
    
    run(){
        this.runOn(server);
    }

    stop(){
        server.send({
            'type': 'command',
            'view_id': vscode.window.activeTextEditor.document.fileName,
            'command': 'stop',
        })
    }

    stopAll(){
        server.send({
            'type': 'command',
            'command': 'stopAll'
        })
    }

    rerun(){
        let editor = vscode.window.activeTextEditor;
        server.send({
            'type': 'command',
            'command': 'rerun',
            'view_id': editor.document.fileName,
            'name': editor.document.fileName,
            'script': editor.document.getText()
        });
    }
    
    runOnDevice(){
        this.selectDevice(device => this.runOn(device));
    }
    
    selectDevice(callback){
        let devices = server.devices;
        if(recentDevice){
            let i = devices.indexOf(recentDevice);
            if(i > 0){
                devices = devices.slice(0);
                devices[i] = devices[0];
                devices[0] = recentDevice;
            }
        }
        let names = devices.map(device => device.toString());
        vscode.window.showQuickPick(names)
             .then(select => {
                let device = devices[names.indexOf(select)];
                recentDevice = device;
                callback(device);
             });
    }

    runOn(target: AutoJs | Device){
        let editor = vscode.window.activeTextEditor;
        target.send({
            'type': 'command',
            'command': 'run',
            'view_id': editor.document.fileName,
            'name': editor.document.fileName,
            'script': editor.document.getText()
        })
    }

    save(){
        this.saveTo(server);
    }

    saveToDevice(){
        this.selectDevice(device => this.saveTo(device));
    }

    saveTo(target: AutoJs | Device){
        let editor = vscode.window.activeTextEditor;
        target.send({
            'command': 'save',
            'type': 'command',
            'view_id':  editor.document.fileName,
            'name':  editor.document.fileName,
            'script': editor.document.getText()
        })
    }
};


const commands = ['startServer', 'stopServer', 'run', 'runOnDevice', 'stop', 'stopAll', 'rerun', 'save', 'saveToDevice'];
let extension = new Extension();

export function activate(context: vscode.ExtensionContext) {
    console.log('extension "auto-js-vscodeext" is now active.');
    commands.forEach((command)=>{
        let action: Function = extension[command];
        context.subscriptions.push(vscode.commands.registerCommand('extension.' + command, action.bind(extension)));
    })
}

export function deactivate() {
    server.disconnect();
}
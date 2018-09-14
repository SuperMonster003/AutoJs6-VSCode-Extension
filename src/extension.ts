'use strict';
import * as vscode from 'vscode';
import { AutoJsDebugServer, Device } from './autojs-debug';


var server = new AutoJsDebugServer(9317);
var recentDevice = null;

server
    .on('connect', () => {
        vscode.window.showInformationMessage('Auto.js server running');
    })
    .on('new_device', (device: Device) => {
        var messageShown = false;
        var showMessage = () => {
            if (messageShown)
                return;
            vscode.window.showInformationMessage('New device attached: ' + device);
            messageShown = true;
        };
        setTimeout(showMessage, 1000);
        device.on('data:device_name', showMessage);
    });

class Extension {

    startServer() {
        server.listen();
    }

    stopServer() {
        server.disconnect();
        vscode.window.showInformationMessage('Auto.js server stopped');
    }

    run() {
        this.runOn(server);
    }

    stop() {
        server.sendCommand('stop', {
            'id': vscode.window.activeTextEditor.document.fileName,
        })
    }

    stopAll() {
        server.sendCommand('stopAll')
    }

    rerun() {
        let editor = vscode.window.activeTextEditor;
        server.sendCommand('rerun', {
            'id': editor.document.fileName,
            'name': editor.document.fileName,
            'script': editor.document.getText()
        });
    }

    runOnDevice() {
        this.selectDevice(device => this.runOn(device));
    }

    selectDevice(callback) {
        let devices = server.devices;
        if (recentDevice) {
            let i = devices.indexOf(recentDevice);
            if (i > 0) {
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

    runOn(target: AutoJsDebugServer | Device) {
        let editor = vscode.window.activeTextEditor;
        target.sendCommand('run', {
            'id': editor.document.fileName,
            'name': editor.document.fileName,
            'script': editor.document.getText()
        })
    }

    save() {
        this.saveTo(server);
    }

    saveToDevice() {
        this.selectDevice(device => this.saveTo(device));
    }

    saveTo(target: AutoJsDebugServer | Device) {
        let editor = vscode.window.activeTextEditor;
        target.sendCommand('save', {
            'id': editor.document.fileName,
            'name': editor.document.fileName,
            'script': editor.document.getText()
        })
    }
};


const commands = ['startServer', 'stopServer', 'run', 'runOnDevice', 'stop', 'stopAll', 'rerun', 'save', 'saveToDevice'];
let extension = new Extension();

export function activate(context: vscode.ExtensionContext) {
    console.log('extension "auto-js-vscodeext" is now active.');
    commands.forEach((command) => {
        let action: Function = extension[command];
        context.subscriptions.push(vscode.commands.registerCommand('extension.' + command, action.bind(extension)));
    })
}

export function deactivate() {
    server.disconnect();
}
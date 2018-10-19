'use strict';
import * as vscode from 'vscode';
import { AutoJsDebugServer, Device } from './autojs-debug';
import * as oldAutojs from './autojs-debug-old';
import { ProjectTemplate, Project } from './project';
import { join } from 'path';

var server = new AutoJsDebugServer(9317);
var oldServer = new oldAutojs.AutoJsDebugServer(1209);

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
    })
    .on('log', log => {
    });

oldServer
    .on('connect', () => {
        console.log('Auto.js server running');
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
        oldServer.listen();
    }

    stopServer() {
        server.disconnect();
        oldServer.disconnect();
        vscode.window.showInformationMessage('Auto.js server stopped');
    }

    run() {
        this.runOn(server);
        this.runOn(oldServer);
    }

    stop() {
        server.sendCommand('stop', {
            'id': vscode.window.activeTextEditor.document.fileName,
        });
        oldServer.send({
            'type': 'command',
            'view_id': vscode.window.activeTextEditor.document.fileName,
            'command': 'stop',
        })
    }

    stopAll() {
        server.sendCommand('stopAll');
        oldServer.send({
            'type': 'command',
            'command': 'stopAll'
        })
    }

    rerun() {
        let editor = vscode.window.activeTextEditor;
        server.sendCommand('rerun', {
            'id': editor.document.fileName,
            'name': editor.document.fileName,
            'script': editor.document.getText()
        });
        oldServer.send({
            'type': 'command',
            'command': 'rerun',
            'view_id': editor.document.fileName,
            'name': editor.document.fileName,
            'script': editor.document.getText()
        });
    }

    runOnDevice() {
        this.selectDevice(device => this.runOn(device));
    }

    selectDevice(callback) {
        let devices: Array<Device | oldAutojs.Device> = server.devices;
        devices = devices.concat(oldServer.devices);
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

    runOn(target: AutoJsDebugServer | Device | oldAutojs.Device | oldAutojs.AutoJsDebugServer) {
        let editor = vscode.window.activeTextEditor;
        if (target instanceof oldAutojs.Device || target instanceof oldAutojs.AutoJsDebugServer) {
            target.send({
                'type': 'command',
                'command': 'run',
                'view_id': editor.document.fileName,
                'name': editor.document.fileName,
                'script': editor.document.getText()
            })
        } else {
            target.sendCommand('run', {
                'id': editor.document.fileName,
                'name': editor.document.fileName,
                'script': editor.document.getText()
            })
        }

    }

    save() {
        this.saveTo(server);
    }

    saveToDevice() {
        this.selectDevice(device => this.saveTo(device));
    }

    saveTo(target: AutoJsDebugServer | Device | oldAutojs.Device) {
        let editor = vscode.window.activeTextEditor;
        if (target instanceof oldAutojs.Device || target instanceof oldAutojs.AutoJsDebugServer) {
            target.send({
                'command': 'save',
                'type': 'command',
                'view_id': editor.document.fileName,
                'name': editor.document.fileName,
                'script': editor.document.getText()
            })
        } else {
            target.sendCommand('save', {
                'id': editor.document.fileName,
                'name': editor.document.fileName,
                'script': editor.document.getText()
            })
        }
    }

    newProject() {
        vscode.window.showOpenDialog({
            'canSelectFiles': false,
            'canSelectFolders': true,
            'openLabel': '新建到这里'
        }).then(uris => {
            if (!uris || uris.length == 0) {
                return;
            }
            return new ProjectTemplate(uris[0])
                .build();
        }).then(uri => {
            vscode.commands.executeCommand("vscode.openFolder", uri);
        });
    }

    runProject() {
       this.sendProjectCommand("run_project");
    }

    sendProjectCommand(command: string) {
        let folders = vscode.workspace.workspaceFolders;
        if(!folders || folders.length == 0){
            vscode.window.showInformationMessage("请打开一个项目的文件夹");
            return null;
        }
        let folder = folders[0].uri;
        if(!server.project || server.project.folder != folder){
            server.project && server.project.dispose();
            server.project = new Project(folder);
        }
        server.sendProjectCommand(folder.fsPath, command);
    }
    saveProject() {
        this.sendProjectCommand("save_project");
    }
};


const commands = ['startServer', 'stopServer', 'run', 'runOnDevice', 'stop', 'stopAll', 'rerun', 'save', 'saveToDevice', 'newProject',
            'runProject', 'saveProject'];
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
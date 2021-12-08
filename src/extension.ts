'use strict';
import * as vscode from 'vscode';
import {AutoJsDebugServer, Device} from './autojs-debug';
import {ProjectTemplate, Project} from './project';

let server = new AutoJsDebugServer(9317);
let vscContext: vscode.ExtensionContext = null;
let recentDevice = null;

server
    .on('connect', () => {
        vscode.window.showInformationMessage(`AutoJs6 服务正在运行 (${server.ip})`);
        // vscode.window.showInformationMessage(`AutoJs6 server is running on ${server.ip}`);
    })
    .on('new_device', (device: Device) => {
        let messageShown = false;
        const showMessage = () => {
            if (!messageShown) {
                vscode.window.showInformationMessage(`AutoJs6 设备接入: ${device}`);
                // vscode.window.showInformationMessage(`AutoJs6 device attached: ${device}`);
                messageShown = true;
            }
        };
        setTimeout(showMessage, 1000);
        device.on('data:device_name', showMessage);
    })
    .on('log', (text) => {
        console.log(text);
    });

class Extension {
    viewDocument() {
        vscode.env.openExternal(vscode.Uri.parse('http://docs.autojs.org/'));
    }

    startServer() {
        server.listen();
    }

    stopServer() {
        server.disconnect();
        vscode.window.showInformationMessage('AutoJs6 服务已停止');
        // vscode.window.showInformationMessage('AutoJs6 server stopped');
    }

    run() {
        this.runOn(server);
    }

    stop() {
        server.sendCommand('stop', {
            'id': vscode.window.activeTextEditor.document.fileName,
        });
    }

    stopAll() {
        server.sendCommand('stopAll');
    }

    rerun() {
        let editor = vscode.window.activeTextEditor;
        server.sendCommand('rerun', {
            'id': editor.document.fileName,
            'name': editor.document.fileName,
            'script': editor.document.getText(),
        });
    }

    runOnDevice() {
        this.selectDevice(device => this.runOn(device));
    }

    selectDevice(callback) {
        let devices: Array<Device> = server.devices;
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
            'script': editor.document.getText(),
        });
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
            'script': editor.document.getText(),
        });
    }

    newProject() {
        vscode.window.showOpenDialog({
            'canSelectFiles': false,
            'canSelectFolders': true,
            'openLabel': '新建到这里',
        }).then(uris => {
            if (!uris || uris.length == 0) {
                return;
            }
            return new ProjectTemplate(uris[0])
                .build();
        }).then(uri => {
            vscode.commands.executeCommand('vscode.openFolder', uri);
        });
    }

    runProject() {
        this.sendProjectCommand('run_project');
    }

    sendProjectCommand(command: string) {
        let folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length == 0) {
            // vscode.window.showInformationMessage('An opened AutoJs6 project is needed');
            vscode.window.showInformationMessage('需要一个已打开的 AutoJs6 项目');
            return null;
        }
        let folder = folders[0].uri;
        if (!server.project || server.project.folder != folder) {
            server.project && server.project.dispose();
            server.project = new Project(folder);
        }
        server.sendProjectCommand(folder.fsPath, command);
    }
    saveProject() {
        this.sendProjectCommand('save_project');
    }
}

// noinspection JSUnusedGlobalSymbols
export function activate(context: vscode.ExtensionContext) {
    vscContext = context;

    let extension = new Extension();
    let commands = [
        'viewDocument', 'startServer', 'stopServer', 'run', 'runOnDevice', 'stop',
        'stopAll', 'rerun', 'save', 'saveToDevice', 'newProject', 'runProject', 'saveProject',
    ];

    commands.forEach((command) => {
        let action: Function = extension[command];
        context.subscriptions.push(vscode.commands.registerCommand('extension.' + command, action.bind(extension)));
    });
    console.log('extension "AutoJs6 VSCode Ext" is now active.');
}

// noinspection JSUnusedGlobalSymbols
export function deactivate() {
    server.disconnect();
}
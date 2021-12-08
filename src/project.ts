import {Uri} from 'vscode';
import {FileObserver, FileFilter} from './diff';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import * as archiver from 'archiver';
import * as streamBuffers from 'stream-buffers';

export class ProjectTemplate {
    private readonly uri: Uri;

    constructor(uri: Uri) {
        this.uri = uri;
    }

    build(): Thenable<Uri> {
        const projectConfig = new ProjectConfig();
        projectConfig.name = '新建项目';
        projectConfig.main = 'main.js';
        projectConfig.ignore = ['build'];
        projectConfig.packageName = 'com.example';
        projectConfig.versionName = '1.0.0';
        projectConfig.versionCode = 1;
        const uri = this.uri;
        const jsonFilePath = path.join(uri.fsPath, 'project.json');
        const mainFilePath = path.join(uri.fsPath, 'main.js');
        const mainScript = 'toast(\'Hello, AutoJs6\');';
        return projectConfig.save(jsonFilePath)
            .then(() => {
                return new Promise<Uri>(function (res, rej) {
                    fs.writeFile(mainFilePath, mainScript, function (err) {
                        if (err) {
                            rej(err);
                            return;
                        }
                        res(uri);
                    });
                });
            });
    }
}

export class Project {
    config: ProjectConfig;
    folder: Uri;

    private watcher: vscode.FileSystemWatcher;

    constructor(folder: Uri) {
        this.folder = folder;
        this.config = ProjectConfig.fromJsonFile(path.join(this.folder.fsPath, 'project.json'));
        this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder.fsPath, 'project\.json'));
        this.watcher.onDidChange((event) => {
            console.log('file changed: ', event.fsPath);
            if (event.fsPath == path.join(this.folder.fsPath, 'project.json')) {
                this.config = ProjectConfig.fromJsonFile(event.fsPath);
                console.log('project.json changed: ', this.config);
            }
        });
    }

    // noinspection JSUnusedLocalSymbols
    fileFilter = (relativePath: string, absPath: string, stats: fs.Stats) => {
        return this.config.ignore.filter(p => {
            const fullPath = path.join(this.folder.fsPath, p);
            return absPath.startsWith(fullPath);
        }).length == 0;
    };

    dispose() {
        this.watcher.dispose();
    }
}

export class ProjectObserver {
    folder: string;

    private fileObserver: FileObserver;
    private fileFilter: FileFilter;

    constructor(folder: string, filter: FileFilter) {
        this.folder = folder;
        this.fileFilter = filter;
        this.fileObserver = new FileObserver(folder, filter);
    }

    diff(): Promise<{ buffer: Buffer, md5: string }> {
        return this.fileObserver.walk()
            .then(changedFiles => {
                const zip = archiver('zip');
                const streamBuffer = new streamBuffers.WritableStreamBuffer();
                zip.pipe(streamBuffer);
                changedFiles.forEach(relativePath => {
                    zip.append(fs.createReadStream(path.join(this.folder, relativePath)), {name: relativePath});
                });
                zip.finalize();
                return new Promise<Buffer>((res) => {
                    zip.on('finish', () => {
                        streamBuffer.end();
                        let content = streamBuffer.getContents();
                        if (content) {
                            res(content);
                        }
                    });
                });
            })
            .then((buffer) => {
                const md5 = crypto.createHash('md5').update(buffer).digest('hex');
                return {
                    buffer: buffer,
                    md5: md5,
                };
            });
    }
}

export class LaunchConfig {
    hideLogs: boolean;
}

export class ProjectConfig {
    name: string;
    icon: string;
    packageName: String;
    main: String;
    versionCode: number;
    versionName: string;
    ignore: string[];
    launchConfig: LaunchConfig;

    save(path: string) {
        return new Promise((res, rej) => {
            const json = JSON.stringify(this, null, 4);
            fs.writeFile(path, json, function (err) {
                if (err) {
                    rej(err);
                    return;
                }
                res(path);
            });
        });
    }

    static fromJsonFile(path: string): ProjectConfig {
        const text = fs.readFileSync(path).toString('utf-8');
        const config = JSON.parse(text) as ProjectConfig;
        config.ignore = (config.ignore || []);
        return config;
    }
}
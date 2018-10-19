import { Uri } from "vscode";
import * as vscode from "vscode";
import * as fs from "fs";
import { AutoJsDebugServer } from "./autojs-debug";
import { FileObserver, FileFilter } from "./diff";
import * as archiver from 'archiver'
import * as path from 'path'
import * as cryto from 'crypto'
import * as walk from 'walk'
import * as streamBuffers from 'stream-buffers'

export class ProjectTemplate {

    private uri: Uri;

    constructor(uri: Uri) {
        this.uri = uri;
    }

    build(): Thenable<Uri> {
        var projectConfig = new ProjectConfig();
        projectConfig.name = "新建项目";
        projectConfig.main = "main.js";
        projectConfig.ignore = ["build"];
        projectConfig.packageName = "com.example";
        projectConfig.versionName = "1.0.0";
        projectConfig.versionCode = 1;
        var uri = this.uri;
        var jsonFilePath = path.join(uri.fsPath, "project.json");
        var mainFilePath = path.join(uri.fsPath, "main.js");
        var mainScript = "toast('Hello, Auto.js');";
        return projectConfig.save(jsonFilePath)
            .then(() => {
                return new Promise<Uri>(function (res, rej) {
                    fs.writeFile(mainFilePath, mainScript, function (err) {
                        if (err) {
                            rej(err);
                            return;
                        }
                        res(uri);
                    })
                });
            });
    }
}

export class Project {
    config: ProjectConfig;
    folder: Uri;
    fileFilter = (relativePath: string, absPath: string, stats: fs.Stats) => {
        return this.config.ignore.filter(p => {
            var fullPath = path.join(this.folder.fsPath, p);
            return absPath.startsWith(fullPath);
        }).length == 0;
    };
    private watcher: vscode.FileSystemWatcher;

    constructor(folder: Uri) {
        this.folder = folder;
        this.config = ProjectConfig.fromJsonFile(path.join(this.folder.fsPath, "project.json"));
        this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder.fsPath, "project\.json"));
        this.watcher.onDidChange((event) => {
            console.log("file changed: ", event.fsPath);
            if (event.fsPath == path.join(this.folder.fsPath, "project.json")) {
                this.config = ProjectConfig.fromJsonFile(event.fsPath);
                console.log("project.json changed: ", this.config);
            }
        });
    }

    dispose() {
        this.watcher.dispose();
    }

}


export class ProjectObserser {
    folder: string;
    private fileObserver: FileObserver
    private fileFilter: FileFilter;

    constructor(folder: string, filter: FileFilter) {
        this.folder = folder;
        this.fileFilter = filter;
        this.fileObserver = new FileObserver(folder, filter);
    }

    diff(): Promise<{ buffer: Buffer, md5: string }> {
        return this.fileObserver.walk()
            .then(changedFiles => {
                var zip = archiver('zip')
                var streamBuffer = new streamBuffers.WritableStreamBuffer();
                zip.pipe(streamBuffer);
                changedFiles.forEach(relativePath => {
                    zip.append(fs.createReadStream(path.join(this.folder, relativePath)), { name: relativePath })
                });
                zip.finalize();
                return new Promise<Buffer>((res, rej) => {
                    zip.on('finish', () => {
                        streamBuffer.end();
                        res(streamBuffer.getContents());
                    });
                });
            })
            .then(buffer => {
                var md5 = cryto.createHash('md5').update(buffer).digest('hex');
                return {
                    buffer: buffer,
                    md5: md5
                };
            });
    }

    zip(): Promise<{ buffer: Buffer, md5: string }> {
        return new Promise<{ buffer: Buffer, md5: string }>((res, rej) => {
            var walker = walk.walk(this.folder);
            var zip = archiver('zip')
            var streamBuffer = new streamBuffers.WritableStreamBuffer();
            zip.pipe(streamBuffer);
            walker.on("file", (root, stat, next) => {
                var filePath = path.join(root, stat.name);
                var relativePath = path.relative(this.folder, filePath);
                if (!this.fileFilter(relativePath, filePath, stat)) {
                    next();
                    return;
                }
                zip.append(fs.createReadStream(path.join(this.folder, relativePath)), { name: relativePath })
                next();
            });
            walker.on("end", () => {
                zip.finalize();
                return new Promise<Buffer>((res, rej) => {
                    zip.on('finish', () => {
                        streamBuffer.end();
                        res(streamBuffer.getContents());
                    });
                });
            })
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
            var json = JSON.stringify(this, null, 4);
            fs.writeFile(path, json, function (err) {
                if (err) {
                    rej(err);
                    return;
                }
                res(path);
            });
        });
    }

    static fromJson(text: string): ProjectConfig {
        var config = JSON.parse(text) as ProjectConfig;
        config.ignore = (config.ignore || []).map(p => path.normalize(p));
        return config;
    }

    static fromJsonFile(path: string): ProjectConfig {
        var text = fs.readFileSync(path).toString("utf-8");
        var config = JSON.parse(text) as ProjectConfig;
        config.ignore = (config.ignore || []);
        return config;
    }
}
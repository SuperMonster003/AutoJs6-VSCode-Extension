import { Uri } from "vscode";
import * as fs from "fs";
import { AutoJsDebugServer } from "./autojs-debug";
import { FileObserver } from "./diff";
import * as JSZip from 'jszip'
import * as path from 'path'
import * as cryto from 'crypto'
import * as walk from 'walk'

export class ProjectTemplate {

    private uri: Uri;

    constructor(uri: Uri) {
        this.uri = uri;
    }

    build(): Thenable<Uri> {
        var projectConfig = new ProjectConfig();
        projectConfig.name = "新建项目";
        projectConfig.packageName = "com.example";
        projectConfig.versionCode = 1;
        var uri = this.uri;
        var jsonFilePath = path.join(uri.fsPath, "project.json");
        var mainFilePath = path.join(uri.fsPath, "main.js");
        var mainScript = "toast('Hello, Auto.js')";
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
    private fileObserver: FileObserver
    private fileFilter = (relativePath: string, path: string, stats: fs.Stats) => {
        return this.config.ignore.indexOf(path.normalize(relativePath)) < 0;
    };

    constructor(folder: Uri) {
        this.folder = folder;
        this.fileObserver = new FileObserver(folder.fsPath);
        fs.readFile(path.join(folder.fsPath, 'project.json'), (err, buffer) => {
            if (err) {
                throw err;
            }
            this.config = ProjectConfig.fromJson(buffer.toString('utf-8'));
        });
    }

    diff(): Promise<{ buffer: Buffer, md5: string }> {
        return this.fileObserver.walk()
            .then(changedFiles => {
                var zip = new JSZip();
                changedFiles.forEach(relativePath => {
                    zip.file(path.join(this.folder.fsPath, relativePath));
                });
                return zip.generateAsync({ type: "nodebuffer" });
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
            var walker = walk.walk(this.folder.fsPath);
            var zip = new JSZip();
            walker.on("file", (root, stat, next) => {
                var filePath = path.join(root, stat.name);
                var relativePath = path.relative(this.folder.fsPath, filePath);
                if (!this.fileFilter(relativePath, filePath, stat)) {
                    return;
                }
                zip.file(filePath);
            });
            walker.on("end", () => {
                zip.generateAsync({ type: "nodebuffer" })
                    .then(buffer => {
                        var md5 = cryto.createHash('md5').update(buffer).digest('hex');
                        res({ buffer: buffer, md5: md5 });
                    })
            })
        });

    }

}

export class ProjectConfig {
    name: string;
    icon: string;
    packageName: String;
    versionCode: number;
    ignore: string[]

    save(path: string) {
        return new Promise(function (res, rej) {
            var json = JSON.stringify(this);
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
}
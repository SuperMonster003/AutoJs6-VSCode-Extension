import * as fs from 'fs'
import * as walk from 'walk'
import * as path from 'path'

export type FileFilter = ((relativePath: string, path: string, stats: fs.Stats) => boolean)

export class FileObserver {

    private dir: string
    private files = new Map<string, number>()
    private filter: FileFilter


    constructor(dirPath: string, filter: FileFilter = null) {
        this.dir = dirPath;
        this.filter = filter;
    }

    walk() {
        return new Promise<string[]>((res, rej) => {
            var changedFiles = [];
            var walker = walk.walk(this.dir);
            walker.on("file", (root, stat, next) => {
                var filePath = path.join(root, stat.name);
                var relativePath = path.relative(this.dir, filePath);
                if (this.filter && !this.filter(relativePath, filePath, stat)) {
                    next();
                    return;
                }
                var millis = stat.mtime.getTime();
                if (this.files.has(filePath) && this.files.get(filePath)
                    == millis) {
                    next();
                    return;
                }
                this.files.set(filePath, millis);
                changedFiles.push(relativePath);
                next();
            })
            walker.on("end", () => {
                res(changedFiles);
            });
            walker.on("nodeError", err => {
                rej(err);
            })
        });

    }



}
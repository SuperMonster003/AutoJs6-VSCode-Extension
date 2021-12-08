import * as fs from 'fs';
import * as walk from 'walk';
import * as path from 'path';

export type FileFilter = (relativePath: string, path: string, stats: fs.Stats) => boolean;

export class FileObserver {
    private readonly dir: string;
    private files = new Map<string, number>();
    private readonly filter: FileFilter;

    constructor(dirPath: string, filter: FileFilter = null) {
        this.dir = dirPath;
        this.filter = filter;
    }

    walk() {
        return new Promise<string[]>((res, rej) => {
            const changedFiles = [];
            const walker = walk.walk(this.dir);
            walker.on('file', (root, stat, next) => {
                const filePath = path.join(root, stat.name);
                const relativePath = path.relative(this.dir, filePath);
                if (!this.filter || this.filter(relativePath, filePath, stat)) {
                    const millis = stat.mtime.getTime();
                    if (!this.files.has(filePath) || this.files.get(filePath) != millis) {
                        this.files.set(filePath, millis);
                        changedFiles.push(relativePath);
                    }
                }
                next();
            });
            walker.on('end', () => res(changedFiles));
            walker.on('nodeError', err => rej(err));
        });
    }
}
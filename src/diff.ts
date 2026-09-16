import * as fs from 'fs';
import * as path from 'path';

const readdir = fs.promises.readdir;
const lstat = fs.promises.lstat;

export type FileFilter = (relativePath: string, absPath: string, stats: fs.Stats) => boolean;

export interface WalkedResult {
    path: string;
    stats: fs.Stats;
}

/**
 * Recursively walk `dir`. Directories rejected by `filter` are pruned early (never descended).
 * zh-CN: 递归遍历目录, 被 filter 拒绝的目录直接跳过 (不再深入).
 */
export async function walk(dir: string, filter: FileFilter | null = null): Promise<WalkedResult[]> {
    const result: WalkedResult[] = [];
    await walkInto(dir, dir, filter, result);
    return result;
}

async function walkInto(root: string, dir: string, filter: FileFilter | null, result: WalkedResult[]) {
    let names: string[];
    try {
        names = await readdir(dir);
    } catch (e) {
        return;
    }
    await Promise.all(names.map(async (name) => {
        const fullPath = path.join(dir, name);
        let stats: fs.Stats;
        try {
            stats = await lstat(fullPath);
        } catch (e) {
            return;
        }
        const relativePath = path.relative(root, fullPath);
        if (filter && !filter(relativePath, fullPath, stats)) {
            return;
        }
        if (stats.isDirectory()) {
            await walkInto(root, fullPath, filter, result);
        } else if (stats.isFile()) {
            result.push({ path: fullPath, stats });
        }
    }));
}

export interface FileChanges {
    modified: string[];
    deleted: string[];
}

/**
 * Tracks mtimes between walks to produce incremental change sets.
 * zh-CN: 记录两次遍历之间的修改时间以生成增量变更集.
 */
export class FileObserver {
    private readonly dir: string;
    private readonly filter: FileFilter | null;
    private files: Map<string, number> = new Map();

    constructor(dirPath: string, filter: FileFilter | null = null) {
        this.dir = dirPath;
        this.filter = filter;
    }

    /** Whether at least one walk completed. zh-CN: 是否已完成过至少一次遍历. */
    get hasBaseline(): boolean {
        return this.files.size > 0;
    }

    reset() {
        this.files = new Map();
    }

    async walk(): Promise<FileChanges> {
        const files = await walk(this.dir, this.filter);
        const modified: string[] = [];
        const oldFiles = this.files;
        const newFiles = new Map<string, number>();
        for (const file of files) {
            const relativePath = path.relative(this.dir, file.path);
            const timestamp = file.stats.mtime.getTime();
            const previous = oldFiles.get(file.path);
            oldFiles.delete(file.path);
            newFiles.set(file.path, timestamp);
            if (previous === undefined || previous !== timestamp) {
                modified.push(relativePath);
            }
        }
        const deleted: string[] = [];
        oldFiles.forEach((_, filePath) => deleted.push(path.relative(this.dir, filePath)));
        this.files = newFiles;
        return { modified, deleted };
    }
}

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as archiver from 'archiver';
import * as streamBuffers from 'stream-buffers';
import { FileFilter, FileObserver } from './diff';
import { logDebug } from './logger';

/*
 * Project synchronization helpers. This module must not import `vscode` so that it stays unit-testable.
 * zh-CN: 项目同步辅助模块. 不得引入 `vscode`, 以便进行单元测试.
 */

export interface ProjectDiffResult {
    buffer: Buffer;
    md5: string;
    deletedFiles: string[];
    /** `true` when the archive contains the whole project. zh-CN: 归档包含完整项目时为 true. */
    full: boolean;
}

/**
 * Produces zip archives of project changes for one device.
 * zh-CN: 为单个设备生成项目变更的 zip 归档.
 */
export class ProjectObserver {
    readonly folder: string;
    private readonly fileObserver: FileObserver;

    constructor(folder: string, filter: FileFilter | null) {
        this.folder = folder;
        this.fileObserver = new FileObserver(folder, filter);
    }

    /** Forget the baseline so that the next diff is a full archive. zh-CN: 清除基线, 下次 diff 为全量归档. */
    reset() {
        this.fileObserver.reset();
    }

    async diff(): Promise<ProjectDiffResult> {
        const full = !this.fileObserver.hasBaseline;
        const changes = await this.fileObserver.walk();
        const buffer = await ProjectObserver.zip(this.folder, changes.modified);
        const md5 = crypto.createHash('md5').update(buffer).digest('hex');
        logDebug(`project diff: ${changes.modified.length} modified, ${changes.deleted.length} deleted, full = ${full}, zip = ${buffer.length} bytes`);
        return { buffer, md5, deletedFiles: changes.deleted, full };
    }

    static zip(folder: string, relativePaths: string[]): Promise<Buffer> {
        return new Promise<Buffer>((resolve, reject) => {
            const zip = archiver('zip');
            const streamBuffer = new streamBuffers.WritableStreamBuffer();
            zip.on('error', reject);
            zip.pipe(streamBuffer);
            relativePaths.forEach((relativePath) => {
                zip.append(fs.createReadStream(path.join(folder, relativePath)), { name: relativePath.replace(/\\/g, '/') });
            });
            zip.on('finish', () => {
                streamBuffer.end();
                resolve((streamBuffer.getContents() as Buffer) || Buffer.alloc(0));
            });
            zip.finalize();
        });
    }
}

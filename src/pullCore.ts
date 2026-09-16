import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Device, DeviceError } from './device';
import { FileFilter, walk } from './diff';
import { logDebug } from './logger';
import { joinRemotePath, RemoteEntry, RemoteRoots, toPosixPath } from './protocol';

/*
 * Pull files changed on the device back into the local project (roadmap 5.7). This module must not import
 * `vscode` so that the comparison logic stays unit-testable; the picker and progress UI live in `pull.ts`.
 * zh-CN: 将设备端修改的文件拉回本地项目 (roadmap 5.7). 本模块不得引入 `vscode`, 以便对比较逻辑做单元测试; 选择器与进度 UI 位于 `pull.ts`.
 */

export type ChangeKind = 'added' | 'modified';

export interface RemoteChange {
    /** Posix path relative to the project root. zh-CN: 相对项目根目录的 posix 路径. */
    relativePath: string;
    kind: ChangeKind;
    remotePath: string;
    size: number;
    mtime: number;
}

export interface RemoteFileInfo {
    path: string;
    size: number;
    mtime: number;
    /** Present when AutoJs6 answered `fs.list { hash: true }` (6.8.0+). zh-CN: AutoJs6 6.8.0+ 对 `fs.list { hash: true }` 返回. */
    md5?: string;
}

export interface LocalFileInfo {
    path: string;
    size: number;
}

export interface PullPlan {
    remoteDir: string;
    changes: RemoteChange[];
    /** Local files that do not exist on the device (reported, never deleted). zh-CN: 设备上不存在的本地文件 (仅报告, 不删除). */
    missingOnDevice: string[];
    /** Number of device files compared. zh-CN: 已比较的设备文件数. */
    scanned: number;
}

export type RemoteReader = (remotePath: string) => Promise<Uint8Array>;

/** Same-size files without an md5 are compared by content up to this size. zh-CN: 无 md5 的同大小文件按内容比较的上限. */
const MAX_CONTENT_COMPARE_SIZE = 8 * 1024 * 1024;

/**
 * Locate the project on the device: `save_project` stores it under `<workingDir>/<basename(localDir)>`.
 * zh-CN: 定位设备上的项目: `save_project` 将其保存到 `<工作目录>/<本地目录名>`.
 */
export async function locateRemoteProject(device: Device, localDir: string): Promise<string> {
    const roots = await device.request<RemoteRoots>('fs.roots', {});
    const remoteDir = joinRemotePath(roots.workingDir, path.basename(localDir));
    const stat = await device.request<{ exists: boolean; type?: string }>('fs.stat', { path: remoteDir });
    if (!stat.exists || stat.type !== 'directory') {
        throw new DeviceError(`设备 ${device.name} 上不存在项目目录 ${remoteDir}, 请先执行 "保存项目到设备"`, device);
    }
    return remoteDir;
}

/**
 * Recursively list the device project, keyed by relative posix path; directories rejected by the project's
 * ignore filter are pruned like on the local side.
 * zh-CN: 递归列出设备项目 (以相对 posix 路径为键); 被项目忽略规则拒绝的目录与本地一样直接跳过.
 */
export async function listRemoteFiles(device: Device, remoteDir: string, localDir: string, filter: FileFilter | null): Promise<Map<string, RemoteFileInfo>> {
    const result = new Map<string, RemoteFileInfo>();
    const noStats = {} as fs.Stats;
    const visit = async (dir: string) => {
        const listing = await device.request<{ entries: RemoteEntry[] }>('fs.list', { path: dir, hash: true });
        for (const entry of listing.entries || []) {
            const remotePath = entry.path || joinRemotePath(dir, entry.name);
            const relativePath = toPosixPath(path.posix.relative(remoteDir, remotePath));
            if (!relativePath || relativePath.startsWith('..')) {
                continue;
            }
            const localRelative = relativePath.split('/').join(path.sep);
            if (filter && !filter(localRelative, path.join(localDir, localRelative), noStats)) {
                continue;
            }
            if (entry.type === 'directory') {
                await visit(remotePath);
            } else {
                result.set(relativePath, { path: remotePath, size: entry.size, mtime: entry.mtime, md5: entry.md5 });
            }
        }
    };
    await visit(remoteDir);
    return result;
}

export async function listLocalFiles(localDir: string, filter: FileFilter | null): Promise<Map<string, LocalFileInfo>> {
    const files = await walk(localDir, filter);
    return new Map(files.map(f => [ toPosixPath(path.relative(localDir, f.path)), { path: f.path, size: f.stats.size } ]));
}

export function md5File(file: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('md5');
        fs.createReadStream(file)
            .on('error', reject)
            .on('data', (chunk) => hash.update(chunk))
            .on('end', () => resolve(hash.digest('hex')));
    });
}

/**
 * Classify device files against local ones: missing locally is `added`, different size or md5 is `modified`.
 * Without an md5 (older AutoJs6) same-size files are compared by content when small enough.
 * zh-CN: 将设备文件与本地文件比较: 本地缺失为 `added`, 大小或 md5 不同为 `modified`. 无 md5 (旧版 AutoJs6) 时同大小的小文件按内容比较.
 */
export async function computeChanges(remote: Map<string, RemoteFileInfo>, local: Map<string, LocalFileInfo>, readRemote: RemoteReader): Promise<{ changes: RemoteChange[]; missingOnDevice: string[] }> {
    const changes: RemoteChange[] = [];
    for (const [ relativePath, r ] of remote) {
        const change = (kind: ChangeKind): RemoteChange => ({ relativePath, kind, remotePath: r.path, size: r.size, mtime: r.mtime });
        const l = local.get(relativePath);
        if (!l) {
            changes.push(change('added'));
            continue;
        }
        if (l.size !== r.size) {
            changes.push(change('modified'));
            continue;
        }
        if (r.md5) {
            if ((await md5File(l.path)) !== r.md5.toLowerCase()) {
                changes.push(change('modified'));
            }
            continue;
        }
        if (r.size <= MAX_CONTENT_COMPARE_SIZE) {
            const [ remoteBytes, localBytes ] = await Promise.all([ readRemote(r.path), fs.promises.readFile(l.path) ]);
            if (!Buffer.from(remoteBytes).equals(localBytes)) {
                changes.push(change('modified'));
            }
        }
    }
    changes.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    const missingOnDevice = Array.from(local.keys()).filter(rel => !remote.has(rel)).sort();
    return { changes, missingOnDevice };
}

export async function planPull(device: Device, localDir: string, filter: FileFilter | null, readRemote: RemoteReader): Promise<PullPlan> {
    const remoteDir = await locateRemoteProject(device, localDir);
    const [ remote, local ] = await Promise.all([ listRemoteFiles(device, remoteDir, localDir, filter), listLocalFiles(localDir, filter) ]);
    const { changes, missingOnDevice } = await computeChanges(remote, local, readRemote);
    logDebug(`pull plan for ${localDir} from ${device}: ${remote.size} remote, ${local.size} local, ${changes.length} changed, ${missingOnDevice.length} missing on device`);
    return { remoteDir, changes, missingOnDevice, scanned: remote.size };
}

export async function writeLocalFile(localDir: string, relativePath: string, data: Uint8Array): Promise<string> {
    const target = path.join(localDir, ...relativePath.split('/'));
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, data);
    return target;
}

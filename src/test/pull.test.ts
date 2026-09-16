import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Device } from '../device';
import { computeChanges, listLocalFiles, listRemoteFiles, locateRemoteProject, RemoteFileInfo, writeLocalFile } from '../pullCore';

/*
 * Pull-from-device comparison (roadmap 5.7) against an in-memory fake of the AutoJs6 `fs.*` request handler.
 * zh-CN: 使用内存中的 AutoJs6 `fs.*` 请求处理器假件测试 "从设备拉取" 的比较逻辑 (roadmap 5.7).
 */

const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');

function tempProject(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ajpull-'));
    for (const [ rel, content ] of Object.entries(files)) {
        const file = path.join(dir, ...rel.split('/'));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    }
    return dir;
}

/** Fake device whose file system is a flat map of posix paths. zh-CN: 以 posix 路径映射模拟文件系统的假设备. */
function fakeDevice(workingDir: string, files: Record<string, string>): Device {
    const isDir = (p: string) => Object.keys(files).some(f => f.startsWith(p + '/'));
    const request = async (method: string, params: any) => {
        switch (method) {
            case 'fs.roots':
                return { workingDir, externalStorage: '/storage/emulated/0', roots: [] };
            case 'fs.stat':
                if (files[params.path] !== undefined) return { path: params.path, exists: true, type: 'file', size: files[params.path].length };
                return { path: params.path, exists: isDir(params.path), type: isDir(params.path) ? 'directory' : undefined };
            case 'fs.list': {
                const names = new Set<string>();
                Object.keys(files).filter(f => f.startsWith(params.path + '/')).forEach(f => names.add(f.slice(params.path.length + 1).split('/')[0]));
                return {
                    path: params.path,
                    entries: Array.from(names).map((name) => {
                        const p = `${params.path}/${name}`;
                        const content = files[p];
                        return content === undefined
                            ? { name, path: p, type: 'directory', size: 0, mtime: 1 }
                            : { name, path: p, type: 'file', size: content.length, mtime: 2, ...(params.hash ? { md5: md5(content) } : {}) };
                    }),
                };
            }
            default:
                throw new Error(`unexpected method ${method}`);
        }
    };
    return { name: 'Fake', request, toString: () => 'Fake' } as unknown as Device;
}

test('locateRemoteProject resolves <workingDir>/<project name> and rejects a missing project', async () => {
    const local = tempProject({ 'main.js': 'x' });
    const name = path.basename(local);
    const device = fakeDevice('/sdcard/Scripts', { [`/sdcard/Scripts/${name}/main.js`]: 'x' });
    assert.equal(await locateRemoteProject(device, local), `/sdcard/Scripts/${name}`);
    await assert.rejects(() => locateRemoteProject(fakeDevice('/sdcard/Scripts', {}), local), /does not exist on/);
});

test('listRemoteFiles recurses, keys by relative posix path and honours the ignore filter', async () => {
    const remote = '/sdcard/Scripts/demo';
    const device = fakeDevice('/sdcard/Scripts', {
        [`${remote}/main.js`]: 'aaa',
        [`${remote}/lib/util.js`]: 'bb',
        [`${remote}/node_modules/x/index.js`]: 'c',
    });
    const filter = (rel: string) => !rel.split(path.sep)[0].startsWith('node_modules');
    const files = await listRemoteFiles(device, remote, 'D:/demo', filter);
    assert.deepEqual(Array.from(files.keys()).sort(), [ 'lib/util.js', 'main.js' ]);
    assert.equal(files.get('lib/util.js')?.md5, md5('bb'));
});

test('computeChanges classifies added / modified / unchanged files and falls back to content without md5', async () => {
    const local = tempProject({
        'same.js': 'aaa',
        'changed.js': 'bbb',
        'sizediff.js': 'c',
        'nomd5-same.js': 'ddd',
        'nomd5-changed.js': 'eee',
        'local-only.js': 'x',
    });
    const remote = new Map<string, RemoteFileInfo>([
        [ 'same.js', { path: '/r/same.js', size: 3, mtime: 1, md5: md5('aaa') } ],
        [ 'changed.js', { path: '/r/changed.js', size: 3, mtime: 1, md5: md5('BBB') } ],
        [ 'sizediff.js', { path: '/r/sizediff.js', size: 5, mtime: 1 } ],
        [ 'nomd5-same.js', { path: '/r/nomd5-same.js', size: 3, mtime: 1 } ],
        [ 'nomd5-changed.js', { path: '/r/nomd5-changed.js', size: 3, mtime: 1 } ],
        [ 'new/added.js', { path: '/r/new/added.js', size: 2, mtime: 1 } ],
    ]);
    const reads: string[] = [];
    const readRemote = async (p: string) => {
        reads.push(p);
        return Buffer.from(p.endsWith('nomd5-same.js') ? 'ddd' : 'EEE');
    };
    const { changes, missingOnDevice } = await computeChanges(remote, await listLocalFiles(local, null), readRemote);
    assert.deepEqual(changes.map(c => `${c.kind}:${c.relativePath}`), [ 'modified:changed.js', 'added:new/added.js', 'modified:nomd5-changed.js', 'modified:sizediff.js' ]);
    assert.deepEqual(missingOnDevice, [ 'local-only.js' ]);
    assert.deepEqual(reads.sort(), [ '/r/nomd5-changed.js', '/r/nomd5-same.js' ], 'only same-size files without md5 are downloaded for comparison');
});

test('writeLocalFile creates missing directories', async () => {
    const local = tempProject({});
    const target = await writeLocalFile(local, 'a/b/c.txt', Buffer.from('hi'));
    assert.equal(fs.readFileSync(target, 'utf8'), 'hi');
    assert.equal(target, path.join(local, 'a', 'b', 'c.txt'));
});

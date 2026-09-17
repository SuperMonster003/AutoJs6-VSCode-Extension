import { mock, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import type * as vscode from 'vscode';
import type { Device, Devices } from '../device';
import { FEATURE, FS_CHUNK_SIZE } from '../protocol';

/* Exercise registered commands and the real provider with in-memory local/device storage, without VSCode.
 * zh-CN: 使用内存中的本地/设备存储测试已注册命令与实际文件系统提供者, 无需启动 VSCode.
 */
const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };

class Uri {
    constructor(readonly path: string, readonly scheme = 'file', readonly authority = '') {}
    static from(parts: { path: string; scheme: string; authority?: string }) {
        return new Uri(parts.path, parts.scheme, parts.authority);
    }
    static joinPath(base: Uri, ...parts: string[]) {
        return new Uri(path.posix.join(base.path, ...parts), base.scheme, base.authority);
    }
    toString() { return `${this.scheme}://${this.authority}${this.path}`; }
}

class FileSystemError extends Error {
    constructor(readonly code: string, value: unknown) { super(`${code}: ${value}`); }
    static FileNotFound(value: unknown) { return new FileSystemError('FileNotFound', value); }
    static FileExists(value: unknown) { return new FileSystemError('FileExists', value); }
    static FileNotADirectory(value: unknown) { return new FileSystemError('FileNotADirectory', value); }
    static FileIsADirectory(value: unknown) { return new FileSystemError('FileIsADirectory', value); }
    static NoPermissions(value: unknown) { return new FileSystemError('NoPermissions', value); }
    static Unavailable(value: unknown) { return new FileSystemError('Unavailable', value); }
}

class EventEmitter {
    private listeners: ((value: any) => void)[] = [];
    event = (listener: (value: any) => void) => { this.listeners.push(listener); return { dispose() {} }; };
    fire(value: any) { this.listeners.forEach(listener => listener(value)); }
}

let active: UploadFixture;
const vscodeMock = {
    Uri, FileType, FileSystemError, EventEmitter,
    FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
    CancellationError: class extends Error {},
    ThemeIcon: class { constructor(_id: string) {} },
    ProgressLocation: { Notification: 15 },
    commands: {
        registerCommand(command: string, handler: (...args: any[]) => Promise<void>) {
            active.commands.set(command, handler);
            return { dispose() {} };
        },
    },
    window: {
        async showOpenDialog(options: vscode.OpenDialogOptions) {
            active.dialogOptions = options;
            return active.selection;
        },
        async withProgress(_options: vscode.ProgressOptions, task: Function) {
            const token = { isCancellationRequested: false };
            active.tokens.push(token);
            return task({ report: (value: { message?: string }) => active.progress.push(value.message) }, token);
        },
        showInformationMessage(message: string) { active.info.push(message); },
        showWarningMessage(message: string) { active.warnings.push(message); },
        showErrorMessage(message: string) { active.errors.push(message); },
    },
    workspace: {
        fs: {
            async stat(uri: Uri) { return active.localEntry(uri.path); },
            async readDirectory(uri: Uri) {
                active.beforeRead?.(uri.path);
                return Array.from(active.local)
                    .filter(([ p ]) => p !== uri.path && path.posix.dirname(p) === uri.path)
                    .map(([ p, entry ]) => [ path.posix.basename(p), entry.type ]);
            },
            async readFile(uri: Uri) {
                active.beforeRead?.(uri.path);
                const entry = active.localEntry(uri.path);
                assert.equal(entry.type, FileType.File);
                return entry.content;
            },
        },
    },
};

// Limit the module hook to loading the code under test. zh-CN: 模块替换仅在加载被测代码时生效.
const Module = require('module');
const originalLoad = Module._load;
const loadMock = mock.method(Module, '_load', function (this: unknown, id: string, ...args: any[]) {
    return id === 'vscode' ? vscodeMock : originalLoad.call(this, id, ...args);
});
let remote: typeof import('../remoteFs');
try {
    remote = require('../remoteFs');
} finally {
    loadMock.mock.restore();
}

class UploadFixture {
    readonly local = new Map<string, { type: number; content?: Buffer }>();
    readonly storage = new Map<string, Buffer | null>([ [ '/sdcard/Scripts', null ] ]);
    readonly commands = new Map<string, (...args: any[]) => Promise<void>>();
    readonly requests: { method: string; params: any }[] = [];
    readonly tokens: { isCancellationRequested: boolean }[] = [];
    readonly progress: string[] = [];
    readonly info: string[] = [];
    readonly warnings: string[] = [];
    readonly errors: string[] = [];
    selection: Uri[] | undefined;
    dialogOptions?: vscode.OpenDialogOptions;
    beforeRead?: (p: string) => void;
    afterWrite?: (p: string) => void;
    beforeRequest?: (method: string, p: string) => void;
    refreshes = 0;
    readonly device: Device;

    constructor() {
        active = this;
        this.device = {
            deviceId: 'fake:folder-upload', name: 'Fake', isConnected: true, supportsRequests: true,
            hasFeature: (feature: string) => feature === FEATURE.FS_CHUNKED,
            toString: () => 'Fake',
            request: async (method: string, params: any) => {
                this.requests.push({ method, params });
                const p = params.path;
                this.beforeRequest?.(method, p);
                const existing = this.storage.get(p);
                if (method === 'fs.stat') {
                    return { path: p, exists: existing !== undefined, type: existing === null ? 'directory' : 'file', size: existing?.length || 0 };
                }
                if (!this.storage.has(path.posix.dirname(p))) throw new Error(`Not found: ${path.posix.dirname(p)}`);
                if (method === 'fs.mkdir') {
                    if (existing !== undefined) throw new Error(`Already exists: ${p}`);
                    this.storage.set(p, null);
                } else if (method === 'fs.write') {
                    if (existing === null) throw new Error(`Is a directory: ${p}`);
                    if (existing !== undefined && !params.overwrite && !params.append) throw new Error(`Already exists: ${p}`);
                    if (existing === undefined && !params.create) throw new Error(`Not found: ${p}`);
                    const content = Buffer.from(params.content, params.encoding);
                    this.storage.set(p, params.append ? Buffer.concat([ existing!, content ]) : content);
                    this.afterWrite?.(p);
                } else {
                    throw new Error(`Unexpected request: ${method}`);
                }
                return { path: p };
            },
        } as unknown as Device;
        const devices = { getDevice: () => this.device, on() {} } as unknown as Devices;
        const provider = new remote.RemoteFileSystemProvider(devices);
        const tree = new remote.DeviceFilesTreeProvider(devices, provider);
        tree.onDidChangeTreeData(() => this.refreshes++);
        new remote.RemoteFileCommands(devices, provider, tree).register({ subscriptions: [] } as unknown as vscode.ExtensionContext);
    }

    folder(root: string, contents: Record<string, string | Buffer | null> = {}): Uri {
        this.local.set(root, { type: FileType.Directory });
        for (const [ relative, value ] of Object.entries(contents)) {
            const p = path.posix.join(root, relative);
            for (let parent = path.posix.dirname(p); parent.startsWith(root + '/'); parent = path.posix.dirname(parent)) {
                this.local.set(parent, { type: FileType.Directory });
            }
            this.local.set(p, value === null ? { type: FileType.Directory } : { type: FileType.File, content: Buffer.from(value) });
        }
        return new Uri(root);
    }

    localEntry(p: string) {
        const entry = this.local.get(p);
        if (!entry) throw FileSystemError.FileNotFound(p);
        return entry;
    }

    async upload(node = new remote.RootNode(this.device, 'Scripts', '/sdcard/Scripts')) {
        await this.commands.get('extension.remoteFiles.uploadFolders')!(node);
    }
}

test('folder upload preserves selected roots, nested/empty folders, special names and binary contents', async () => {
    const fixture = new UploadFixture();
    const binary = Buffer.from([ 0, 255, 128, 13, 10, 0 ]);
    fixture.selection = [
        fixture.folder('/C:/projects/演示 #1', { 'main.js': 'log("你好")', 'lib/nested/raw %.bin': binary, 'empty/deep': null, 'zero.txt': '' }),
        fixture.folder('/C:/projects/empty'),
    ];
    await fixture.upload();
    assert.equal(fixture.dialogOptions?.canSelectFiles, false);
    assert.equal(fixture.dialogOptions?.canSelectFolders, true);
    assert.equal(fixture.dialogOptions?.canSelectMany, true);
    assert.deepEqual(Array.from(fixture.storage.keys()).sort(), [
        '/sdcard/Scripts', '/sdcard/Scripts/empty', '/sdcard/Scripts/演示 #1',
        '/sdcard/Scripts/演示 #1/empty', '/sdcard/Scripts/演示 #1/empty/deep',
        '/sdcard/Scripts/演示 #1/lib', '/sdcard/Scripts/演示 #1/lib/nested',
        '/sdcard/Scripts/演示 #1/lib/nested/raw %.bin', '/sdcard/Scripts/演示 #1/main.js', '/sdcard/Scripts/演示 #1/zero.txt',
    ].sort());
    assert.deepEqual(fixture.storage.get('/sdcard/Scripts/演示 #1/lib/nested/raw %.bin'), binary);
    assert.deepEqual(fixture.storage.get('/sdcard/Scripts/演示 #1/zero.txt'), Buffer.alloc(0));
    assert.equal(fixture.storage.get('/sdcard/Scripts/演示 #1/main.js')?.toString(), 'log("你好")');
    assert.ok(fixture.progress.includes('演示 #1/lib/nested/raw %.bin'));
    assert.ok(fixture.refreshes > 0);
    assert.equal(fixture.info.length, 1);
    assert.deepEqual(fixture.errors, []);
});

test('repeated folder upload merges directories and overwrites files while retaining device-only files', async () => {
    const fixture = new UploadFixture();
    fixture.selection = [ fixture.folder('/home/user/demo', { 'lib/main.js': 'new' }) ];
    fixture.storage.set('/sdcard/Scripts/demo', null);
    fixture.storage.set('/sdcard/Scripts/demo/lib', null);
    fixture.storage.set('/sdcard/Scripts/demo/lib/main.js', Buffer.from('old contents'));
    fixture.storage.set('/sdcard/Scripts/demo/keep.txt', Buffer.from('keep'));
    await fixture.upload();
    await fixture.upload();
    assert.equal(fixture.storage.get('/sdcard/Scripts/demo/lib/main.js')?.toString(), 'new');
    assert.equal(fixture.storage.get('/sdcard/Scripts/demo/keep.txt')?.toString(), 'keep');
    assert.equal(fixture.requests.filter(r => r.method === 'fs.mkdir').length, 0);
    assert.deepEqual(fixture.errors, []);
});

test('folder names containing error phrases do not change a missing-path error into a conflict or permission error', async () => {
    const fixture = new UploadFixture();
    const names = [ 'exists', 'denied', 'is a directory', 'not a directory' ];
    fixture.selection = names.map(name => fixture.folder(`/home/user/${name}`));
    await fixture.upload();
    for (const name of names) assert.equal(fixture.storage.get(`/sdcard/Scripts/${name}`), null);
    assert.deepEqual(fixture.errors, []);
});

test('folder upload targets the selected device subdirectory', async () => {
    const fixture = new UploadFixture();
    fixture.selection = [ fixture.folder('/home/user/demo', { 'main.js': 'hello' }) ];
    fixture.storage.set('/sdcard/Scripts/nested', null);
    const node = new remote.EntryNode(fixture.device, { name: 'nested', path: '/sdcard/Scripts/nested', type: 'directory', size: 0, mtime: 0 });
    await fixture.commands.get('extension.remoteFiles.uploadFolders')!(node);
    assert.equal(fixture.storage.get('/sdcard/Scripts/nested/demo/main.js')?.toString(), 'hello');
    assert.deepEqual(fixture.errors, []);
});

test('dismissing the folder picker does not access the device', async () => {
    const fixture = new UploadFixture();
    await fixture.upload();
    fixture.selection = [];
    await fixture.upload();
    assert.equal(fixture.requests.length, 0);
    assert.equal(fixture.tokens.length, 0);
    assert.deepEqual(fixture.info, []);
});

test('folder upload skips symbolic links and unsupported entries and reports them', async () => {
    const fixture = new UploadFixture();
    fixture.selection = [ fixture.folder('/home/user/demo', { 'main.js': 'hello' }) ];
    fixture.local.set('/home/user/demo/loop', { type: FileType.Directory | FileType.SymbolicLink });
    fixture.local.set('/home/user/demo/external', { type: FileType.File | FileType.SymbolicLink });
    fixture.local.set('/home/user/demo/pipe', { type: FileType.Unknown });
    await fixture.upload();
    assert.equal(fixture.storage.size, 3);
    assert.match(fixture.warnings[0], /skipped 3/);
    assert.deepEqual(fixture.errors, []);
});

test('folder upload stops on directory/file conflicts without changing existing content', async () => {
    for (const remoteIsDirectory of [ false, true ]) {
        const fixture = new UploadFixture();
        fixture.selection = [ fixture.folder('/home/user/demo', { 'item': remoteIsDirectory ? 'file' : null }) ];
        fixture.storage.set('/sdcard/Scripts/demo', null);
        const original = remoteIsDirectory ? null : Buffer.from('keep');
        fixture.storage.set('/sdcard/Scripts/demo/item', original);
        await fixture.upload();
        assert.deepEqual(fixture.storage.get('/sdcard/Scripts/demo/item'), original);
        assert.match(fixture.errors[0], remoteIsDirectory ? /FileIsADirectory/ : /FileNotADirectory/);
        assert.deepEqual(fixture.info, []);
    }
});

test('folder upload stops after local read or device errors without reporting success', async () => {
    for (const failure of [ 'local', 'device' ]) {
        const fixture = new UploadFixture();
        fixture.selection = [ fixture.folder('/home/user/demo', { 'first.js': 'first', 'later.js': 'later' }) ];
        if (failure === 'local') {
            fixture.beforeRead = p => { if (p.endsWith('/first.js')) throw new Error('local read failed'); };
        } else {
            fixture.beforeRequest = method => { if (method === 'fs.stat') throw new Error('device disconnected'); };
        }
        await fixture.upload();
        assert.match(fixture.errors[0], failure === 'local' ? /local read failed/ : /device disconnected/);
        assert.equal(fixture.requests.filter(r => r.method === 'fs.write').length, 0);
        assert.deepEqual(fixture.info, []);
    }
});

test('cancelling folder upload after a local read prevents the next device write', async () => {
    const fixture = new UploadFixture();
    fixture.selection = [ fixture.folder('/home/user/demo', { 'main.js': 'hello', 'later.js': 'later' }) ];
    fixture.beforeRead = p => { if (p.endsWith('/main.js')) fixture.tokens[0].isCancellationRequested = true; };
    await fixture.upload();
    assert.equal(fixture.requests.filter(r => r.method === 'fs.write').length, 0);
    assert.match(fixture.info[0], /cancelled/);
    assert.deepEqual(fixture.errors, []);
});

test('large folder files use chunked writes and keep all binary bytes', async () => {
    const fixture = new UploadFixture();
    const binary = Buffer.alloc(FS_CHUNK_SIZE * 2 + 17, 0xa5);
    fixture.selection = [ fixture.folder('/home/user/demo', { 'large.bin': binary }) ];
    await fixture.upload();
    assert.deepEqual(fixture.requests.filter(r => r.method === 'fs.write').map(r => r.params.append), [ false, true, true ]);
    assert.deepEqual(fixture.storage.get('/sdcard/Scripts/demo/large.bin'), binary);
    assert.deepEqual(fixture.errors, []);
});

test('cancelling folder upload stops an in-progress chunked file and subsequent files', async () => {
    const fixture = new UploadFixture();
    fixture.selection = [ fixture.folder('/home/user/demo', { 'large.bin': Buffer.alloc(FS_CHUNK_SIZE * 3, 7), 'later.js': 'later' }) ];
    fixture.storage.set('/sdcard/Scripts/demo', null);
    fixture.afterWrite = () => { fixture.tokens[0].isCancellationRequested = true; };
    await fixture.upload();
    assert.equal(fixture.requests.filter(r => r.method === 'fs.write').length, 1);
    assert.equal(fixture.storage.get('/sdcard/Scripts/demo/large.bin')?.length, FS_CHUNK_SIZE);
    assert.equal(fixture.storage.has('/sdcard/Scripts/demo/later.js'), false);
    assert.ok(fixture.refreshes > 0, 'refresh the tree even when the only write was interrupted');
    assert.match(fixture.info[0], /cancelled/);
    assert.deepEqual(fixture.errors, []);
});

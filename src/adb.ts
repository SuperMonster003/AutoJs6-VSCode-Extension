'use strict';

import * as c_proc from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SpawnSyncReturns } from 'child_process';
import { logDebug } from './logger';

export class AdbExecError extends Error {
    constructor(readonly result: SpawnSyncReturns<Buffer>) {
        super(result.status !== null
            ? `adb exited ${result.status}: ${result.stderr.toString().trim() || result.stdout.toString().trim()}`
            : `adb killed by ${result.signal}: ${result.stderr.toString().trim()}`);
        this.name = 'AdbExecError';
    }
}

export class AdbNotFoundError extends Error {
    constructor() {
        super('ADB executable not found');
        this.name = 'AdbNotFoundError';
    }
}

export interface AdbDeviceInfo {
    id: string;
    brand: string;
    model: string;
    product: string;
    name: string;
    state: string;
}

/**
 * Thin wrapper around the `adb` executable with cross-platform discovery (issue #35).
 * zh-CN: adb 可执行文件的轻量封装, 支持跨平台自动探测 (issue #35).
 */
export class Adb {
    private readonly prebuiltDir: string;
    private readonly configuredPath: () => string;
    private resolved: string | null = null;

    constructor(prebuiltDir: string, configuredPath: () => string = () => '') {
        this.prebuiltDir = prebuiltDir;
        this.configuredPath = configuredPath;
    }

    /** Drop the cached executable, e.g. after settings changed. zh-CN: 清除缓存 (如配置变更后). */
    invalidate() {
        this.resolved = null;
    }

    private static isExecutable(file: string): boolean {
        try {
            fs.accessSync(file, fs.constants.X_OK);
            return fs.statSync(file).isFile();
        } catch (e) {
            return false;
        }
    }

    private static works(executable: string): boolean {
        try {
            const res = c_proc.spawnSync(executable, [ 'version' ], { timeout: 10_000 });
            return !res.error && res.status === 0;
        } catch (e) {
            return false;
        }
    }

    /** Candidate locations in priority order. zh-CN: 候选路径 (按优先级). */
    candidates(): string[] {
        const isWin = process.platform === 'win32';
        const exe = isWin ? 'adb.exe' : 'adb';
        const list: string[] = [];
        const configured = this.configuredPath();
        if (configured) {
            list.push(fs.existsSync(configured) && fs.statSync(configured).isDirectory() ? path.join(configured, exe) : configured);
        }
        list.push('adb');
        for (const envName of [ 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'ANDROID_SDK_HOME' ]) {
            const root = process.env[envName];
            if (root) list.push(path.join(root, 'platform-tools', exe));
        }
        const home = os.homedir();
        if (isWin) {
            const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
            list.push(path.join(localAppData, 'Android', 'Sdk', 'platform-tools', exe));
            list.push(path.join(this.prebuiltDir, exe));
        } else if (process.platform === 'darwin') {
            list.push(path.join(home, 'Library', 'Android', 'sdk', 'platform-tools', exe));
            list.push('/opt/homebrew/bin/adb', '/usr/local/bin/adb');
        } else {
            list.push(path.join(home, 'Android', 'Sdk', 'platform-tools', exe));
            list.push('/usr/bin/adb', '/usr/local/bin/adb', '/opt/android-sdk/platform-tools/adb');
        }
        return Array.from(new Set(list));
    }

    executable(): string {
        if (this.resolved !== null) {
            return this.resolved;
        }
        for (const candidate of this.candidates()) {
            if (candidate !== 'adb' && !Adb.isExecutable(candidate)) {
                continue;
            }
            if (Adb.works(candidate)) {
                logDebug(`adb resolved: ${candidate}`);
                this.resolved = candidate;
                return candidate;
            }
        }
        throw new AdbNotFoundError();
    }

    exec(args: ReadonlyArray<string>, timeout = 30_000): SpawnSyncReturns<Buffer> {
        const executable = this.executable();
        logDebug(`adb ${args.join(' ')}`);
        return c_proc.spawnSync(executable, args, { timeout });
    }

    execOrThrow(args: ReadonlyArray<string>, timeout = 30_000): SpawnSyncReturns<Buffer> {
        return Adb.throwsIfNeeded(this.exec(args, timeout));
    }

    static throwsIfNeeded<T extends SpawnSyncReturns<Buffer>>(result: T): T {
        if (result.error) {
            throw result.error;
        }
        if (result.signal !== null || result.status !== 0) {
            throw new AdbExecError(result);
        }
        return result;
    }

    /** `adb devices -l` parsed. Works with `\n` and `\r\n` line endings. zh-CN: 解析设备列表, 兼容不同换行符. */
    listDevices(): AdbDeviceInfo[] {
        const res = this.execOrThrow([ 'devices', '-l' ]);
        const devices: AdbDeviceInfo[] = [];
        for (const line of res.stdout.toString().split(/\r?\n/)) {
            const info = Adb.parseDeviceLine(line);
            if (info) devices.push(info);
        }
        for (const dev of devices) {
            if (dev.state !== 'device') continue;
            const brand = this.exec([ '-s', dev.id, 'shell', 'getprop', 'ro.product.brand' ], 10_000);
            if (!brand.error && brand.status === 0) {
                dev.brand = brand.stdout.toString().trim() || dev.brand;
            }
            dev.name = `${dev.brand} ${dev.model} (${dev.id})`;
        }
        return devices;
    }

    static parseDeviceLine(line: string): AdbDeviceInfo | null {
        const matched = /^(\S+)\s+(device|offline|unauthorized|recovery|sideload|no permissions)\b\s*(.*)$/.exec(line.trim());
        if (!matched) {
            return null;
        }
        const info: AdbDeviceInfo = { id: matched[1], state: matched[2], brand: 'Unknown', model: 'Unknown', product: 'Unknown', name: '' };
        matched[3].split(/\s+/).forEach((kv) => {
            const idx = kv.indexOf(':');
            if (idx > 0) {
                const key = kv.slice(0, idx);
                const value = kv.slice(idx + 1);
                if (key === 'model') info.model = value;
                else if (key === 'product') info.product = value;
            }
        });
        info.name = `${info.brand} ${info.model} (${info.id})`;
        return info;
    }

    forward(deviceId: string, localPort: number, remotePort: number) {
        this.execOrThrow([ '-s', deviceId, 'forward', `tcp:${localPort}`, `tcp:${remotePort}` ]);
    }

    removeForward(deviceId: string, localPort: number) {
        try {
            this.exec([ '-s', deviceId, 'forward', '--remove', `tcp:${localPort}` ], 10_000);
        } catch (e) {
            logDebug('failed to remove adb forward:', e);
        }
    }
}

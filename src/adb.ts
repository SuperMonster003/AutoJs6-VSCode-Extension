'use strict';

import * as c_proc from 'child_process';
import * as path from 'path';

import {SpawnSyncReturns} from 'child_process';

class AbdExecError extends Error {
    constructor(result: SpawnSyncReturns<Buffer>) {
        result.status !== null
            ? super(`exited ${result.status}, stderr = ${result.stderr.toString()}, stdout = ${result.stdout.toString()}`)
            : super(`killed ${result.signal}, stderr = ${result.stderr.toString()}, stdout = ${result.stdout.toString()}`);
    }
}

export class Adb {
    private readonly prebuiltDir: string;
    private adb: string = null;

    constructor(prebuiltDir: string) {
        this.prebuiltDir = prebuiltDir;
    }

    executable(): string {
        if (this.adb === null) {
            if (process.platform.startsWith('win') && c_proc.spawnSync('adb').pid === 0) {
                this.adb = path.join(this.prebuiltDir, 'adb.exe');
            } else {
                this.adb = 'adb';
            }
        }
        return this.adb;
    }

    exec(args: ReadonlyArray<string>): SpawnSyncReturns<Buffer> {
        return c_proc.spawnSync(this.executable(), args);
    }

    execOrThrow(args: ReadonlyArray<string>): SpawnSyncReturns<Buffer> {
        return Adb.throwsIfNeeded(this.exec(args));
    }

    execOut(args: ReadonlyArray<string>, options: Object): SpawnSyncReturns<Buffer> {
        return c_proc.spawnSync(this.executable(), ['exec-out', ...args], Object.assign({encoding: 'buffer'}, options));
    }

    execOutOrThrow(args: ReadonlyArray<string>, options: Object): SpawnSyncReturns<Buffer> {
        return Adb.throwsIfNeeded(this.execOut(args, options));
    }

    static throwsIfNeeded<T extends SpawnSyncReturns<Buffer>>(result: T): T {
        if (result.signal !== null || result.status !== 0) {
            throw new AbdExecError(result);
        }
        return result;
    }
}
import type * as vscode from 'vscode';

/*
 * This module must not import `vscode` at runtime so that modules depending on it stay unit-testable.
 * zh-CN: 本模块不得在运行时引入 `vscode`, 以便依赖它的模块可以进行单元测试.
 */

let debugChannel: vscode.OutputChannel | null = null;
let isDebugEnabled: () => boolean = () => false;

export function initLogger(channel: vscode.OutputChannel, debugEnabled: () => boolean) {
    debugChannel = channel;
    isDebugEnabled = debugEnabled;
}

function stringify(param: any): string {
    if (typeof param === 'string') return param;
    if (param instanceof Error) return param.stack || param.message;
    if (Buffer.isBuffer(param)) return `<Buffer ${param.length} bytes>`;
    if (typeof param === 'object' && param !== null) {
        try {
            const s = JSON.stringify(param);
            return s.length > 2000 ? s.slice(0, 2000) + `... (${s.length} chars)` : s;
        } catch (e) {
            return String(param);
        }
    }
    return String(param);
}

/**
 * Debug log (only written when `autojs6.log.debug` is enabled; errors are always written).
 * zh-CN: 调试日志 (仅在 `autojs6.log.debug` 开启时写入, 错误总是写入).
 */
export function logDebug(message?: any, ...optionalParams: any[]) {
    if (!debugChannel || !isDebugEnabled()) {
        return;
    }
    writeLine(message, optionalParams);
}

export function logError(message?: any, ...optionalParams: any[]) {
    if (!debugChannel) {
        return;
    }
    writeLine(`[ERROR] ${stringify(message)}`, optionalParams);
}

function writeLine(message: any, optionalParams: any[]) {
    const time = new Date();
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    let full = stringify(message);
    if (optionalParams.length > 0) {
        full += ' ' + optionalParams.map(stringify).join(' ');
    }
    debugChannel!.appendLine(`[${p(time.getHours())}:${p(time.getMinutes())}:${p(time.getSeconds())}.${p(time.getMilliseconds(), 3)}] ${full}`);
}

/**
 * One output channel per device, keyed by device id.
 * zh-CN: 每个设备一个输出面板, 以设备 id 为键.
 */
export class DeviceChannels implements vscode.Disposable {

    private readonly channels = new Map<string, vscode.OutputChannel>();

    constructor(
        private readonly createChannel: (name: string) => vscode.OutputChannel,
        private readonly disposeOnDisconnect: () => boolean,
    ) {
    }

    get(deviceId: string): vscode.OutputChannel | undefined {
        return this.channels.get(deviceId);
    }

    getOrCreate(deviceId: string, title: string): vscode.OutputChannel {
        let channel = this.channels.get(deviceId);
        if (!channel) {
            channel = this.createChannel(`AutoJs6: ${title}`);
            this.channels.set(deviceId, channel);
        }
        return channel;
    }

    append(deviceId: string, line: string) {
        this.channels.get(deviceId)?.appendLine(line);
    }

    /** Called on disconnect; disposes or annotates depending on settings (issue #30). zh-CN: 断开时调用 (issue #30). */
    onDisconnect(deviceId: string, title: string) {
        const channel = this.channels.get(deviceId);
        if (!channel) return;
        if (this.disposeOnDisconnect()) {
            channel.dispose();
            this.channels.delete(deviceId);
            const next = this.channels.values().next();
            if (!next.done) {
                next.value.show(true);
            }
        } else {
            channel.appendLine(`--- ${title} disconnected ---`);
        }
    }

    dispose() {
        this.channels.forEach(c => c.dispose());
        this.channels.clear();
    }
}

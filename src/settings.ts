import * as vscode from 'vscode';
import { ConnectionOptions } from './device';
import { DEFAULT_CLIENT_PORT, DEFAULT_HTTP_PORT, DEFAULT_SERVER_PORT } from './protocol';

/**
 * Typed accessors for `contributes.configuration` (section `autojs6`).
 * zh-CN: 插件配置项的类型化访问器 (`autojs6` 节).
 */
export class Settings {

    static readonly section = 'autojs6';

    private static get config(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration(Settings.section);
    }

    private static num(key: string, fallback: number, min?: number, max?: number): number {
        let value = Number(Settings.config.get<number>(key, fallback));
        if (!Number.isFinite(value)) value = fallback;
        if (min !== undefined && value < min) value = min;
        if (max !== undefined && value > max) value = max;
        return value;
    }

    /** Port the extension listens on for AutoJs6 client mode. zh-CN: 插件监听端口 (AutoJs6 客户端模式). */
    static get serverPort(): number {
        return Settings.num('server.port', DEFAULT_SERVER_PORT, 1, 65535);
    }

    /** Default port of AutoJs6 server mode. zh-CN: AutoJs6 服务端模式默认端口. */
    static get clientPort(): number {
        return Settings.num('client.port', DEFAULT_CLIENT_PORT, 1, 65535);
    }

    static get httpEnabled(): boolean {
        return Settings.config.get<boolean>('http.enabled', true);
    }

    static get httpPort(): number {
        return Settings.num('http.port', DEFAULT_HTTP_PORT, 1, 65535);
    }

    static get httpHost(): string {
        return Settings.config.get<string>('http.host', '127.0.0.1') || '127.0.0.1';
    }

    static get adbPath(): string {
        return (Settings.config.get<string>('adb.path', '') || '').trim();
    }

    static get connectTimeout(): number {
        return Settings.num('connection.connectTimeout', 8000, 1000, 120000);
    }

    static get handshakeTimeout(): number {
        return Settings.num('connection.handshakeTimeout', 6000, 1000, 120000);
    }

    /** 0 disables heartbeat. zh-CN: 0 表示禁用心跳. */
    static get heartbeatInterval(): number {
        return Settings.num('connection.heartbeatInterval', 15000, 0, 600000);
    }

    static get heartbeatTimeout(): number {
        return Settings.num('connection.heartbeatTimeout', 10000, 1000, 600000);
    }

    static get autoReconnect(): boolean {
        return Settings.config.get<boolean>('connection.autoReconnect', true);
    }

    /** 0 = unlimited within `reconnectTimeout`. zh-CN: 0 表示仅受重连时间窗口限制. */
    static get maxReconnectAttempts(): number {
        return Settings.num('connection.maxReconnectAttempts', 0, 0, 10000);
    }

    /** Seconds; 0 = unlimited. zh-CN: 秒, 0 表示不限. */
    static get reconnectTimeout(): number {
        return Settings.num('connection.reconnectTimeout', 300, 0, 86400);
    }

    static get reconnectMaxDelay(): number {
        return Settings.num('connection.reconnectMaxDelay', 10000, 1000, 600000);
    }

    /** Reconnect to the targets that were connected when VSCode closed. zh-CN: 启动时恢复上次的主动连接. */
    static get restoreOnStartup(): boolean {
        return Settings.config.get<boolean>('connection.restoreOnStartup', true);
    }

    /** Snapshot for `Devices`; read on demand so that changes apply without restart. zh-CN: 供 `Devices` 使用的参数快照. */
    static get connectionOptions(): ConnectionOptions {
        return {
            connectTimeout: Settings.connectTimeout,
            handshakeTimeout: Settings.handshakeTimeout,
            heartbeatInterval: Settings.heartbeatInterval,
            heartbeatTimeout: Settings.heartbeatTimeout,
            autoReconnect: Settings.autoReconnect,
            maxReconnectAttempts: Settings.maxReconnectAttempts,
            reconnectTimeout: Settings.reconnectTimeout * 1000,
            reconnectMaxDelay: Settings.reconnectMaxDelay,
        };
    }

    static get disposeChannelOnDisconnect(): boolean {
        return Settings.config.get<boolean>('log.disposeChannelOnDisconnect', false);
    }

    static get showChannelOnConnect(): boolean {
        return Settings.config.get<boolean>('log.showChannelOnConnect', true);
    }

    static get debugLog(): boolean {
        return Settings.config.get<boolean>('log.debug', false);
    }

    /** Keep the path relative to the workspace when saving a file to device (issue #37). zh-CN: 保存文件时保留相对目录. */
    static get saveKeepRelativePath(): boolean {
        return Settings.config.get<boolean>('save.keepRelativePath', true);
    }

    static onDidChange(listener: () => void): vscode.Disposable {
        return vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration(Settings.section)) {
                listener();
            }
        });
    }
}

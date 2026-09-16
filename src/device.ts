import * as events from 'events';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { logDebug, logError } from './logger';
import { ProjectObserver } from './sync';
import {
    ByeData,
    ByeReason,
    compareVersions,
    encodeBytesFrame,
    encodeJsonFrame,
    ExtensionHelloData,
    FRAME_TYPE_JSON,
    FrameParseError,
    FrameParser,
    HelloData,
    Message,
    MessageType,
    PROTOCOL_VERSION,
    RequestMethod,
    ResponseData,
    toPosixPath,
} from './protocol';

const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));

export const EXTENSION_VERSION: string = packageJson.version;
export const REQUIRED_AUTOJS6_VERSION_NAME: string = packageJson.requiredClientVersionName;
export const REQUIRED_AUTOJS6_VERSION_CODE: number = parseInt(packageJson.requiredClientVersionCode) || -1;

/**
 * Tunables read on demand so that settings changes apply to the next connection without a restart.
 * This module must stay free of `vscode` imports; the extension supplies a provider backed by its settings.
 * zh-CN: 按需读取的连接参数, 使设置变更对后续连接生效. 本模块不得依赖 `vscode`, 由插件传入基于设置的提供者.
 */
export interface ConnectionOptions {
    /** TCP connect timeout (ms). zh-CN: TCP 连接超时. */
    connectTimeout: number;
    /** Time to wait for the peer's hello (ms). zh-CN: 等待对端 hello 的时长. */
    handshakeTimeout: number;
    /** Idle time before a ping is sent (ms), 0 disables. zh-CN: 空闲多久后发送 ping, 0 禁用. */
    heartbeatInterval: number;
    /** Time to wait for any inbound data after a ping (ms). zh-CN: ping 后等待任意入站数据的时长. */
    heartbeatTimeout: number;
    /** Reconnect after an unexpected disconnect when the extension is the connecting side. zh-CN: 插件主动连接意外断开后自动重连. */
    autoReconnect: boolean;
    /** Max attempts per reconnect session, 0 = unlimited within `reconnectTimeout`. zh-CN: 单次重连最大尝试次数, 0 表示仅受时间窗口限制. */
    maxReconnectAttempts: number;
    /** Total time a reconnect session may last (ms), 0 = unlimited. zh-CN: 单次重连的总时长上限, 0 表示不限. */
    reconnectTimeout: number;
    /** Upper bound of the exponential backoff delay (ms). zh-CN: 指数退避的最大间隔. */
    reconnectMaxDelay: number;
}

export const DEFAULT_CONNECTION_OPTIONS: ConnectionOptions = {
    connectTimeout: 8_000,
    handshakeTimeout: 6_000,
    heartbeatInterval: 15_000,
    heartbeatTimeout: 10_000,
    autoReconnect: true,
    maxReconnectAttempts: 0,
    reconnectTimeout: 300_000,
    reconnectMaxDelay: 10_000,
};

export type ConnectionOptionsProvider = () => ConnectionOptions;

export enum ConnectionType {
    /** AutoJs6 connects to the extension. zh-CN: AutoJs6 (客户端) 连接至插件 (服务端). */
    CLIENT_LAN = 0,
    /** Extension connects to AutoJs6 over LAN. zh-CN: 插件 (客户端) 经局域网连接至 AutoJs6 (服务端). */
    SERVER_LAN = 1,
    /** Extension connects to AutoJs6 over an ADB port forward. zh-CN: 插件经 ADB 端口转发连接至 AutoJs6. */
    SERVER_ADB = 2,
}

export interface ConnectionTarget {
    type: ConnectionType;
    host: string;
    port: number;
    adbDeviceId?: string;
    /** Display name, e.g. the ADB device name. zh-CN: 展示名称 (如 ADB 设备名). */
    label?: string;
    /** Re-resolve host/port before (re)connecting, e.g. to re-create an ADB forward. zh-CN: 重连前重新解析地址 (如重建 ADB 转发). */
    prepare?: () => Promise<{ host: string; port: number }>;
    /** Cleanup after the connection is gone, e.g. remove ADB forward. zh-CN: 连接结束后的清理 (如移除 ADB 转发). */
    cleanup?: () => void;
}

export function targetKey(target: ConnectionTarget): string {
    return target.type === ConnectionType.SERVER_ADB ? `adb:${target.adbDeviceId}` : `lan:${target.host}:${target.port}`;
}

export function describeTarget(target: ConnectionTarget): string {
    if (target.type === ConnectionType.SERVER_ADB) {
        return target.label ? `${target.label} (ADB ${target.adbDeviceId})` : `ADB ${target.adbDeviceId}`;
    }
    return `${target.host}:${target.port}`;
}

export type ScriptCommand = 'run' | 'stop' | 'stopAll' | 'save' | 'rerun';
export type ProjectCommand = 'run_project' | 'save_project';

export interface DeviceCommandParam {
    '\xa0cmd\xa0': string;
    [key: string]: any;
}

interface PendingRequest {
    resolve: (value: any) => void;
    reject: (reason: Error) => void;
    timer: NodeJS.Timeout;
    method: string;
}

export class DeviceError extends Error {
    constructor(message: string, readonly device?: Device) {
        super(message);
        this.name = 'DeviceError';
    }
}

/** Reason strings used for `disconnect` events. zh-CN: `disconnect` 事件使用的原因字符串. */
export const CLOSE_REASON = {
    USER: 'closed by user',
    SHUTDOWN: 'closed (shutdown)',
    REPLACED: 'closed (replaced)',
    PEER_USER: 'closed by peer (user)',
    HEARTBEAT: 'heartbeat timed out',
    HANDSHAKE: 'handshake timed out',
} as const;

/**
 * A single AutoJs6 connection.
 * zh-CN: 单个 AutoJs6 连接.
 *
 * Events: `attach`, `disconnect(reason)`, `log(text)`, `command(param)`, `error(e)`, `reject(message)`, `message(m)`.
 */
export class Device extends events.EventEmitter {

    name = 'unknown device';
    deviceId = '';
    versionName = '';
    versionCode = 0;
    protocolVersion = 1;
    readonly target: ConnectionType;
    readonly connectionTarget: ConnectionTarget | null;
    readonly remoteAddress: string;
    readonly connectedAt = Date.now();

    isAttached = false;
    /** Set when this side closed the socket on purpose (user, shutdown, replaced). zh-CN: 本端主动关闭时置位. */
    isClosedByUser = false;
    /** Reason carried by the peer's `bye`, if any. zh-CN: 对端 `bye` 携带的原因. */
    peerByeReason: string | null = null;
    projectObserver: ProjectObserver | null = null;

    private socket: net.Socket | null;
    private readonly options: ConnectionOptionsProvider;
    private readonly parser = new FrameParser();
    private nextId = 1;
    private readonly pending = new Map<number, PendingRequest>();
    private handshakeTimer: NodeJS.Timeout | null = null;
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private heartbeatTimeoutTimer: NodeJS.Timeout | null = null;
    private lastInbound = Date.now();
    private closeReason = '';
    private pingCount = 0;

    constructor(socket: net.Socket, type: ConnectionType, target: ConnectionTarget | null, options: ConnectionOptionsProvider = () => DEFAULT_CONNECTION_OPTIONS) {
        super();
        this.socket = socket;
        this.target = type;
        this.connectionTarget = target;
        this.options = options;
        this.remoteAddress = Device.normalizeAddress(socket.remoteAddress) || target?.host || 'unknown';

        socket.setKeepAlive(true, 10_000);
        socket.setNoDelay(true);

        socket.on('data', (chunk: Buffer) => this.onData(chunk));
        socket.on('error', (e: Error) => {
            logError(`socket error (${this}):`, e);
            this.closeReason = this.closeReason || e.message;
            // An unhandled 'error' event would throw inside the socket callback and crash the extension host.
            // zh-CN: 无监听者的 'error' 事件会在 socket 回调中抛出并导致扩展宿主崩溃.
            if (this.listenerCount('error') > 0) {
                this.emit('error', e);
            }
        });
        socket.on('close', (hadError: boolean) => {
            logDebug(`socket closed (${this}), hadError = ${hadError}, reason = ${this.closeReason}`);
            this.cleanup();
            this.emit('disconnect', this.closeReason || (hadError ? 'socket error' : 'closed by peer'));
        });

        this.handshakeTimer = setTimeout(() => {
            if (!this.isAttached) {
                this.closeReason = CLOSE_REASON.HANDSHAKE;
                logDebug(`handshake timed out (${this})`);
                this.destroy();
            }
        }, this.options().handshakeTimeout);
    }

    static normalizeAddress(address?: string | null): string {
        if (!address) return '';
        return address.replace(/^::ffff:/i, '');
    }

    get isConnected(): boolean {
        return this.socket !== null && !this.socket.destroyed;
    }

    /** Whether the peer speaks protocol v2 (request/response, heartbeat, bye). zh-CN: 对端是否支持协议 v2. */
    get supportsRequests(): boolean {
        return this.protocolVersion >= 2;
    }

    /** Timestamp of the last inbound frame. zh-CN: 最近一次收到数据的时间. */
    get lastInboundAt(): number {
        return this.lastInbound;
    }

    /** Number of pings sent so far. zh-CN: 已发送的 ping 数量. */
    get pingsSent(): number {
        return this.pingCount;
    }

    toString(): string {
        const addr = this.remoteAddress === '127.0.0.1' && this.connectionTarget?.adbDeviceId
            ? `ADB ${this.connectionTarget.adbDeviceId}`
            : this.remoteAddress;
        return `${this.name} (${addr})`;
    }

    private onData(chunk: Buffer) {
        this.lastInbound = Date.now();
        this.clearHeartbeatTimeout();
        let frames;
        try {
            frames = this.parser.push(chunk);
        } catch (e) {
            if (e instanceof FrameParseError) {
                logError(`${e.message} (${this}), destroying socket`);
                this.closeReason = 'protocol desync';
                this.destroy();
                return;
            }
            throw e;
        }
        for (const frame of frames) {
            if (frame.type !== FRAME_TYPE_JSON) {
                logDebug(`ignored bytes frame of ${frame.payload.length} bytes`);
                continue;
            }
            let message: Message;
            try {
                message = JSON.parse(frame.payload.toString('utf8'));
            } catch (e) {
                logError('invalid JSON frame:', e);
                continue;
            }
            this.onMessage(message);
        }
    }

    private onMessage(message: Message) {
        if (!message || typeof message.type !== 'string') {
            return;
        }
        switch (message.type) {
            case MessageType.HELLO:
                this.onHello(message.data as HelloData);
                break;
            case MessageType.LOG:
                this.emit('log', String(message.data?.log ?? ''));
                break;
            case MessageType.PING:
                this.sendJson({ type: MessageType.PONG, data: message.data ?? {} });
                break;
            case MessageType.PONG:
                logDebug(`pong from ${this}`);
                break;
            case MessageType.RESPONSE:
                this.onResponse(message);
                break;
            case MessageType.COMMAND:
                this.emit('command', message.data as DeviceCommandParam);
                break;
            case MessageType.BYE: {
                const reason = String((message.data as ByeData)?.reason || 'unknown');
                this.peerByeReason = reason;
                this.closeReason = reason === 'user' ? CLOSE_REASON.PEER_USER : `closed by peer (${reason})`;
                logDebug(`bye from ${this}: ${reason}`);
                break;
            }
            default:
                logDebug(`unknown message type "${message.type}" from ${this}`);
        }
        this.emit('message', message);
    }

    private onHello(data: HelloData) {
        logDebug('hello from device:', data);
        if (!data) {
            return;
        }
        this.name = data.device_name || 'unknown device';
        this.deviceId = data.device_id || `${this.remoteAddress}`;
        this.versionName = String(data.app_version || '');
        this.versionCode = parseInt(String(data.app_version_code)) || 0;
        this.protocolVersion = parseInt(String(data.protocol_version)) || 1;

        if (this.versionCode < REQUIRED_AUTOJS6_VERSION_CODE) {
            const current = `${this.versionName} (${this.versionCode})`;
            const required = `${REQUIRED_AUTOJS6_VERSION_NAME} (${REQUIRED_AUTOJS6_VERSION_CODE})`;
            const message = `无法建立连接, AutoJs6 版本 ${current} 应不低于 ${required}`;
            this.sendHello(message);
            this.closeReason = message;
            this.emit('reject', message);
            // Give the message a chance to flush before closing. zh-CN: 留出时间发送拒绝信息.
            setTimeout(() => this.destroy(), 300);
            return;
        }

        this.sendHello();
        this.isAttached = true;
        if (this.handshakeTimer) {
            clearTimeout(this.handshakeTimer);
            this.handshakeTimer = null;
        }
        this.startHeartbeat();
        this.emit('attach', this);
    }

    private onResponse(message: Message<ResponseData>) {
        const id = Number(message.id);
        const pending = this.pending.get(id);
        if (!pending) {
            logDebug(`response with unknown id ${id}`);
            return;
        }
        this.pending.delete(id);
        clearTimeout(pending.timer);
        const data = message.data;
        if (data && data.ok) {
            pending.resolve(data.result);
        } else {
            pending.reject(new DeviceError(data?.error || `request "${pending.method}" failed`, this));
        }
    }

    private startHeartbeat() {
        const interval = this.options().heartbeatInterval;
        if (interval <= 0 || !this.supportsRequests) {
            return;
        }
        // Poll a few times per interval so that the idle check stays responsive to setting changes.
        // zh-CN: 每个间隔内轮询数次, 使空闲判断对设置变更保持及时.
        const tick = Math.max(200, Math.min(interval, 5_000));
        this.heartbeatTimer = setInterval(() => {
            if (!this.isConnected || this.heartbeatTimeoutTimer) return;
            const idle = Date.now() - this.lastInbound;
            if (idle < this.options().heartbeatInterval) return; // Recent traffic proves liveness. zh-CN: 近期有数据即视为存活.
            this.pingCount += 1;
            this.sendJson({ type: MessageType.PING, data: { ts: Date.now() } });
            this.heartbeatTimeoutTimer = setTimeout(() => {
                logError(`heartbeat timed out (${this})`);
                this.closeReason = CLOSE_REASON.HEARTBEAT;
                this.destroy();
            }, this.options().heartbeatTimeout);
        }, tick);
    }

    private clearHeartbeatTimeout() {
        if (this.heartbeatTimeoutTimer) {
            clearTimeout(this.heartbeatTimeoutTimer);
            this.heartbeatTimeoutTimer = null;
        }
    }

    private cleanup() {
        if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.clearHeartbeatTimeout();
        this.handshakeTimer = null;
        this.heartbeatTimer = null;
        this.socket = null;
        this.pending.forEach((p) => {
            clearTimeout(p.timer);
            p.reject(new DeviceError(`connection closed (${this})`, this));
        });
        this.pending.clear();
        this.connectionTarget?.cleanup?.();
    }

    private write(buffer: Buffer): boolean {
        if (!this.socket || this.socket.destroyed) {
            logDebug(`write skipped, socket closed (${this})`);
            return false;
        }
        this.socket.write(buffer);
        return true;
    }

    sendJson(message: Message): boolean {
        if (message.id === undefined && message.type !== MessageType.PONG) {
            message.id = this.nextId++;
        }
        logDebug(`>> ${this}:`, message.type === MessageType.COMMAND ? { ...message, data: { ...message.data, script: undefined } } : message);
        return this.write(encodeJsonFrame(message));
    }

    sendBytes(bytes: Buffer): boolean {
        logDebug(`>> ${this}: ${bytes.length} bytes`);
        return this.write(encodeBytesFrame(bytes));
    }

    sendHello(errorMessage?: string) {
        const data: ExtensionHelloData = {
            extensionVersion: EXTENSION_VERSION,
            protocolVersion: PROTOCOL_VERSION,
            features: [ 'heartbeat', 'request', 'fs', 'bye' ],
            name: os.hostname(),
            platform: process.platform,
        };
        if (errorMessage) {
            data.errorMessage = errorMessage;
        }
        this.sendJson({ type: MessageType.HELLO, data });
    }

    sendCommand(command: ScriptCommand, data: object = {}): boolean {
        return this.sendJson({ type: MessageType.COMMAND, data: Object.assign({}, data, { command }) });
    }

    /**
     * Send a request (protocol v2) and await its response.
     * zh-CN: 发送请求 (协议 v2) 并等待响应.
     */
    request<T = any>(method: RequestMethod, params: object = {}, timeout = 30_000): Promise<T> {
        if (!this.supportsRequests) {
            return Promise.reject(new DeviceError(`AutoJs6 ${this.versionName} 不支持此功能, 请升级至协议 v2 版本`, this));
        }
        if (!this.isConnected) {
            return Promise.reject(new DeviceError(`设备未连接 (${this})`, this));
        }
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new DeviceError(`request "${method}" timed out (${this})`, this));
            }, timeout);
            this.pending.set(id, { resolve, reject, timer, method });
            this.sendJson({ id, type: MessageType.REQUEST, data: { method, params } });
        });
    }

    /**
     * Close initiated by this side. `user` marks an explicit disconnect that the peer must respect (no auto reconnect).
     * zh-CN: 本端主动关闭. `user` 表示用户显式断开, 对端不应自动重连.
     */
    disconnect(reason: ByeReason = 'user') {
        this.isClosedByUser = true;
        this.closeReason = reason === 'user' ? CLOSE_REASON.USER
            : reason === 'shutdown' ? CLOSE_REASON.SHUTDOWN
                : reason === 'replaced' ? CLOSE_REASON.REPLACED
                    : `closed (${reason})`;
        if (this.isAttached && this.supportsRequests && this.isConnected) {
            this.sendJson({ type: MessageType.BYE, data: { reason } });
            this.end();
        } else {
            this.destroy();
        }
    }

    /** Close after flushing pending writes, destroying as a fallback. zh-CN: 发送完毕后关闭, 超时则强制销毁. */
    private end() {
        const socket = this.socket;
        if (!socket || socket.destroyed) return;
        const fallback = setTimeout(() => socket.destroy(), 500);
        socket.once('close', () => clearTimeout(fallback));
        socket.end();
    }

    private destroy() {
        this.socket?.destroy();
    }
}

/** State of one automatic reconnect loop. zh-CN: 一次自动重连过程的状态. */
export interface ReconnectSession {
    readonly key: string;
    readonly target: ConnectionTarget;
    attempts: number;
    readonly startedAt: number;
    lastError: string;
    nextAttemptAt: number;
    active: boolean;
    timer: NodeJS.Timeout | null;
}

/**
 * Device manager: listens for AutoJs6 clients and connects to AutoJs6 servers.
 * zh-CN: 设备管理器: 监听 AutoJs6 客户端连接, 并主动连接 AutoJs6 服务端.
 *
 * Events: `new_device(device)`, `detach_device(device, reason)`, `log(device, text)`, `command(device, param)`,
 * `reject(device, message)`, `reconnecting(target, attempt, session)`, `reconnected(device, session)`,
 * `reconnect_failed(target, lastError, session)`, `reconnect_cancelled(target)`, `server_error(e)`, `changed`.
 */
export class Devices extends events.EventEmitter {

    readonly devices: Device[] = [];

    private server: net.Server | null = null;
    private serverPort = 0;
    private readonly reconnects = new Map<string, ReconnectSession>();
    private readonly connecting = new Set<string>();
    private recentDevice: Device | null = null;
    private projectFilter: ((relativePath: string, absPath: string, stats: fs.Stats) => boolean) | null = null;

    constructor(private readonly options: ConnectionOptionsProvider = () => DEFAULT_CONNECTION_OPTIONS) {
        super();
    }

    setProjectFilter(filter: ((relativePath: string, absPath: string, stats: fs.Stats) => boolean) | null) {
        this.projectFilter = filter;
    }

    get listeningPort(): number {
        return this.serverPort;
    }

    get isListening(): boolean {
        return this.server !== null && this.server.listening;
    }

    /**
     * Start listening. Rejects (instead of crashing the extension host) when the port is in use (issue #14/#15).
     * zh-CN: 启动监听, 端口占用时返回 rejected Promise 而非抛出未捕获异常 (issue #14/#15).
     */
    startServer(port: number, host?: string): Promise<number> {
        return new Promise((resolve, reject) => {
            if (this.server) {
                if (this.serverPort === port) {
                    return resolve(port);
                }
                this.stopServer();
            }
            const server = net.createServer((socket) => this.accept(socket));
            server.on('error', (e: NodeJS.ErrnoException) => {
                logError('server error:', e);
                if (!server.listening) {
                    this.server = null;
                    reject(e);
                } else {
                    this.emit('server_error', e);
                }
            });
            server.listen(port, host, () => {
                this.server = server;
                this.serverPort = (server.address() as net.AddressInfo).port;
                logDebug(`server listening on port ${this.serverPort}`);
                resolve(this.serverPort);
            });
        });
    }

    stopServer() {
        this.server?.close();
        this.server = null;
        this.serverPort = 0;
    }

    private accept(socket: net.Socket) {
        logDebug(`accepted connection from ${socket.remoteAddress}:${socket.remotePort}`);
        socket.on('error', (e) => logDebug('accepted socket error:', e));
        const device = new Device(socket, ConnectionType.CLIENT_LAN, null, this.options);
        device.on('attach', () => this.attachDevice(device));
        device.on('reject', (message: string) => this.emit('reject', device, message));
    }

    hasTarget(target: ConnectionTarget): Device | undefined {
        const key = targetKey(target);
        return this.devices.find(d => d.connectionTarget && targetKey(d.connectionTarget) === key);
    }

    /**
     * Connect to an AutoJs6 server (LAN or ADB forward) with a connect timeout. A manual call cancels any pending
     * reconnect loop for the same target.
     * zh-CN: 连接 AutoJs6 服务端 (局域网或 ADB 转发), 带连接超时. 手动调用会取消同一目标的重连过程.
     */
    async connectTo(target: ConnectionTarget, fromReconnect = false): Promise<Device> {
        const key = targetKey(target);
        const existing = this.hasTarget(target);
        if (existing) {
            throw new DeviceError(`设备 ${existing} 已建立连接, 无需重复连接`, existing);
        }
        if (this.connecting.has(key)) {
            throw new DeviceError(`正在连接 ${describeTarget(target)}, 请稍候`);
        }
        if (!fromReconnect) {
            this.cancelReconnect(key);
        }
        this.connecting.add(key);
        try {
            if (target.prepare) {
                const resolved = await target.prepare();
                target.host = resolved.host;
                target.port = resolved.port;
            }
            return await this.openSocket(target);
        } finally {
            this.connecting.delete(key);
        }
    }

    private openSocket(target: ConnectionTarget): Promise<Device> {
        return new Promise<Device>((resolve, reject) => {
            logDebug(`connecting to ${target.host}:${target.port}`);
            const socket = new net.Socket();
            let settled = false;
            const fail = (e: Error) => {
                if (settled) return;
                settled = true;
                socket.destroy();
                reject(e);
            };
            socket.setTimeout(this.options().connectTimeout, () => fail(new DeviceError(`连接超时 (${target.host}:${target.port})`)));
            socket.once('error', (e) => fail(e));
            socket.connect(target.port, target.host, () => {
                socket.setTimeout(0);
                const device = new Device(socket, target.type, target, this.options);
                device.once('attach', () => {
                    if (settled) return;
                    settled = true;
                    this.attachDevice(device);
                    resolve(device);
                });
                device.once('reject', (message: string) => {
                    this.emit('reject', device, message);
                    fail(new DeviceError(message, device));
                });
                device.once('disconnect', (reason: string) => {
                    if (!settled) {
                        settled = true;
                        reject(new DeviceError(`连接已关闭: ${reason}`));
                    }
                });
            });
        });
    }

    private attachDevice(device: Device) {
        logDebug(`attached: ${device}`);
        // Replace a stale entry with the same device id (e.g. reconnect before old socket closed).
        // zh-CN: 若存在相同设备 id 的旧连接, 先移除.
        const stale = this.devices.find(d => d.deviceId === device.deviceId && d !== device);
        if (stale) {
            stale.disconnect('replaced');
            this.removeDevice(stale);
        }
        this.devices.push(device);
        this.recentDevice = device;

        device.on('log', (text: string) => this.emit('log', device, text));
        device.on('command', (param: DeviceCommandParam) => this.emit('command', device, param));
        device.on('disconnect', (reason: string) => {
            this.removeDevice(device);
            this.emit('detach_device', device, reason);
            this.emit('changed');
            this.maybeScheduleReconnect(device, reason);
        });

        this.emit('new_device', device);
        this.emit('changed');
    }

    private removeDevice(device: Device) {
        const idx = this.devices.indexOf(device);
        if (idx >= 0) {
            this.devices.splice(idx, 1);
        }
        if (this.recentDevice === device) {
            this.recentDevice = this.devices.length > 0 ? this.devices[this.devices.length - 1] : null;
        }
    }

    /** Whether a disconnect of `device` should be followed by automatic reconnection. zh-CN: 断开后是否应自动重连. */
    shouldReconnect(device: Device, reason: string): boolean {
        const target = device.connectionTarget;
        if (!target || device.target === ConnectionType.CLIENT_LAN) return false;
        if (device.isClosedByUser) return false;
        // The person disconnected on the device side; respect it (roadmap 3.9). zh-CN: 用户在设备侧显式断开, 尊重其意愿.
        if (device.peerByeReason === 'user') return false;
        if (!this.options().autoReconnect) return false;
        if (reason && reason.includes('版本')) return false; // Version rejection is permanent. zh-CN: 版本拒绝无需重试.
        return true;
    }

    private maybeScheduleReconnect(device: Device, reason: string) {
        if (!this.shouldReconnect(device, reason)) {
            return;
        }
        this.startReconnect(device.connectionTarget!, reason);
    }

    /**
     * Begin (or keep) a reconnect loop for `target`. `immediate` performs the first attempt right away, which is what
     * restoring connections on startup needs.
     * zh-CN: 为目标启动 (或保持) 重连过程. `immediate` 立即进行首次尝试 (用于启动时恢复连接).
     */
    startReconnect(target: ConnectionTarget, cause = '', immediate = false): ReconnectSession {
        const key = targetKey(target);
        const existing = this.reconnects.get(key);
        if (existing) {
            return existing;
        }
        const session: ReconnectSession = {
            key, target, attempts: 0, startedAt: Date.now(), lastError: cause, nextAttemptAt: 0, active: true, timer: null,
        };
        this.reconnects.set(key, session);
        this.emit('changed');
        this.scheduleAttempt(session, immediate ? 0 : undefined);
        return session;
    }

    private scheduleAttempt(session: ReconnectSession, delayOverride?: number) {
        const o = this.options();
        const delay = delayOverride ?? Math.min(1000 * 2 ** session.attempts, Math.max(100, o.reconnectMaxDelay));
        if (o.maxReconnectAttempts > 0 && session.attempts >= o.maxReconnectAttempts) {
            this.finishReconnect(session, false);
            return;
        }
        if (o.reconnectTimeout > 0 && Date.now() + delay - session.startedAt > o.reconnectTimeout) {
            this.finishReconnect(session, false);
            return;
        }
        session.nextAttemptAt = Date.now() + delay;
        logDebug(`scheduling reconnect #${session.attempts + 1} to ${session.key} in ${delay} ms`);
        session.timer = setTimeout(() => this.attemptReconnect(session), delay);
    }

    private async attemptReconnect(session: ReconnectSession) {
        session.timer = null;
        if (!session.active) return;
        session.attempts += 1;
        this.emit('reconnecting', session.target, session.attempts, session);
        try {
            const device = await this.connectTo(session.target, true);
            this.finishReconnect(session, true, device);
        } catch (e) {
            session.lastError = String((e as Error)?.message || e);
            logDebug(`reconnect #${session.attempts} to ${session.key} failed: ${session.lastError}`);
            if (session.active) {
                this.scheduleAttempt(session);
            }
        }
    }

    private finishReconnect(session: ReconnectSession, ok: boolean, device?: Device) {
        session.active = false;
        if (session.timer) clearTimeout(session.timer);
        session.timer = null;
        if (this.reconnects.get(session.key) === session) {
            this.reconnects.delete(session.key);
        }
        if (ok) {
            logDebug(`reconnected to ${session.key} after ${session.attempts} attempt(s)`);
            this.emit('reconnected', device, session);
        } else {
            logError(`giving up reconnecting to ${session.key} after ${session.attempts} attempt(s): ${session.lastError}`);
            this.emit('reconnect_failed', session.target, session.lastError, session);
        }
        this.emit('changed');
    }

    /** Skip the pending delay and try again now. zh-CN: 跳过等待, 立即重试. */
    retryNow(key: string): boolean {
        const session = this.reconnects.get(key);
        if (!session || !session.active || !session.timer) return false;
        clearTimeout(session.timer);
        session.timer = null;
        this.attemptReconnect(session).catch(e => logDebug(e));
        return true;
    }

    cancelReconnect(key?: string) {
        const keys = key ? [ key ] : Array.from(this.reconnects.keys());
        let cancelled = 0;
        keys.forEach((k) => {
            const session = this.reconnects.get(k);
            if (!session) return;
            session.active = false;
            if (session.timer) clearTimeout(session.timer);
            session.timer = null;
            this.reconnects.delete(k);
            cancelled += 1;
            this.emit('reconnect_cancelled', session.target);
        });
        if (cancelled > 0) {
            this.emit('changed');
        }
    }

    get isReconnecting(): boolean {
        return this.reconnects.size > 0;
    }

    get reconnectSessions(): ReconnectSession[] {
        return Array.from(this.reconnects.values());
    }

    hasDevices(): boolean {
        return this.devices.length > 0;
    }

    getDevice(id: string): Device | null {
        if (id === '[recent]') {
            return this.recentDevice || (this.devices.length > 0 ? this.devices[this.devices.length - 1] : null);
        }
        return this.devices.find(d => d.deviceId === id) || null;
    }

    sendCommand(command: ScriptCommand, data: object = {}, devices: Device[] = this.devices): number {
        let count = 0;
        devices.forEach((device) => {
            if (device.sendCommand(command, data)) count += 1;
        });
        return count;
    }

    /**
     * Zip and push a project folder to devices, then run or save it.
     * zh-CN: 打包项目并推送至设备, 随后运行或保存.
     */
    async sendProjectCommand(folder: string, command: ProjectCommand, devices: Device[] = this.devices, force = false): Promise<number> {
        let count = 0;
        for (const device of devices) {
            if (!device.projectObserver || device.projectObserver.folder !== folder || force) {
                device.projectObserver = new ProjectObserver(folder, this.projectFilter);
            }
            const result = await device.projectObserver.diff();
            if (!device.isConnected) continue;
            device.sendBytes(result.buffer);
            device.sendJson({
                type: MessageType.BYTES_COMMAND,
                md5: result.md5,
                data: {
                    id: folder,
                    name: path.basename(folder),
                    deletedFiles: result.deletedFiles.map(toPosixPath),
                    override: result.full,
                    command: command,
                },
            });
            count += 1;
        }
        return count;
    }

    /** Close every connection. `user` also tells peers not to reconnect. zh-CN: 关闭所有连接, `user` 同时告知对端不要重连. */
    disconnectAll(reason: ByeReason = 'user') {
        this.cancelReconnect();
        this.devices.slice().forEach(d => d.disconnect(reason));
        this.devices.splice(0);
        this.recentDevice = null;
        this.emit('changed');
    }

    dispose() {
        this.disconnectAll('shutdown');
        this.stopServer();
    }

    static isVersionAtLeast(device: Device, versionName: string): boolean {
        return compareVersions(device.versionName, versionName) >= 0;
    }
}

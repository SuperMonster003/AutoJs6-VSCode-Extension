/**
 * Wire protocol shared by the extension and AutoJs6.
 * zh-CN: 插件与 AutoJs6 共用的通信协议定义.
 *
 * This module must stay free of `vscode` imports so it can be unit-tested with plain Node.js.
 * zh-CN: 本模块不得依赖 `vscode`, 以便使用纯 Node.js 进行单元测试.
 */

export const HEADER_SIZE = 8;

export const FRAME_TYPE_JSON = 1;
export const FRAME_TYPE_BYTES = 2;

/** Max size of a single frame, used to detect desync early. zh-CN: 单帧最大长度, 用于尽早发现失步. */
export const MAX_FRAME_SIZE = 64 * 1024 * 1024;

/** Protocol version spoken by this extension. zh-CN: 当前插件使用的协议版本. */
export const PROTOCOL_VERSION = 2;

/** Well-known ports. zh-CN: 约定端口. */
export const DEFAULT_SERVER_PORT = 6347; // Extension listens (AutoJs6 client mode). zh-CN: 插件监听 (AutoJs6 客户端模式).
export const DEFAULT_CLIENT_PORT = 7347; // AutoJs6 listens (AutoJs6 server mode). zh-CN: AutoJs6 监听 (AutoJs6 服务端模式).
export const DEFAULT_HTTP_PORT = 10347;  // Local HTTP command bridge. zh-CN: 本地 HTTP 命令桥.

export const MessageType = {
    HELLO: 'hello',
    COMMAND: 'command',
    BYTES_COMMAND: 'bytes_command',
    LOG: 'log',
    PING: 'ping',
    PONG: 'pong',
    REQUEST: 'request',
    RESPONSE: 'response',
    /** Sent right before an intentional close (v2). zh-CN: 主动关闭前发送 (v2). */
    BYE: 'bye',
} as const;

/**
 * Why a side closes the connection. `user` means the person explicitly disconnected and the peer must not
 * reconnect automatically; other reasons keep automatic reconnection allowed.
 * zh-CN: 关闭连接的原因. `user` 表示用户显式断开, 对端不得自动重连; 其他原因允许自动重连.
 */
export type ByeReason = 'user' | 'shutdown' | 'restart' | 'replaced';

export interface ByeData {
    reason: ByeReason | string;
}

export type MessageTypeValue = typeof MessageType[keyof typeof MessageType];

export interface Message<T = any> {
    id?: number;
    type: MessageTypeValue | string;
    data?: T;
    md5?: string;
}

/** `hello` sent by AutoJs6. zh-CN: AutoJs6 发送的 hello. */
export interface HelloData {
    device_id: string;
    device_name: string;
    app_version: string;
    app_version_code: string | number;
    protocol_version?: number;
    /** Capabilities advertised by AutoJs6 6.8.0+ (e.g. `fs.chunked`, `pairing`). zh-CN: AutoJs6 6.8.0+ 声明的能力. */
    features?: string[];
    /** One-time token copied from the connection QR code (roadmap 4.4). zh-CN: 来自连接二维码的一次性令牌. */
    qr_token?: string;
}

export interface LogData {
    log: string;
}

/** `hello` sent by the extension. zh-CN: 插件发送的 hello. */
export interface ExtensionHelloData {
    extensionVersion: string;
    protocolVersion: number;
    features: string[];
    /** Host name of the PC, shown by AutoJs6 (6.8.0+). zh-CN: PC 主机名, 供 AutoJs6 展示. */
    name?: string;
    platform?: string;
    errorMessage?: string;
    /** `true` while the extension waits for the person to approve the device. zh-CN: 等待用户确认设备期间为 true. */
    pending?: boolean;
}

/** Capability names exchanged in hello frames. zh-CN: hello 帧中交换的能力名称. */
export const FEATURE = {
    HEARTBEAT: 'heartbeat',
    REQUEST: 'request',
    FS: 'fs',
    BYE: 'bye',
    /** `fs.read` accepts `offset`/`length` and `fs.write` accepts `append` (roadmap 5.8). zh-CN: 支持分块读写. */
    FS_CHUNKED: 'fs.chunked',
    /** The peer understands the `pending` hello and `qr_token` (roadmap 4.4). zh-CN: 支持配对确认与二维码令牌. */
    PAIRING: 'pairing',
} as const;

export const EXTENSION_FEATURES: string[] = [ FEATURE.HEARTBEAT, FEATURE.REQUEST, FEATURE.FS, FEATURE.BYE, FEATURE.FS_CHUNKED, FEATURE.PAIRING ];

/** Piece size of chunked file transfers. zh-CN: 分块传输的块大小. */
export const FS_CHUNK_SIZE = 1024 * 1024;

/** mDNS service advertised by AutoJs6 server mode (`_autojs6._tcp`). zh-CN: AutoJs6 服务端模式广播的 mDNS 服务. */
export const MDNS_SERVICE_TYPE = 'autojs6';
export const MDNS_SERVICE_PROTOCOL = 'tcp';

export interface ResponseData<T = any> {
    ok: boolean;
    result?: T;
    error?: string;
}

/** Request methods understood by AutoJs6 (protocol v2). zh-CN: AutoJs6 支持的请求方法 (协议 v2). */
export type RequestMethod =
    | 'fs.roots' | 'fs.list' | 'fs.stat' | 'fs.read' | 'fs.write'
    | 'fs.mkdir' | 'fs.delete' | 'fs.rename'
    | 'script.run' | 'sys.info';

export interface RemoteEntry {
    name: string;
    path: string;
    type: 'file' | 'directory';
    size: number;
    mtime: number;
}

export interface RemoteRoots {
    workingDir: string;
    externalStorage: string;
    roots: { name: string; path: string }[];
}

export interface RemoteStat {
    path: string;
    exists: boolean;
    type?: 'file' | 'directory';
    size?: number;
    mtime?: number;
}

/**
 * Encode a frame: 8-byte header (int32BE payload length, int32BE type) followed by payload.
 * zh-CN: 编码帧: 8 字节头 (int32BE 载荷长度, int32BE 类型) + 载荷.
 */
export function encodeFrame(payload: Buffer, type: number): Buffer {
    const header = Buffer.allocUnsafe(HEADER_SIZE);
    header.writeInt32BE(payload.length, 0);
    header.writeInt32BE(type, 4);
    return Buffer.concat([ header, payload ]);
}

export function encodeJsonFrame(message: object): Buffer {
    return encodeFrame(Buffer.from(JSON.stringify(message), 'utf8'), FRAME_TYPE_JSON);
}

export function encodeBytesFrame(bytes: Buffer): Buffer {
    return encodeFrame(bytes, FRAME_TYPE_BYTES);
}

export interface Frame {
    type: number;
    payload: Buffer;
}

export class FrameParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FrameParseError';
    }
}

/**
 * Incremental frame parser for a TCP byte stream. Handles partial and coalesced frames.
 * zh-CN: TCP 字节流的增量帧解析器, 处理半包与粘包.
 */
export class FrameParser {
    private buffer: Buffer = Buffer.alloc(0);
    private readonly maxFrameSize: number;

    constructor(maxFrameSize: number = MAX_FRAME_SIZE) {
        this.maxFrameSize = maxFrameSize;
    }

    get pending(): number {
        return this.buffer.length;
    }

    reset() {
        this.buffer = Buffer.alloc(0);
    }

    /**
     * Feed a chunk and return all complete frames. Throws `FrameParseError` on an invalid header.
     * zh-CN: 送入数据块并返回所有完整帧. 帧头非法时抛出 `FrameParseError`.
     */
    push(chunk: Buffer): Frame[] {
        this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([ this.buffer, chunk ]);
        const frames: Frame[] = [];
        while (this.buffer.length >= HEADER_SIZE) {
            const length = this.buffer.readInt32BE(0);
            const type = this.buffer.readInt32BE(4);
            const isTypeValid = type === FRAME_TYPE_JSON || type === FRAME_TYPE_BYTES;
            const isLengthValid = length >= 0 && length <= this.maxFrameSize;
            if (!isTypeValid || !isLengthValid) {
                this.reset();
                throw new FrameParseError(`Invalid frame header {length: ${length}, type: ${type}}`);
            }
            const total = HEADER_SIZE + length;
            if (this.buffer.length < total) {
                break;
            }
            frames.push({ type, payload: this.buffer.subarray(HEADER_SIZE, total) });
            this.buffer = this.buffer.subarray(total);
        }
        if (this.buffer.length === 0) {
            this.buffer = Buffer.alloc(0);
        }
        return frames;
    }
}

/** Convert an OS path separator to POSIX (`/`). zh-CN: 将路径分隔符转换为 POSIX 风格. */
export function toPosixPath(p: string): string {
    return p.replace(/\\/g, '/');
}

/** Join remote (POSIX) paths. zh-CN: 拼接远程 (POSIX) 路径. */
export function joinRemotePath(...parts: string[]): string {
    const joined = parts.filter(p => p !== undefined && p !== null && p !== '').join('/');
    return joined.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
}

export function remoteBasename(p: string): string {
    const trimmed = p.replace(/\/+$/, '');
    const idx = trimmed.lastIndexOf('/');
    return idx < 0 ? trimmed : trimmed.slice(idx + 1);
}

export function remoteDirname(p: string): string {
    const trimmed = p.replace(/\/+$/, '');
    const idx = trimmed.lastIndexOf('/');
    return idx <= 0 ? '/' : trimmed.slice(0, idx);
}

/**
 * Compare dotted version strings ("1.0.13" vs "1.1.0"). Returns negative, zero or positive.
 * zh-CN: 比较点分版本号, 返回负数/零/正数.
 */
export function compareVersions(a: string, b: string): number {
    const pa = String(a).split(/[.-]/).map(s => parseInt(s, 10) || 0);
    const pb = String(b).split(/[.-]/).map(s => parseInt(s, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0) return d;
    }
    return 0;
}

/* QR code payload. zh-CN: 二维码载荷. */

export const QR_SCHEME = 'autojs6';

export interface QrConnectPayload {
    host: string;
    port: number;
    name?: string;
    /** Alternative hosts. zh-CN: 备选地址. */
    alt?: string[];
    /** One-time pairing token (roadmap 4.4). zh-CN: 一次性配对令牌. */
    token?: string;
}

/**
 * Build the text encoded in the QR code, e.g. `autojs6://connect?host=192.168.1.5&port=6347&name=PC`.
 * zh-CN: 生成二维码文本.
 */
export function buildQrConnectPayload(payload: QrConnectPayload): string {
    const params = new URLSearchParams();
    params.set('host', payload.host);
    params.set('port', String(payload.port));
    if (payload.name) params.set('name', payload.name);
    if (payload.alt && payload.alt.length > 0) params.set('alt', payload.alt.join(','));
    if (payload.token) params.set('token', payload.token);
    params.set('v', String(PROTOCOL_VERSION));
    return `${QR_SCHEME}://connect?${params.toString()}`;
}

/**
 * Parse a QR text. Accepts the `autojs6://connect?...` form and plain `host[:port]`.
 * zh-CN: 解析二维码文本, 支持 `autojs6://connect?...` 与纯 `host[:port]` 形式.
 */
export function parseQrConnectPayload(text: string, defaultPort: number = DEFAULT_SERVER_PORT): QrConnectPayload | null {
    const s = (text || '').trim();
    if (!s) return null;
    if (s.toLowerCase().startsWith(`${QR_SCHEME}://`)) {
        const q = s.indexOf('?');
        if (q < 0) return null;
        const params = new URLSearchParams(s.slice(q + 1));
        const host = params.get('host');
        if (!host) return null;
        const port = parseInt(params.get('port') || '', 10) || defaultPort;
        const alt = (params.get('alt') || '').split(',').map(x => x.trim()).filter(Boolean);
        const payload: QrConnectPayload = { host, port, name: params.get('name') || undefined, alt: alt.length ? alt : undefined };
        const token = params.get('token');
        if (token) payload.token = token;
        return payload;
    }
    const endpoint = parseEndpoint(s, defaultPort);
    return endpoint ? { host: endpoint.host, port: endpoint.port } : null;
}

export interface Endpoint {
    host: string;
    port: number;
}

/**
 * Parse `host`, `host:port`, `[ipv6]`, `[ipv6]:port`. Hostnames are allowed (issue #20).
 * zh-CN: 解析 host[:port], 支持域名与 IPv6 (issue #20).
 */
export function parseEndpoint(input: string, defaultPort: number): Endpoint | null {
    const s = (input || '').trim();
    if (!s) return null;
    if (s.startsWith('[')) {
        const end = s.indexOf(']');
        if (end < 0) return null;
        const host = s.slice(1, end);
        const rest = s.slice(end + 1);
        if (rest.startsWith(':')) {
            const port = parseInt(rest.slice(1), 10);
            return Number.isFinite(port) && port > 0 && port < 65536 ? { host, port } : null;
        }
        return rest === '' ? { host, port: defaultPort } : null;
    }
    const colons = (s.match(/:/g) || []).length;
    if (colons === 1) {
        const idx = s.lastIndexOf(':');
        const host = s.slice(0, idx);
        const port = parseInt(s.slice(idx + 1), 10);
        if (!host || !Number.isFinite(port) || port <= 0 || port >= 65536) return null;
        return isValidHostname(host) ? { host, port } : null;
    }
    if (colons > 1) {
        return { host: s, port: defaultPort }; // Raw IPv6. zh-CN: 裸 IPv6.
    }
    return isValidHostname(s) ? { host: s, port: defaultPort } : null;
}

export function isValidHostname(host: string): boolean {
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) {
        return host.split('.').every(n => parseInt(n, 10) <= 255);
    }
    return /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,62}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,62}[a-zA-Z0-9])?)*\.?$/.test(host);
}

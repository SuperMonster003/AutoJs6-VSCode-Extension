import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as net from 'net';
import { ConnectionOptions, ConnectionTarget, ConnectionType, Device, Devices, DEFAULT_CONNECTION_OPTIONS, CLOSE_REASON } from '../device';
import { encodeJsonFrame, FrameParser, FRAME_TYPE_JSON, Message, MessageType } from '../protocol';

/*
 * Integration-style tests against a fake AutoJs6 server (protocol v2) running in-process. They cover the
 * heartbeat timeout, automatic reconnection, the `bye` handshake and the legacy (v1) path without VSCode.
 * zh-CN: 使用进程内的 AutoJs6 假服务端 (协议 v2) 进行集成测试, 覆盖心跳超时, 自动重连, `bye` 握手与旧版 (v1) 路径.
 */

const FAST: ConnectionOptions = {
    ...DEFAULT_CONNECTION_OPTIONS,
    connectTimeout: 1_000,
    handshakeTimeout: 1_000,
    heartbeatInterval: 120,
    heartbeatTimeout: 150,
    autoReconnect: true,
    maxReconnectAttempts: 0,
    reconnectTimeout: 3_000,
    reconnectMaxDelay: 200,
};

interface FakeConnection {
    socket: net.Socket;
    received: Message[];
}

/** Minimal AutoJs6 stand-in: says hello, answers pings unless muted, records everything. zh-CN: 最小化的 AutoJs6 替身. */
class FakeAutoJs6 {
    readonly connections: FakeConnection[] = [];
    muted = false;
    protocolVersion = 2;
    private server: net.Server | null = null;
    port = 0;

    async start(port = 0): Promise<number> {
        this.server = net.createServer((socket) => this.onConnection(socket));
        await new Promise<void>((resolve, reject) => {
            this.server!.once('error', reject);
            this.server!.listen(port, '127.0.0.1', () => resolve());
        });
        this.port = (this.server.address() as net.AddressInfo).port;
        return this.port;
    }

    private onConnection(socket: net.Socket) {
        const conn: FakeConnection = { socket, received: [] };
        this.connections.push(conn);
        const parser = new FrameParser();
        socket.on('error', () => { /* ignore */ });
        socket.on('data', (chunk) => {
            for (const frame of parser.push(chunk)) {
                if (frame.type !== FRAME_TYPE_JSON) continue;
                const message = JSON.parse(frame.payload.toString('utf8')) as Message;
                conn.received.push(message);
                if (message.type === MessageType.PING && !this.muted) {
                    socket.write(encodeJsonFrame({ type: MessageType.PONG, data: message.data }));
                }
            }
        });
        const hello: any = { device_name: 'Fake', device_id: 'fake-1', app_version: '6.8.0', app_version_code: 5280 };
        if (this.protocolVersion >= 2) hello.protocol_version = this.protocolVersion;
        socket.write(encodeJsonFrame({ type: MessageType.HELLO, data: hello }));
    }

    /** Close every client socket without a `bye`, like a crash. zh-CN: 不发送 bye 直接关闭 (模拟崩溃). */
    crash() {
        this.connections.forEach(c => c.socket.destroy());
    }

    /** Tell clients the user disconnected, then close. zh-CN: 告知客户端用户已断开, 然后关闭. */
    byeUser() {
        this.connections.forEach((c) => {
            c.socket.write(encodeJsonFrame({ type: MessageType.BYE, data: { reason: 'user' } }), () => c.socket.end());
        });
    }

    async stop() {
        this.crash();
        await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve());
        this.server = null;
    }
}

function once<T = any>(emitter: NodeJS.EventEmitter, event: string, timeout = 5_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeout);
        emitter.once(event, (...args: any[]) => {
            clearTimeout(timer);
            resolve((args.length <= 1 ? args[0] : args) as T);
        });
    });
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function lanTarget(port: number): ConnectionTarget {
    return { type: ConnectionType.SERVER_LAN, host: '127.0.0.1', port };
}

test('heartbeat timeout disconnects a silent peer and auto reconnect restores it', async () => {
    const fake = new FakeAutoJs6();
    const port = await fake.start();
    const devices = new Devices(() => FAST);
    try {
        const device = await devices.connectTo(lanTarget(port));
        assert.ok(device.isAttached);
        assert.equal(device.protocolVersion, 2);
        assert.equal(devices.devices.length, 1);

        fake.muted = true;
        const [ detached, reason ] = await once<[ Device, string ]>(devices, 'detach_device');
        assert.equal(detached, device);
        assert.equal(reason, CLOSE_REASON.HEARTBEAT);
        assert.ok(device.pingsSent >= 1, 'a ping must have been sent before timing out');
        assert.ok(devices.isReconnecting, 'a reconnect session must start after an unexpected disconnect');

        fake.muted = false;
        const [ reconnected ] = await once<[ Device, any ]>(devices, 'reconnected');
        assert.ok(reconnected.isAttached);
        assert.equal(devices.devices.length, 1);
        assert.ok(!devices.isReconnecting);
        assert.ok(fake.connections.length >= 2);
    } finally {
        devices.dispose();
        await fake.stop();
    }
});

test('user disconnect sends bye and never reconnects', async () => {
    const fake = new FakeAutoJs6();
    const port = await fake.start();
    const devices = new Devices(() => FAST);
    try {
        const device = await devices.connectTo(lanTarget(port));
        const detach = once<[ Device, string ]>(devices, 'detach_device');
        device.disconnect('user');
        const [ , reason ] = await detach;
        assert.equal(reason, CLOSE_REASON.USER);
        await sleep(50);
        const bye = fake.connections[0].received.find(m => m.type === MessageType.BYE);
        assert.ok(bye, 'peer must receive a bye frame');
        assert.equal(bye!.data.reason, 'user');
        assert.ok(!devices.isReconnecting);
        await sleep(FAST.reconnectMaxDelay * 2);
        assert.equal(fake.connections.length, 1, 'no reconnect attempt expected');
    } finally {
        devices.dispose();
        await fake.stop();
    }
});

test('bye(user) from the device suppresses auto reconnect', async () => {
    const fake = new FakeAutoJs6();
    const port = await fake.start();
    const devices = new Devices(() => FAST);
    try {
        const device = await devices.connectTo(lanTarget(port));
        const detach = once<[ Device, string ]>(devices, 'detach_device');
        fake.byeUser();
        const [ , reason ] = await detach;
        assert.equal(device.peerByeReason, 'user');
        assert.equal(reason, CLOSE_REASON.PEER_USER);
        assert.ok(!devices.shouldReconnect(device, reason));
        assert.ok(!devices.isReconnecting);
    } finally {
        devices.dispose();
        await fake.stop();
    }
});

test('reconnect gives up once after the window and can be restarted', async () => {
    const fake = new FakeAutoJs6();
    const port = await fake.start();
    const options: ConnectionOptions = { ...FAST, reconnectTimeout: 700, reconnectMaxDelay: 150 };
    const devices = new Devices(() => options);
    let failed = 0;
    devices.on('reconnect_failed', () => failed++);
    try {
        await devices.connectTo(lanTarget(port));
        await fake.stop(); // Crash and stay down. zh-CN: 崩溃并保持离线.
        const [ target, lastError, session ] = await once<[ ConnectionTarget, string, any ]>(devices, 'reconnect_failed');
        assert.equal(target.port, port);
        assert.ok(session.attempts >= 2, `expected several attempts, got ${session.attempts}`);
        assert.ok(lastError.length > 0);
        await sleep(400);
        assert.equal(failed, 1, 'the failure must be reported exactly once');
        assert.ok(!devices.isReconnecting);

        // The server comes back and the user asks for a retry (or VSCode restarts): an immediate session succeeds.
        // zh-CN: 服务端恢复后用户重试 (或 VSCode 重启): 立即重连成功.
        const fake2 = new FakeAutoJs6();
        await fake2.start(port);
        try {
            devices.startReconnect(lanTarget(port), 'manual', true);
            const [ device ] = await once<[ Device, any ]>(devices, 'reconnected');
            assert.ok(device.isAttached);
        } finally {
            await fake2.stop();
        }
    } finally {
        devices.dispose();
    }
});

test('legacy v1 peer gets no heartbeat and no bye', async () => {
    const fake = new FakeAutoJs6();
    fake.protocolVersion = 1;
    const port = await fake.start();
    const devices = new Devices(() => FAST);
    try {
        const device = await devices.connectTo(lanTarget(port));
        assert.equal(device.protocolVersion, 1);
        assert.ok(!device.supportsRequests);
        await sleep(FAST.heartbeatInterval * 3);
        assert.equal(device.pingsSent, 0);
        assert.ok(device.isConnected, 'a v1 peer must not be dropped for missing pongs');
        device.disconnect('user');
        await sleep(50);
        assert.ok(!fake.connections[0].received.some(m => m.type === MessageType.BYE));
    } finally {
        devices.dispose();
        await fake.stop();
    }
});

test('disconnectAll(shutdown) keeps the peer free to reconnect later', async () => {
    const fake = new FakeAutoJs6();
    const port = await fake.start();
    const devices = new Devices(() => FAST);
    try {
        await devices.connectTo(lanTarget(port));
        devices.disconnectAll('shutdown');
        await sleep(50);
        const bye = fake.connections[0].received.find(m => m.type === MessageType.BYE);
        assert.equal(bye?.data.reason, 'shutdown');
        assert.equal(devices.devices.length, 0);
        assert.ok(!devices.isReconnecting);
    } finally {
        devices.dispose();
        await fake.stop();
    }
});

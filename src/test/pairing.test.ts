import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as net from 'net';
import { ConnectionOptions, Device, Devices, DEFAULT_CONNECTION_OPTIONS, PairingHandler, PairingVerdict } from '../device';
import { buildQrConnectPayload, encodeJsonFrame, FrameParser, FRAME_TYPE_JSON, Message, MessageType, parseQrConnectPayload } from '../protocol';

/*
 * Pairing (roadmap 4.4): a fake AutoJs6 in client mode connects to the extension's server and sends `hello`;
 * the tests cover QR tokens, trusted devices, the pending hello and the deny path. No VSCode needed.
 * zh-CN: 配对 (roadmap 4.4): 客户端模式的 AutoJs6 假客户端连接插件服务端并发送 hello; 覆盖二维码令牌 / 已信任设备 /
 * pending hello / 拒绝路径. 无需 VSCode.
 */

const FAST: ConnectionOptions = {
    ...DEFAULT_CONNECTION_OPTIONS,
    handshakeTimeout: 1_000,
    heartbeatInterval: 200,
    heartbeatTimeout: 300,
};

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function until(condition: () => boolean, timeout = 3_000, what = 'condition') {
    const start = Date.now();
    while (!condition()) {
        if (Date.now() - start > timeout) {
            throw new Error(`timeout waiting for ${what}`);
        }
        await wait(20);
    }
}

function helloOf(deviceId: string, extra: object = {}) {
    return { device_name: `Fake ${deviceId}`, device_id: deviceId, app_version: '6.8.0', app_version_code: 5280, protocol_version: 2, features: [ 'heartbeat', 'request', 'fs', 'bye', 'pairing' ], ...extra };
}

/** Raw stand-in for AutoJs6 client mode. zh-CN: AutoJs6 客户端模式的原始替身. */
class FakeClient {
    readonly received: Message[] = [];
    socket!: net.Socket;
    closed = false;

    async connect(port: number, hello: object) {
        this.socket = net.connect(port, '127.0.0.1');
        const parser = new FrameParser();
        this.socket.on('data', (chunk: Buffer) => {
            for (const frame of parser.push(chunk)) {
                if (frame.type === FRAME_TYPE_JSON) {
                    const message = JSON.parse(frame.payload.toString('utf8')) as Message;
                    this.received.push(message);
                    if (message.type === MessageType.PING) {
                        this.socket.write(encodeJsonFrame({ type: MessageType.PONG, data: message.data }));
                    }
                }
            }
        });
        this.socket.on('close', () => this.closed = true);
        this.socket.on('error', () => undefined);
        await new Promise<void>(resolve => this.socket.once('connect', () => resolve()));
        this.socket.write(encodeJsonFrame({ type: MessageType.HELLO, data: hello }));
    }

    hellos(): any[] {
        return this.received.filter(m => m.type === MessageType.HELLO).map(m => m.data);
    }

    end() {
        this.socket.destroy();
    }
}

class ScriptedPairing implements PairingHandler {
    readonly tokens = new Set<string>();
    readonly trusted = new Set<string>();
    readonly remembered: string[] = [];
    verdict: PairingVerdict = 'allow';
    confirmDelay = 50;
    confirmed = 0;

    consumeToken(token: string): boolean {
        if (!this.tokens.has(token)) return false;
        this.tokens.delete(token);
        return true;
    }

    isTrusted(device: Device): boolean {
        return this.trusted.has(device.deviceId);
    }

    remember(device: Device): void {
        this.remembered.push(device.deviceId);
        this.trusted.add(device.deviceId);
    }

    async confirm(): Promise<PairingVerdict> {
        this.confirmed++;
        await wait(this.confirmDelay);
        return this.verdict;
    }
}

async function setup() {
    const devices = new Devices(() => FAST);
    const pairing = new ScriptedPairing();
    devices.pairing = pairing;
    const rejections: string[] = [];
    devices.on('reject', (_device: Device, message: string) => rejections.push(message));
    const port = await devices.startServer(0, '127.0.0.1');
    const dispose = () => {
        devices.devices.slice().forEach(d => d.disconnect());
        devices.stopServer();
    };
    return { devices, pairing, port, rejections, dispose };
}

test('a valid QR token attaches the device at once and remembers it', async () => {
    const { devices, pairing, port, dispose } = await setup();
    try {
        pairing.tokens.add('tok-1');
        const client = new FakeClient();
        await client.connect(port, helloOf('dev-a', { qr_token: 'tok-1' }));
        await until(() => devices.devices.length === 1, 3_000, 'attach');
        assert.equal(pairing.confirmed, 0);
        assert.deepEqual(pairing.remembered, [ 'dev-a' ]);
        assert.equal(pairing.tokens.size, 0, 'token is burnt');
        assert.equal(client.hellos().length, 1);
        assert.equal(client.hellos()[0].pending, undefined);
        assert.ok(client.hellos()[0].features.includes('pairing'));
        assert.ok(client.hellos()[0].features.includes('fs.chunked'));
        assert.ok(devices.devices[0].hasFeature('pairing'));
        client.end();
    } finally {
        dispose();
    }
});

test('an unknown device gets a pending hello, then attaches when the person allows and remembers', async () => {
    const { devices, pairing, port, dispose } = await setup();
    try {
        pairing.verdict = 'trust';
        pairing.confirmDelay = 150;
        const client = new FakeClient();
        await client.connect(port, helloOf('dev-b'));
        await until(() => client.hellos().length === 1, 3_000, 'pending hello');
        assert.equal(client.hellos()[0].pending, true);
        assert.equal(devices.devices.length, 0, 'not attached while pending');
        assert.equal(devices.devices.length, 0);
        await until(() => devices.devices.length === 1, 3_000, 'attach after approval');
        assert.equal(pairing.confirmed, 1);
        assert.deepEqual(pairing.remembered, [ 'dev-b' ]);
        assert.equal(client.hellos().length, 2, 'pending hello followed by the final hello');
        assert.equal(client.hellos()[1].pending, undefined);
        // Heartbeats only start after approval. zh-CN: 心跳在确认后才开始.
        await until(() => client.received.some(m => m.type === MessageType.PING), 2_000, 'ping');
        client.end();
    } finally {
        dispose();
    }
});

test('a trusted device attaches without a prompt', async () => {
    const { devices, pairing, port, dispose } = await setup();
    try {
        pairing.trusted.add('dev-c');
        const client = new FakeClient();
        await client.connect(port, helloOf('dev-c', { qr_token: 'stale' }));
        await until(() => devices.devices.length === 1, 3_000, 'attach');
        assert.equal(pairing.confirmed, 0);
        assert.deepEqual(pairing.remembered, [], 'a stale token does not re-remember');
        client.end();
    } finally {
        dispose();
    }
});

test('a denied device is rejected with an error hello and closed', async () => {
    const { devices, pairing, port, rejections, dispose } = await setup();
    try {
        pairing.verdict = 'deny';
        const client = new FakeClient();
        await client.connect(port, helloOf('dev-d'));
        await until(() => client.closed, 3_000, 'close');
        assert.equal(devices.devices.length, 0);
        const hellos = client.hellos();
        assert.equal(hellos[0].pending, true);
        assert.match(hellos[hellos.length - 1].errorMessage, /denied/);
        assert.equal(rejections.length, 1);
        assert.match(rejections[0], /Fake dev-d/);
    } finally {
        dispose();
    }
});

test('a legacy device without the pairing feature is asked without a pending hello', async () => {
    const { devices, pairing, port, dispose } = await setup();
    try {
        pairing.verdict = 'allow';
        const client = new FakeClient();
        await client.connect(port, helloOf('dev-e', { features: undefined }));
        await until(() => devices.devices.length === 1, 3_000, 'attach');
        assert.equal(pairing.confirmed, 1);
        assert.deepEqual(pairing.remembered, [], '"allow" does not remember');
        assert.equal(client.hellos().length, 1, 'no pending hello for peers that cannot show it');
        client.end();
    } finally {
        dispose();
    }
});

test('the person closing the prompt after the device left does not throw', async () => {
    const { devices, pairing, port, dispose } = await setup();
    try {
        pairing.confirmDelay = 300;
        const client = new FakeClient();
        await client.connect(port, helloOf('dev-f'));
        await until(() => client.hellos().length === 1, 3_000, 'pending hello');
        client.end();
        await wait(400);
        assert.equal(devices.devices.length, 0);
        assert.equal(pairing.confirmed, 1);
    } finally {
        dispose();
    }
});

test('QR payload carries the token both ways', () => {
    const text = buildQrConnectPayload({ host: '192.168.1.5', port: 6347, name: 'PC', token: 'abc_-9' });
    assert.ok(text.includes('token=abc_-9'));
    const parsed = parseQrConnectPayload(text);
    assert.equal(parsed?.token, 'abc_-9');
    assert.equal(parseQrConnectPayload('192.168.1.5:6347')?.token, undefined);
});

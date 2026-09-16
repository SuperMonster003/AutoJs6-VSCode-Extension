import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    buildQrConnectPayload,
    compareVersions,
    encodeBytesFrame,
    encodeJsonFrame,
    FRAME_TYPE_BYTES,
    FRAME_TYPE_JSON,
    FrameParseError,
    FrameParser,
    HEADER_SIZE,
    isValidHostname,
    joinRemotePath,
    parseEndpoint,
    parseQrConnectPayload,
    remoteBasename,
    remoteDirname,
    toPosixPath,
} from '../protocol';
import { Adb } from '../adb';

test('encodeJsonFrame writes int32BE length and type', () => {
    const frame = encodeJsonFrame({ type: 'hello' });
    const payload = Buffer.from(JSON.stringify({ type: 'hello' }));
    assert.equal(frame.length, HEADER_SIZE + payload.length);
    assert.equal(frame.readInt32BE(0), payload.length);
    assert.equal(frame.readInt32BE(4), FRAME_TYPE_JSON);
    assert.deepEqual(frame.subarray(HEADER_SIZE), payload);
});

test('FrameParser handles coalesced and split frames', () => {
    const parser = new FrameParser();
    const a = encodeJsonFrame({ type: 'a' });
    const b = encodeBytesFrame(Buffer.from([ 1, 2, 3 ]));
    const c = encodeJsonFrame({ type: 'c', data: { text: '中文' } });
    const all = Buffer.concat([ a, b, c ]);

    const frames1 = parser.push(all.subarray(0, 3));
    assert.equal(frames1.length, 0);
    const frames2 = parser.push(all.subarray(3, a.length + 5));
    assert.equal(frames2.length, 1);
    assert.equal(frames2[0].type, FRAME_TYPE_JSON);
    assert.equal(JSON.parse(frames2[0].payload.toString()).type, 'a');
    const frames3 = parser.push(all.subarray(a.length + 5));
    assert.equal(frames3.length, 2);
    assert.equal(frames3[0].type, FRAME_TYPE_BYTES);
    assert.deepEqual(Array.from(frames3[0].payload), [ 1, 2, 3 ]);
    assert.equal(JSON.parse(frames3[1].payload.toString()).data.text, '中文');
    assert.equal(parser.pending, 0);
});

test('FrameParser rejects invalid headers', () => {
    const parser = new FrameParser(1024);
    const bad = Buffer.alloc(HEADER_SIZE);
    bad.writeInt32BE(2048, 0);
    bad.writeInt32BE(FRAME_TYPE_JSON, 4);
    assert.throws(() => parser.push(bad), FrameParseError);
    const badType = Buffer.alloc(HEADER_SIZE);
    badType.writeInt32BE(1, 0);
    badType.writeInt32BE(9, 4);
    assert.throws(() => parser.push(badType), FrameParseError);
    assert.equal(parser.pending, 0);
});

test('path helpers', () => {
    assert.equal(toPosixPath('a\\b\\c.js'), 'a/b/c.js');
    assert.equal(joinRemotePath('/sdcard/', '/脚本', 'a.js'), '/sdcard/脚本/a.js');
    assert.equal(joinRemotePath('/sdcard', ''), '/sdcard');
    assert.equal(remoteBasename('/sdcard/a/b.js'), 'b.js');
    assert.equal(remoteDirname('/sdcard/a/b.js'), '/sdcard/a');
    assert.equal(remoteDirname('/a'), '/');
});

test('compareVersions', () => {
    assert.ok(compareVersions('1.0.13', '1.1.0') < 0);
    assert.ok(compareVersions('6.8.0', '6.7.0') > 0);
    assert.equal(compareVersions('1.1.0', '1.1'), 0);
});

test('parseEndpoint accepts ip, host:port, domain and ipv6', () => {
    assert.deepEqual(parseEndpoint('192.168.1.2', 7347), { host: '192.168.1.2', port: 7347 });
    assert.deepEqual(parseEndpoint('192.168.1.2:9000', 7347), { host: '192.168.1.2', port: 9000 });
    assert.deepEqual(parseEndpoint('phone.local', 7347), { host: 'phone.local', port: 7347 });
    assert.deepEqual(parseEndpoint('my-phone.lan:1234', 7347), { host: 'my-phone.lan', port: 1234 });
    assert.deepEqual(parseEndpoint('[fe80::1]:8000', 7347), { host: 'fe80::1', port: 8000 });
    assert.deepEqual(parseEndpoint('fe80::1', 7347), { host: 'fe80::1', port: 7347 });
    assert.equal(parseEndpoint('999.1.1.1', 7347), null);
    assert.equal(parseEndpoint('bad host', 7347), null);
    assert.equal(parseEndpoint('1.2.3.4:99999', 7347), null);
    assert.ok(isValidHostname('a.b-c.d'));
    assert.ok(!isValidHostname('-bad'));
});

test('QR payload round trip', () => {
    const text = buildQrConnectPayload({ host: '192.168.1.5', port: 6347, name: 'My PC', alt: [ '10.0.0.2:6347' ] });
    assert.ok(text.startsWith('autojs6://connect?'));
    const parsed = parseQrConnectPayload(text);
    assert.deepEqual(parsed, { host: '192.168.1.5', port: 6347, name: 'My PC', alt: [ '10.0.0.2:6347' ] });
    assert.deepEqual(parseQrConnectPayload('192.168.1.5:6000'), { host: '192.168.1.5', port: 6000 });
    assert.deepEqual(parseQrConnectPayload('192.168.1.5'), { host: '192.168.1.5', port: 6347 });
    assert.equal(parseQrConnectPayload(''), null);
});

test('Adb.parseDeviceLine works with adb devices -l output', () => {
    const info = Adb.parseDeviceLine('KNSOXGKRKVJ7JJSO       device product:lancelot model:M2004J19C device:lancelot transport_id:3');
    assert.ok(info);
    assert.equal(info!.id, 'KNSOXGKRKVJ7JJSO');
    assert.equal(info!.model, 'M2004J19C');
    assert.equal(info!.product, 'lancelot');
    assert.equal(info!.state, 'device');
    const unauthorized = Adb.parseDeviceLine('abc123 unauthorized usb:1-2 transport_id:5');
    assert.equal(unauthorized!.state, 'unauthorized');
    assert.equal(Adb.parseDeviceLine('List of devices attached'), null);
    assert.equal(Adb.parseDeviceLine(''), null);
});

// Device test harness using the compiled extension core (no VSCode needed).
// Usage: node .internal/harness.js <host:port>      (connect to an AutoJs6 server, e.g. through `adb forward`)
//        node .internal/harness.js server [port]    (listen like the extension does, e.g. through `adb reverse`)
// Commands (stdin or lines appended to .internal/harness_cmd.txt):
//   run <file> | stop <file> | stopall | bye [reason] | retry | cancel | connect | status | quit
//   server-stop | server-start   (server mode: simulate VSCode going away / coming back without a bye)
//   allow | trust | deny          (answer a pending pairing confirmation, PAIRING=ask)
//   token <t> | forget            (add a valid one-time QR token / clear trusted devices)
//   discover [ms] | sysinfo | read <remote> [local] | write <local> <remote>   (mDNS browse / features / chunked fs)
// Env: PAIRING=allow|trust|deny|ask|off (default ask), QR_TOKENS=a,b
const { Devices, ConnectionType } = require('../out/device');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const [ , , mode, extra ] = process.argv;
const isServer = mode === 'server';
const serverPort = isServer ? Number(extra || 6347) : 0;
const [ host, portStr ] = (!isServer && mode || '127.0.0.1:57600').split(':');
const options = {
    connectTimeout: 8000, handshakeTimeout: 6000, heartbeatInterval: 15000, heartbeatTimeout: 10000,
    autoReconnect: true, maxReconnectAttempts: 0, reconnectTimeout: 300000, reconnectMaxDelay: 10000,
};
const devices = new Devices(() => options);

// Pairing (roadmap 4.4): scripted handler standing in for the extension's prompt. zh-CN: 配对: 代替插件提示的脚本化处理器.
const pairingMode = process.env.PAIRING || 'ask';
const qrTokens = new Set((process.env.QR_TOKENS || '').split(',').filter(Boolean));
const trusted = new Set();
let pendingVerdict = null;
if (pairingMode !== 'off') {
    devices.pairing = {
        consumeToken(token, d) { const ok = qrTokens.delete(token); console.log(ts(), 'TOKEN', token, ok ? 'accepted' : 'rejected', '| from', d.name); return ok; },
        isTrusted(d) { return trusted.has(d.deviceId); },
        remember(d) { trusted.add(d.deviceId); console.log(ts(), 'REMEMBER', d.deviceId); },
        confirm(d) {
            console.log(ts(), 'CONFIRM?', d.name, '| id', d.deviceId, '| addr', d.remoteAddress, '| features', d.features.join(','), '| mode', pairingMode);
            if (pairingMode !== 'ask') return Promise.resolve(pairingMode);
            return new Promise(resolve => { pendingVerdict = resolve; });
        },
    };
}
const ts = () => new Date().toISOString().substr(11, 12);

devices.on('new_device', d => console.log(ts(), 'ATTACH', d.name, 'proto', d.protocolVersion, '| target', d.target, '| features', d.features.join(',')));
devices.on('detach_device', (d, reason) => console.log(ts(), 'DETACH', d.name, '| reason:', reason, '| peerBye:', d.peerByeReason, '| shouldReconnect:', devices.shouldReconnect(d, reason)));
devices.on('reconnecting', (t, attempts) => console.log(ts(), 'RECONNECTING attempt', attempts));
devices.on('reconnected', d => console.log(ts(), 'RECONNECTED', d.name));
devices.on('reconnect_failed', (t, err, s) => console.log(ts(), 'RECONNECT_FAILED', err, '| attempts', s.attempts));
devices.on('reconnect_cancelled', () => console.log(ts(), 'RECONNECT_CANCELLED'));
devices.on('log', (d, text) => console.log(ts(), 'LOG', String(text).trimEnd()));
devices.on('reject', (d, m) => console.log(ts(), 'REJECT', m));
devices.on('error', e => console.log(ts(), 'ERROR', e && e.message));
devices.on('server_error', e => console.log(ts(), 'SERVER_ERROR', e && e.message));

const target = { type: ConnectionType.SERVER_LAN, host, port: Number(portStr) };

function handle(line) {
    const [ cmd, ...args ] = line.trim().split(/\s+/);
    switch (cmd) {
        case 'run': {
            const file = args[0];
            const script = fs.readFileSync(file, 'utf8');
            const name = path.basename(file);
            devices.devices.forEach(d => d.sendCommand('run', { id: 'h-' + name, name, script }));
            console.log(ts(), 'sent run', name);
            break;
        }
        case 'stop':
            devices.devices.forEach(d => d.sendCommand('stop', { id: 'h-' + path.basename(args[0]) }));
            break;
        case 'stopall':
            devices.devices.forEach(d => d.sendCommand('stopAll'));
            break;
        case 'bye':
            devices.devices.forEach(d => d.disconnect(args[0] || 'user'));
            break;
        case 'retry':
            devices.startReconnect(target, 'manual', true);
            break;
        case 'cancel':
            devices.cancelReconnect();
            break;
        case 'connect':
            devices.connectTo(target).then(() => console.log(ts(), 'connected')).catch(e => console.log(ts(), 'CONNECT FAILED', e.message));
            break;
        case 'server-stop':
            // Kill sockets without a bye and stop listening, like a crashed VSCode. zh-CN: 不发送 bye 直接杀掉并停止监听 (模拟 VSCode 崩溃).
            devices.devices.forEach(d => d.socket && d.socket.destroy());
            devices.stopServer && devices.stopServer();
            if (devices.server) { devices.server.close(); devices.server = null; }
            console.log(ts(), 'server stopped');
            break;
        case 'server-start':
            devices.startServer(serverPort, '127.0.0.1').then(() => console.log(ts(), 'server listening', serverPort)).catch(e => console.log(ts(), 'SERVER FAILED', e.message));
            break;
        case 'allow': case 'trust': case 'deny':
            if (pendingVerdict) { pendingVerdict(cmd); pendingVerdict = null; console.log(ts(), 'VERDICT', cmd); } else console.log(ts(), 'no pending confirmation');
            break;
        case 'token':
            qrTokens.add(args[0]); console.log(ts(), 'token added', args[0]);
            break;
        case 'forget':
            trusted.clear(); console.log(ts(), 'trusted cleared');
            break;
        case 'discover': {
            const { DeviceDiscovery } = require('../out/discovery');
            const disc = new DeviceDiscovery();
            disc.start(list => console.log(ts(), 'DISCOVERED', list.map(d => `${d.name} ${d.host}:${d.port} v${d.version} p${d.protocolVersion} id=${d.id}`)));
            setTimeout(() => { console.log(ts(), 'discovery done, found', disc.list().length); disc.stop(); }, Number(args[0] || 8000));
            break;
        }
        case 'sysinfo':
            devices.devices.forEach(d => d.request('sys.info', {}).then(r => console.log(ts(), 'SYSINFO', JSON.stringify(r))).catch(e => console.log(ts(), 'SYSINFO FAILED', e.message)));
            break;
        case 'read': {
            // Chunked read through fs.read offset/length (roadmap 5.8). zh-CN: 通过 fs.read 的 offset/length 分块读取.
            const d = devices.devices[0];
            if (!d) { console.log(ts(), 'no device'); break; }
            (async () => {
                const stat = await d.request('fs.stat', { path: args[0] });
                const CH = 1024 * 1024; const chunks = []; let off = 0; const t0 = Date.now();
                while (off < stat.size) {
                    const r = await d.request('fs.read', { path: args[0], encoding: 'base64', offset: off, length: CH }, 120000);
                    const b = Buffer.from(r.content, 'base64'); chunks.push(b); off += b.length;
                    console.log(ts(), 'chunk offset', r.offset, 'length', r.length, 'eof', r.eof, 'size', r.size);
                    if (r.eof || b.length === 0) break;
                }
                const all = Buffer.concat(chunks);
                console.log(ts(), 'READ DONE', all.length, 'bytes in', Date.now() - t0, 'ms | md5', require('crypto').createHash('md5').update(all).digest('hex'));
                if (args[1]) fs.writeFileSync(args[1], all);
            })().catch(e => console.log(ts(), 'READ FAILED', e.message));
            break;
        }
        case 'write': {
            // Chunked upload: first piece overwrites, the rest append (roadmap 5.8). zh-CN: 分块上传: 首块覆盖, 其余追加.
            const d = devices.devices[0];
            if (!d) { console.log(ts(), 'no device'); break; }
            (async () => {
                const data = fs.readFileSync(args[0]); const CH = 1024 * 1024; const t0 = Date.now();
                for (let off = 0; off < data.length; off += CH) {
                    const chunk = data.subarray(off, Math.min(data.length, off + CH));
                    const r = await d.request('fs.write', { path: args[1], content: chunk.toString('base64'), encoding: 'base64', create: true, overwrite: true, mkdirs: true, append: off > 0 }, 120000);
                    console.log(ts(), 'wrote offset', off, '+', chunk.length, '-> size', r.size, 'written', r.written);
                }
                console.log(ts(), 'WRITE DONE', data.length, 'bytes in', Date.now() - t0, 'ms | md5', require('crypto').createHash('md5').update(data).digest('hex'));
            })().catch(e => console.log(ts(), 'WRITE FAILED', e.message));
            break;
        }
        case 'status':
            console.log(ts(), 'devices', devices.devices.map(d => d.name), '| reconnecting', devices.isReconnecting);
            break;
        case 'quit':
            devices.dispose();
            process.exit(0);
    }
}

async function main() {
    if (isServer) {
        try {
            await devices.startServer(serverPort, '127.0.0.1');
            console.log(ts(), 'server listening', serverPort);
        } catch (e) {
            console.log(ts(), 'SERVER FAILED', e.message);
        }
    } else {
        try {
            await devices.connectTo(target);
        } catch (e) {
            console.log(ts(), 'CONNECT FAILED', e.message);
        }
    }
    const cmdFile = path.join(__dirname, 'harness_cmd.txt');
    let offset = fs.existsSync(cmdFile) ? fs.statSync(cmdFile).size : 0;
    setInterval(() => {
        if (!fs.existsSync(cmdFile)) return;
        const size = fs.statSync(cmdFile).size;
        if (size <= offset) return;
        const fd = fs.openSync(cmdFile, 'r');
        const buf = Buffer.alloc(size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        fs.closeSync(fd);
        offset = size;
        buf.toString('utf8').split(/[\r\n]+/).filter(Boolean).forEach(handle);
    }, 300);
    readline.createInterface({ input: process.stdin }).on('line', handle);
}
main();

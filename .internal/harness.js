// Device test harness using the compiled extension core (no VSCode needed).
// Usage: node .internal/harness.js <host:port>      (connect to an AutoJs6 server, e.g. through `adb forward`)
//        node .internal/harness.js server [port]    (listen like the extension does, e.g. through `adb reverse`)
// Commands (stdin or lines appended to .internal/harness_cmd.txt):
//   run <file> | stop <file> | stopall | bye [reason] | retry | cancel | connect | status | quit
//   server-stop | server-start   (server mode: simulate VSCode going away / coming back without a bye)
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
const ts = () => new Date().toISOString().substr(11, 12);

devices.on('new_device', d => console.log(ts(), 'ATTACH', d.name, 'proto', d.protocolVersion, '| type', d.type));
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

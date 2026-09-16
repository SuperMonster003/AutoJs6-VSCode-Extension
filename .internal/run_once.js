// Connect to an AutoJs6 server, run one script file, print its log for a few seconds, then leave with bye(shutdown).
// Usage: node .internal/run_once.js <host:port> <file> [waitMs]
const { Devices, ConnectionType } = require('../out/device');
const fs = require('fs');
const path = require('path');

const [ , , addr, file, waitArg ] = process.argv;
const [ host, portStr ] = addr.split(':');
const waitMs = Number(waitArg || 4000);
const devices = new Devices(() => ({
    connectTimeout: 8000, handshakeTimeout: 6000, heartbeatInterval: 15000, heartbeatTimeout: 10000,
    autoReconnect: false, maxReconnectAttempts: 0, reconnectTimeout: 0, reconnectMaxDelay: 1000,
}));
const ts = () => new Date().toISOString().substr(11, 12);
devices.on('log', (d, text) => console.log(ts(), 'LOG', String(text).trimEnd()));
devices.on('detach_device', (d, reason) => console.log(ts(), 'DETACH', reason, '| peerBye:', d.peerByeReason, '| shouldReconnect:', devices.shouldReconnect(d, reason)));

(async () => {
    const device = await devices.connectTo({ type: ConnectionType.SERVER_LAN, host, port: Number(portStr) });
    console.log(ts(), 'ATTACH', device.name);
    const script = fs.readFileSync(file, 'utf8');
    const name = path.basename(file);
    device.sendCommand('run', { id: 'once-' + name, name, script });
    await new Promise(r => setTimeout(r, waitMs));
    devices.disconnectAll('shutdown');
    await new Promise(r => setTimeout(r, 500));
    devices.dispose();
    process.exit(0);
})().catch((e) => {
    console.log(ts(), 'FAILED', e.message);
    process.exit(1);
});

// End-to-end check of "pull project changes from the device" (roadmap 5.7) against a real AutoJs6 server:
// save a temp project, change it on the device, plan the pull, apply it and verify the local copy.
// Usage: node .internal/pull_probe.js [host:port]   (default 127.0.0.1:57600 via `adb forward tcp:57600 tcp:7347`)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Devices, ConnectionType } = require('../out/device');
const { planPull, writeLocalFile } = require('../out/pullCore');

const [ host, portStr ] = (process.argv[2] || '127.0.0.1:57600').split(':');
const ts = () => new Date().toISOString().substr(11, 12);
const devices = new Devices(() => ({
    connectTimeout: 8000, handshakeTimeout: 6000, heartbeatInterval: 15000, heartbeatTimeout: 10000,
    autoReconnect: false, maxReconnectAttempts: 0, reconnectTimeout: 0, reconnectMaxDelay: 1000,
}));
devices.on('log', (d, text) => console.log(ts(), 'LOG', String(text).trimEnd()));

(async () => {
    const device = await devices.connectTo({ type: ConnectionType.SERVER_LAN, host, port: Number(portStr) });
    console.log(ts(), 'ATTACH', device.name, '| features', device.features.join(','));

    const local = fs.mkdtempSync(path.join(os.tmpdir(), 'ajpullprobe-'));
    const name = path.basename(local);
    fs.writeFileSync(path.join(local, 'a.js'), 'console.log("a v1");\n');
    fs.mkdirSync(path.join(local, 'sub'));
    fs.writeFileSync(path.join(local, 'sub', 'b.js'), 'console.log("b");\n');
    fs.writeFileSync(path.join(local, 'project.json'), JSON.stringify({ name, main: 'a.js', versionCode: 1, versionName: '1.0.0', packageName: 'org.autojs.pullprobe' }));

    const sent = await devices.sendProjectCommand(local, 'save_project', [ device ], true);
    console.log(ts(), 'save_project sent to', sent, 'device(s)');
    await new Promise(r => setTimeout(r, 2000));

    const roots = await device.request('fs.roots', {});
    const remoteDir = `${roots.workingDir}/${name}`;
    const b64 = s => Buffer.from(s).toString('base64');
    await device.request('fs.write', { path: `${remoteDir}/a.js`, content: b64('console.log("a v2 edited on device");\n'), encoding: 'base64', create: true, overwrite: true, mkdirs: true });
    await device.request('fs.write', { path: `${remoteDir}/sub/c.js`, content: b64('console.log("c new on device");\n'), encoding: 'base64', create: true, overwrite: true, mkdirs: true });
    fs.writeFileSync(path.join(local, 'local-only.txt'), 'only here');
    console.log(ts(), 'device copy modified:', remoteDir);

    const readRemote = async (p) => {
        const r = await device.request('fs.read', { path: p, encoding: 'base64' }, 120000);
        return Buffer.from(r.content || '', 'base64');
    };
    const listing = await device.request('fs.list', { path: remoteDir, hash: true });
    console.log(ts(), 'fs.list hash support:', listing.entries.some(e => e.md5) ? 'yes (md5 present)' : 'no (content fallback)');

    const plan = await planPull(device, local, null, readRemote);
    console.log(ts(), 'PLAN', JSON.stringify({ remoteDir: plan.remoteDir, scanned: plan.scanned, missingOnDevice: plan.missingOnDevice, changes: plan.changes.map(c => `${c.kind}:${c.relativePath}`) }));

    for (const change of plan.changes) {
        await writeLocalFile(local, change.relativePath, await readRemote(change.remotePath));
    }
    const a = fs.readFileSync(path.join(local, 'a.js'), 'utf8');
    const c = fs.readFileSync(path.join(local, 'sub', 'c.js'), 'utf8');
    console.log(ts(), 'APPLIED a.js =', JSON.stringify(a.trim()), '| sub/c.js =', JSON.stringify(c.trim()));

    const again = await planPull(device, local, null, readRemote);
    console.log(ts(), 'PLAN AFTER PULL', JSON.stringify({ changes: again.changes.length, missingOnDevice: again.missingOnDevice }));

    await device.request('fs.delete', { path: remoteDir, recursive: true });
    fs.rmSync(local, { recursive: true, force: true });
    console.log(ts(), 'cleaned up');
    devices.disconnectAll('shutdown');
    await new Promise(r => setTimeout(r, 500));
    devices.dispose();
    process.exit(0);
})().catch((e) => {
    console.log(ts(), 'FAILED', e && e.stack || e);
    process.exit(1);
});

// Probe mDNS: query the AutoJs6 PTR record via the default socket and via a socket bound to a given interface.
// Usage: node .internal/mdns_probe.js [ifaceIp]
const mdns = require('multicast-dns');
const iface = process.argv[2];
function probe(label, opts) {
    return new Promise((resolve) => {
        const m = mdns(opts);
        const seen = [];
        m.on('response', (res, rinfo) => {
            const names = res.answers.concat(res.additionals || []).map(a => `${a.type} ${a.name}` + (a.type === 'A' ? ` ${a.data}` : a.type === 'SRV' ? ` ${a.data.target}:${a.data.port}` : a.type === 'TXT' ? ` ${a.data.map(String).join('|')}` : ''));
            seen.push(`${rinfo.address}: ${names.join(' ; ')}`);
        });
        m.on('error', e => seen.push('ERROR ' + e.message));
        m.query([ { name: '_autojs6._tcp.local', type: 'PTR' }, { name: '_services._dns-sd._udp.local', type: 'PTR' } ]);
        setTimeout(() => { m.query({ name: '_autojs6._tcp.local', type: 'PTR' }); }, 1500);
        setTimeout(() => { m.destroy(); console.log(`[${label}] ${seen.length} responses`); seen.slice(0, 12).forEach(s => console.log('   ', s)); resolve(); }, 5000);
    });
}
(async () => {
    await probe('default', {});
    if (iface) await probe('bound ' + iface, { interface: iface });
})();

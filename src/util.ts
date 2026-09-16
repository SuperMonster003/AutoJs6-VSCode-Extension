import * as os from 'os';
import { execFile } from 'child_process';
import { logDebug } from './logger';

export interface NIDetails {
    iface: string;           // Interface id. zh-CN: 网络接口名称.
    ifaceName?: string;      // Friendly name. zh-CN: 网卡详细名称.
    ip4: string;             // IPv4 address. zh-CN: IPv4 地址.
    mac: string;             // MAC address. zh-CN: MAC 地址.
    type?: string;           // wired / wireless / virtual. zh-CN: 网卡类型.
    speed?: number | string; // Mbps or 'N/A'. zh-CN: 网卡速率.
    default?: boolean;       // Default route interface. zh-CN: 默认网络接口.
}

/**
 * Interface names that are almost never the one a phone can reach (issue #12).
 * zh-CN: 手机几乎不可能访问到的虚拟网卡名称 (issue #12).
 */
const VIRTUAL_IFACE_PATTERN = /\b(vmware|vmnet\d*|vethernet|virtualbox|vbox|hyper-v|docker\d*|br-[0-9a-f]{12}|wsl|tailscale|zerotier|utun\d*|tun\d*|tap\d*|npcap|loopback)\b/i;

export function isLikelyVirtualInterface(iface: string): boolean {
    return VIRTUAL_IFACE_PATTERN.test(iface);
}

/** Rank so that typical LAN addresses appear first. zh-CN: 排序, 使常见局域网地址靠前. */
function rankIp(ip4: string): number {
    if (ip4.startsWith('192.168.')) return 0;
    if (ip4.startsWith('10.')) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip4)) return 2;
    return 3;
}

export function getBasicNetworkInterfaces(includeVirtual = false): NIDetails[] {
    const interfaces = os.networkInterfaces();
    const result: NIDetails[] = [];

    for (const [ iface, infos ] of Object.entries(interfaces)) {
        if (!includeVirtual && isLikelyVirtualInterface(iface)) {
            continue;
        }
        infos?.forEach((info) => {
            const family = String((info as { family: string | number }).family) === '4' ? 'IPv4' : (info as { family: string | number }).family;
            if (
                family === 'IPv4' &&
                info.address !== '127.0.0.1' &&
                !info.address.startsWith('169.254') && // APIPA. zh-CN: 跳过无效的自动私有地址.
                !info.internal
            ) {
                result.push({ iface, ip4: info.address, mac: info.mac });
            }
        });
    }

    return result.sort((a, b) => rankIp(a.ip4) - rankIp(b.ip4));
}

/** Interface names that usually mean Wi-Fi. zh-CN: 通常表示无线网卡的接口名称. */
const WIRELESS_IFACE_PATTERN = /\b(wi-?fi|wlan\d*|wireless|wlp\d\S*|wlx\S*|ath\d*|ra\d*|en0)\b/i;
const WIRED_IFACE_PATTERN = /\b(ethernet|eth\d*|enp\d\S*|eno\d*|ens\d*|em\d*|以太网|本地连接|en[1-9]\d*)\b/i;

function guessInterfaceType(iface: string): string | undefined {
    if (isLikelyVirtualInterface(iface)) return 'virtual';
    if (WIRELESS_IFACE_PATTERN.test(iface)) return 'wireless';
    if (WIRED_IFACE_PATTERN.test(iface)) return 'wired';
    return undefined;
}

function run(cmd: string, args: string[], timeout = 3000): Promise<string> {
    return new Promise((resolve) => {
        try {
            execFile(cmd, args, { timeout, windowsHide: true, encoding: 'utf8' }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
        } catch {
            resolve('');
        }
    });
}

/**
 * Find the interface (id or IPv4 address) that carries the default route, using the OS routing tools instead
 * of a heavy dependency. Returns `{ iface }`, `{ ip4 }` or null.
 * zh-CN: 通过系统路由工具 (而非重量级依赖) 找出承载默认路由的接口 (接口名或 IPv4 地址); 找不到时返回 null.
 */
export async function findDefaultRouteInterface(): Promise<{ iface?: string; ip4?: string } | null> {
    try {
        if (process.platform === 'win32') {
            // "0.0.0.0  0.0.0.0  <gateway>  <interface ip>  <metric>" rows of the IPv4 routing table; lowest metric wins.
            // zh-CN: IPv4 路由表中 "0.0.0.0 0.0.0.0 <网关> <接口 IP> <跃点数>" 行, 跃点数最小者胜出.
            const out = await run('route', [ 'print', '-4', '0.0.0.0' ]);
            let best: { ip4: string; metric: number } | null = null;
            for (const line of out.split(/\r?\n/)) {
                const m = line.trim().match(/^0\.0\.0\.0\s+0\.0\.0\.0\s+(\S+)\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+)/);
                if (m) {
                    const metric = parseInt(m[3], 10);
                    if (!best || metric < best.metric) best = { ip4: m[2], metric };
                }
            }
            return best ? { ip4: best.ip4 } : null;
        }
        if (process.platform === 'darwin') {
            const out = await run('route', [ '-n', 'get', 'default' ]);
            const m = out.match(/interface:\s*(\S+)/);
            return m ? { iface: m[1] } : null;
        }
        const out = await run('ip', [ '-4', 'route', 'show', 'default' ]);
        const m = out.match(/\bdev\s+(\S+)/);
        return m ? { iface: m[1] } : null;
    } catch (err) {
        logDebug(`failed to find the default route: ${err}`);
        return null;
    }
}

/**
 * Enrich the basic interface list with a type guess and the default-route flag, default route first.
 * zh-CN: 为基础接口列表补充类型推测与默认路由标记, 默认路由优先.
 */
export async function getDetailedNetworkInterfaces(ref: NIDetails[]): Promise<NIDetails[]> {
    const route = await findDefaultRouteInterface();
    const merged = ref.map((basic) => ({
        ...basic,
        type: basic.type || guessInterfaceType(basic.iface),
        default: !!route && (route.ip4 === basic.ip4 || (!!route.iface && route.iface === basic.iface)),
    } as NIDetails));
    // Default route first, then LAN ranking. zh-CN: 默认路由优先, 其次按局域网地址排序.
    return merged.sort((a, b) => Number(!!b.default) - Number(!!a.default) || rankIp(a.ip4) - rankIp(b.ip4));
}

export function formatTimestamp(ts: number): string {
    const date = new Date(ts);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}/${p(date.getMonth() + 1)}/${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

export function formatSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

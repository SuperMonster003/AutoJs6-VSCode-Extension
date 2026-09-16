import * as os from 'os';
import * as si from 'systeminformation';
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

export async function getDetailedNetworkInterfaces(ref: NIDetails[]): Promise<NIDetails[]> {
    try {
        const raw = await si.networkInterfaces();
        const detailedInfo: si.Systeminformation.NetworkInterfacesData[] = Array.isArray(raw) ? raw : [ raw ];
        const merged = ref.map((basic) => {
            const info = detailedInfo.find(d => d.iface === basic.iface || d.ip4 === basic.ip4);
            if (!info) return basic;
            return {
                ...basic,
                ifaceName: info.ifaceName,
                type: info.type,
                speed: info.speed || 'N/A',
                default: info.default,
            } as NIDetails;
        });
        // Default route first, then LAN ranking. zh-CN: 默认路由优先, 其次按局域网地址排序.
        return merged.sort((a, b) => Number(!!b.default) - Number(!!a.default) || rankIp(a.ip4) - rankIp(b.ip4));
    } catch (err) {
        logDebug(`failed to get detailed network interfaces: ${err}`);
        return ref;
    }
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

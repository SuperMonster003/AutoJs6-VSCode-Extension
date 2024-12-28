import * as os from 'os';
import * as crypto from 'crypto';
import * as si from 'systeminformation';

import { StringDecoder } from 'string_decoder';
import { logDebug } from './extension';

export function getBasicNetworkInterfaces(): NIDetails[] {
    const interfaces = os.networkInterfaces();
    const result: NIDetails[] = [];

    for (const [ iface, infos ] of Object.entries(interfaces)) {
        if (/\b(vmware|vmnet\d*)\b/i.test(iface)) {
            continue;
        }
        infos?.forEach(info => {
            if (
                info.family === 'IPv4' &&
                info.address !== '127.0.0.1' && // 排除本地回环网络
                !info.address.startsWith('169.254') && // 优化: 跳过无效的 APIPA 地址
                !info.internal // 排除虚拟网卡
            ) {
                let basic = {
                    iface, // 网卡名称
                    ip4: info.address,
                    mac: info.mac,
                };
                // logDebug(`已获取基本信息:`, basic); // 打印基本信息
                result.push(basic);
            }
        });
    }

    return result;
}

export async function getDetailedNetworkInterfaces(ref: NIDetails[]): Promise<NIDetails[]> {
    try {
        let detailedInfo = await si.networkInterfaces();

        if (!Array.isArray(detailedInfo)) {
            detailedInfo = [ detailedInfo ];
        }

        // 并行处理匹配
        return detailedInfo
            .filter(info => ref.some(r => r.iface === info.iface)) // 过滤匹配的接口
            .map(info => ({
                iface: info.iface,
                ifaceName: info.ifaceName,
                ip4: info.ip4,
                mac: info.mac,
                type: info.type, // wired/wireless...
                speed: info.speed || 'N/A', // 默认值
                default: info.default, // 是否为默认接口
            }));
    } catch (err) {
        logDebug(`获取网络接口详细信息失败: ${err}`);
        return [];
    }
}

export function buffToString(buff) {
    const decoder = new StringDecoder('utf8');
    return decoder.write(buff);
}

export function SHA1(str): string {
    return crypto.createHash('sha1').update(str).digest().toString('base64');
}

export interface NIDetails {
    iface: string;           // 网络接口名称
    ifaceName?: string;      // 网卡详细名称 (详细信息)
    ip4: string;             // IPv4 地址
    mac: string;             // MAC 地址
    type?: string;           // 网卡类型: wired / wireless (详细信息)
    speed?: number | string; // 网卡速率: 数字或 'N/A' (详细信息)
    default?: boolean;       // 默认设备 (详细信息)
}
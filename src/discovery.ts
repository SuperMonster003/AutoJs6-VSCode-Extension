import * as net from 'net';
import { Bonjour, Browser, Service } from 'bonjour-service';
import { logDebug } from './logger';
import { DEFAULT_CLIENT_PORT, MDNS_SERVICE_PROTOCOL, MDNS_SERVICE_TYPE } from './protocol';
import { getBasicNetworkInterfaces } from './util';

/** An AutoJs6 device found on the LAN. zh-CN: 局域网内发现的 AutoJs6 设备. */
export interface DiscoveredDevice {
    /** Display name (TXT `n`, else the service instance name). zh-CN: 显示名称 (TXT n, 否则为服务实例名). */
    name: string;
    host: string;
    port: number;
    /** AutoJs6 version name (TXT `v`). zh-CN: AutoJs6 版本名 (TXT v). */
    version?: string;
    /** Protocol version (TXT `p`). zh-CN: 协议版本 (TXT p). */
    protocolVersion?: number;
    /** Device id (TXT `id`). zh-CN: 设备 ID (TXT id). */
    id?: string;
    fqdn: string;
}

interface Instance {
    bonjour: Bonjour;
    browser: Browser;
}

/**
 * Browses `_autojs6._tcp` on the LAN; AutoJs6 6.8.0+ advertises it while server mode runs with LAN discovery
 * enabled (roadmap 3.10). One socket is opened per IPv4 interface besides the wildcard one: on Windows a wildcard
 * socket multicasts through a single (often virtual) adapter, so the real LAN never sees the query. Failures
 * (no multicast, sandboxed network) only disable discovery.
 * zh-CN: 在局域网浏览 `_autojs6._tcp`; AutoJs6 6.8.0+ 在服务端模式且开启局域网发现时广播 (roadmap 3.10). 除通配 socket 外, 每个
 * IPv4 接口再单独打开一个 socket: Windows 下通配 socket 仅经某一 (常为虚拟) 网卡发送组播, 真实局域网收不到查询. 失败 (无组播 /
 * 受限网络) 仅使发现功能不可用.
 */
export class DeviceDiscovery {

    private readonly instances: Instance[] = [];
    private readonly found = new Map<string, DiscoveredDevice>();

    start(onChange: (devices: DiscoveredDevice[]) => void): void {
        if (this.instances.length > 0) {
            return;
        }
        const interfaces = getBasicNetworkInterfaces().map(i => i.ip4).filter(ip => net.isIPv4(ip));
        const bindings: (string | undefined)[] = [ undefined, ...new Set(interfaces) ];
        for (const ip of bindings) {
            try {
                const options = ip ? { interface: ip } : undefined;
                const bonjour = new Bonjour(options as any, (e: Error) => logDebug(`mDNS error (${ip || 'any'}): ${e}`));
                const browser = bonjour.find({ type: MDNS_SERVICE_TYPE, protocol: MDNS_SERVICE_PROTOCOL });
                browser.on('up', (service: Service) => {
                    const device = DeviceDiscovery.toDevice(service);
                    if (device && !this.found.has(device.fqdn)) {
                        logDebug(`mDNS up (${ip || 'any'}): ${device.name} at ${device.host}:${device.port}`);
                        this.found.set(device.fqdn, device);
                        onChange(this.list());
                    }
                });
                browser.on('down', (service: Service) => {
                    if (this.found.delete(service.fqdn)) {
                        logDebug(`mDNS down (${ip || 'any'}): ${service.fqdn}`);
                        onChange(this.list());
                    }
                });
                this.instances.push({ bonjour, browser });
            } catch (e) {
                logDebug(`mDNS discovery unavailable on ${ip || 'any'}: ${e}`);
            }
        }
    }

    list(): DiscoveredDevice[] {
        return Array.from(this.found.values()).sort((a, b) => a.name.localeCompare(b.name) || a.host.localeCompare(b.host));
    }

    stop(): void {
        for (const { bonjour, browser } of this.instances.splice(0)) {
            try {
                browser.stop();
            } catch (e) {
                logDebug(`failed to stop an mDNS browser: ${e}`);
            }
            try {
                bonjour.destroy();
            } catch (e) {
                logDebug(`failed to destroy an mDNS instance: ${e}`);
            }
        }
    }

    private static toDevice(service: Service): DiscoveredDevice | null {
        const addresses = (service.addresses || []).filter(a => net.isIPv4(a));
        const host = addresses[0] || service.referer?.address;
        if (!host || !service.port) {
            return null;
        }
        const txt = (service.txt || {}) as Record<string, string>;
        return {
            name: txt.n || service.name,
            host,
            port: service.port || DEFAULT_CLIENT_PORT,
            version: txt.v || undefined,
            protocolVersion: txt.p ? parseInt(txt.p, 10) || undefined : undefined,
            id: txt.id || undefined,
            fqdn: service.fqdn || `${service.name}.${service.type}`,
        };
    }
}

import * as os from 'os';
import * as vscode from 'vscode';
import * as QRCode from 'qrcode';
import * as util from './util';
import { buildQrConnectPayload } from './protocol';
import { logDebug } from './logger';
import { t } from './i18n';

const DEFAULT_QR_SIZE = 320;
const STORAGE_KEY_SIZE = 'autojs6.qrcode.size';

/**
 * Webview showing a QR code that AutoJs6 can scan to connect in client mode.
 * zh-CN: 展示二维码的 Webview, AutoJs6 扫码后以客户端模式连接.
 */
export class QrCodePanel {

    private static current: QrCodePanel | null = null;
    private static tokenProvider: (() => string) | null = null;

    static async show(context: vscode.ExtensionContext, port: number, interfaces: util.NIDetails[], preferredIp?: string, tokenProvider?: () => string) {
        if (tokenProvider) {
            QrCodePanel.tokenProvider = tokenProvider;
        }
        if (QrCodePanel.current) {
            QrCodePanel.current.panel.reveal();
            await QrCodePanel.current.update(port, interfaces, preferredIp);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'autojs6.qrcode',
            t('AutoJs6 QR Code Connect'),
            vscode.ViewColumn.Beside,
            { enableScripts: true, retainContextWhenHidden: true },
        );
        panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'assets', 'images', 'autojs6_material.png');
        QrCodePanel.context = context;
        QrCodePanel.current = new QrCodePanel(panel, port, interfaces, preferredIp);
        context.subscriptions.push(panel);
    }

    static refresh(port: number) {
        if (QrCodePanel.current) {
            QrCodePanel.current.update(port, util.getBasicNetworkInterfaces(), QrCodePanel.current.selectedIp).catch(e => logDebug(e));
        }
    }

    static get isVisible(): boolean {
        return QrCodePanel.current !== null;
    }

    private static context: vscode.ExtensionContext | null = null;

    private selectedIp: string | undefined;
    private interfaces: util.NIDetails[];
    private port: number;
    private detailsLoaded = false;
    private size: number = QrCodePanel.context?.globalState.get<number>(STORAGE_KEY_SIZE, DEFAULT_QR_SIZE) ?? DEFAULT_QR_SIZE;

    /** One-time pairing token inside the current code; renewed on refresh (roadmap 4.4). zh-CN: 当前二维码中的一次性配对令牌, 刷新时更新. */
    private token = '';

    private constructor(private readonly panel: vscode.WebviewPanel, port: number, interfaces: util.NIDetails[], preferredIp?: string) {
        this.port = port;
        this.interfaces = interfaces;
        this.selectedIp = preferredIp;
        panel.onDidDispose(() => {
            QrCodePanel.current = null;
        });
        panel.webview.onDidReceiveMessage(async (message: { cmd: string; ip?: string; text?: string; size?: number }) => {
            switch (message.cmd) {
                case 'select':
                    this.selectedIp = message.ip;
                    await this.render();
                    break;
                case 'copy':
                    if (message.text) {
                        await vscode.env.clipboard.writeText(message.text);
                        vscode.window.showInformationMessage(t('Connection info copied to the clipboard'));
                    }
                    break;
                case 'refresh':
                    this.detailsLoaded = false;
                    this.token = '';
                    await this.update(this.port, util.getBasicNetworkInterfaces(), this.selectedIp);
                    break;
                case 'size':
                    this.size = Math.max(200, Math.min(900, Number(message.size) || DEFAULT_QR_SIZE));
                    QrCodePanel.context?.globalState.update(STORAGE_KEY_SIZE, this.size);
                    break;
            }
        });
        this.render().catch(e => logDebug(e));
    }

    async update(port: number, interfaces: util.NIDetails[], preferredIp?: string) {
        this.port = port;
        this.interfaces = interfaces;
        this.selectedIp = preferredIp || this.selectedIp;
        await this.render();
    }

    private pickSelected(): util.NIDetails | undefined {
        if (this.interfaces.length === 0) return undefined;
        return this.interfaces.find(i => i.ip4 === this.selectedIp)
            || this.interfaces.find(i => i.default)
            || this.interfaces[0];
    }

    private async render() {
        if (!this.detailsLoaded) {
            // Load details once in the background so the default interface can be preferred.
            // zh-CN: 后台加载一次详细信息, 以便优先选择默认网络接口.
            this.detailsLoaded = true;
            util.getDetailedNetworkInterfaces(this.interfaces).then((detailed) => {
                if (detailed.length > 0 && QrCodePanel.current === this) {
                    this.interfaces = detailed;
                    this.render().catch(e => logDebug(e));
                }
            }).catch(e => logDebug(e));
        }
        const selected = this.pickSelected();
        this.selectedIp = selected?.ip4;
        let payload = '';
        let dataUrl = '';
        if (selected) {
            // Keep the payload short (no alternative hosts, capped name) so the code has fewer modules and scans
            // faster from a screen; AutoJs6 only reads host/port anyway.
            // zh-CN: 保持载荷简短 (不含备选地址, 限制主机名长度) 以减少二维码模块数, 便于从屏幕扫描; AutoJs6 仅读取 host/port.
            if (!this.token && QrCodePanel.tokenProvider) {
                this.token = QrCodePanel.tokenProvider();
            }
            payload = buildQrConnectPayload({ host: selected.ip4, port: this.port, name: os.hostname().slice(0, 24), token: this.token || undefined });
            dataUrl = await QRCode.toDataURL(payload, { errorCorrectionLevel: 'L', margin: 2, width: 720 });
        }
        this.panel.webview.html = this.html(selected, payload, dataUrl);
    }

    private html(selected: util.NIDetails | undefined, payload: string, dataUrl: string): string {
        const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const options = this.interfaces.map((ni) => {
            const parts = [ ni.ip4, ni.ifaceName || ni.iface ];
            if (ni.default) parts.push(t('default'));
            const label = parts.join(' | ');
            return `<option value="${esc(ni.ip4)}" ${ni.ip4 === selected?.ip4 ? 'selected' : ''}>${esc(label)}</option>`;
        }).join('');
        const nonce = String(Date.now());
        const body = selected ? `
            <div class="qr"><img id="qr" src="${dataUrl}" alt="QR Code" style="width:${this.size}px;height:${this.size}px" /></div>
            <div class="size"><label for="size">${t('QR code size')}</label> <input id="size" type="range" min="200" max="900" step="20" value="${this.size}" /> <span id="sizeValue">${this.size}px</span></div>
            <div class="addr">${esc(selected.ip4)}:${this.port}</div>
            <div class="payload"><code id="payload">${esc(payload)}</code></div>
            <div class="actions">
                <button id="copy">${t('Copy connection info')}</button>
                <button id="refresh">${t('Refresh')}</button>
            </div>` : `
            <p class="warn">${t('No usable LAN IP address found; check the network and refresh.')}</p>
            <div class="actions"><button id="refresh">${t('Refresh')}</button></div>`;
        return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>AutoJs6 QR Code</title>
<style nonce="${nonce}">
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px 24px; max-width: 720px; }
    h2 { font-weight: 600; margin: 0 0 8px; }
    ol { padding-left: 20px; line-height: 1.7; }
    select { width: 100%; max-width: 480px; padding: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); }
    .qr { margin: 16px 0 8px; }
    .qr img { background: #fff; padding: 12px; border-radius: 8px; image-rendering: pixelated; }
    .size { margin: 4px 0 8px; opacity: .85; font-size: 12px; }
    .size input { vertical-align: middle; width: 240px; }
    .addr { font-size: 22px; font-weight: 600; letter-spacing: 1px; }
    .payload { margin: 8px 0 12px; word-break: break-all; opacity: .8; }
    .actions button { margin-right: 8px; padding: 6px 14px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; cursor: pointer; }
    .actions button:hover { background: var(--vscode-button-hoverBackground); }
    .warn { color: var(--vscode-errorForeground); }
    .hint { opacity: .75; font-size: 12px; margin-top: 16px; }
</style>
</head>
<body>
    <h2>${t('AutoJs6 QR Code Connect')}</h2>
    <ol>
        <li>${t('Open the AutoJs6 drawer and tap the scan button next to the "Client mode" input')}</li>
        <li>${t('Scan the QR code below; AutoJs6 connects to this PC (port {0})', this.port)}</li>
        <li>${t('Hold the phone about 15 - 30 cm from the screen and wait for focus; if it will not scan, enlarge the code with the slider below')}</li>
        <li>${t('If the phone and the PC are on different subnets, switch the network interface below')}</li>
    </ol>
    <label for="iface">${t('Network interface')}</label>
    <select id="iface">${options}</select>
    ${body}
    <p class="hint">${t('Tip: the code carries a one-time pairing token (valid for 10 minutes); devices that scan it are trusted automatically. The text can also be typed into the AutoJs6 address box as "IP:port" or as the full autojs6:// link. Make sure the firewall allows TCP port {0}.', this.port)}</p>
<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('iface').addEventListener('change', (e) => vscode.postMessage({ cmd: 'select', ip: e.target.value }));
    const copy = document.getElementById('copy');
    if (copy) copy.addEventListener('click', () => vscode.postMessage({ cmd: 'copy', text: document.getElementById('payload').textContent }));
    document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ cmd: 'refresh' }));
    const size = document.getElementById('size');
    if (size) size.addEventListener('input', (e) => {
        const v = Number(e.target.value);
        const img = document.getElementById('qr');
        img.style.width = v + 'px';
        img.style.height = v + 'px';
        document.getElementById('sizeValue').textContent = v + 'px';
        vscode.postMessage({ cmd: 'size', size: v });
    });
</script>
</body>
</html>`;
    }
}

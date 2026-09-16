import * as os from 'os';
import * as vscode from 'vscode';
import * as QRCode from 'qrcode';
import * as util from './util';
import { buildQrConnectPayload } from './protocol';
import { logDebug } from './logger';

const DEFAULT_QR_SIZE = 320;
const STORAGE_KEY_SIZE = 'autojs6.qrcode.size';

/**
 * Webview showing a QR code that AutoJs6 can scan to connect in client mode.
 * zh-CN: 展示二维码的 Webview, AutoJs6 扫码后以客户端模式连接.
 */
export class QrCodePanel {

    private static current: QrCodePanel | null = null;

    static async show(context: vscode.ExtensionContext, port: number, interfaces: util.NIDetails[], preferredIp?: string) {
        if (QrCodePanel.current) {
            QrCodePanel.current.panel.reveal();
            await QrCodePanel.current.update(port, interfaces, preferredIp);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'autojs6.qrcode',
            'AutoJs6 扫码连接 (QR Code)',
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
                        vscode.window.showInformationMessage('连接信息已复制到剪贴板');
                    }
                    break;
                case 'refresh':
                    this.detailsLoaded = false;
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
            payload = buildQrConnectPayload({ host: selected.ip4, port: this.port, name: os.hostname().slice(0, 24) });
            dataUrl = await QRCode.toDataURL(payload, { errorCorrectionLevel: 'L', margin: 2, width: 720 });
        }
        this.panel.webview.html = this.html(selected, payload, dataUrl);
    }

    private html(selected: util.NIDetails | undefined, payload: string, dataUrl: string): string {
        const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const options = this.interfaces.map((ni) => {
            const parts = [ ni.ip4, ni.ifaceName || ni.iface ];
            if (ni.default) parts.push('默认');
            const label = parts.join(' | ');
            return `<option value="${esc(ni.ip4)}" ${ni.ip4 === selected?.ip4 ? 'selected' : ''}>${esc(label)}</option>`;
        }).join('');
        const nonce = String(Date.now());
        const body = selected ? `
            <div class="qr"><img id="qr" src="${dataUrl}" alt="QR Code" style="width:${this.size}px;height:${this.size}px" /></div>
            <div class="size"><label for="size">二维码尺寸</label> <input id="size" type="range" min="200" max="900" step="20" value="${this.size}" /> <span id="sizeValue">${this.size}px</span></div>
            <div class="addr">${esc(selected.ip4)}:${this.port}</div>
            <div class="payload"><code id="payload">${esc(payload)}</code></div>
            <div class="actions">
                <button id="copy">复制连接信息 (Copy)</button>
                <button id="refresh">刷新 (Refresh)</button>
            </div>` : `
            <p class="warn">未找到可用的局域网 IP 地址, 请检查网络连接后刷新.</p>
            <div class="actions"><button id="refresh">刷新 (Refresh)</button></div>`;
        return `<!DOCTYPE html>
<html lang="zh-CN">
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
    <h2>AutoJs6 扫码连接</h2>
    <ol>
        <li>打开 AutoJs6 侧拉菜单, 点击 "客户端模式" 输入框右侧的扫码按钮</li>
        <li>扫描下方二维码, AutoJs6 将自动连接到本机 (端口 ${this.port})</li>
        <li>扫描时保持手机与屏幕距离约 15 - 30 cm 并等待对焦; 若难以识别, 可拖动下方滑块放大二维码</li>
        <li>若手机与电脑不在同一网段, 可在下方切换网络接口</li>
    </ol>
    <label for="iface">网络接口</label>
    <select id="iface">${options}</select>
    ${body}
    <p class="hint">提示: 二维码内容也可手动输入到 AutoJs6 的地址框, 格式为 "IP:端口" 或完整的 autojs6:// 链接. 需确保防火墙放行 TCP ${this.port} 端口.</p>
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

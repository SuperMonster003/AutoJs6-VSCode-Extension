/*
 * Thin wrapper over `vscode.l10n` that also works where `vscode` is unavailable (unit tests, the device harness).
 * Source strings are English; `l10n/bundle.l10n.zh-cn.json` provides Simplified Chinese and VSCode picks the bundle
 * matching its display language (roadmap 1.9).
 * zh-CN: 对 `vscode.l10n` 的轻量封装, 在没有 `vscode` 的环境 (单元测试, 设备测试脚本) 中同样可用. 源字符串为英文;
 * `l10n/bundle.l10n.zh-cn.json` 提供简体中文, VSCode 按显示语言选择对应的 bundle (roadmap 1.9).
 */

interface L10n {
    t(message: string, ...args: (string | number | boolean)[]): string;
}

let l10n: L10n | null = null;
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    l10n = (require('vscode') as { l10n?: L10n }).l10n || null;
} catch {
    l10n = null;
}

/**
 * Translate `message` for the current display language and fill `{0}`, `{1}`, ... with `args`.
 * zh-CN: 按当前显示语言翻译 `message`, 并用 `args` 填充 `{0}`, `{1}` 等占位符.
 */
export function t(message: string, ...args: (string | number | boolean)[]): string {
    if (l10n) {
        return args.length > 0 ? l10n.t(message, ...args) : l10n.t(message);
    }
    return message.replace(/\{(\d+)\}/g, (match, index) => (Number(index) < args.length ? String(args[Number(index)]) : match));
}

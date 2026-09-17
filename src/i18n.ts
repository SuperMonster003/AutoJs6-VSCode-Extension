/*
 * Thin wrapper over `vscode.l10n` that also works where `vscode` is unavailable (unit tests, the device harness).
 * Source strings are English; `l10n/bundle.l10n.zh-cn.json` provides Simplified Chinese. By default VSCode picks the
 * bundle matching its display language (roadmap 1.9); the `autojs6.language` setting can pin the language instead,
 * in which case the bundle is read from disk here and `vscode.l10n` is bypassed. Manifest strings (command titles,
 * setting descriptions) are resolved by VSCode from `package.nls*.json` and always follow its display language.
 * zh-CN: 对 `vscode.l10n` 的轻量封装, 在没有 `vscode` 的环境 (单元测试, 设备测试脚本) 中同样可用. 源字符串为英文;
 * `l10n/bundle.l10n.zh-cn.json` 提供简体中文. 默认由 VSCode 按显示语言选择 bundle (roadmap 1.9); `autojs6.language`
 * 配置可显式指定语言, 此时由本模块自行读取 bundle 并绕过 `vscode.l10n`. 清单字符串 (命令标题, 配置说明) 由 VSCode 按
 * `package.nls*.json` 解析, 始终跟随其显示语言.
 */

import * as fs from 'fs';
import * as path from 'path';

/** `auto` follows VSCode's display language. zh-CN: `auto` 跟随 VSCode 显示语言. */
export type Language = 'auto' | 'en' | 'zh-cn';

export const LANGUAGES: readonly Language[] = [ 'auto', 'en', 'zh-cn' ];

interface L10n {
    t(message: string, ...args: (string | number | boolean)[]): string;
}

let l10n: L10n | null = null;
let language: Language = 'auto';
let bundle: Record<string, string> | null = null;

try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode = require('vscode') as {
        l10n?: L10n;
        workspace?: { getConfiguration(section: string): { get<T>(key: string, fallback: T): T } };
    };
    l10n = vscode.l10n || null;
    // Read the setting at load time so that module-level `t()` calls already use the pinned language.
    // zh-CN: 加载时即读取配置, 使模块顶层的 `t()` 调用也使用指定语言.
    setLanguage(normalizeLanguage(vscode.workspace?.getConfiguration('autojs6').get<string>('language', 'auto')));
} catch {
    l10n = null;
}

export function normalizeLanguage(value: unknown): Language {
    return LANGUAGES.includes(value as Language) ? value as Language : 'auto';
}

/** Bundle path relative to this module; valid from both `dist/` and `out/`. zh-CN: 相对本模块的 bundle 路径, `dist/` 与 `out/` 下均有效. */
function bundlePath(lang: string): string {
    return path.join(__dirname, '..', 'l10n', `bundle.l10n.${lang}.json`);
}

function loadBundle(lang: Language): Record<string, string> | null {
    if (lang === 'auto' || lang === 'en') {
        return null;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(bundlePath(lang), 'utf8')) as Record<string, unknown>;
        const entries = Object.entries(parsed).filter((entry): entry is [ string, string ] => typeof entry[1] === 'string');
        return Object.fromEntries(entries);
    } catch {
        return null;
    }
}

/**
 * Pin the language (or `auto`); returns whether it changed. Strings computed earlier (module constants, view
 * titles) keep their old language until the window reloads.
 * zh-CN: 指定语言 (或 `auto`); 返回是否发生变化. 之前已计算的字符串 (模块常量, 视图标题) 在窗口重新加载前保持旧语言.
 */
export function setLanguage(lang: Language): boolean {
    const next = normalizeLanguage(lang);
    if (next === language) {
        return false;
    }
    language = next;
    bundle = loadBundle(next);
    return true;
}

export function getLanguage(): Language {
    return language;
}

function format(message: string, args: (string | number | boolean)[]): string {
    return message.replace(/\{(\d+)\}/g, (match, index) => (Number(index) < args.length ? String(args[Number(index)]) : match));
}

/**
 * Translate `message` for the effective language and fill `{0}`, `{1}`, ... with `args`.
 * zh-CN: 按生效语言翻译 `message`, 并用 `args` 填充 `{0}`, `{1}` 等占位符.
 */
export function t(message: string, ...args: (string | number | boolean)[]): string {
    if (language === 'auto') {
        if (l10n) {
            return args.length > 0 ? l10n.t(message, ...args) : l10n.t(message);
        }
        return format(message, args);
    }
    const translated = bundle?.[message];
    return format(translated || message, args);
}

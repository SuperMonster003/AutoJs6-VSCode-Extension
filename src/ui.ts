import * as vscode from 'vscode';
import { Disposable, QuickPickItem, ThemeIcon } from 'vscode';
import * as util from './util';
import { logDebug } from './logger';
import { t } from './i18n';

export const STRING_YES = t('Yes');
export const STRING_NO = t('No');

const closeButton: vscode.QuickInputButton = {
    iconPath: new ThemeIcon('close'),
    tooltip: t('Close'),
};

export interface PickOptions<T extends QuickPickItem> {
    title?: string;
    placeholder?: string;
    items: T[];
    /** Resolve the typed text when Enter is pressed without a matching item. zh-CN: 回车时若无匹配项则返回输入文本. */
    acceptInput?: boolean;
    matchOnDetail?: boolean;
    matchOnDescription?: boolean;
    buttons?: vscode.QuickInputButton[];
    onDidTriggerButton?: (button: vscode.QuickInputButton, input: vscode.QuickPick<T>) => void;
    /** Hook to mutate the QuickPick after creation (e.g. lazy details). zh-CN: 创建后回调 (如延迟加载详情). */
    onCreated?: (input: vscode.QuickPick<T>) => void;
}

/**
 * Single-selection QuickPick. Resolves the picked item, the typed string (`acceptInput`) or `undefined`.
 * zh-CN: 单选 QuickPick, 返回选中项/输入文本/undefined.
 */
export function showPick<T extends QuickPickItem>(options: PickOptions<T>): Promise<T | string | undefined> {
    const disposables: Disposable[] = [];
    return new Promise<T | string | undefined>((resolve) => {
        const input = vscode.window.createQuickPick<T>();
        input.title = options.title;
        input.placeholder = options.placeholder;
        input.items = options.items;
        input.matchOnDetail = options.matchOnDetail ?? false;
        input.matchOnDescription = options.matchOnDescription ?? false;
        input.buttons = [ ...(options.buttons || []), closeButton ];
        let resolved = false;
        const done = (value: T | string | undefined) => {
            if (resolved) return;
            resolved = true;
            resolve(value);
            input.hide();
        };
        disposables.push(
            input.onDidAccept(() => {
                const active = input.activeItems[0];
                const value = input.value.trim();
                if (options.acceptInput && value && (!active || !itemMatchesInput(active, value))) {
                    done(value);
                } else {
                    done(active);
                }
            }),
            input.onDidTriggerButton((button) => {
                if (button === closeButton) {
                    done(undefined);
                } else {
                    options.onDidTriggerButton?.(button, input);
                }
            }),
            input.onDidHide(() => {
                done(undefined);
                input.dispose();
            }),
        );
        options.onCreated?.(input);
        input.show();
    }).finally(() => disposables.forEach(d => d.dispose()));
}

function itemMatchesInput(item: QuickPickItem, value: string): boolean {
    const label = item.label.toLowerCase();
    const v = value.toLowerCase();
    return label === v || label.endsWith(' - ' + v);
}

/**
 * Multi-selection QuickPick. When nothing is checked, the active item is used.
 * zh-CN: 多选 QuickPick, 未勾选任何项时使用光标所在项.
 */
export function showMultiPick<T extends QuickPickItem>(options: PickOptions<T>): Promise<T[] | undefined> {
    const disposables: Disposable[] = [];
    return new Promise<T[] | undefined>((resolve) => {
        const input = vscode.window.createQuickPick<T>();
        input.title = options.title;
        input.placeholder = options.placeholder;
        input.items = options.items;
        input.canSelectMany = true;
        input.buttons = [ closeButton ];
        let resolved = false;
        const done = (value: T[] | undefined) => {
            if (resolved) return;
            resolved = true;
            resolve(value);
            input.hide();
        };
        disposables.push(
            input.onDidAccept(() => {
                const selected = new Set<T>(input.selectedItems);
                if (selected.size === 0 && input.activeItems[0]) {
                    selected.add(input.activeItems[0]);
                }
                done(Array.from(selected));
            }),
            input.onDidTriggerButton((button) => {
                if (button === closeButton) done(undefined);
            }),
            input.onDidHide(() => {
                done(undefined);
                input.dispose();
            }),
        );
        input.show();
    }).finally(() => disposables.forEach(d => d.dispose()));
}

export async function confirm(title: string, detail?: string): Promise<boolean> {
    const picked = await showPick({
        title,
        placeholder: detail || t('Pick "Yes" to continue or press Esc to cancel'),
        items: [ { label: STRING_YES }, { label: STRING_NO } ],
    });
    return typeof picked === 'object' && picked.label === STRING_YES;
}

export async function promptInput(options: vscode.InputBoxOptions): Promise<string | undefined> {
    const value = await vscode.window.showInputBox(options);
    return value === undefined ? undefined : value.trim();
}

export function translateNetworkType(type: string): string {
    switch ((type || '').toLowerCase()) {
        case 'wired':
            return t('Wired');
        case 'wireless':
            return t('Wireless');
        case 'virtual':
            return t('Virtual');
        case 'unknown':
            return t('Unknown');
        case 'other':
            return t('Other');
        default:
            return (type || '').toUpperCase();
    }
}

interface NIItem extends QuickPickItem {
    ni: util.NIDetails;
}

/**
 * Pick a local network interface; details are fetched lazily in the background.
 * zh-CN: 选择本机网络接口, 详细信息在后台补充.
 */
export async function pickNetworkInterface(items: util.NIDetails[], title = t('Active network interfaces')): Promise<util.NIDetails | undefined> {
    const sep = ' | ';
    const toItem = (ni: util.NIDetails): NIItem => {
        let label = ni.iface;
        let detail = ni.ip4 + sep + (ni.mac || '').toLowerCase();
        if (ni.ifaceName) label += sep + ni.ifaceName;
        if (ni.type) detail += sep + translateNetworkType(ni.type);
        if (ni.speed !== undefined && ni.speed !== 'N/A') detail += sep + ni.speed + ' Mbps';
        if (ni.default) detail += sep + t('default interface');
        return { label, detail, ni, description: ni.default ? '$(star-full)' : undefined };
    };
    const picked = await showPick<NIItem>({
        title,
        placeholder: t('Type or pick a network interface [ loading details... ]'),
        items: items.map(toItem),
        matchOnDetail: true,
        onCreated: (input) => {
            input.busy = true;
            util.getDetailedNetworkInterfaces(items).then((detailed) => {
                if (detailed.length > 0) {
                    input.items = detailed.map(toItem);
                }
            }).catch(e => logDebug(e)).finally(() => {
                input.busy = false;
                input.placeholder = t('Type or pick a network interface');
            });
        },
    });
    return typeof picked === 'object' ? picked.ni : undefined;
}

export function showErrorWithAction(message: string, action: string, onAction: () => void) {
    vscode.window.showErrorMessage(message, action).then(choice => choice === action && onAction());
}

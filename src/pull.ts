import * as path from 'path';
import * as vscode from 'vscode';
import { Device, DeviceError } from './device';
import { logDebug } from './logger';
import { PullPlan, RemoteChange, RemoteReader, writeLocalFile } from './pullCore';
import { remoteUri } from './remoteFs';
import { formatSize, formatTimestamp } from './util';
import { t } from './i18n';

/*
 * UI half of "pull project changes from the device" (roadmap 5.7): a multi-select picker with per-file diff
 * preview, and the copy-back progress. The comparison lives in `pullCore.ts`.
 * zh-CN: "从设备拉取项目变更" (roadmap 5.7) 的界面部分: 带逐文件差异预览的多选列表与回写进度. 比较逻辑位于 `pullCore.ts`.
 */

interface ChangeItem extends vscode.QuickPickItem {
    change: RemoteChange;
}

/**
 * Let the person choose which changed files to pull. The row button opens a diff (modified) or the device file
 * (added) without closing the picker.
 * zh-CN: 让用户选择要拉取的文件. 行尾按钮打开差异 (已修改) 或设备端文件 (新增), 不会关闭列表.
 */
export function pickChanges(device: Device, localDir: string, plan: PullPlan): Promise<RemoteChange[] | undefined> {
    const diffButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('diff'), tooltip: t('Preview diff (local vs device)') };
    const openButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('go-to-file'), tooltip: t('Open the device file') };
    const pick = vscode.window.createQuickPick<ChangeItem>();
    pick.title = t('Pull changes of project {0} from {1} ({2} file(s))', path.basename(localDir), device.name, plan.changes.length);
    pick.placeholder = t('Check the files to pull, then press Enter; use the row icon to preview the diff');
    pick.canSelectMany = true;
    pick.matchOnDescription = true;
    pick.ignoreFocusOut = true;
    pick.items = plan.changes.map((change): ChangeItem => ({
        label: `$(${change.kind === 'added' ? 'diff-added' : 'diff-modified'}) ${change.relativePath}`,
        description: change.kind === 'added' ? t('added on device') : t('modified on device'),
        detail: t('{0}, modified on the device at {1}', formatSize(change.size), formatTimestamp(change.mtime)),
        buttons: [ change.kind === 'modified' ? diffButton : openButton ],
        change,
    }));
    pick.selectedItems = pick.items;
    return new Promise<RemoteChange[] | undefined>((resolve) => {
        let settled = false;
        const finish = (value: RemoteChange[] | undefined) => {
            if (settled) return;
            settled = true;
            resolve(value);
            pick.dispose();
        };
        pick.onDidTriggerItemButton(async (e) => {
            const change = e.item.change;
            const remote = remoteUri(device, change.remotePath);
            try {
                if (change.kind === 'modified') {
                    const local = vscode.Uri.file(path.join(localDir, ...change.relativePath.split('/')));
                    await vscode.commands.executeCommand('vscode.diff', local, remote, `${change.relativePath} (${t('local')} ↔ ${device.name})`, { preview: true, preserveFocus: true });
                } else {
                    await vscode.commands.executeCommand('vscode.open', remote, { preview: true, preserveFocus: true });
                }
            } catch (err) {
                logDebug(`failed to preview ${change.relativePath}: ${err}`);
            }
        });
        pick.onDidAccept(() => finish(pick.selectedItems.map(item => item.change)));
        pick.onDidHide(() => finish(undefined));
        pick.show();
    });
}

/** Copy the chosen files from the device into the project with a cancellable progress. zh-CN: 带可取消进度地将所选文件从设备复制到项目. */
export function applyPull(device: Device, localDir: string, changes: RemoteChange[], readRemote: RemoteReader): Promise<number> {
    const title = t('Pulling {0} file(s) from {1}', changes.length, device.name);
    return Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, token) => {
        let done = 0;
        for (const change of changes) {
            if (token.isCancellationRequested) {
                throw new DeviceError(t('Pull cancelled after {0} of {1} file(s)', done, changes.length), device);
            }
            progress.report({ message: change.relativePath, increment: 100 / changes.length });
            const data = await readRemote(change.remotePath);
            await writeLocalFile(localDir, change.relativePath, data);
            done++;
        }
        return done;
    }));
}

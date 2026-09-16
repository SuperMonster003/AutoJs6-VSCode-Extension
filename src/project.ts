import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Uri } from 'vscode';
import { FileFilter } from './diff';
import { logDebug, logError } from './logger';

/**
 * Copies the bundled project template into a target folder without overwriting existing files.
 * zh-CN: 将内置项目模板复制到目标目录, 不覆盖已存在的文件.
 */
export class ProjectTemplate {

    constructor(private readonly templateUri: Uri, private readonly outUri: Uri) {
    }

    build(): Uri {
        ProjectTemplate.copyDirIfNotExists(this.templateUri.fsPath, this.outUri.fsPath);
        return this.outUri;
    }

    static copyDirIfNotExists(from: string, to: string) {
        fs.mkdirSync(to, { recursive: true });
        for (const file of fs.readdirSync(from)) {
            const source = path.join(from, file);
            const target = path.join(to, file);
            if (fs.statSync(source).isDirectory()) {
                ProjectTemplate.copyDirIfNotExists(source, target);
            } else if (!fs.existsSync(target)) {
                fs.copyFileSync(source, target);
            }
        }
    }
}

export class ProjectConfig {
    name = '';
    main = 'main.js';
    versionCode = 1;
    versionName = '1.0.0';
    ignore: string[] = [];

    static fromJsonFile(jsonPath: string): ProjectConfig {
        const text = fs.readFileSync(jsonPath, 'utf8');
        const config = Object.assign(new ProjectConfig(), JSON.parse(text)) as ProjectConfig;
        config.ignore = Array.isArray(config.ignore) ? config.ignore : [];
        return config;
    }
}

/**
 * Resolve the project directory for a folder or a `project.json` path; `null` when invalid.
 * zh-CN: 由目录或 project.json 路径解析项目目录, 无效时返回 null.
 */
export function resolveProjectDir(fsPath: string): { dir: string; error?: string } {
    let dir = fsPath;
    try {
        if (!fs.statSync(dir).isDirectory()) {
            if (path.basename(dir) !== 'project.json') {
                return { dir, error: `项目路径 "${dir}" 需为目录` };
            }
            dir = path.dirname(dir);
        }
    } catch (e) {
        return { dir, error: `项目路径 "${dir}" 不存在` };
    }
    const jsonPath = path.join(dir, 'project.json');
    if (!fs.existsSync(jsonPath)) {
        return { dir, error: `缺少必要的项目配置文件: ${jsonPath}` };
    }
    return { dir };
}

export class Project implements vscode.Disposable {
    config: ProjectConfig;
    readonly projectDir: string;
    private readonly watcher: vscode.FileSystemWatcher;
    private ignoreRealPaths: string[] = [];

    constructor(projectDir: string) {
        this.projectDir = projectDir;
        const jsonPath = path.join(projectDir, 'project.json');
        this.config = ProjectConfig.fromJsonFile(jsonPath);
        this.refreshIgnore();
        this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(projectDir, 'project.json'));
        this.watcher.onDidChange(() => {
            try {
                this.config = ProjectConfig.fromJsonFile(jsonPath);
                this.refreshIgnore();
                logDebug('project.json reloaded:', this.config);
            } catch (e) {
                logError('failed to reload project.json:', e);
            }
        });
    }

    private refreshIgnore() {
        this.ignoreRealPaths = this.config.ignore.map((p) => {
            const full = path.join(this.projectDir, p);
            try {
                return fs.realpathSync(full);
            } catch (e) {
                return path.normalize(full);
            }
        });
    }

    fileFilter: FileFilter = (relativePath: string, absPath: string) => {
        if (this.ignoreRealPaths.length === 0) {
            return true;
        }
        let real = absPath;
        try {
            real = fs.realpathSync(absPath);
        } catch (e) {
            /* Keep the original path. zh-CN: 保留原路径. */
        }
        const candidates = real === absPath ? [ real ] : [ real, path.normalize(absPath) ];
        return !this.ignoreRealPaths.some(ignored => candidates.some(c => c === ignored || c.startsWith(ignored + path.sep)));
    };

    dispose() {
        this.watcher.dispose();
    }
}

export { ProjectObserver, ProjectDiffResult } from './sync';

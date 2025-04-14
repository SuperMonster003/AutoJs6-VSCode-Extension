#!/usr/bin/env node
import { execSync } from 'child_process';
import { existsSync, lstatSync, rmdirSync, unlinkSync, symlinkSync } from 'fs';
import { join } from 'path';

try {
    console.log('全局安装 @sm003/autojs6-dts 模块...');
    // 直接全局安装, npm 会根据版本判断是否需要更新
    execSync('npm install -g @sm003/autojs6-dts', { stdio: 'inherit' });
} catch (err) {
    console.error('全局安装 @sm003/autojs6-dts 失败', err);
    process.exit(1);
}

let globalNodeModules;
try {
    // 获取全局 node_modules 路径
    globalNodeModules = execSync('npm root -g', { encoding: 'utf8' }).trim();
} catch (err) {
    console.error('获取全局安装路径失败, 请检查 npm 配置', err);
    process.exit(1);
}

// 构造目标 declarations 目录的路径 (全局安装路径下模块的 declarations 目录)
const targetDeclarations = join(globalNodeModules, '@sm003', 'autojs6-dts', 'declarations');

// 当前项目下要创建的软链接名称
const linkPath = join(process.cwd(), 'declarations');

// 如果已存在同名链接或目录, 先删除
if (existsSync(linkPath)) {
    console.log('检测到已有 declarations 文件或目录, 正在删除...');
    try {
        const stat = lstatSync(linkPath);
        if (stat.isDirectory()) {
            rmdirSync(linkPath, { recursive: true });
        } else {
            unlinkSync(linkPath);
        }
    } catch (err) {
        console.error('删除已存在的 declarations 失败', err);
        process.exit(1);
    }
}

try {
    // 在 Windows 下使用 "junction" 类型创建软链接, 相当于 "mklink /J"
    symlinkSync(targetDeclarations, linkPath, 'junction');
    console.log(`软链接创建成功: ${linkPath} -> ${targetDeclarations}`);
    console.log("可能需要重新启动 VSCode 或重新打开当前项目以使代码智能补全功能生效")
} catch (err) {
    console.error('创建软链接失败', err);
    process.exit(1);
}
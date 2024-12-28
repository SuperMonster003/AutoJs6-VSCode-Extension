<!--suppress HtmlDeprecatedAttribute -->

<div align="center">
  <p>
    <img src="https://s1.imagehub.cc/images/2023/03/07/8d09e153dd83ad9d523f14c28447a02e.png" alt="autojs6-vscode-ext-banner_1024×310" border="0" width="496" />
  </p>

  <p>AutoJs6 (AutoJs6 调试工具 (VSCode 插件)</p>
  <p>Debugger for AutoJs6 on VSCode</p>

  <p>
    <a href="https://github.com/SuperMonster003/AutoJs6-VSCode-Extension/issues"><img alt="GitHub closed issues" src="https://img.shields.io/github/issues/SuperMonster003/AutoJs6-VSCode-Extension?color=009688"/></a>
    <a href="https://github.com/SuperMonster003/AutoJs6"><img alt="GitHub AutoJs6 repository" src="https://img.shields.io/badge/autojs6->= 6.4.0-67a91b"/></a>
    <a href="https://github.com/topics/javascript"><img alt="GitHub top language" src="https://img.shields.io/github/languages/top/SuperMonster003/AutoJs6-VSCode-Extension?color=eb8031"/></a>
    <br>
    <a href="https://github.com/SuperMonster003/AutoJs6-VSCode-Extension/commit/d43a0119b214a17062501ea8a938b13bd97d2028"><img alt="Created" src="https://img.shields.io/date/1638929280?color=2e7d32&label=created"/></a>
    <a href="https://github.com/SuperMonster003/AutoJs6-VSCode-Extension/find/master"><img alt="GitHub Code Size" src="https://img.shields.io/github/languages/code-size/SuperMonster003/AutoJs6-VSCode-Extension?color=795548"/></a>
    <a href="https://github.com/SuperMonster003/AutoJs6-VSCode-Extension/blob/master/LICENSE"><img alt="GitHub License" src="https://img.shields.io/github/license/SuperMonster003/AutoJs6-VSCode-Extension?color=534BAE"/></a>
  </p>
</div>

******

### AutoJs6 VSCode 开发插件

******

* 支持 [AutoJs6](https://github.com/SuperMonster003/AutoJs6) 脚本调试与运行的 [VSCode](https://code.visualstudio.com/) 插件
* 克隆 (Clone) 自 [hyb1996/Auto.js-VSCode-Extension](https://github.com/hyb1996/Auto.js-VSCode-Extension)

******

### 安装 (Install)

******

- VSCode 菜单 `View / 查看` - `Extensions / 扩展` `[ Ctrl+Shift+X ]`
- 搜索 "AutoJs6" 或 "003"
- 选择 "AutoJs6 VSCode Extension" 插件并安装 (或更新)

******

### 功能 (Features)

******

- 在 VSCode 中连接设备并操作 AutoJs6 的脚本或项目 (运行 / 停止 / 保存 等)
- 在 VSCode 中实时显示 AutoJs6 的日志

******

### 使用 (Usage)

******

0. 基本操作

- `< 命令面板 >`
    - VSCode 菜单 `View / 查看` - `Command Palette / 命令面板` `[ Ctrl+Shift+P ]`
- `< 开发人员工具 >`
    - VSCode 菜单 `Help / 帮助` - `Toggle Developer Tools / 切换开发人员工具`
- `< 菜单按钮 >`
    - VSCode 标题区域按钮, 位于顶部区域, 用于快捷操作文件或项目

1. 连接到计算机

- 打开 `< 命令面板 >` 选择 `AutoJs6: 建立设备连接 (Connect)` `[ Ctrl+Alt+F6 ]`, 或点击相应的菜单按钮
- 使用下述方式之一建立设备连接 (任选其一)
    - `AutoJs6 (客户端) > VSCode (服务端) | 局域网`
        - AutoJs6 侧拉菜单中开启 "客户端模式"
        - 输入 VSCode 弹窗显示的本机 IP 地址
    - `AutoJs6 (服务端) < VSCode (客户端) | 局域网`
        - AutoJs6 侧拉菜单中开启 "服务端模式"
        - VSCode 输入 AutoJs6 所在设备的 IP 地址
    - `AutoJs6 (服务端) < VSCode (客户端) | ADB (USB)`
        - AutoJs6 侧拉菜单中开启 "服务端模式"
        - AutoJs6 所在设备通过 USB 连接到 VSCode 所在计算机
        - AutoJs6 所在设备需启用 USB 调试模式并勾选信任上述计算机
        - 不同设备操作方式可能不同 详见设备厂商手册或相关互联网资料
    - `历史记录 (IP)`
        - 连接成功后的设备 IP 地址会记录在列表中方便选择
        - AutoJs6 需启用 "服务端模式"
        - 设备 IP 地址可能发生改变
        - 使用 "清理" 选项清除所有已保存的记录
- VSCode 弹窗显示 `AutoJs6 设备接入: ${DEVICE} (${IP_ADDRESS})` 完成设备连接

2. 执行命令

- 打开 `< 命令面板 >` 查看并执行支持的命令 (快捷键详见下述 "命令" 板块)
- 如 `AutoJs6: 运行脚本 (Run)` `AutoJs6: 停止所有脚本 (Stop All)` 等
- 部分功能可通过点击相应的菜单按钮实现

3. 查看日志

- 采用下述方式之一查看来自 AutoJs6 的日志 (任选其一)
    - 在建立设备连接后弹出的 `OUTPUT / 输出` 面板 `[ F12 ]` 查看
    - 打开 `< 开发人员工具 >` 在 `Console` 面板查看

4. 断开连接

- 采用下述方式之一断开所有 AutoJs6 与 VSCode 建立的连接 (任选其一)
    - 打开 `< 命令面板 >` 选择 `AutoJs6: 断开所有连接 (Disconnect All)` `[ Ctrl+Alt+Shift+F6 ]`
    - 在 AutoJs6 侧拉菜单关闭对应开关 (客服端 / 服务端)
    - 断开 AutoJs6 的 USB 连接 (仅适用于 ADB (USB) 连接方式)
    - 退出 AutoJs6 应用 / 关闭 VSCode 软件

******

### 命令 (Commands)

******

- 查看在线文档 (View Online Document) `[ Alt+Shift+F6 ]`
    - 查看 AutoJs6 在线开发文档
- 建立设备连接 (Connect) `[ Ctrl+Alt+F6 ]`
    - 建立 AutoJs6 与 VSCode 的连接
    - AutoJs6 相关开关可能需要手动开启
- 断开所有连接 (Disconnect All) `[ Ctrl+Alt+Shift+F6 ]`
    - 断开所有已建立的连接
    - AutoJs6 相关开关状态可能被重置
- 运行脚本 (Run) `[ F6 ]`
    - 运行当前 VSCode 对应的脚本
    - 对所有已连接的设备有效
- 重新运行脚本 (Rerun)
    - 停止当前 VSCode 对应的脚本并重新运行
    - 对所有已连接的设备有效
- 停止当前脚本 (Stop) `[ Ctrl+F6 ]`
    - 停止当前 VSCode 对应的脚本
    - 对所有已连接的设备有效
- 停止所有脚本 (Stop All) `[ Ctrl+Shift+F6 ]`
    - 停止所有正在运行的脚本
    - 对所有已连接的设备有效
- 保存到所有设备 (Save)
    - 保存当前文件到已连接设备的 AutoJs6 工作目录
    - 对所有已连接的设备有效
- 指定设备运行 (Run On Device)
    - 弹出设备菜单并指定运行 VSCode 对应脚本的设备
- 保存到指定设备 (Save To Device)
    - 弹出设备菜单并在指定保存 VSCode 对应脚本的设备
- 新建项目 (New Project) `[ CTRL+ALT+6 N ]`
    - 选择 (或创建后选择) 一个空文件夹用于新建 AutoJs6 项目
    - 新建项目后执行 `npm install` 或 `npm run dts` 可完成声明文件部署
- 运行项目 (Run Project) `[ CTRL+ALT+6 R / Alt+F6 ]`
    - 运行一个 AutoJs6 项目
- 保存项目到设备 (Save Project) `[ CTRL+ALT+6 S ]`
    - 保存一个 AutoJs6 项目

******

### 版本历史 (Release Notes)

******

# v1.0.10

###### 2024/12/28

* `新增` VSCode 编辑器菜单栏增加支持插件基本操作的图标按钮
* `新增` VSCode 资源管理器增加支持插件基本操作的右键菜单项
* `优化` 选择窗口未勾选任何项目时按下回车键将选择光标所在项目
* `优化` 连接选择窗口标题显示可用的 IP 地址信息兼容更多可用的地址
* `优化` 使用服务端局域网连接方式时, 将显示全部可用的网络接口并展示详细信息
* `优化` 新建项目时, 项目配置文件的项目名称及包名后缀自动适配目录名称 (支持拼音转换)

# v1.0.9

###### 2023/11/15

* `修复` 执行 npm install 可能出现 Not Found 的问题 _[`issue #1`](https://github.com/SuperMonster003/AutoJs6-TypeScript-Declarations/issues/1#issuecomment-1758808581)_
* `修复` 新建项目时存在目录时可能出现文件遗漏复制的问题
* `优化` 新建项目后执行 npm install 或 npm run dts 可完成声明文件部署

# v1.0.8

###### 2023/10/31

* `修复` 执行任何命令均无效的问题

# v1.0.7

##### 更多版本历史可参阅

* [CHANGELOG.md](https://github.com/SuperMonster003/AutoJs6-VSCode-Extension/blob/master/assets/docs/CHANGELOG.md)

******

### 相关项目

******

* [AutoJs6](http://autojs6.com) { author: [SuperMonster003](https://github.com/SuperMonster003) }
    - `安卓平台 JavaScript 自动化工具 (二次开发项目)`
* [AutoJs6-TypeScript-Declarations](http://dts-project.autojs6.com) { author: [SuperMonster003](https://github.com/SuperMonster003) }
    - `AutoJs6 声明文件 (代码智能补全)`
* [Auto.js-VSCode-Extension](https://github.com/hyb1996/Auto.js-VSCode-Extension) { author: [hyb1996](https://github.com/hyb1996) }
    - `Auto.js VSCode 开发插件`
* [Auto.js-VSCode-Extension](https://github.com/710850609/Auto.js-VSCode-Extension) { author: [710850609](https://github.com/710850609) }
    - `Auto.js VSCode 开发插件 (二次开发项目)`
* [Auto.js-VSCode-Extension](https://github.com/kkevsekk1/Auto.js-VSCode-Extension) { author: [kkevsekk1](https://github.com/kkevsekk1) }
    - `Auto.js VSCode 开发插件 (二次开发项目)`
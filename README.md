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
- 扫描二维码建立连接, 局域网内自动发现开启服务端模式的设备 (AutoJs6 6.8.0+)
- 配对确认: 未知设备接入前询问, 扫码连接的设备自动信任, 可管理已信任设备
- 浏览, 编辑, 上传, 下载, 删除设备文件及运行设备脚本, 大文件分块传输并显示进度 (AutoJs6 6.8.0+)
- 心跳检测与自动重连, 状态栏设备指示器
- 本地 HTTP 命令桥, 供外部工具触发插件命令

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
    - `服务端模式 (Server) | 局域网 (LAN)`
        - AutoJs6 侧拉菜单中开启 "客户端模式"
        - 输入 VSCode 弹窗显示的本机 IP 地址 (插件监听端口 `6347`, 需在防火墙放行, 可通过 `autojs6.server.port` 修改)
    - `服务端模式 (Server) | 二维码 (QR Code)`
        - VSCode 显示本机连接二维码 (可切换网络接口)
        - AutoJs6 (6.8.0+) 侧拉菜单点击 "客户端模式", 点击地址输入框右侧的扫码按钮扫描二维码后自动连接
    - `客户端模式 (Client) | 局域网 (LAN)`
        - AutoJs6 侧拉菜单中开启 "服务端模式" (监听端口 `7347`)
        - VSCode 输入 AutoJs6 所在设备的 IP 地址或域名, 可附带端口 (如 `192.168.1.5:7347`, `[fe80::1]:7347`)
        - 意外断开后插件将自动重连 (指数退避, 默认持续 5 分钟, 可通过 `autojs6.connection.autoReconnect` 关闭), VSCode 重启后自动恢复上次连接 (`autojs6.connection.restoreOnStartup`)
        - 任一方显式断开 (VSCode 命令或 AutoJs6 侧拉菜单 / 管理器) 后不再自动重连
    - `客户端模式 (Client) | 安卓调试桥 (ADB)`
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
    - 在建立设备连接后弹出的 `OUTPUT / 输出` 面板 `[ F12 ]` 查看 (每台设备一个面板)
    - 点击状态栏的 `AutoJs6: N` 指示器选择设备后选择 "显示日志"
- 设备断开后面板默认保留并标记断开, 可通过 `autojs6.log.disposeChannelOnDisconnect` 设置为自动移除
- 插件自身的调试日志可通过 `autojs6.log.debug` 开启, 位于 `AutoJs6 VSCode Extension Debug` 面板

4. 管理设备文件 (AutoJs6 6.8.0+)

- 点击活动栏的 `AutoJs6` 图标, 在 "设备文件 (Device Files)" 视图中浏览已连接设备的工作目录与外部存储
- 单击文件即可在编辑器中打开, 修改后使用 VSCode 的保存功能直接写回设备
- 右键或使用行内按钮可运行脚本, 新建文件夹/文件, 上传当前文件或本地文件, 下载, 重命名, 删除
- `AutoJs6: 浏览设备文件 (Browse Device Files)` 可将设备目录作为工作区文件夹加入资源管理器

5. 断开连接

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
- 显示连接二维码 (Show QR Code) `[ CTRL+ALT+6 Q ]`
    - 显示供 AutoJs6 客户端模式扫描的连接二维码
- 断开所有连接 (Disconnect All) `[ Ctrl+Alt+Shift+F6 ]`
    - 断开所有已建立的连接
    - AutoJs6 相关开关状态可能被重置
- 断开指定设备 (Disconnect Device)
    - 选择需要断开的设备
- 重新连接上次的设备 (Reconnect)
    - 立即重试正在重连的目标, 或恢复上次成功连接的设备 (局域网 / ADB)
- 停止自动重连 (Cancel Reconnect)
    - 停止所有进行中的自动重连会话
- 管理已信任设备 (Manage Trusted Devices)
    - 查看并移除已信任的 AutoJs6 设备 (移除后该设备下次接入时需重新确认)
- 选择设备 (Select Device)
    - 列出已连接设备并选择操作 (显示日志 / 运行 / 保存 / 浏览文件 / 断开), 也可点击状态栏指示器
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
    - 新建项目后执行 `npm run dts-link` 或 `npm run dts` 可完成声明文件部署
- 运行项目 (Run Project) `[ CTRL+ALT+6 R / Alt+F6 ]`
    - 运行一个 AutoJs6 项目
- 保存项目到设备 (Save Project) `[ CTRL+ALT+6 S ]`
    - 保存一个 AutoJs6 项目 (增量同步, 需 AutoJs6 6.8.0+ 才会同步删除设备上已删除的文件)
- 重新完整同步项目 (Resync Project)
    - 向设备发送项目全部文件并覆盖同名文件
- 浏览设备文件 (Browse Device Files)
    - 将设备目录作为工作区文件夹加入资源管理器 (AutoJs6 6.8.0+)

******

### 配置 (Settings)

******

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `autojs6.server.port` | `6347` | 插件监听端口 (AutoJs6 客户端模式连接目标) |
| `autojs6.server.confirmUnknownDevices` | `true` | 未知设备 (客户端模式) 接入前先询问; 扫码连接或已选择 "允许并记住" 的设备无需确认 |
| `autojs6.client.port` | `7347` | AutoJs6 服务端模式默认端口 |
| `autojs6.http.enabled` / `autojs6.http.host` / `autojs6.http.port` | `true` / `127.0.0.1` / `10347` | 本地 HTTP 命令桥, 如 `http://127.0.0.1:10347/exec?cmd=run&path=...` |
| `autojs6.adb.path` | 空 | adb 可执行文件路径或目录, 留空时自动探测 |
| `autojs6.discovery.enabled` | `true` | 建立局域网连接时通过 mDNS (`_autojs6._tcp`) 搜索开启了服务端模式的 AutoJs6 6.8.0+ 设备 |
| `autojs6.connection.connectTimeout` / `handshakeTimeout` | `8000` / `6000` | 连接与握手超时 (毫秒) |
| `autojs6.connection.heartbeatInterval` / `heartbeatTimeout` | `15000` / `10000` | 心跳间隔与超时 (毫秒), 间隔为 0 时禁用 |
| `autojs6.connection.autoReconnect` / `maxReconnectAttempts` | `true` / `0` | 插件主动连接意外断开后自动重连, 次数为 0 时不限 |
| `autojs6.connection.reconnectTimeout` / `reconnectMaxDelay` | `300` / `10000` | 单次重连会话的时间窗 (秒, 0 不限) 与最大退避间隔 (毫秒) |
| `autojs6.connection.restoreOnStartup` | `true` | VSCode 启动时恢复上次成功连接的设备 (显式断开的除外) |
| `autojs6.log.showChannelOnConnect` | `true` | 设备接入时自动显示日志面板 |
| `autojs6.log.disposeChannelOnDisconnect` | `false` | 设备断开时移除日志面板 |
| `autojs6.log.debug` | `false` | 记录插件调试日志 |
| `autojs6.save.keepRelativePath` | `true` | 保存文件时保留相对工作区的目录结构 (AutoJs6 6.8.0+) |

通信协议详见 [protocol.md](https://github.com/SuperMonster003/AutoJs6-VSCode-Extension/blob/master/protocol.md).

******

### 版本历史 (Release Notes)

******

# v1.1.0

###### 2026/09/16

* `新增` 活动栏 "AutoJs6" 视图: "设备 (Devices)" 列表与 "设备文件 (Device Files)" 树, 支持浏览/打开/编辑/上传/下载/重命名/删除设备文件及运行设备脚本 (需 AutoJs6 6.8.0+)
* `新增` 远程文件系统 `autojs6fs://`, 设备文件可直接在编辑器中打开并保存回设备; "浏览设备文件" 命令可将设备目录加入工作区
* `新增` 二维码连接: "服务端模式 | 二维码" 显示本机连接二维码, AutoJs6 6.8.0+ 客户端模式扫码后自动连接 _[`issue #12`](http://vscext-project.autojs6.com/issues/12)_
* `新增` 通信协议 v2: 应用层心跳 (ping/pong) 检测半死连接, 插件主动连接 (局域网/ADB) 意外断开后自动重连 _[`issue #3`](http://vscext-project.autojs6.com/issues/3)_ _[`issue #13`](http://vscext-project.autojs6.com/issues/13)_
* `新增` 自动重连会话: 意外断开后按指数退避持续重连 (默认 5 分钟, 可配置次数 / 时间窗 / 最大间隔), VSCode 重启后自动恢复上次连接 (`autojs6.connection.restoreOnStartup`); 新增 "重新连接上次的设备 (Reconnect)" 与 "停止自动重连 (Cancel Reconnect)" 命令, 状态栏显示重连进度
* `新增` 断开通告 `bye`: 任一方显式断开连接时告知对端, 对端不再自动重连也不再于启动时恢复; VSCode 关闭时发送 `bye(shutdown)` 以便 AutoJs6 (6.8.0+) 稍后自动重连
* `新增` 配对确认: 未知设备以客户端模式接入时先询问 "允许并记住 / 仅本次允许 / 拒绝", 扫描二维码连接的设备凭一次性令牌自动信任; 新增 "管理已信任设备 (Manage Trusted Devices)" 命令与 `autojs6.server.confirmUnknownDevices` 配置 (AutoJs6 6.8.0+ 会显示 "等待 VSCode 端确认" 提示)
* `新增` 局域网发现 (mDNS): "客户端模式 | 局域网" 连接列表自动列出局域网内开启了服务端模式及 "局域网发现" 的 AutoJs6 6.8.0+ 设备, 可通过 `autojs6.discovery.enabled` 关闭
* `新增` 大文件分块传输: 设备文件读写超过 1 MiB 时按 1 MiB 分块传输并显示可取消的进度 (AutoJs6 6.8.0+)
* `新增` 状态栏设备指示器 (点击可快速选择设备执行运行/保存/查看日志/断开等操作)
* `新增` 配置项 (`autojs6.*`): 监听端口, HTTP 命令服务地址与端口, adb 路径, 连接/握手/心跳超时, 自动重连, 日志面板行为, 保存时保留相对路径等
* `新增` 连接地址支持域名与自定义端口 (`host:port`, `[ipv6]:port`) _[`issue #20`](http://vscext-project.autojs6.com/issues/20)_
* `新增` "重新完整同步项目 (Resync Project)" 命令, 强制全量覆盖设备上的项目 _[`issue #29`](http://vscext-project.autojs6.com/issues/29)_
* `修复` 端口 6347/10347 被占用 (如同时打开多个 VSCode 窗口) 时插件激活失败, 导致所有命令 "not found" 的问题 _[`issue #14`](http://vscext-project.autojs6.com/issues/14)_ _[`issue #15`](http://vscext-project.autojs6.com/issues/15)_
* `修复` Linux / macOS 下 `adb devices` 结果按 Windows 换行符解析导致无法识别设备的问题; 增加 adb 路径自动探测 (`ANDROID_HOME`, `ANDROID_SDK_ROOT`, 常见安装目录) 与 `autojs6.adb.path` 配置 _[`issue #35`](http://vscext-project.autojs6.com/issues/35)_
* `修复` 项目增量同步 `override` 标志取反以及 Windows 下 `deletedFiles` 含反斜杠导致设备端文件无法删除的问题 (需配合 AutoJs6 6.8.0+) _[`issue #29`](http://vscext-project.autojs6.com/issues/29)_
* `修复` 焦点位于输出面板时 "停止当前脚本" 与 "保存" 命令取到错误编辑器的问题
* `修复` 握手超时或断开后访问已销毁连接抛出异常的问题
* `修复` 设备断开后输出面板未处理的问题: 默认保留日志并标记断开, 可通过 `autojs6.log.disposeChannelOnDisconnect` 自动移除 _[`issue #30`](http://vscext-project.autojs6.com/issues/30)_
* `修复` ADB 连接断开后未移除端口转发的问题
* `修复` 意外断开后偶发 "无法重新连接 ..., 已停止重试" 误报的问题 (原固定 5 次约 31 s 后即放弃); 失败提示改为在重连窗口结束后仅出现一次并提供 "重试" / "不再自动恢复"
* `优化` 保存/运行文件时携带相对工作区路径, AutoJs6 6.8.0+ 按目录结构保存到工作目录 _[`issue #37`](http://vscext-project.autojs6.com/issues/37)_
* `优化` HTTP 命令服务默认仅监听 `127.0.0.1` (原为 `0.0.0.0`), 避免局域网内其他主机触发本机命令
* `优化` 网络接口列表过滤 Hyper-V / VirtualBox / Docker / WSL 等虚拟网卡并优先展示默认网关接口 _[`issue #12`](http://vscext-project.autojs6.com/issues/12)_
* `优化` 连接二维码降低模块密度 (更短载荷, 低纠错等级) 并提供尺寸滑块, 便于 AutoJs6 扫码对焦
* `优化` 项目同步遍历时直接跳过 `ignore` 目录 (如 `node_modules`), 移除整包字节调试输出
* `优化` 代码结构拆分为协议/设备/界面/远程文件/二维码等模块, 增加纯 Node.js 单元测试 (`npm test`)
* `优化` 使用 esbuild 打包, vsix 体积由 9.6 MB 缩减至约 1 MB; 以 `tiny-pinyin` 与系统路由表探测替代 `pinyin` / `systeminformation` 依赖
* `优化` README 补充端口说明与协议文档 `protocol.md` _[`issue #10`](http://vscext-project.autojs6.com/issues/10)_

# v1.0.13

###### 2026/03/14

* `优化` 重构设备端 Socket 分帧协议: 使用固定 8 字节二进制帧头 (int32BE 长度 + 类型) 替代旧的文本式头部写入方式
* `优化` TCP 流解析逻辑使用基于累积缓冲区的循环拆帧模型, 提升对半包与粘包场景的处理可靠性
* `优化` 增加帧合法性校验 (类型检查与最大帧长度限制), 用于尽早发现协议失步并防止异常内存膨胀
* `优化` 发送 JSON 及二进制数据时移除不必要的字符串中转流程

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
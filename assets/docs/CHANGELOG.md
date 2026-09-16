******

### Changelog

******

# v1.1.0

###### 2026/09/16

* `新增` 活动栏 "AutoJs6" 视图: "设备 (Devices)" 列表与 "设备文件 (Device Files)" 树, 支持浏览/打开/编辑/上传/下载/重命名/删除设备文件及运行设备脚本 (需 AutoJs6 6.8.0+)
* `新增` 远程文件系统 `autojs6fs://`, 设备文件可直接在编辑器中打开并保存回设备; "浏览设备文件" 命令可将设备目录加入工作区
* `新增` 二维码连接: "服务端模式 | 二维码" 显示本机连接二维码, AutoJs6 6.8.0+ 客户端模式扫码后自动连接 _[`issue #12`](http://vscext-project.autojs6.com/issues/12)_
* `新增` 通信协议 v2: 应用层心跳 (ping/pong) 检测半死连接, 插件主动连接 (局域网/ADB) 意外断开后自动重连 _[`issue #3`](http://vscext-project.autojs6.com/issues/3)_ _[`issue #13`](http://vscext-project.autojs6.com/issues/13)_
* `新增` 自动重连会话: 意外断开后按指数退避持续重连 (默认 5 分钟, 可配置次数 / 时间窗 / 最大间隔), VSCode 重启后自动恢复上次连接 (`autojs6.connection.restoreOnStartup`); 新增 "重新连接上次的设备 (Reconnect)" 与 "停止自动重连 (Cancel Reconnect)" 命令, 状态栏显示重连进度
* `新增` 断开通告 `bye`: 任一方显式断开连接时告知对端, 对端不再自动重连也不再于启动时恢复; VSCode 关闭时发送 `bye(shutdown)` 以便 AutoJs6 (6.8.0+) 稍后自动重连
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
* `优化` README 补充端口说明与协议文档 `protocol.md` _[`issue #10`](http://vscext-project.autojs6.com/issues/10)_

# v1.0.13

###### 2026/03/14

* `优化` 重构设备端 Socket 分帧协议: 使用固定 8 字节二进制帧头 (int32BE 长度 + 类型) 替代旧的文本式头部写入方式
* `优化` TCP 流解析逻辑使用基于累积缓冲区的循环拆帧模型, 提升对半包与粘包场景的处理可靠性
* `优化` 增加帧合法性校验 (类型检查与最大帧长度限制), 用于尽早发现协议失步并防止异常内存膨胀
* `优化` 发送 JSON 及二进制数据时移除不必要的字符串中转流程

# v1.0.12

###### 2025/04/14

* `修复` 服务端模式因版本判断失误导致无法连接的问题 _[`issue #27`](http://vscext-project.autojs6.com/issues/27)_
* `优化` 新建项目支持使用 `dts-link` 脚本任务自动创建 [AutoJs6 声明文件](http://dts-project.autojs6.com/) 软链接 _[`issue #8`](http://vscext-project.autojs6.com/issues/8)_

# v1.0.11

###### 2025/04/14

* `修复` VSCode 编辑器菜单栏运行项目及保存项目按钮功能失效的问题 (Ref to [terwer](https://github.com/terwer)) _[`pr #25`](https://github.com/SuperMonster003/AutoJs6-VSCode-Extension/pull/25)_ _[`issue #26`](http://vscext-project.autojs6.com/issues/26)_ _[`issue #24`](http://vscext-project.autojs6.com/issues/24)_ _[`issue #23`](http://vscext-project.autojs6.com/issues/23)_

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

###### 2023/10/30

* `修复` 输入 AutoJs6 服务端地址有效且部分匹配历史记录时无法按输入值建立连接的问题
* `优化` 增加 AutoJs6 项目实例的必要文件检测及提示
* `优化` 未命名文件保存到设备时自动识别文件类型并添加扩展名

# v1.0.6

###### 2023/07/21

* `修复` 服务端发送消息长度超过四位十进制数时长度数据被截断的问题 _[`issue #7`](http://vscext-project.autojs6.com/issues/7)_ _[`issue #9`](http://vscext-project.autojs6.com/issues/9)_

# v1.0.5

###### 2023/07/06

* `新增` 支持通过 HTTP 协议携带参数执行插件命令 _[`issue #6`](http://vscext-project.autojs6.com/issues/6)_
* `新增` 已建立连接的历史客户端支持显示最近连接时间
* `修复` 无法保存文件到设备以及无法运行或保存项目的问题 _[`issue #5`](http://vscext-project.autojs6.com/issues/5)_
* `优化` 插件命令选择窗口增加详细说明便于用户了解并选择合适的连接方式
* `优化` 实现 VSCode 插件与 AutoJs6 的双向版本检测并提示异常检测结果
* `优化` 支持同一设备使用同一方式重复连接的行为检测及提示
* `优化` 清除连接设备历史记录时增加确认操作提示

# v1.0.4

###### 2022/02/05

* `修复` 当 AutoJs6 单次生成日志长度较大时无法正常拼接的问题  _[`issue #4`](http://vscext-project.autojs6.com/issues/4)_
* `修复` 新设备建立连接后焦点自动转移至输出面板 (OUTPUT) 的问题

# v1.0.3

###### 2022/01/05

* `修复` VSCode 焦点位于输出面板 (OUTPUT) 时无法运行脚本的问题

# v1.0.2

###### 2022/01/02

* `修复` VSCode 无设备连接历史时无法建立连接的问题

# v1.0.1

###### 2022/01/01

* `新增` 支持客户端 (LAN) 及服务端 (LAN/ADB) 连接方式 (Ref to [Auto.js Pro](http://www.autojs.cc/))

# v1.0.0

###### 2021/12/07

* `优化` 在 VSCode 的 OUTPUT (输出) 面板显示实时日志 (Ref to [710850609](https://github.com/710850609))
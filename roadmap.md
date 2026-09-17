# AutoJs6 VSCode Extension - Roadmap

> 目标: 将插件从 "能用" 提升为 "稳定, 完整, 可扩展" 的 AutoJs6 开发工具.
> 每一项均可独立 check 并落地. 涉及宿主 (AutoJs6 应用, `D:\idea-projects\AutoJs6`) 的条目以 `[宿主]` 标注, 两端需配套修改的以 `[双端]` 标注.
>
> 状态图例: `[x]` 已完成 / `[-]` 进行中 / `[ ]` 待办

---

## 0. 现状评估 (2026/09/16)

| 维度 | 现状 | 问题 |
|---|---|---|
| 代码结构 | `extension.ts` 约 1500 行, UI/网络/命令/存储耦合在单个类中 | 难维护, 5 个近乎相同的 QuickPick 函数, 死代码 (commandsHierarchy) |
| 协议 | 8 字节帧头 (int32BE len + type), JSON `{type, data}` | 无心跳, 无请求/响应语义, 无协议版本号, 宿主无帧长上限 |
| 连接 | 客户端 LAN (6347) / 服务端 LAN (7347) / ADB 转发 | 无超时, 无重连, 半死连接无法检测, 端口冲突导致插件激活失败 |
| 项目同步 | zip 增量 + md5 | `full` 标志取反, Windows 反斜杠路径, 宿主忽略 `deletedFiles`/`override`, 缓存目录从不清理 (issue #29) |
| 远程文件 | 无 | 无法浏览/编辑/删除设备文件 |
| 二维码 | 菜单占位, 未实现 | - |
| 日志 | 每设备一个 OutputChannel | 断开后不清理 (issue #30); 宿主单线程写日志可被半死连接阻塞 (issue #13, AutoJs6 #385) |
| 国际化 | 仅 `close` 一个词条 | 全部中文硬编码 |
| 配置 | 无任何 `contributes.configuration` | 端口/ADB 路径/行为不可配置 |
| 测试 | 无 | - |

---

## 1. 重构 (Refactor)

- [x] 1.1 拆分 `extension.ts`: `protocol.ts` (帧编解码), `device.ts` (连接与设备管理), `commands.ts` (命令实现), `ui.ts` (QuickPick 等), `settings.ts` (配置), `logger.ts` (调试与设备日志), `remoteFs.ts` (远程文件), `qrcode.ts` (二维码)
- [x] 1.2 统一 QuickPick 实现, 移除 5 份重复代码
- [x] 1.3 移除未实现的 `commandsHierarchy` 死代码及其快捷键 (F8)
- [x] 1.4 `activate`/`deactivate` 规范化: 所有 Server/Socket/Timer/Channel 纳入 `context.subscriptions`, 退出时释放
- [x] 1.5 `ProjectTemplate` 复制逻辑改为同步实现, 去除伪 generator 写法
- [x] 1.6 `FileObserver.walk` 在遍历阶段即跳过 ignore 目录 (避免遍历 node_modules), 移除整包字节 dump 日志
- [x] 1.7 增加 `npm test` (Node 内置 test runner) 覆盖帧解析/路径工具/QR payload 等纯逻辑
- [x] 1.8 `tsconfig` 开启 `strict` 子集 (`noImplicitThis`, `strictBindCallApply`) 并修复类型问题
- [x] 1.9 全量国际化 (zh-CN / en), 所有用户可见字符串走 `i18n` (2026-09-17: 源字符串改为英文并经 `vscode.l10n` 翻译, `l10n/bundle.l10n.zh-cn.json` 206 条与源码 `t()` 调用一一对应; `package.nls.json` / `package.nls.zh-cn.json` 覆盖命令标题, 视图, 欢迎页与配置说明; 无 `vscode` 时 `t()` 回退为英文源串; 2026-09-17 补充: `autojs6.language` 配置 (`auto` / `en` / `zh-cn`) 可显式指定插件语言, 非 `auto` 时 `i18n.ts` 自行读取 `l10n/bundle.l10n.<lang>.json` 并绕过 `vscode.l10n`, 修改后提示重新加载窗口; 清单字符串仍由 VSCode 按显示语言解析)
- [x] 1.10 使用 `esbuild` 打包以缩减 vsix 体积 (9.6 MB → 0.96 MB; `tiny-pinyin` 与系统路由表探测替代 `pinyin` / `systeminformation`)

## 2. Bug 修复 (Fix)

- [x] 2.1 多窗口: 6347/10347 端口被占用时 `net.Server` 抛出未处理 `error` → 插件激活失败 → "command 'extension.connect' not found" (issue #14, #15). 改为捕获并提示, 允许配置端口
- [x] 2.2 非 Windows 平台 `adb devices -l` 按 `\r\n` 拆行导致只识别第一台设备/识别失败 (issue #35); 增加 `autojs6.adb.path` 配置, 自动探测 `ANDROID_HOME`/`ANDROID_SDK_ROOT`/常见目录
- [x] 2.3 项目同步 `full/override` 语义取反; `deletedFiles` 在 Windows 下含反斜杠 (issue #29)
- [x] 2.4 `stop`/`save` 在焦点位于输出面板时取到错误的 editor (与 1.0.3 修复的 run 相同问题)
- [x] 2.5 握手超时回调在连接已关闭后访问 `null` 抛异常
- [x] 2.6 断开连接后 `sendJson` 写入已销毁 socket 抛异常; `detachDevice` 对不在列表中的设备执行 `splice(-1, 1)`
- [x] 2.7 设备断开后 OutputChannel 处理 (issue #30): 默认保留日志但标记断开; 提供 `autojs6.log.disposeChannelOnDisconnect` 开关
- [x] 2.8 HTTP 命令服务默认仅监听 `127.0.0.1` (原为 `0.0.0.0`, 局域网任意主机可触发运行本机脚本), 提供 `autojs6.http.host` 配置
- [x] 2.9 ADB 转发在断开时执行 `adb forward --remove`
- [x] 2.10 `run` 从资源管理器传入 `Uri` 时直接使用 `fsPath`, 不再经过 `Uri.parse(url.path)`
- [x] 2.11 `[宿主]` `JsonSocket.onMessage(ByteString)` 对整个 zip 执行 `Arrays.toString` 打日志, 大项目触发 OOM (AutoJs6 #523/#198 相关)
- [x] 2.12 `[宿主]` 增加帧长上限校验 (64 MB), 避免失步时超大内存分配
- [x] 2.13 `[宿主]` `save_project` 尊重 `override` (清空缓存目录) 与 `deletedFiles` (缓存与目标目录同步删除) (issue #29)
- [x] 2.14 `[宿主]` 日志写入改为每连接独立串行队列, 单个半死连接不再阻塞全局日志 (issue #13, AutoJs6 #385)
- [x] 2.15 `[宿主]` 语言切换后日志停止推送的复现与修复 (AutoJs6 #385 维护者提到的复现路径): 真机 (QV770340J7) 切换语言 / 暗色模式 / 旋转屏幕各数次, 日志持续输出且无断开; 握手失败对话框改为 Activity 已销毁时以 toast 展示

## 3. 连接稳定性 (Stability)

- [x] 3.1 `[双端]` 协议版本协商: 宿主 `hello` 携带 `protocol_version`, 插件 `hello` 携带 `protocolVersion`/`features`, 新特性按版本门控, 老版本互相兼容
- [x] 3.2 `[双端]` 应用层心跳 `ping`/`pong`: 插件默认 15 s 一次, 超时 10 s 判定断开; 宿主同样对每个连接心跳, 及时释放半死连接
- [x] 3.3 插件作为客户端 (服务端 LAN / ADB) 时支持自动重连 (指数退避, 最多 N 次, 可配置 `autojs6.connection.autoReconnect`)
- [x] 3.4 TCP 连接超时 (默认 8 s) 与 `keepAlive`
- [x] 3.5 连接地址支持域名与自定义端口 (issue #20)
- [x] 3.6 状态栏显示已连接设备数, 点击快速选择/断开设备
- [x] 3.7 网络接口过滤扩展 (Hyper-V `vEthernet`, VirtualBox, Docker, WSL 等) 并优先展示默认网关接口 (issue #12)
- [x] 3.8 `[宿主]` Socket `keepAlive` / `tcpNoDelay`
- [x] 3.9 `[宿主]` 客户端模式断线后自动重连 (`DevPluginClientReconnector`: 退避 2/4/8/16/30 s, 网络恢复时立即重试, 启动时恢复; 显式断开或 `bye(user)` 后不重连) 及客户端 / 服务端模式 "管理器" 对话框 (AutoJs6 #3, #333, #523)
- [x] 3.10 mDNS/局域网自动发现设备 (`_autojs6._tcp`: 宿主 NSD 广播 (服务端管理器可开关), 插件 `bonjour-service` 逐接口浏览并列入局域网连接列表)

## 4. 二维码连接 (QR Code)

- [x] 4.1 插件: `建立设备连接` 新增 "服务端模式 | 二维码" 入口, Webview 展示二维码 (payload: `autojs6://connect?host=<ip>&port=<port>&name=<pc>`), 可切换网络接口, 显示可复制的文本
- [x] 4.2 `[宿主]` 客户端模式地址输入框增加扫码按钮, 调用摄像头扫描 (zxing-android-embedded), 解析 payload 后自动填入并连接; 同时兼容直接扫描 `host[:port]` 纯文本
- [x] 4.3 `[宿主]` 扫码 Activity 处理摄像头运行时权限与横竖屏
- [x] 4.4 插件: 二维码携带一次性 token, 宿主握手回传, 插件校验后才接受连接 (防止误连); 另含未知设备确认提示 (`pending` hello), 已信任设备列表与管理命令

## 5. 远程文件管理 (Remote Files)

- [x] 5.1 `[双端]` 请求/响应协议: `{type:'request', id, data:{method, params}}` ↔ `{type:'response', id, data:{ok, result|error}}`
- [x] 5.2 `[宿主]` 文件方法: `fs.roots` `fs.list` `fs.stat` `fs.read` `fs.write` `fs.mkdir` `fs.delete` `fs.rename` `script.run` `sys.info`, 路径限制在外部存储目录内
- [x] 5.3 插件: 活动栏 "AutoJs6" 视图容器, "设备 (Devices)" 树 + "设备文件 (Device Files)" 树 (刷新/新建文件夹/重命名/删除/上传当前文件/运行)
- [x] 5.4 插件: `FileSystemProvider` (`autojs6fs://<deviceId>/<path>`) 使远程文件可直接在编辑器中打开, 修改并保存回设备
- [x] 5.5 `[双端]` `save` 保留相对目录 (issue #37): 插件发送相对工作区的 `path`, 宿主按目录保存 (老宿主回退为文件名)
- [x] 5.6 插件: `重新完整同步项目 (Resync Project)` 命令, 强制全量覆盖
- [x] 5.7 双向同步: 设备端修改 → 拉回本地 (diff 预览) ("从设备拉取项目变更" 命令: `fs.list { hash }` md5 比较, 多选列表 + 行内差异预览, 仅本地存在的文件只提示不删除)
- [x] 5.8 大文件分块传输与进度 (`withProgress`; `fs.read` offset/length + `fs.write` append, 1 MiB 分块, 能力 `fs.chunked`)

## 6. Issue 跟踪

### AutoJs6-VSCode-Extension

| # | 标题 | 状态 | 处理 |
|---|---|---|---|
| 37 | 保存文件时自动创建相关路径 | 已处理 | 5.5 |
| 36 | 适配 CodeBuddy IDE | 待办 | 需验证 VSCode API 兼容性 (`engines.vscode` 已放宽); 待反馈 |
| 35 | adb 连接问题 (Linux/Mac) | 已处理 | 2.2 |
| 32 | 怎么保存到设备 | 已回复 | 文档: README 增加保存说明 |
| 30 | 设备断开 VSCode 不会清理 | 已处理 | 2.7 |
| 29 | 代码同步有缓存 | 已处理 | 2.3 + 2.13 + 5.6 |
| 27 | 1.0.11 后不能连接客户端 | 已修复 (1.0.12) | 关闭 |
| 26 | module 相对引用 / 运行项目报错 | 部分处理 | 运行项目按钮已修 (1.0.11); 单文件 `require('./x')` 需 "运行项目" 或 5.x 远程目录运行; README 说明 |
| 21 | 怎么打开 debug 调试 | 已回复 | 断点调试不在计划内 |
| 20 | 连接方式支持域名 | 已处理 | 3.5 |
| 17 | 快捷操作和右键菜单 | 已完成 (1.0.10) | 关闭 |
| 15 / 14 | 执行命令报 not found | 已处理 | 2.1 (根因: 端口占用导致激活失败) |
| 13 | 跑着跑着没日志 | 已处理 | 2.14 + 3.2 |
| 12 | VMware 虚拟网卡 IP / 描述难懂 | 已处理 | 3.7; 描述在 1.0.10 已调整 |
| 11 | text(xxx).click() 没反应 | 无关 | 属宿主脚本问题, 建议转移 |
| 10 | 文档写明 6347 端口 | 已处理 | README 增加端口说明 |
| 9 / 7 | Unknown data type (0) | 已修复 (1.0.6) | 关闭 |
| 5 | 运行项目没反应 | 已修复 (1.0.5) | 关闭 |
| 4 | 超长日志 | 已修复 (1.0.4) | 关闭 |
| 3 | 连接一段时间后自动断开 | 已处理 | 3.2 + 3.3 + 3.9 (真机验证通过) |
| 2 | Cannot read property 'map' | 已修复 (1.0.2) | 关闭 |

### AutoJs6 (与 VSCode 相关)

| # | 标题 | 状态 | 处理 |
|---|---|---|---|
| 552 | 6.7.0 没有服务端模式开关 | 无法复现 | 评论者确认 6.7.0 存在开关; 待反馈 |
| 523 | 远程开发插件经常断开 (OOM) | 已处理 | 2.11 + 2.14 + 3.2 |
| 482 | 保持服务端模式常开 | 已回复 | 维护者已给出协议示例; 本次协议文档化 (`protocol.md`) |
| 440 | 客户端模式连不上 | 已回复 | 需同一局域网; 3.7 / 4.x 降低配置难度 |
| 410 | 9317 端口 | 已回复 | 端口为 6347; README 说明 |
| 385 | 服务端模式 VSCode 无日志 | 已处理 | 2.14 + 3.2 + 2.15 (真机验证通过) |
| 333 | 雷电模拟器概率断开 | 已处理 | 3.2 + 3.3 |
| 208 | 客户端模式连接成功但保存提示无设备 | 已处理 | 2.4 / 2.6 (设备列表与连接状态一致性) |
| 116 | 脱离 VSCode 启动服务 | 已回复 | `protocol.md` 提供协议, 可自行实现客户端 |
| 3 | 连接自动断开 | 已处理 | 同上 |

## 7. 发布 (Release)

- [x] 7.1 插件版本升至 `1.1.0`, `requiredClientVersionName` 保持 `6.7.0` (新特性按协议版本门控)
- [x] 7.2 `[宿主]` `.changelog/*.json` 补充 v6.8.0 条目并生成 README
- [x] 7.3 `CHANGELOG.md` / `README.md` 更新 (端口说明, 新命令, 配置项)
- [x] 7.4 `protocol.md` 完整协议文档 (v1 + v2)
- [x] 7.5 `vsce package` 生成 vsix 并真机验证 (客户端 LAN / 服务端 LAN / ADB / 二维码 / 远程文件): 2026-09-16 用户确认二维码连接与远程文件读写正常; 其余项见下文 "真机验证记录"
- [ ] 7.6 发布到 VSCode Marketplace

## 8. 测试方法 (Test Methods)

自动化: 插件仓库 `npm test` (纯 Node.js, 无需 VSCode / 设备) 覆盖帧编解码, 路径工具, QR payload, 项目同步 (全量 / 增量 / 删除 / `reset`) 以及针对进程内 AutoJs6 假服务端的心跳超时, 自动重连, `bye` 握手, v1 兼容 (`src/test/*.test.ts`).

真机 (以 QV770340J7 为例):

- 心跳断线重连 (3.2 / 3.3)
    - 服务端 LAN: VSCode 连接手机 `7347`; 手机关闭 Wi-Fi (或在 PC 防火墙阻断 7347). 约 `heartbeatInterval + heartbeatTimeout` (默认 25 s) 内右下角提示 "已断开 (heartbeat timed out), 将自动重连", 状态栏显示 "重连中 (n)"; 恢复 Wi-Fi 后自动重连并提示 "已连接"
    - ADB: `adb shell am force-stop org.autojs.autojs6` → 提示断开并进入重连; 重新打开 AutoJs6 (服务端模式开启) → 自动重连. 在 5 分钟窗口内未恢复则仅提示一次 "无法重新连接", 可点 "重试"
    - 显式断开: VSCode "断开所有连接" → 手机端不重连, 且 AutoJs6 重启后不会恢复该连接; 反之在 AutoJs6 抽屉关闭 "客户端模式" → VSCode 不重连, 重启 VSCode 也不恢复
    - 观察宿主日志: `adb logcat -s JsonSocket JsonSocketClient JsonSocketServer DevPluginService DevPluginClientReconnector`
- 项目同步删除 (2.3 / 2.13)
    - "保存项目到设备" 保存一个含 `lib/util.js` 的项目; 本地删除 `lib/util.js` 后再次保存; 用 "浏览设备文件" 或 `adb shell ls /sdcard/脚本/<项目名>/lib` 确认设备上的文件已删除. "重新完整同步项目" 可强制全量覆盖
- 宿主脚本类型 (`.ts` / `.lua` / `.node.js` / `.bun.js` / `.py`): 分别对文件执行 "运行脚本", 宿主日志 (或控制台) 中的引擎与执行结果应与文件类型一致
- Activity 重建 (2.15): 连接建立并运行 `while (~sleep(1e3)) log(new Date());` 后, 在宿主切换语言 / 暗色模式 / 旋转屏幕, 日志应持续输出且 VSCode 无断开提示
    - 命令行等效: `adb shell settings put system user_rotation 1` (旋转), `adb shell cmd uimode night yes|no` (暗色), `adb shell cmd locale set-app-locales org.autojs.autojs6 --user 0 --locales en-US` (语言, Android 13+)
- 宿主管理器 (3.9): 抽屉 "客户端模式" / "服务端模式" 条目点击标题后选 "管理器" (或长按条目). 客户端管理器: 断开后 "立即重连" 应连上并展示 VSCode 主机 / 插件版本 / 协议版本 / 时长; "断开连接" 后 VSCode 侧应收到 `bye(user)` 且双方不再重连. 服务端管理器: 有客户端时显示客户端行, "断开所有客户端" 后 VSCode 侧收到 `bye(user)`, 监听保持

### 真机验证记录 (2026-09-16, Sony XQ-DQ72 / QV770340J7, Android 13, AutoJs6 6.8.0 debug)

无 VSCode 的验证可使用 `.internal/harness.js` (客户端: `node .internal/harness.js 127.0.0.1:<adb forward 端口>`; 服务端: `node .internal/harness.js server 6347` 配合 `adb reverse tcp:6347 tcp:6347`) 与 `.internal/run_once.js`, 两者直接调用编译后的 `out/device.js`. 注意本机 VSCode 若已运行本插件会占用 `0.0.0.0:6347`, harness 绑定 `127.0.0.1:6347` 时二者可共存, 但 harness 停止后经 `adb reverse` 进来的连接会落到 VSCode.

| 项目 | 结果 |
|---|---|
| 脚本类型路由 (`.js` / `.ts` / `.lua` / `.node.js` / `.bun.js` / `.quickjs.js` / `.py`) | 通过: 各自进入对应引擎 (TS / Lua / QuickJS / Python 因设备未安装对应插件而报插件缺失, 属预期) |
| 旋转 6 次 / 暗色模式 4 次 / 语言切换 2 次 (ADB 连接, 日志循环) | 通过: 无断开, 日志不间断 |
| 心跳超时 / 插件崩溃 (无 `bye`) 后插件自动重连 | 通过: 退避 1/2/4/8 s 后重连成功 |
| VSCode `bye(user)` → 宿主 | 通过: 宿主置 "正常关闭", 不重连, 重启不恢复 |
| VSCode `bye(shutdown)` / 服务端消失 → 宿主客户端模式 | 通过: 2 s 后开始重连, 服务端恢复后连上; 启动时恢复亦通过 |
| 宿主管理器 "断开连接" / "断开所有客户端" → VSCode | 通过: VSCode 侧 `peerBye: user`, 不重连 |
| 客户端 / 服务端管理器渲染与刷新 | 通过 (截图核对) |
| 二维码扫描页 (连续对焦 + 闪光灯按钮) | 通过 (用户实测对焦体验良好) |
| 配对 (2026-09-17): 未知设备 → `pending` hello → 允许 / 拒绝; 二维码令牌; 已信任设备直连 | 通过: 设备显示 "等待 VSCode 端确认", 允许后握手完成; 拒绝后设备收到 `errorMessage` 并关闭且不重连; 令牌被消费并记住设备; 再次连接无需确认 |
| 分块传输 (2026-09-17): 3 MiB 随机文件分 3 块上传 / 下载 | 通过: 本机与设备 md5 一致, 上传 332 ms, 下载 187 ms (ADB 转发) |
| 拉取项目变更 (2026-09-17): `save_project` 后在设备端修改 a.js / 新增 sub/c.js | 通过: 计划列出 `modified:a.js`, `added:sub/c.js`, 本地独有文件仅提示; 拉取后再次比较无差异 (md5 路径与旧版内容比较路径均通过) |
| 国际化 (2026-09-17) | 通过 (静态): `npm test` 26 项 (含无 vscode 环境下 `t()` 回退), 脚本校验 bundle 键与 `t()` 调用无缺失 / 无冗余, 清单 37 条命令标题 `%key%` 唯一; 显示语言切换效果待在 VSCode 中人工确认 |
| 服务端管理器 "局域网发现 (mDNS)" 开关 | 通过: 关闭 → `unregistered`, 开启 → `registered` (logcat) |
| mDNS (2026-09-17): 宿主 NSD 注册, 插件逐接口浏览 | 通过: 发现 `Sony XQ-DQ72 192.168.3.213:7347 v6.8.0 p2`; 通配 socket 在多网卡 Windows 上收不到应答, 已改为逐接口绑定 |

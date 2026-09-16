# AutoJs6 VSCode Extension - 通信协议 (Protocol)

> 适用范围: AutoJs6 VSCode Extension 1.1.0+ 与 AutoJs6 6.8.0+ (协议 v2); v1 部分同样适用于旧版本.
> 任何第三方工具 (如 WebStorm 插件, 命令行脚本) 均可按本文实现与 AutoJs6 的直接通信 (AutoJs6 issue #116, #482).

## 1. 连接方式与端口

| 模式 | 监听方 | 默认端口 | 说明 |
|---|---|---|---|
| AutoJs6 客户端模式 | VSCode 插件 | `6347` | AutoJs6 主动连接至插件, 插件需放行防火墙 TCP 6347 (可通过 `autojs6.server.port` 修改) |
| AutoJs6 服务端模式 (局域网) | AutoJs6 | `7347` | 插件主动连接至设备 IP (或域名) |
| AutoJs6 服务端模式 (ADB) | AutoJs6 | `7347` | 插件执行 `adb forward tcp:<随机端口> tcp:7347` 后连接 `127.0.0.1:<随机端口>` |
| HTTP 命令桥 | VSCode 插件 | `10347` | 仅本机 (`127.0.0.1`), `GET /exec?cmd=<命令>&path=<路径>` 触发插件命令 |

## 2. 帧格式 (Frame)

所有 TCP 数据均以帧为单位, 帧头固定 8 字节, 大端序 (Big Endian):

```
+----------------------+----------------------+------------------+
| int32BE payload 长度 | int32BE 帧类型       | payload          |
+----------------------+----------------------+------------------+
```

| 帧类型 | 值 | 载荷 |
|---|---|---|
| JSON | `1` | UTF-8 编码的 JSON 文本 |
| BYTES | `2` | 原始字节 (目前仅用于项目 zip 归档) |

* 单帧最大长度 `64 MB`, 超出或类型非法视为协议失步, 双方均会断开连接.
* JSON 帧为一个对象: `{ "id"?: number, "type": string, "data"?: object, "md5"?: string }`.

## 3. 握手 (Hello)

连接建立后, **AutoJs6 先发送** `hello`, 插件收到后回复 `hello`:

```jsonc
// AutoJs6 -> 插件
{ "type": "hello", "data": {
    "device_name": "Xiaomi M2004J19C",
    "app_version": "6.8.0",
    "app_version_code": 5280,
    "device_id": "<android id>",
    "protocol_version": 2,         // 6.8.0+ 携带; 缺省视为 1
    "features": [ "heartbeat", "request", "fs", "bye", "fs.chunked", "pairing" ],  // 6.8.0+ 声明的能力
    "qr_token": "k3JxPzQ2mA9d"     // 可选, 扫描插件二维码连接时回传的一次性配对令牌 (见 3.1)
} }

// 插件 -> AutoJs6
{ "id": 1, "type": "hello", "data": {
    "extensionVersion": "1.1.0",   // AutoJs6 客户端模式要求 >= VSCODE_EXT_REQUIRED_VERSION
    "protocolVersion": 2,          // 缺省视为 1
    "features": [ "heartbeat", "request", "fs", "bye", "fs.chunked", "pairing" ],
    "name": "DESKTOP-PC",          // 可选, 计算机名 (AutoJs6 管理器中展示)
    "platform": "win32",           // 可选, 插件所在平台
    "errorMessage": "...",         // 可选, 携带时 AutoJs6 断开并展示该信息
    "pending": true                // 可选, 插件正在询问用户是否允许该设备连接 (见 3.1), 之后还会再发一次 hello
} }
```

* 插件侧 `handshakeTimeout` (默认 6 s) 内未收到 `hello` 则断开; AutoJs6 侧握手超时 6.4 s.
* 版本检查: 插件要求 `app_version_code >= requiredClientVersionCode`; AutoJs6 (客户端模式) 要求 `extensionVersion >= VSCODE_EXT_REQUIRED_VERSION`.
* 协议版本协商: 双方取各自声明版本, 新特性 (心跳, 请求/响应) 仅在对端 `>= 2` 时启用, 以保持向下兼容.
* 能力声明: `features` 列出对端可用的扩展能力 (`fs.chunked` 分块读写, `pairing` 配对确认); 缺省视为仅具备 v1/v2 基础能力.

### 3.1 配对 (Pairing, 插件 1.1.0+ / AutoJs6 6.8.0+)

仅适用于 **AutoJs6 客户端模式** (设备主动连接插件). 插件收到 `hello` 后按顺序判断:

1. `qr_token` 有效 (由插件二维码签发, 10 分钟内且仅可使用一次): 直接接受并将 `device_id` 加入已信任列表.
2. `device_id` 已在信任列表: 直接接受.
3. 其他: 先回复 `{ "type": "hello", "data": { ..., "pending": true } }` (仅当对端声明 `pairing`), 然后弹窗询问用户 "允许并记住 / 仅本次允许 / 拒绝" (90 s 无响应视为拒绝).
   * 允许: 再发送一次正常 `hello` (不含 `pending`), 之后握手完成, 心跳开始.
   * 拒绝: 发送带 `errorMessage` 的 `hello` 并关闭连接; AutoJs6 不会自动重连.

AutoJs6 收到 `pending` 后保持 "连接中" 状态并提示 "等待 VSCode 端确认", 不触发握手超时. 插件的 "管理已信任设备 (Manage Trusted Devices)" 命令可移除信任;
`autojs6.server.confirmUnknownDevices` 为 `false` 时跳过询问 (仍会记录扫码信任).

## 4. 命令 (v1)

插件 -> AutoJs6, `type = "command"`, 由 `data.command` 区分:

| command | data 字段 | 说明 |
|---|---|---|
| `run` | `id`, `name`, `script`, `path?` | 运行脚本文本. `id` 用于后续 `stop`; `name` 为文件名 |
| `stop` | `id` | 停止由 `run` 启动的脚本 |
| `rerun` | 同 `run` | 停止后重新运行 (6.8.0+; 插件为兼容旧版仍以 `stop` + `run` 实现) |
| `stopAll` | - | 停止所有脚本 |
| `save` | `id`, `name`, `script`, `path?` | 保存到工作目录. `path` 为相对工作区的 POSIX 路径, 6.8.0+ 按目录结构保存 (旧版仅取文件名) |

项目命令使用 BYTES 帧 + `bytes_command` JSON 帧, 两帧顺序不限, 以 zip 的 MD5 (hex) 关联:

```jsonc
// 先发 BYTES 帧 (zip), 再发:
{ "id": 2, "type": "bytes_command", "md5": "<zip md5 hex>", "data": {
    "id": "D:\\projects\\demo",       // 项目唯一标识 (插件使用本地目录路径), AutoJs6 以其 MD5 命名缓存目录
    "name": "demo",                   // 保存到工作目录时的目录名
    "command": "run_project",         // 或 "save_project"
    "override": true,                 // true: zip 为完整项目, AutoJs6 先清空缓存目录 (6.8.0+)
    "deletedFiles": [ "a/b.js" ]      // 自上次同步以来删除的文件 (POSIX 相对路径), 6.8.0+ 同步删除
} }
```

AutoJs6 -> 插件:

| type | data | 说明 |
|---|---|---|
| `log` | `{ "log": "<一行日志>" }` | 每条 `console` 输出一帧 |
| `command` | `{ "\u00a0cmd\u00a0": "run", ... }` | 请求插件执行命令 (保留能力, 键名为 NBSP 包裹的 `cmd`) |

## 5. 心跳 (v2)

任一方在空闲时发送 `ping`, 对端立即回复 `pong`; 任何入站消息均视为存活证明.

```jsonc
{ "id": 7, "type": "ping", "data": { "ts": 1758000000000 } }
{ "type": "pong", "data": { "ts": 1758000000000 } }
```

| 方 | 空闲发送间隔 | 超时判定 |
|---|---|---|
| 插件 | `autojs6.connection.heartbeatInterval` (默认 15 s) | `heartbeatTimeout` (默认 10 s) 内无任何入站消息 |
| AutoJs6 | 20 s | 60 s 内无任何入站消息 |

超时后关闭连接, 随后按下文的重连规则处理.

### 5.1 主动断开通告 (`bye`, v2)

任一方**主动**关闭连接前发送 `bye`, 随后关闭 socket; 对端据此区分 "意外断开" 与 "对方有意关闭":

```jsonc
{ "type": "bye", "data": { "reason": "user" } }
```

| `reason` | 含义 | 对端是否可自动重连 |
|---|---|---|
| `user` | 用户显式断开 (VSCode 命令 / AutoJs6 抽屉开关或管理器) | 否, 且启动时不再恢复该连接 |
| `shutdown` | 进程退出 (VSCode 关闭 / `deactivate`) | 是 |
| `restart` | 即将重启 | 是 |
| `replaced` | 同一目标建立了新连接, 旧连接被替换 | 否 (新连接已存在) |

收到 `bye` 后读到流结束视为正常关闭, 不再报错. 未收到 `bye` 的断开 (进程被杀, 网络中断, 心跳超时) 一律视为意外断开.

### 5.2 自动重连

| 方 | 触发 | 策略 |
|---|---|---|
| 插件 (客户端 LAN / ADB) | 意外断开, 或 VSCode 启动时恢复上次连接 (`autojs6.connection.restoreOnStartup`) | 指数退避 1, 2, 4 ... 秒, 上限 `reconnectMaxDelay` (默认 10 s); 持续 `reconnectTimeout` (默认 300 s, 0 不限) 或 `maxReconnectAttempts` 次 (默认 0 不限); 窗口结束后提示一次并提供 "重试" / "不再自动恢复" |
| AutoJs6 (客户端模式, 6.8.0+) | 意外断开 (含 `bye(shutdown)`), 或应用启动时恢复 (管理器 "启动时恢复连接") | 退避 2, 4, 8, 16, 30 秒 (会话超过 10 分钟后 60 秒), 网络恢复时立即重试, 直至成功或用户停止; 握手被拒绝 (版本不符) 不重试 |

任一方显式断开 (`bye(user)`) 后, 双方均不再自动重连, 直至用户再次手动连接.

## 6. 请求 / 响应 (v2)

```jsonc
// 插件 -> AutoJs6
{ "id": 12, "type": "request", "data": { "method": "fs.list", "params": { "path": "/sdcard/脚本" } } }

// AutoJs6 -> 插件
{ "id": 12, "type": "response", "data": { "ok": true, "result": { ... } } }
{ "id": 12, "type": "response", "data": { "ok": false, "error": "Not found: /sdcard/x" } }
```

* `id` 由请求方分配并原样回传; 插件默认 30 s 超时 (文件读写 120 s).
* 所有 `fs.*` 路径必须位于外部存储目录 (`/storage/emulated/0`) 内, 否则返回 `Access denied`.

| method | params | result |
|---|---|---|
| `sys.info` | - | `{ appVersion, appVersionCode, protocolVersion, features, deviceName, sdk, workingDir, externalStorage }` |
| `fs.roots` | - | `{ workingDir, externalStorage, roots: [ { name, path } ] }` |
| `fs.list` | `{ path, hash? }` | `{ path, entries: [ { name, path, type: "file" \| "directory", size, mtime, md5? } ] }` (`hash: true` 时不超过 16 MB 的文件附带 `md5`, 6.8.0+) |
| `fs.stat` | `{ path }` | `{ path, exists, type?, size?, mtime? }` |
| `fs.read` | `{ path, encoding?: "utf8" \| "base64", offset?, length? }` | `{ path, size, offset, length, eof, encoding, content }` (单次最大 32 MB; `size` 为文件总长, 见 6.1) |
| `fs.write` | `{ path, content, encoding?, create?, overwrite?, mkdirs?, append? }` | `{ path, size, written, mtime }` (`append` 需文件已存在, 见 6.1) |
| `fs.mkdir` | `{ path }` | `{ path }` |
| `fs.delete` | `{ path, recursive? }` | `{ path }` |
| `fs.rename` | `{ path, newPath, overwrite? }` | `{ path }` |
| `script.run` | `{ path }` | `{ path }` 运行设备上的脚本文件 |

错误信息以英文短语开头, 插件据此映射为 VSCode 文件系统错误: `Not found`, `Already exists`, `Is a directory`, `Not a directory`, `Access denied`.

### 6.1 分块传输 (`fs.chunked`, AutoJs6 6.8.0+)

对端声明 `fs.chunked` 时, 插件对超过 1 MiB 的文件按 1 MiB 分块并显示可取消的进度:

* 读取: 先 `fs.stat` 取 `size`, 再循环 `fs.read { offset, length }` 直到响应 `eof: true` (或返回 0 字节); `offset`/`length` 之一存在即视为分块读取.
* 写入: 首块 `fs.write { append: false, overwrite, create }` 覆盖 / 创建文件, 后续块 `append: true` 追加 (此时不再检查 `overwrite`); 取消时设备上的文件可能不完整.

### 6.2 拉取设备端变更 (Pull Project, 插件 1.1.0+)

"从设备拉取项目变更" 命令将设备上 `<工作目录>/<项目目录名>` (即 `save_project` 的保存位置) 与本地项目比较, 列出设备端新增 / 修改的文件供勾选拉回 (可逐文件预览差异):

* 插件递归 `fs.list { hash: true }` 遍历设备项目 (沿用 `project.json` 的 `ignore` 规则), 本地缺失的文件为 "新增", 大小或 `md5` 不同的为 "已修改".
* 旧版 AutoJs6 不返回 `md5` 时, 同大小且不超过 8 MB 的文件通过 `fs.read` 下载后按内容比较.
* 仅本地存在的文件只做提示, 不会删除; 拉取通过 `fs.read` (大文件分块, 见 6.1) 完成.

## 7. 二维码 (QR Code)

插件生成的二维码内容:

```
autojs6://connect?host=192.168.1.5&port=6347&name=MY-PC&alt=10.0.0.5:6347&v=2&token=k3JxPzQ2mA9d
```

AutoJs6 (6.8.0+) 客户端模式地址输入框的扫码按钮解析 `host` 与 `port` 并直接连接; 纯文本 `host[:port]` 亦可识别.
`token` 为插件签发的一次性配对令牌 (10 分钟内有效, 二维码刷新时更新), AutoJs6 6.8.0+ 在随后的 `hello` 中以 `qr_token` 回传, 插件校验通过后直接信任该设备 (见 3.1).

## 8. HTTP 命令桥

```
GET http://127.0.0.1:10347/exec?cmd=run&path=D:\demo\main.js
GET http://127.0.0.1:10347/exec?cmd=rerunProject&path=D:\demo
```

`cmd` 取值: `viewDocument` `connect` `disconnectAll` `run` `runOnDevice` `stop` `stopAll` `rerun` `save` `saveToDevice` `newUntitledFile` `newProject` `runProject` `saveProject` `showQrCode` `rerunProject`.
默认仅监听 `127.0.0.1`, 可通过 `autojs6.http.host` / `autojs6.http.port` / `autojs6.http.enabled` 调整.

## 9. 最小客户端示例 (Node.js)

```js
const net = require('net');
const HEADER = 8;
const sock = net.createConnection({ host: '192.168.1.20', port: 7347 });
let buf = Buffer.alloc(0);
const send = (obj) => {
    const payload = Buffer.from(JSON.stringify(obj));
    const header = Buffer.alloc(HEADER);
    header.writeInt32BE(payload.length, 0);
    header.writeInt32BE(1, 4);
    sock.write(Buffer.concat([ header, payload ]));
};
sock.on('data', (chunk) => {
    buf = Buffer.concat([ buf, chunk ]);
    while (buf.length >= HEADER) {
        const len = buf.readInt32BE(0), type = buf.readInt32BE(4);
        if (buf.length < HEADER + len) break;
        const payload = buf.subarray(HEADER, HEADER + len);
        buf = buf.subarray(HEADER + len);
        if (type !== 1) continue;
        const msg = JSON.parse(payload.toString('utf8'));
        if (msg.type === 'hello') {
            send({ id: 1, type: 'hello', data: { extensionVersion: '1.1.0', protocolVersion: 2 } });
            send({ id: 2, type: 'command', data: { command: 'run', id: 'demo', name: 'demo.js', script: 'toast("hi")' } });
        } else if (msg.type === 'ping') {
            send({ type: 'pong', data: msg.data });
        } else if (msg.type === 'log') {
            console.log(msg.data.log);
        }
    }
});
```

## 10. 局域网发现 (mDNS, AutoJs6 6.8.0+)

AutoJs6 服务端模式开启且 "局域网发现 (mDNS)" 打开时, 通过 Android NSD 注册服务:

```
类型: _autojs6._tcp.     实例名: AutoJs6 <型号>     端口: 7347
TXT:  v=<应用版本>  p=<协议版本>  n=<设备名>  id=<设备 ID>
```

插件 "客户端模式 | 局域网" 的连接列表使用 `bonjour-service` 浏览该类型, 发现的设备以 `[ 发现 ] - <设备名>` 列出 (地址为 A 记录 + SRV 端口).
Windows 下通配 socket 的组播可能只经某一 (虚拟) 网卡发出, 因此插件会为每个 IPv4 接口分别打开一个浏览 socket. `autojs6.discovery.enabled` 可关闭发现.

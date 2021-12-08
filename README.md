******

### AutoJs6 VSCode 开发插件

******

* 支持 [AutoJs6](https://github.com/SuperMonster003/AutoJs6) 开发的 [VSCode](https://code.visualstudio.com/) 插件
* 复刻 (Fork) 自 [hyb1996/Auto.js-VSCode-Extension](https://github.com/hyb1996/Auto.js-VSCode-Extension)

******

### 安装 (Install)

******

- VSCode 菜单 `View / 查看` - `Extensions / 扩展` `[ Ctrl+Shift+X ]`
- 搜索 "AutoJs6" 或 "003" 
- 选择 "AutoJs6 VSCode Ext" 插件并安装 (或更新)

******

### 功能 (Features)

******

- 在 VSCode 中连接设备并操作 AutoJs6 的脚本或项目 (运行 / 停止 / 保存 等)
- 在 VSCode 中实时显示 AutoJs6 的日志

******

### 使用 (Usage)

******

1. 启动服务

- VSCode 菜单 `View / 查看` - `Command Palette / 命令面板` `[ Ctrl+Shift+P ]`
- 输入 "AutoJs6" 并选择 `AutoJs6: 启动服务 (Start Server)` `[ Ctrl+Alt+F6 ]`
- VSCode 通知 `AutoJs6 服务正在运行 (${IP})` 并记录此 IP 地址

2. 连接到计算机

- 在 AutoJs6 首页侧拉菜单中选择 "连接到计算机"
- 输入上一步记录的 IP 地址
- VSCode 通知 `AutoJs6 设备接入: ${DEVICE} (${DEVICE_IP})` 完成设备连接

3. 执行命令

- VSCode 菜单 `View / 查看` - `Command Palette / 命令面板` `[ Ctrl+Shift+P ]`
- 输入 "AutoJs6" 查看并执行支持的命令
- 如 `AutoJs6: 运行脚本 (Run)` `AutoJs6: 停止所有脚本 (Stop All)` `新建项目 (New Project)` 等

4. 查看日志

- 采用下述方式之一查看来自 AutoJs6 的日志
    - 在建立设备连接后弹出的 `OUTPUT / 输出` 面板 `[ F12 ]` 查看
    - 在 VSCode 菜单 `Help / 帮助` - `Toggle Developer Tools / 切换开发人员工具` 的 `Console` 面板查看

******

### 命令 (Commands)

******

- 查看文档 (View Online Document) `[ Alt+Shift+F6 ]`
    - 查看 AutoJs6 在线开发文档
- 启动服务 (Start Server) `[ Ctrl+Alt+F6 ]`
    - 启动插件服务
- 停止服务 (Stop Server) `[ Ctrl+Alt+Shift+F6 ]`
    - 停止插件服务
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
    - 文件名附加前缀 "remote"
    - 对所有已连接的设备有效
- 指定设备运行 (Run On Device)
    - 弹出设备菜单并指定运行 VSCode 对应脚本的设备
- 保存到指定设备 (Save To Device)
    - 弹出设备菜单并在指定保存 VSCode 对应脚本的设备
- 新建项目 (New Project)
    - 选择 (或创建后选择) 一个空文件夹用于新建 AutoJs6 项目
- 运行项目 (Run Project)
    - 运行一个 AutoJs6 项目
- 保存项目 (Save Project)
    - 保存一个 AutoJs6 项目

******

### 版本历史 (Release Notes)

******

[comment]: <> "Version history only shows last 3 versions"

# v1.0.0

###### 2021/12/07

* `优化` 在 VSCode 的 OUTPUT (输出) 面板显示实时日志 (Ref to 710850609)

******

### 相关项目

******

* [AutoJs6](https://github.com/SuperMonster003/AutoJs6) { author: [SuperMonster003](https://github.com/SuperMonster003) }
    - `安卓平台 JavaScript 自动化工具`
* [Auto.js-VSCode-Extension](https://github.com/hyb1996/Auto.js-VSCode-Extension) { author: [hyb1996](https://github.com/hyb1996) }
    - `Auto.js VSCode 开发插件`
* [Auto.js-VSCode-Extension](https://github.com/710850609/Auto.js-VSCode-Extension) { author: [710850609](https://github.com/710850609) }
    - `Auto.js VSCode 开发插件`
* [Auto.js-VSCode-Extension](https://github.com/kkevsekk1/Auto.js-VSCode-Extension) { author: [kkevsekk1](https://github.com/kkevsekk1) }
    - `Auto.js VSCode 开发插件`

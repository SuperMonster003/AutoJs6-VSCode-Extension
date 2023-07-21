******

### Changelog

******

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

* `新增` 支持客户端 (LAN) 及服务端 (LAN/ADB) 连接方式 (Ref to Auto.js Pro)

# v1.0.0

###### 2021/12/07

* `优化` 在 VSCode 的 OUTPUT (输出) 面板显示实时日志 (Ref to 710850609)
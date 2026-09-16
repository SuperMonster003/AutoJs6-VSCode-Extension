// Runs ON THE DEVICE (sent through run_once.js): make AutoJs6 client mode connect to a server, optionally with a
// pending QR pairing token, without touching the UI. Replace __ADDR__ / __TOKEN__ before sending.
// zh-CN: 在设备上运行 (经 run_once.js 下发): 不经 UI 让 AutoJs6 客户端模式连接到服务端, 可携带待用的二维码配对令牌.
var addr = '__ADDR__';
var token = '__TOKEN__';
var AutoJs = Packages.org.autojs.autojs.AutoJs;
var inst = AutoJs.Companion.getInstance();
var svc = null;

function findService(cls) {
    var methods = cls.getDeclaredMethods();
    for (var i = 0; i < methods.length; i++) {
        if (String(methods[i].getName()).indexOf('getDevPluginService') === 0) {
            methods[i].setAccessible(true);
            return methods[i].invoke(inst);
        }
    }
    return null;
}

var cls = inst.getClass();
while (svc === null && cls !== null) {
    svc = findService(cls);
    cls = cls.getSuperclass();
}
console.log('service: ' + svc);
if (token && token.charAt(0) !== '_') {
    var host = addr.split(':')[0];
    Packages.org.autojs.autojs.pluginclient.DevPluginService.Companion.setPendingQrToken(new Packages.kotlin.Pair(host, token));
    console.log('pending token set for ' + host);
}
svc.connectToRemoteServer(context, addr, true).subscribe();
console.log('connect requested: ' + addr);

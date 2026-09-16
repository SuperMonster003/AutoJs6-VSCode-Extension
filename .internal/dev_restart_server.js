// Runs ON THE DEVICE (sent through run_once.js): stop the local server, then start it again 1.5 s later, so the
// mDNS unregister / register path can be checked in logcat (DevPluginDiscovery).
// zh-CN: 在设备上运行 (经 run_once.js 下发): 停止本地服务端并在 1.5 s 后重新启动, 用于在 logcat 中核对 mDNS 注销 / 注册路径.
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
svc.disconnectJsonSocketServer();
console.log('server stopped');
setTimeout(function () {
    svc.enableLocalServer().subscribe();
    console.log('server restart requested');
}, 1500);

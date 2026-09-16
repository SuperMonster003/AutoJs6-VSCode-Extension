// Smoke-load the esbuild bundle outside VSCode: `vscode` is replaced by a permissive Proxy so that every
// top-level require / API touch succeeds; this catches unresolved dynamic requires and broken interop.
// Usage: node .internal/load_bundle.js
const Module = require('module');
const path = require('path');

const handler = {
    get(target, key) {
        if (key === '__esModule') return true;
        if (key === 'then') return undefined;
        if (key === Symbol.toPrimitive) return () => 'vscode-stub';
        if (key === 'toString') return () => 'vscode-stub';
        return proxy;
    },
    apply() { return proxy; },
    construct() { return proxy; },
};
const proxy = new Proxy(function vscodeStub() {}, handler);

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === 'vscode') return path.resolve(__dirname, 'load_bundle.js');
    return originalResolve.call(this, request, ...rest);
};
if (require.main !== module) {
    module.exports = proxy;
} else {
    require.cache[path.resolve(__dirname, 'load_bundle.js')] = { exports: proxy, loaded: true };
    const ext = require(path.resolve(__dirname, '..', 'dist', 'extension.js'));
    console.log('bundle loaded, exports:', Object.keys(ext));
}

// Open the QR scanner from inside the app (the Activity is not exported).
Packages.org.autojs.autojs.ui.qrcode.QrCodeScanActivity.Companion.launch(context, null, function (text) {
    log("scanned: " + text);
});
log("qr scanner launched");

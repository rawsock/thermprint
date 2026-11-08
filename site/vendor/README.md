# QR encoder

`qrcode.mjs` is the unmodified ES module from `qrcode-generator` version **2.0.4**, obtained from the npm registry. Upstream: https://github.com/kazuhikoarase/qrcode-generator. Copyright (c) 2009 Kazuhiko Arase. MIT licensed; see `qrcode-LICENSE.txt`.

Vendored so QR contents and generation stay entirely in the browser, with no CDN or runtime build dependency. Unicode encoding uses the browser's TextEncoder in our wrapper.

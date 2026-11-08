# ThermPrint

A small, static web app for the **TEDi SWS-PT1** Bluetooth thermal printer used by Funny Print. Compose text or import a photo, inspect the exact monochrome preview, and print directly from the browser. Content stays on your device; there is no backend, account, analytics, or third-party asset request.

## Use it

1. Open the app in **Chrome on Android**, or **Chrome / Edge on Windows or macOS**. Safari and Firefox do not support the required Web Bluetooth API.
2. Power on the printer and close Funny Print or any other app connected to it.
3. Click **Connect printer** and select **SWS-PT1** in the browser dialog.
4. Write text or choose a PNG, JPEG, or WebP. Adjust size, alignment, ink balance, or photo dithering. Click **Print this**.

The preview is 384 dots wide (about 48 mm). Each job includes 64 blank feed rows and is limited to 1536 rows (about 19 cm). Images scale to fit without cropping. **Save PNG** exports the exact raster without connecting. Keep the tab in the foreground while printing. **Stop sending** disconnects; the printer may finish buffered lines. Jobs are never automatically retried after a disconnect.

## Local development

The browser app is plain HTML/CSS/JavaScript in `site/`, with no dependencies or build step. JavaScript is necessary for direct browser Bluetooth access; the original hardware diagnostics remain Python tools.

```sh
python -m http.server 8000 --bind 127.0.0.1 --directory site
```

Open `http://localhost:8000`. Bluetooth requires HTTPS or localhost; opening `index.html` directly or using a plain HTTP LAN address will not work. Node 22+ runs the browser-protocol and image-processing tests:

```sh
npm test
```

## GitHub Pages

The remote is `https://github.com/rawsock/thermprint`, and `main` tracks `origin/main`. In the repository's **Settings → Pages**, choose **GitHub Actions** as the source, then push `main` or run the **Test and deploy to GitHub Pages** workflow. It tests the app and uploads only `site/`.

The expected URL is **https://rawsock.github.io/thermprint/** after a successful deployment. All asset paths are relative, so the repository subpath works without a build configuration.

## Hardware and protocol

The Python diagnostic physically printed a 384 × 240 calibration strip on an SWS-PT1 on 2026-11-08, and its output was confirmed good. The browser implementation uses the same protocol. Automated tests emulate the browser GATT boundary and printer notifications; they do not replace a physical browser print test. Other Funny Print models and firmware are unverified.

- Service `FFE6`; write without response on `FFE1`; notifications on `FFE2`.
- Device name filter `SWS-PT1`, with `FFE6` in `optionalServices`: this printer advertises no service UUIDs.
- Authentication derives CRC16/XMODEM from a zero byte followed by the MAC returned in the printer's hello. No hardcoded device address or challenge response.
- Raster packets are 100 bytes: `55`, big-endian packet index, 96 bytes (two 384-dot rows, black = 1, MSB first), and `00`. The final odd row is padded white.
- Transfer starts with `5A 04 count_hi count_lo 00 00`. Packets are paced at 40 ms, with pause and one-based retransmission handling. Completion requires `5A 06` with the matching packet count before sending the end marker.
- Paper, heat, low-voltage, timeout, disconnect, and malformed-response errors stop the job. Web Bluetooth cannot explicitly select an MTU; the browser/OS must support a 100-byte write. A rejected write disconnects without silently splitting packets.

The earlier diagnostic is available with `python tools/thermprint.py --preview`, `--authenticate`, or `--test-print`. Install `tools/requirements.txt` first. Its tests use `python -m pytest tests/test_thermprint.py`; its calibration font currently requires Windows Arial. The earlier C# probe source is retained as a historical diagnostic, with compiled binaries and local logs excluded from Git.

References: [Chrome Web Bluetooth documentation](https://developer.chrome.com/docs/capabilities/bluetooth), [GitHub Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages), and community protocol research in [printer-driver-funnyprint](https://github.com/ValdikSS/printer-driver-funnyprint) and [Pocketprint](https://github.com/antoniosolismz/Pocketprint). This implementation was written independently and checked against the captured responses from this printer.

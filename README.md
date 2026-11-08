# ThermPrint

**Open the app: https://thermprint.github.io/**

A small, static web app for the **TEDi SWS-PT1** Bluetooth thermal printer used by Funny Print. Compose text, import a photo, generate a QR code, find free graphics, or draw your own image, then print directly from the browser. Print content stays on your device. Graphics searches and selected image requests go directly to Wikimedia Commons; there is no app backend, account, or analytics.

## Use it

1. Open the app in **Chrome on Android**, or **Chrome / Edge on Windows or macOS**. Safari and Firefox do not support the required Web Bluetooth API.
2. Power on the printer and close Funny Print or any other app connected to it.
3. Click **Connect printer** and select **SWS-PT1** in the browser dialog.
4. Choose a tab: **Text**, **Image**, **QR code**, **Graphics**, or **Draw**. Adjust your artwork and click **Print this**.

The preview is 384 dots wide (about 48 mm). Images scale to fit without cropping. **Save PNG** exports the monochrome artwork at its intended proportions without connecting. Jobs include blank space for tearing and are limited to 1536 encoded rows (about 17 cm with the default calibration). Keep the tab in the foreground while printing. **Stop sending** disconnects; the printer may finish buffered lines. Jobs are never automatically retried after a disconnect.

**Paper-feed calibration** corrects the measured vertical squeeze: a 29 mm circle printed only 25.5 mm tall. The default expands the print rows by 29 / 25.5, approximately **113.7%**, across all five tabs. The preview and exported PNG keep the intended proportions. Adjust the slider if your printer differs; **100%** disables compensation. This setting is saved locally. The physical result of the new compensation still needs measurement on paper.

- **QR code:** links or arbitrary UTF-8 text, generated locally, with an integral module size, medium error correction, and a four-module quiet zone. Overly detailed codes are rejected at small print sizes. Automated tests decode both the source and compensated QR images.
- **Graphics:** search Wikimedia Commons and select a result to import it directly. Illustrations are the default; turn off that filter to include photos. Creator, license, and source are displayed. Follow the linked license when sharing prints. Search availability depends on Wikimedia and the network. Google is not used: its Custom Search JSON API is closed to new customers and retires January 1, 2027.
- **Draw:** smooth mouse, touch, or stylus strokes; size selection, eraser, undo (20 actions), and undoable clear. Artwork stays in memory for the current visit.

## Local development

The browser app is plain HTML/CSS/JavaScript in `site/`, with a locally vendored QR encoder and no build step or CDN dependencies. JavaScript is necessary for direct browser Bluetooth access; the original hardware diagnostics remain Python tools.

```sh
python -m http.server 8000 --bind 127.0.0.1 --directory site
```

Open `http://localhost:8000`. Bluetooth requires HTTPS or localhost; opening `index.html` directly or using a plain HTTP LAN address will not work. Node 22+ runs the browser-protocol and image-processing tests:

```sh
npm ci --ignore-scripts
npm test
```

## GitHub Pages

The development upstream remains `https://github.com/rawsock/thermprint`, and `main` tracks `origin/main`. The branded site is published from `https://github.com/thermprint/thermprint.github.io`. Both repositories use **GitHub Actions** as the Pages source and the same **Test and deploy to GitHub Pages** workflow. It tests the app and uploads only `site/`.

The primary URL is **https://thermprint.github.io/**. The original **https://rawsock.github.io/thermprint/** remains available. All asset paths are relative, so both the root and repository subpath work without a build configuration.

This workspace has a `pages` remote for the organization repository, and two push URLs on `origin`, so `git push origin main` updates both repositories. For a fresh clone, configure the same behavior with:

```sh
git remote add pages https://github.com/thermprint/thermprint.github.io
git remote set-url --add --push origin https://github.com/rawsock/thermprint
git remote set-url --add --push origin https://github.com/thermprint/thermprint.github.io
```

Fetches still use the development upstream. Changes made through GitHub's editor or another checkout must also be pushed to both repositories; there is no cross-repository credential stored in Actions.

## Hardware and protocol

The Python diagnostic physically printed a 384 × 240 calibration strip on an SWS-PT1 on 2026-11-08, and its output was confirmed good. The user subsequently confirmed that browser printing works. Automated tests emulate the browser GATT boundary and printer notifications, render artwork on a real canvas implementation, decode QR output, and exercise the gallery API boundary and drawing input. Other Funny Print models and firmware are unverified.

- Service `FFE6`; write without response on `FFE1`; notifications on `FFE2`.
- Device name filter `SWS-PT1`, with `FFE6` in `optionalServices`: this printer advertises no service UUIDs.
- Authentication derives CRC16/XMODEM from a zero byte followed by the MAC returned in the printer's hello. No hardcoded device address or challenge response.
- Raster packets are 100 bytes: `55`, big-endian packet index, 96 bytes (two 384-dot rows, black = 1, MSB first), and `00`. The final odd row is padded white.
- Transfer starts with `5A 04 count_hi count_lo 00 00`. Packets are paced at 40 ms, with pause and one-based retransmission handling. Completion requires `5A 06` with the matching packet count before sending the end marker.
- Paper, heat, low-voltage, timeout, disconnect, and malformed-response errors stop the job. Web Bluetooth cannot explicitly select an MTU; the browser/OS must support a 100-byte write. A rejected write disconnects without silently splitting packets.

The earlier diagnostic is available with `python tools/thermprint.py --preview`, `--authenticate`, or `--test-print`. Install `tools/requirements.txt` first. Its tests use `python -m pytest tests/test_thermprint.py`; its calibration font currently requires Windows Arial. The earlier C# probe source is retained as a historical diagnostic, with compiled binaries and local logs excluded from Git.

References: [Chrome Web Bluetooth documentation](https://developer.chrome.com/docs/capabilities/bluetooth), [GitHub Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages), and community protocol research in [printer-driver-funnyprint](https://github.com/ValdikSS/printer-driver-funnyprint) and [Pocketprint](https://github.com/antoniosolismz/Pocketprint). This implementation was written independently and checked against the captured responses from this printer.

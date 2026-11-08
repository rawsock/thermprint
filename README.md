# ThermPrint

**Open the app: https://thermprint.github.io/**

A small, static web app for the **TEDi SWS-PT1** Bluetooth thermal printer used by Funny Print. Compose text, import a photo, generate a QR code, find free graphics, or draw your own image, then print directly from the browser. Print content stays on your device. Graphics searches and image requests go directly to the selected library, Iconify or Wikimedia Commons; there is no app backend, account, or analytics.

## Use it

1. Open the app in **Chrome on Android**, or **Chrome / Edge on Windows or macOS**. Safari and Firefox do not support the required Web Bluetooth API.
2. Power on the printer and close Funny Print or any other app connected to it.
3. Click **Connect printer** and select **SWS-PT1** in the browser dialog.
4. Choose a tab: **Text**, **Image**, **QR code**, **Graphics**, or **Draw**. Adjust your artwork and click **Print this**.

The preview is 384 dots wide (about 48 mm). Print adjustments sit beside it, with separate scrolling for long previews and settings. Controls keep their positions; unavailable options are disabled. **Paper · softer** blends the on-screen dots slightly to approximate paper; **Exact dots** shows the binary raster. Printing and **Save PNG** always use exact black-and-white dots. **Image size** scales images, graphics and drawings from 10% to 100% without cropping; the artwork stays horizontally centered and the paper length shrinks with it. **Start spacing** and **End spacing** independently control 0–8 mm of added blank paper, defaulting to 0.5 mm and 2 mm. White space inside the original artwork and the QR quiet zone remain intact; the printer may also add feed beyond the preview. **Save PNG** exports artwork at its intended proportions without connecting. Jobs are limited to 1536 encoded rows (about 17 cm with the default calibration). Keep the tab in the foreground while printing. **Stop sending** disconnects; the printer may finish buffered lines. Jobs are never automatically retried after a disconnect.

Choose **English / Polski** and **System / Light / Dark** at the top of the page. Both preferences are saved locally. Language changes preserve entered text, QR content, filenames, and artwork. Dark mode keeps paper, drawing pixels, and graphic thumbnails in their original colors.

**Reconnect printer** reuses the printer selected during this visit. Browsers exposing `Bluetooth.getDevices()` can also restore a previously granted site permission after reloading; other browsers may show their chooser again. OS pairing alone does not grant a website access. **Choose another printer** explicitly opens the chooser. The stored preference is the browser's opaque device ID, not the printer's address.

**Paper-feed calibration** corrects the measured vertical squeeze: a 29 mm circle printed only 25.5 mm tall. The default expands the print rows by 29 / 25.5, approximately **113.7%**, across all five tabs. Correction is applied once; the preview and exported PNG keep the intended proportions. If a QR code is too tall, lower the slider; if too short, raise it. **100% · no correction** disables compensation, and **Reset to measured correction** restores the original ratio. This setting is saved locally. A later report of distorted QR proportions could not be measured, so the measured default is retained. Tests check square artwork and a single correction; physical proportions still need confirmation on paper.

**Photo dithering** has two styles: **Photos · smooth tones** for gradual shading, and **Illustrations · crisp contrast** for stronger outlines and cleaner highlights. Ink balance adjusts the actual tone density; lower it if a print is too dark. Contrast and Enhance fine detail let you tune the result. The photo style uses serpentine Stucki diffusion with deterministic pattern breaking; the illustration style uses Atkinson. For photos, paper-feed correction resizes the grayscale image before dithering, avoiding repeated dot bands. Preview and PNG export are dithered at the artwork's intended proportions, while printing is dithered at the corrected hardware resolution.

- **QR code:** links or arbitrary UTF-8 text, generated locally, with an integral module size, medium error correction, and a four-module quiet zone. Overly detailed codes are rejected at small print sizes. Automated tests decode both the source and compensated QR images.
- **Graphics:** Iconify is the default for icons and symbols. Try short subjects such as **cat**, **flower**, or **coffee**. **Monochrome only** uses collection metadata, with no thumbnail downloads or pixel inspection before displaying results; uncheck it to include color collections. Some monochrome sets contain shaded variants. The gallery displays 48 results at a time, buffers additional results, and fetches further matches with **Load more**. Selecting an icon imports a larger SVG, rasterized locally in an isolated image context for printing. Choose **Wikimedia · all images** for photos and other illustrations. Creator, license, and source are displayed; follow the linked license when sharing prints. Search availability depends on the selected library and the network.
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

Dithering kernel reference: [Tanner Helland's image-dithering overview](https://tannerhelland.com/2012/12/28/dithering-eleven-algorithms-source-code.html).

Graphics API references: [Iconify search and pagination](https://iconify.design/docs/api/search.html), [Iconify SVG rendering](https://iconify.design/docs/api/svg.html). Iconify searches match icon names and keywords, so descriptive phrases can have no results even when a shorter subject has many matches.

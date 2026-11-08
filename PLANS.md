# ThermPrint project decisions

The user requested a browser printing app hosted on GitHub Pages, with `rawsock/thermprint` as its upstream. Use static HTML/CSS/JavaScript for the browser runtime; retain Python for the existing diagnostics. See README.md for usage and development commands.

## Printer

The TEDi SWS-PT1 supports custom BLE printing through FFE6/FFE1/FFE2. On 2026-11-08 the Python diagnostic completed authentication and a 120-packet calibration job, including transfer and footer acknowledgements; the user confirmed a good physical print. The calibration width is 384 dots. Application authentication derives its response from the printer-reported MAC rather than a fixed device address.

The browser port preserves 100-byte application packets and conservative 40 ms pacing. It honors printer holds and one-based retry requests, and requires the matching completion acknowledgement. Automatic replay after disconnect is excluded because already printed paper cannot be recalled. The user subsequently confirmed that browser printing works.

Paper-feed compensation defaults to 29 / 25.5 (about 113.7%): the user measured a circular image as 29 mm across and 25.5 mm along the paper. Expand the monochrome rows with nearest-neighbor sampling after rendering all input types. Keep the preview and PNG at intended proportions; the hardware raster alone includes compensation. Store the adjustable correction locally and enforce the 1536-row limit after correction.

## Delivery

Serve only the `site/` directory through GitHub Pages. Use relative asset URLs for the repository path. Text, imported images, drawings, and QR data stay in browser memory. The QR encoder is vendored from qrcode-generator 2.0.4 (MIT); canvas rendering and QR decoding packages are development-only dependencies.

The user approved Wikimedia Commons instead of Google for the graphics gallery. Google Custom Search JSON API is closed to new customers and retires on 2027-01-01 (Google documentation checked during this change). Commons search and its thumbnail server returned CORS-enabled responses during integration checks. Display source and license metadata beside each selected image; searches and image requests go directly to Wikimedia.

The user created the `thermprint` organization and has active admin membership, verified through GitHub's API. Publish the branded site at `https://thermprint.github.io/` from `thermprint/thermprint.github.io`. Keep `rawsock/thermprint` as the development upstream and the original project site available. This workspace has a `pages` remote and two `origin` push URLs so ordinary pushes update both repositories; fetching and branch tracking stay on `rawsock/thermprint`. Changes made outside this workspace also need to reach both repositories. No personal account homepage is used.

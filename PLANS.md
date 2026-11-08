# ThermPrint project decisions

The user requested a browser printing app hosted on GitHub Pages, with `rawsock/thermprint` as its upstream. Use static HTML/CSS/JavaScript for the browser runtime; retain Python for the existing diagnostics. See README.md for usage and development commands.

## Printer

The TEDi SWS-PT1 supports custom BLE printing through FFE6/FFE1/FFE2. On 2026-11-08 the Python diagnostic completed authentication and a 120-packet calibration job, including transfer and footer acknowledgements; the user confirmed a good physical print. The calibration width is 384 dots. Application authentication derives its response from the printer-reported MAC rather than a fixed device address.

The browser port preserves 100-byte application packets and conservative 40 ms pacing. It honors printer holds and one-based retry requests, and requires the matching completion acknowledgement. Automatic replay after disconnect is excluded because already printed paper cannot be recalled. Browser/OS support for the required BLE payload still needs physical validation separately from the Python test.

## Delivery

Serve only the `site/` directory through GitHub Pages. Use relative asset URLs for the repository path. Text and image content stays in browser memory. No server, external runtime dependencies, or service worker is needed for the first release.

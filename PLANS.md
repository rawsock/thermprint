# ThermPrint project decisions

The user requested a browser printing app hosted on GitHub Pages, with `rawsock/thermprint` as its upstream. Use static HTML/CSS/JavaScript for the browser runtime; retain Python for the existing diagnostics. See README.md for usage and development commands.

## Printer

The TEDi SWS-PT1 supports custom BLE printing through FFE6/FFE1/FFE2. On 2026-11-08 the Python diagnostic completed authentication and a 120-packet calibration job, including transfer and footer acknowledgements; the user confirmed a good physical print. The calibration width is 384 dots. Application authentication derives its response from the printer-reported MAC rather than a fixed device address.

The browser port preserves 100-byte application packets and conservative 40 ms pacing. It honors printer holds and one-based retry requests, and requires the matching completion acknowledgement. Automatic replay after disconnect is excluded because already printed paper cannot be recalled. The user subsequently confirmed that browser printing works.

Paper-feed compensation defaults to 29 / 25.5 (about 113.7%): the user measured a circular image as 29 mm across and 25.5 mm along the paper. Resize continuous gray tones before dithering so the final print grid has no duplicated dot rows; preserve nearest-neighbor binary correction for non-dithered text and QR codes. Keep the preview and PNG at intended proportions, with their own quantization at that resolution. Store the adjustable correction locally and enforce the 1536-row limit after correction.

## Image quality

Use serpentine Stucki diffusion for photos, with small deterministic threshold variation to break repeating patterns. Offer Atkinson as a crisper illustration option. Adjust input tones for ink balance, with contrast that preserves white/black endpoints and optional mild sharpening. Moving the diffusion threshold alone conserved nearly the same ink coverage and made the old slider ineffective.

Against the pre-change raster code in commit 3faba7b, a 384 × 256 constant-gray patch had 63 repeated adjacent rows after feed correction; the new print raster had zero. At ink settings 80/160/220, coverage changed from approximately 49.7/49.9/50.0% to 29.0/49.8/68.7% with neutral contrast. Regression tests cover tone density, clean white feed, corrected-size limits, and QR decoding. Sample photograph and gradient comparisons were visually inspected in software; physical print quality still needs confirmation.

## Delivery

Serve only the `site/` directory through GitHub Pages. Use relative asset URLs for the repository path. Text, imported images, drawings, and QR data stay in browser memory. The QR encoder is vendored from qrcode-generator 2.0.4 (MIT); canvas rendering and QR decoding packages are development-only dependencies.

The user approved Wikimedia Commons instead of Google for the graphics gallery. Google Custom Search JSON API is closed to new customers and retires on 2027-01-01 (Google documentation checked during this change). Commons search and its thumbnail server returned CORS-enabled responses during integration checks. Display source and license metadata beside each selected image; searches and image requests go directly to Wikimedia.

The user created the `thermprint` organization and has active admin membership, verified through GitHub's API. Publish the branded site at `https://thermprint.github.io/` from `thermprint/thermprint.github.io`. Keep `rawsock/thermprint` as the development upstream and the original project site available. This workspace has a `pages` remote and two `origin` push URLs so ordinary pushes update both repositories; fetching and branch tracking stay on `rawsock/thermprint`. Changes made outside this workspace also need to reach both repositories. No personal account homepage is used.

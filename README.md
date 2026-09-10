# GeoPDF Navigator

Offline-first GitHub Pages web app for field navigation on georeferenced PDFs. The app reads the embedded GeoPDF map frame, renders the PDF locally in the browser, and places the device's live GPS position over the map. It also isolates PDF.js from the IndexedDB copy so transferred/detached ArrayBuffers do not break offline storage.

## What this version supports

- GeoPDFs containing a `/Measure /GEO` viewport with `/GPTS` and `/LPTS` four-corner registration.
- ArcGIS Pro-style GeoPDF exports, including the supplied `Amethyst_Brook.pdf` test file.
- Browser device geolocation with high-accuracy mode.
- Local PDF persistence in IndexedDB, using an independent byte copy to avoid PDF.js ArrayBuffer detachment issues.
- PWA/service-worker caching so the application and PDF.js engine are available offline after the first online load.
- Pan, zoom, fit-to-screen, center-on-device, GPS accuracy circle, and basic status reporting.

## Deploy to GitHub Pages

1. Create an empty GitHub repository, for example `geopdf-navigator`.
2. Copy the contents of this folder into that repository and commit them to `main`.
3. In GitHub: **Settings → Pages → Build and deployment → Source → Deploy from a branch**.
4. Select `main` and `/ (root)` and save.
5. Open the generated HTTPS GitHub Pages URL on the phone/tablet.
6. Load a GeoPDF once while online. Wait until the app reports **Offline ready**.
7. Use the browser's **Install app** / **Add to Home Screen** action.

Because this is a plain static site, no Node.js build step is required.

## Offline workflow

The first successful load should be done while online so the service worker can cache the application and the PDF.js engine. Your uploaded PDF is stored locally in IndexedDB; it is not uploaded to a server by this app.

After the app reports **Offline ready**, test it before going into the field by enabling airplane mode (or otherwise disabling Wi-Fi/cellular) and reopening the installed app.

Device GPS itself does not require an internet connection, but the browser/device must provide location services and permission.

## GeoPDF georeferencing

For the supplied test PDF, the embedded map viewport is registered by four GPS control points and normalized local points. The app solves the inverse bilinear transform from latitude/longitude to PDF viewport coordinates, then uses the PDF.js page viewport to place the marker on the rendered page.

The test PDF is a 1-page, 612 × 792 pt ArcGIS Pro export with a map viewport BBox of approximately `[0, 67.9961, 612, 792]` and WGS84-style `GPTS` corners around 42.374–42.382 N, 72.488–72.479 W.

## Files

- `index.html` – application shell.
- `app.js` – GeoPDF parser, PDF renderer, GPS logic, overlay math, IndexedDB storage, and interactions.
- `sw.js` – offline application and PDF.js cache.
- `styles.css` – responsive field-oriented UI.
- `manifest.webmanifest` – PWA configuration.
- `icons/` – app icons.

## PDF.js

PDF.js is loaded from cdnjs version `6.3.289` and cached by the service worker for offline use. PDF.js is an Apache-2.0 licensed Mozilla project.

## Current limitations

This is a v0.1 prototype. It intentionally focuses on the GeoPDF format demonstrated by the supplied ArcGIS Pro file. PDFs with multiple map viewports, unusual `/Measure /GEO` layouts, image-only georeferencing, encrypted files, or non-four-corner registrations may need additional parser logic.

The position marker uses the PDF's geographic control points directly for the WGS84 map-frame placement. The embedded projected CRS is retained for metadata display but is not currently used for a separate projection pipeline because the PDF's `GPTS` values already provide geographic coordinates.

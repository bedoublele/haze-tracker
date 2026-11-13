# Haze Tracker SG

A progressive web app that shows Singapore's **24-hour PSI** and **1-hour PM2.5** for each region
(north, south, east, west, central) from NEA's real-time feeds on [data.gov.sg](https://data.gov.sg),
and sends a notification when the PSI in your chosen region reaches a threshold you set.

NEA publishes the PSI as a 24-hour figure. It has no 1-hour PSI, so the hourly reading shown is
1-hour PM2.5 (µg/m³), with NEA's bands.

## Run it

It is plain HTML/CSS/JS with no build step. Service workers and installing need HTTPS (or `localhost`):

```
python3 -m http.server 8000   # then open http://localhost:8000
```

To host it, enable **GitHub Pages** for the `main` branch (Settings → Pages). Open the Pages URL on a
phone, then **Add to Home Screen** (iOS: Share → Add to Home Screen; Android Chrome: menu → Install app).

## Alerts: what works where

An alert fires once when the region's 24-hour PSI reaches the threshold, then stays quiet until the PSI
drops back below it.

- **App open or recently used:** checked every 5 minutes. Works on any browser that supports notifications.
- **App closed, Android Chrome with the app installed:** the browser may check about hourly (Periodic
  Background Sync; the browser decides the timing).
- **iPhone/iPad:** notifications need the app added to the Home Screen first. iOS has no background
  checks without a push server, so alerts arrive while the app is open.

Reliable alerts with the app fully closed on every device need a small server that sends Web Push.
That is not included.

## Files

| File | Purpose |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | The app UI |
| `lib.js` | Fetching, parsing, bands and alert rules (shared by page, service worker and tests) |
| `sw.js` | Offline cache and background checks |
| `manifest.webmanifest`, `icons/` | Install metadata and the app icon |
| `tests/lib.test.js` | `node --test tests/lib.test.js` |

Data © National Environment Agency, used under the
[Singapore Open Data Licence](https://data.gov.sg/open-data-licence). Not an official NEA product.

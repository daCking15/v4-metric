# Roper TV Screensaver

A fullscreen, ambient TV screensaver that shows:

- **ROP (Roper Technologies)** live stock price, change, intraday sparkline, day/52-week range
- **Denver** clock and weather (Open-Meteo, no API key)
- A subtle animated starfield + grid background

Designed to look good on a big TV in fullscreen.

## Quick start

```bash
npm install
npm start
```

Then open `http://localhost:3000` and press `Cmd+Ctrl+F` (Safari) or `F11` (Chrome/Firefox) to enter fullscreen.

## How it works

- `server.js` — tiny Express app. Serves the static UI from `public/` and exposes a single
  `GET /api/quote?symbol=ROP` endpoint that proxies Yahoo Finance's public chart endpoint
  (avoids browser CORS issues). Results are cached for 15s.
- `public/index.html`, `styles.css`, `app.js` — the UI. The clock + weather are fetched
  directly from the browser (Open-Meteo is CORS-friendly). The stock price refreshes every 15s.

## Configuration

You can override the symbol or interval via query params if you want to embed it elsewhere
(e.g. an iframe):

```
GET /api/quote?symbol=ROP&range=1d&interval=2m
```

The UI itself is hard-coded to ROP and Denver — edit `public/app.js` and `public/index.html` to change.

## Running it as an actual screensaver

A couple of easy options:

1. **Browser kiosk mode.** On macOS, launch Chrome with:
   ```bash
   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
     --kiosk --app=http://localhost:3000
   ```
2. **AppleScript wake hook** or `caffeinate` to keep the display on while it's showing.
3. **Apple TV / Fire TV / etc.** — just point a browser app at the server's IP on your LAN
   (`http://<your-mac-ip>:3000`).

## Notes

- Yahoo's public chart endpoint is unofficial. If it ever rate-limits or breaks, swap the
  upstream in `server.js` for another provider (e.g. Finnhub, Polygon, Alpha Vantage — most
  free tiers will work fine for a 15s poll).
- The UI hides the cursor (`cursor: none`) since it's intended as a screensaver.

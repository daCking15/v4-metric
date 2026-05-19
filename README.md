# Roper TV Screensaver

A fullscreen, ambient TV screensaver. Shows:

- **ROP (Roper Technologies)** live price, change, intraday sparkline, day open/high/low
- **Denver** clock and weather (Open-Meteo, no key)
- A scrolling news ticker (Roper / Vertafore / QQ Catalyst headlines)
- Animated starfield + grid background
- Auto-hiding cursor

Designed for a TV in fullscreen.

---

## Architecture

```
┌───────────────────────┐        ┌────────────────────────────┐
│ Static site           │  GET   │ Cloudflare Worker          │
│ (GitHub Pages, S3,    │ /api/* │ (proxies Nasdaq + Google   │
│  local Express, etc.) │ ─────▶ │  News, sets CORS headers)  │
└───────────────────────┘        └────────────────────────────┘
```

The frontend reads `public/config.js` for `API_BASE`:
- Empty string → calls same-origin `/api/*` (so the bundled Node server can serve everything during local dev).
- A Worker URL → calls the Worker (required for any static deploy like GitHub Pages, since GH Pages has no backend).

---

## Local development (Node)

```bash
npm install
npm start
```

Open <http://localhost:3000>. `server.js` proxies Nasdaq + Google News and serves `public/` — same as before.

---

## Deploy: GitHub Pages (frontend) + Cloudflare Worker (backend)

### 1. Deploy the Cloudflare Worker

You only need to do this once. The Worker is the same proxy logic as `server.js`, just on Cloudflare's edge — free tier (100k req/day) covers this screensaver ~10x over.

```bash
npx wrangler login        # opens browser to authenticate (one-time)
npx wrangler deploy       # uses wrangler.toml + worker.js
```

Wrangler prints the deployed URL, e.g.:

```
Published rop-screensaver-proxy
  https://rop-screensaver-proxy.<your-handle>.workers.dev
```

Sanity-check it:

```bash
curl https://rop-screensaver-proxy.<your-handle>.workers.dev/api/quote?symbol=ROP | head -c 400
```

> Prefer clicking around? You can also create the worker via the Cloudflare dashboard:
> *Workers & Pages → Create → Hello World → Edit code → paste `worker.js` → Deploy.*

### 2. Point the frontend at the Worker

Edit `public/config.js`:

```js
window.APP_CONFIG = {
  API_BASE: "https://rop-screensaver-proxy.<your-handle>.workers.dev",
};
```

### 3. Push to GitHub & enable Pages

```bash
git add -A
git commit -m "Deploy"
git push
```

In your GitHub repo:

1. **Settings → Pages**
2. **Source:** *GitHub Actions*

That's it. The included workflow (`.github/workflows/deploy.yml`) publishes `public/` whenever you push to `main`. The site URL will be `https://<you>.github.io/<repo>/`.

---

## Configuration

`public/config.js`:

| Key        | What it does                                                            |
| ---------- | ----------------------------------------------------------------------- |
| `API_BASE` | Worker URL. Leave empty for same-origin (local Express).                |

`wrangler.toml` — Cloudflare Worker name + compatibility date. Change `name` if you want a different `*.workers.dev` subdomain.

To swap the tracked symbol or city, edit `public/app.js` and `worker.js` (the symbol list is hardcoded right now).

---

## Running as an actual screensaver

```bash
# Chrome kiosk against your deployed Pages URL
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --kiosk --app="https://<you>.github.io/<repo>/"
```

Pair with `caffeinate -d` to keep the display awake.

For TVs that have a built-in browser (Apple TV, Fire TV), just open the GitHub Pages URL.

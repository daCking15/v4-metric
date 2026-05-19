// Frontend runtime config.
//
// API_BASE = where the screensaver fetches /api/quote and /api/news from.
//
//   ""  (empty)                     → same-origin (default; works with the
//                                     bundled Node server on localhost:3000)
//   "https://YOUR-WORKER.workers.dev"
//                                   → calls your deployed Cloudflare Worker
//                                     (required for GitHub Pages / S3 / any
//                                     static host)
//
// Edit this value before deploying to GitHub Pages.
window.APP_CONFIG = {
  API_BASE: "https://rop-screensaver-proxy.unclosableschooltest.workers.dev",
};

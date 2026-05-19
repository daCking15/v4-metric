// Frontend runtime config.
//
// API_BASE = where the screensaver fetches /api/quote and /api/news from.
//
//   ""  (empty)                     → same-origin (page served by npm start)
//   "http://HOST:3000"              → Live Server / VS Code on another port
//   "https://YOUR-WORKER.workers.dev" → GitHub Pages / static deploy
//
// Edit WORKER_URL before deploying to GitHub Pages.
const WORKER_URL =
  "https://rop-screensaver-proxy.unclosableschooltest.workers.dev";

function resolveApiBase() {
  if (typeof location === "undefined") return WORKER_URL;
  const host = location.hostname;
  const port = location.port;
  const isLocal = host === "localhost" || host === "127.0.0.1";
  if (!isLocal) return WORKER_URL;
  // Page opened via `npm start` — API is on the same origin.
  if (port === "3000" || port === "") return "";
  // Live Server (:5500), etc. — API runs on the Node server.
  return `${location.protocol}//${host}:3000`;
}

window.APP_CONFIG = {
  API_BASE: resolveApiBase(),
};

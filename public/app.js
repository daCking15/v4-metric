// ---------- Config ----------
// API_BASE comes from public/config.js. Empty string = same-origin (the
// bundled Express server). Set to your Cloudflare Worker URL when deploying
// to GitHub Pages / any other static host.
const API_BASE = (
  (typeof window !== "undefined" && window.APP_CONFIG && window.APP_CONFIG.API_BASE) ||
  ""
).replace(/\/$/, "");
const api = (path) => `${API_BASE}${path}`;

// ---------- Performance / lite mode ----------
const LITE_STORAGE_KEY = "rop-screensaver:liteMode";

/** True when opened via /debug (see public/debug/index.html) or ?debug=1 */
function isDebugUrl() {
  if (typeof window !== "undefined" && window.APP_BOOT?.debugRoute) return true;
  try {
    if (new URLSearchParams(location.search).get("debug") === "1") return true;
  } catch {
    /* ignore */
  }
  const path = (location.pathname || "")
    .replace(/\/index\.html$/i, "")
    .replace(/\/+$/, "");
  return path === "/debug" || path.endsWith("/debug");
}

function loadLiteMode() {
  if (isDebugUrl()) return true;
  try {
    const v = localStorage.getItem(LITE_STORAGE_KEY);
    if (v === "1") return true;
    if (v === "0") return false;
  } catch {
    /* ignore */
  }
  return true;
}

function saveLiteMode(on) {
  try {
    localStorage.setItem(LITE_STORAGE_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

let liteMode = loadLiteMode();
if (liteMode) document.documentElement.classList.add("lite");
let stopAmbientBg = null;
let lastQuoteData = null;
let lastNewsItems = null;

function applyPerformanceMode(on) {
  liteMode = !!on;
  saveLiteMode(liteMode);
  document.documentElement.classList.toggle("lite", liteMode);

  if (liteMode) {
    if (stopAmbientBg) {
      stopAmbientBg();
      stopAmbientBg = null;
    }
    const cvs = document.getElementById("bg");
    if (cvs) {
      const ctx = cvs.getContext("2d");
      if (ctx) ctx.clearRect(0, 0, cvs.width, cvs.height);
    }
  } else if (!stopAmbientBg) {
    startAmbientBg();
  }

  if (lastQuoteData) {
    const q = lastQuoteData;
    const prev = q.previousClose;
    const price = q.price;
    const change =
      Number.isFinite(price) && Number.isFinite(prev) ? price - prev : NaN;
    scheduleSparkDraw(q.series, prev, change, q);
  }

  if (lastNewsItems) renderNews(lastNewsItems);

  if (diag.isDebugEnabled()) diag.refresh();
}

function startAmbientBg() {
  if (stopAmbientBg) return;
  try {
    stopAmbientBg = ambientBg();
  } catch (err) {
    console.warn("ambient bg disabled:", err);
  }
}

async function fetchWithTimeout(url, ms = 22_000) {
  if (typeof AbortController === "undefined") return fetch(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function downsampleSeries(points, max) {
  if (!points || points.length <= max) return points ? points.slice() : [];
  const out = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

/** Vertical spacing between staggered label rows when labels overlap horizontally. */
const CHART_LABEL_ROW_STEP = 32;
/** Space between the vertical guide and the left edge of the label text. */
const CHART_LABEL_PAD_LEFT = 8;
/** Equal gap above/below label ink where guides are hidden. */
const CHART_LABEL_MASK_PAD_Y = 5;

function measureLabelInk(ctx, text) {
  const prev = ctx.textBaseline;
  ctx.textBaseline = "alphabetic";
  const m = ctx.measureText(text);
  ctx.textBaseline = prev;
  const inkAscent = m.actualBoundingBoxAscent || m.fontBoundingBoxAscent || 14;
  const inkDescent = m.actualBoundingBoxDescent || m.fontBoundingBoxDescent || 4;
  return {
    width: m.width,
    inkAscent,
    inkDescent,
    inkHeight: inkAscent + inkDescent,
  };
}

/** Draw a vertical dashed guide, skipping symmetric gaps over other labels at this X. */
function strokeVerticalGuide(ctx, x, yTop, yBottom, placed, skip = null) {
  const blocks = placed
    .filter((p) => p !== skip && x >= p.left && x <= p.right)
    .map((p) => ({ top: p.maskTop, bottom: p.maskBottom }))
    .sort((a, b) => a.top - b.top);

  let y = yTop;
  for (const block of blocks) {
    if (y >= yBottom) break;
    if (block.bottom <= y) continue;
    if (block.top > yBottom) break;
    if (block.top > y) {
      ctx.moveTo(x, y);
      ctx.lineTo(x, block.top);
    }
    y = Math.max(y, block.bottom);
  }
  if (y < yBottom) {
    ctx.moveTo(x, y);
    ctx.lineTo(x, yBottom);
  }
}
/** Headlines shown in the scrolling ticker (keep small for fast load on TV). */
const NEWS_TICKER_LIMIT = 5;
const NEWS_CACHE_KEY = "rop-screensaver:news-v2";
const NEWS_TICKER_MIN_LOOP_SEC = 18;
const NEWS_TICKER_PX_PER_SEC = 100;

/** Y on the drawn polyline at time `t` (so markers sit on the visible chart). */
function chartYOnPlottedSeries(pts, t, py) {
  if (!pts?.length) return null;
  if (t <= pts[0].t) return py(pts[0].c);
  const last = pts[pts.length - 1];
  if (t >= last.t) return py(last.c);
  for (let i = 1; i < pts.length; i++) {
    const b = pts[i];
    if (b.t >= t) {
      const a = pts[i - 1];
      const span = b.t - a.t;
      const u = span > 0 ? (t - a.t) / span : 0;
      return py(a.c + (b.c - a.c) * u);
    }
  }
  return py(pts[0].c);
}

/**
 * Position OPEN/HIGH/LOW labels beside the guide (X + pad), stagger rows on
 * overlap, and compute how far each guide line extends (lower rows run longer).
 */
function layoutChartEventLabels(ctx, events, options) {
  const {
    font,
    px,
    clampX,
    baseY,
    rowStep = CHART_LABEL_ROW_STEP,
    overlapGap = 12,
    maxRows = 3,
    minLabelX = 0,
    maxLabelRight = Infinity,
    labelPadLeft = CHART_LABEL_PAD_LEFT,
  } = options;

  ctx.save();
  ctx.font = font;

  const placed = [...events]
    .sort((a, b) => px(a.t) - px(b.t))
    .map((ev) => {
      const X = clampX(px(ev.t));
      const { width: tw, inkAscent, inkHeight } = measureLabelInk(ctx, ev.label);
      // Sit label just to the right of the guide (not flush on the line).
      let labelX = X + labelPadLeft;
      if (labelX < minLabelX) labelX = minLabelX;
      return {
        ev,
        X,
        labelX,
        left: labelX,
        right: labelX + tw,
        tw,
        row: 0,
        inkAscent,
        inkHeight,
        lblY: 0,
        drawY: 0,
        maskTop: 0,
        maskBottom: 0,
        lineEndY: 0,
      };
    });

  for (let i = 0; i < placed.length; i++) {
    for (let row = 0; row < maxRows; row++) {
      let fits = true;
      for (let j = 0; j < i; j++) {
        if (placed[j].row !== row) continue;
        if (
          placed[i].left - overlapGap < placed[j].right &&
          placed[i].right + overlapGap > placed[j].left
        ) {
          fits = false;
          break;
        }
      }
      if (fits) {
        placed[i].row = row;
        break;
      }
      if (row === maxRows - 1) placed[i].row = row;
    }
  }

  for (const p of placed) {
    // lblY = top of painted glyphs (not em-box top — avoids extra gap above cap height).
    p.lblY = baseY + p.row * rowStep;
    p.drawY = p.lblY + p.inkAscent;
    p.maskTop = p.lblY - CHART_LABEL_MASK_PAD_Y;
    p.maskBottom = p.lblY + p.inkHeight + CHART_LABEL_MASK_PAD_Y;
    p.lineEndY = p.lblY + p.inkHeight / 2;
  }

  ctx.restore();
  return placed;
}

function drawChartEventGuidesAndLabels(
  ctx,
  placed,
  py,
  { plottedPts, ringRadius = 5, ringWidth = 2, glow = false },
) {
  const markerY = (p) => {
    if (p.ev.isOpen) return py(p.ev.price);
    return chartYOnPlottedSeries(plottedPts, p.ev.t, py) ?? py(p.ev.price);
  };

  ctx.setLineDash([3, 4]);
  ctx.lineWidth = 1;
  for (const p of placed) {
    const Y = markerY(p);
    ctx.strokeStyle = p.ev.lineColor;
    ctx.beginPath();
    strokeVerticalGuide(ctx, p.X, Y, p.lineEndY, placed, p);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  for (const p of placed) {
    const Y = markerY(p);
    ctx.save();
    if (glow) {
      ctx.shadowColor = p.ev.color;
      ctx.shadowBlur = 12;
    }
    ctx.strokeStyle = p.ev.color;
    ctx.lineWidth = glow ? 2.2 : ringWidth;
    ctx.beginPath();
    ctx.arc(p.X, Y, ringRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  for (const p of placed) {
    ctx.fillStyle = p.ev.color;
    ctx.fillText(p.ev.label, p.labelX, p.drawY);
  }
}

/**
 * Series point to anchor a HIGH/LOW ring on the drawn line. Label text may still
 * use the official quote value; Y position always uses the intraday close at `t`.
 */
function findExtremePoint(points, mode, officialPrice) {
  if (!points?.length) return null;
  const better =
    mode === "high"
      ? (a, b) => (a.c > b.c ? a : b)
      : (a, b) => (a.c < b.c ? a : b);
  if (Number.isFinite(officialPrice)) {
    const tol = Math.max(0.02, officialPrice * 1e-4);
    const match = points.filter((p) => Math.abs(p.c - officialPrice) <= tol);
    if (match.length) return match.reduce(better, match[0]);
    return points.reduce(
      (best, p) =>
        Math.abs(p.c - officialPrice) < Math.abs(best.c - officialPrice) ? p : best,
      points[0],
    );
  }
  return points.reduce(better, points[0]);
}

function buildChartEvents({ points, openTime, openPrice, highPrice, lowPrice, currentPrice }) {
  const events = [];
  const sameish = (a, b) => Math.abs(a - b) < 0.005;
  if (Number.isFinite(openPrice)) {
    events.push({
      t: openTime,
      price: openPrice,
      isOpen: true,
      color: "rgba(220, 230, 250, 0.95)",
      lineColor: "rgba(255,255,255,0.5)",
      label: `OPEN $${openPrice.toFixed(2)}`,
    });
  }
  if (
    Number.isFinite(highPrice) &&
    !(Number.isFinite(openPrice) && sameish(highPrice, openPrice)) &&
    !(Number.isFinite(currentPrice) && sameish(highPrice, currentPrice))
  ) {
    const pt = findExtremePoint(points, "high", highPrice) || {
      t: openTime,
      c: highPrice,
    };
    events.push({
      t: pt.t,
      price: pt.c,
      color: "#2ee07a",
      lineColor: "rgba(46,224,122,0.6)",
      label: `HIGH $${highPrice.toFixed(2)}`,
    });
  }
  if (
    Number.isFinite(lowPrice) &&
    !(Number.isFinite(openPrice) && sameish(lowPrice, openPrice)) &&
    !(Number.isFinite(currentPrice) && sameish(lowPrice, currentPrice))
  ) {
    const pt = findExtremePoint(points, "low", lowPrice) || {
      t: openTime,
      c: lowPrice,
    };
    events.push({
      t: pt.t,
      price: pt.c,
      color: "#ff5470",
      lineColor: "rgba(255,84,112,0.6)",
      label: `LOW $${lowPrice.toFixed(2)}`,
    });
  }
  return events;
}

// ---------- Diagnostics (on-screen, since TV browsers have no devtools) ----------
const DEBUG_STORAGE_KEY = "rop-screensaver:debugPanel";

function loadDebugEnabled() {
  if (isDebugUrl()) return true;
  try {
    const v = localStorage.getItem(DEBUG_STORAGE_KEY);
    if (v === "1") return true;
    if (v === "0") return false;
  } catch {
    /* ignore */
  }
  return false;
}

function saveDebugEnabled(on) {
  try {
    localStorage.setItem(DEBUG_STORAGE_KEY, on ? "1" : "0");
  } catch {
    /* private mode / quota */
  }
}

const diag = (() => {
  const slots = { quote: "…", weather: "…", news: "…" };
  const errors = [];
  let debugEnabled = loadDebugEnabled();
  const el = document.getElementById("diag");

  function applyVisibility() {
    if (!el) return;
    if (!debugEnabled) {
      el.classList.add("hidden");
      return;
    }
    el.classList.remove("hidden");
  }

  function render() {
    if (!el || !debugEnabled) return;
    const lines = [
      `Stock:   ${slots.quote}`,
      `Weather: ${slots.weather}`,
      `News:    ${slots.news}`,
      `Build:   v21 · ${liteMode ? "lite" : "full"}${isDebugUrl() ? " · /debug" : ""} · API: ${API_BASE || "(same-origin)"}`,
    ];
    if (errors.length) {
      lines.push("");
      lines.push("Recent errors:");
      for (const e of errors.slice(-3)) lines.push(`· ${e}`);
    }
    el.textContent = lines.join("\n");
    applyVisibility();
  }

  function set(slot, msg) {
    slots[slot] = String(msg);
    render();
  }
  function err(msg) {
    const s = String(msg || "").slice(0, 90);
    if (s) errors.push(s);
    if (errors.length > 5) errors.splice(0, errors.length - 5);
    render();
  }

  function setDebugEnabled(on) {
    debugEnabled = !!on;
    saveDebugEnabled(debugEnabled);
    const toggle = document.getElementById("debugToggle");
    if (toggle) toggle.checked = debugEnabled;
    applyVisibility();
    render();
  }

  window.addEventListener("error", (e) =>
    err(`JS: ${e.message || (e.error && e.error.message) || "error"}`),
  );
  window.addEventListener("unhandledrejection", (e) =>
    err(
      `Promise: ${(e.reason && (e.reason.message || e.reason)) || "unhandled"}`,
    ),
  );

  applyVisibility();

  return {
    set,
    err,
    refresh: render,
    setDebugEnabled,
    isDebugEnabled: () => debugEnabled,
  };
})();

// ---------- Settings ----------
function initSettings() {
  const btn = document.getElementById("settingsBtn");
  const panel = document.getElementById("settingsPanel");
  const debugToggle = document.getElementById("debugToggle");
  const liteToggle = document.getElementById("liteToggle");
  if (!btn || !panel) return;

  if (debugToggle) debugToggle.checked = diag.isDebugEnabled();
  if (liteToggle) liteToggle.checked = liteMode;

  function setPanelOpen(open) {
    panel.classList.toggle("hidden", !open);
    panel.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    setPanelOpen(panel.hidden);
  });

  panel.addEventListener("click", (e) => e.stopPropagation());

  if (debugToggle) {
    debugToggle.addEventListener("change", () => {
      diag.setDebugEnabled(debugToggle.checked);
    });
  }

  if (liteToggle) {
    liteToggle.addEventListener("change", () => {
      applyPerformanceMode(liteToggle.checked);
    });
  }

  document.addEventListener("click", (e) => {
    if (panel.hidden) return;
    if (panel.contains(e.target) || btn.contains(e.target)) return;
    setPanelOpen(false);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) setPanelOpen(false);
  });
}

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const els = {
  time: $("time"),
  ampm: $("ampm"),
  date: $("date"),
  marketState: $("marketState"),
  marketStateDot: $("marketStateDot"),
  price: $("price"),
  change: $("change"),
  changePct: $("changePct"),
  changeArrow: $("changeArrow"),
  changeRow: document.querySelector(".change-row"),
  tickerTrack: $("tickerTrack"),
  wxIcon: $("wxIcon"),
  wxTemp: $("wxTemp"),
  wxDesc: $("wxDesc"),
  spark: $("spark"),
  bg: $("bg"),
};

// ---------- Formatters ----------
const fmtMoney = (v) =>
  Number.isFinite(v)
    ? v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "—";
const fmtSigned = (v) => (v >= 0 ? "+" : "") + fmtMoney(v);
const fmtPct = (v) =>
  Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}%` : "—";

// ---------- Clock (Denver) ----------
const TZ = "America/Denver";
function tickClock() {
  const now = new Date();
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(now);
  // Split off AM/PM
  const [hm, ampm] = time.split(" ");
  els.time.textContent = hm;
  els.ampm.textContent = ampm || "";
  els.date.textContent = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
  })
    .format(now)
    .toUpperCase();
}
function tick() {
  tickClock();
  renderMarketState();
}
tick();
setInterval(tick, 1000);

// ---------- Market state (US Eastern, regardless of data source) ----------
function getMarketState() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const wk = parts.find((p) => p.type === "weekday").value;
  const hh = parseInt(parts.find((p) => p.type === "hour").value, 10);
  const mm = parseInt(parts.find((p) => p.type === "minute").value, 10);
  const mins = hh * 60 + mm;
  const isWeekday = !["Sat", "Sun"].includes(wk);
  if (!isWeekday) return { label: "Market Closed", cls: "closed" };
  if (mins >= 4 * 60 && mins < 9 * 60 + 30)
    return { label: "Pre-Market", cls: "pre-post" };
  if (mins >= 9 * 60 + 30 && mins < 16 * 60)
    return { label: "Market Open", cls: "open" };
  if (mins >= 16 * 60 && mins < 20 * 60)
    return { label: "After Hours", cls: "pre-post" };
  return { label: "Market Closed", cls: "closed" };
}

function renderMarketState() {
  const s = getMarketState();
  els.marketState.textContent = s.label;
  els.marketStateDot.className = "state-dot " + s.cls;
}

// ---------- Stock ----------
let lastPrice = null;

async function fetchQuote() {
  try {
    diag.set("quote", "fetching…");
    const r = await fetchWithTimeout(api("/api/quote?symbol=ROP&range=1d&interval=2m"));
    if (!r.ok) {
      diag.set("quote", `HTTP ${r.status}`);
      return;
    }
    const q = await r.json();
    renderQuote(q);
    diag.set("quote", `OK @ ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    diag.set("quote", `FAIL: ${(err && err.message) || err}`);
  }
}

function renderQuote(q) {
  lastQuoteData = q;
  const price = q.price;
  const prev = q.previousClose;
  const change = Number.isFinite(price) && Number.isFinite(prev) ? price - prev : NaN;
  const changePct = Number.isFinite(change) && prev ? (change / prev) * 100 : NaN;

  // Price + flash on movement
  els.price.textContent = "$" + fmtMoney(price);
  if (Number.isFinite(lastPrice) && Number.isFinite(price) && price !== lastPrice) {
    els.price.classList.remove("flash-up", "flash-down");
    void els.price.offsetWidth; // restart animation
    els.price.classList.add(price > lastPrice ? "flash-up" : "flash-down");
  }
  lastPrice = price;

  // Change row
  els.change.textContent = fmtSigned(change);
  els.changePct.textContent = `(${fmtPct(changePct)})`;
  els.changeRow.classList.remove("up", "down", "flat");
  if (!Number.isFinite(change)) {
    els.changeRow.classList.add("flat");
    els.changeArrow.textContent = "·";
  } else if (change > 0) {
    els.changeRow.classList.add("up");
    els.changeArrow.textContent = "▲";
  } else if (change < 0) {
    els.changeRow.classList.add("down");
    els.changeArrow.textContent = "▼";
  } else {
    els.changeRow.classList.add("flat");
    els.changeArrow.textContent = "—";
  }

  scheduleSparkDraw(q.series, prev, change, q);
}

let sparkDrawPending = 0;
function scheduleSparkDraw(series, prev, change, quote) {
  if (sparkDrawPending) cancelAnimationFrame(sparkDrawPending);
  sparkDrawPending = requestAnimationFrame(() => {
    sparkDrawPending = 0;
    if (liteMode) drawSparkLite(series, prev, change, quote);
    else drawSpark(series, prev, change, quote);
  });
}

// ---------- Sparkline ----------
// Returns ms-since-epoch for today's 9:30 ET (open) and 16:00 ET (close).
function tradingDayBounds() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const o = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const y = +o.year;
  const mo = +o.month;
  const d = +o.day;
  // ET offset behind UTC, in minutes (positive value)
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const etMin = parseInt(o.hour, 10) * 60 + parseInt(o.minute, 10);
  let diff = utcMin - etMin;
  if (diff < -12 * 60) diff += 24 * 60;
  if (diff > 12 * 60) diff -= 24 * 60;
  return {
    open: Date.UTC(y, mo - 1, d, 9, 30) + diff * 60_000,
    close: Date.UTC(y, mo - 1, d, 16, 0) + diff * 60_000,
  };
}

// Lightweight chart for Performance mode — same OPEN/HIGH/LOW markers + vertical
// guide lines as the full chart, without shadows or expensive compositing.
function drawSparkLite(series, prev, change, quote) {
  const cvs = els.spark;
  if (!cvs) return;
  const ctx = cvs.getContext("2d");
  const dpr = 1;
  const w = cvs.clientWidth;
  const h = cvs.clientHeight;
  if (w < 2 || h < 2) return;
  cvs.width = w * dpr;
  cvs.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const EVENT_FONT = "600 16px 'Space Grotesk', system-ui, sans-serif";
  const AXIS_H = 108;
  const chartH = h - AXIS_H;
  const labelBaseY = chartH + 14;
  const { open: openTime, close: closeTime } = tradingDayBounds();
  const xMin = openTime;
  const xMax = closeTime;
  const CHART_PAD = Math.max(56, Math.min(96, w * 0.06));

  let pts = (series || [])
    .filter((p) => Number.isFinite(p.c) && p.t >= openTime - 60_000 && p.t <= closeTime + 60_000)
    .sort((a, b) => a.t - b.t);
  const ptsFull = pts;
  pts = downsampleSeries(pts, 72);

  const openPrice = Number.isFinite(quote?.open) ? quote.open : pts[0]?.c ?? null;
  if (pts.length === 0 && !Number.isFinite(openPrice)) return;

  const highPrice = Number.isFinite(quote?.dayHigh)
    ? quote.dayHigh
    : pts.length
      ? Math.max(...pts.map((p) => p.c))
      : openPrice;
  const lowPrice = Number.isFinite(quote?.dayLow)
    ? quote.dayLow
    : pts.length
      ? Math.min(...pts.map((p) => p.c))
      : openPrice;
  const currentPrice = pts.at(-1)?.c ?? null;

  const refs = [openPrice, highPrice, lowPrice, ...pts.map((p) => p.c)].filter(Number.isFinite);
  let yMin = Math.min(...refs);
  let yMax = Math.max(...refs);
  if (yMin === yMax) {
    yMin -= 0.5;
    yMax += 0.5;
  }
  const yPad = Math.max((yMax - yMin) * 0.12, 0.25);
  yMin -= yPad;
  yMax += yPad;

  const plotW = w - CHART_PAD * 2;
  const px = (t) => CHART_PAD + ((t - xMin) / Math.max(1, xMax - xMin)) * plotW;
  const py = (c) => chartH - ((c - yMin) / Math.max(0.0001, yMax - yMin)) * chartH;
  const clampX = (x) => Math.max(CHART_PAD, Math.min(w - CHART_PAD, x));

  const up = change >= 0;
  const stroke = up ? "#2ee07a" : "#ff5470";
  const fill1 = up ? "rgba(46,224,122,0.18)" : "rgba(255,84,112,0.18)";

  ctx.strokeStyle = "rgba(255,255,255,0.1)";
  ctx.beginPath();
  ctx.moveTo(CHART_PAD, chartH);
  ctx.lineTo(w - CHART_PAD, chartH);
  ctx.stroke();

  if (Number.isFinite(openPrice)) {
    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.setLineDash([4, 6]);
    ctx.beginPath();
    ctx.moveTo(CHART_PAD, py(openPrice));
    ctx.lineTo(w - CHART_PAD, py(openPrice));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (pts.length >= 2) {
    ctx.fillStyle = fill1;
    ctx.beginPath();
    ctx.moveTo(px(pts[0].t), chartH);
    pts.forEach((p) => ctx.lineTo(px(p.t), py(p.c)));
    ctx.lineTo(px(pts[pts.length - 1].t), chartH);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    pts.forEach((p, i) => {
      const X = px(p.t);
      const Y = py(p.c);
      if (i === 0) ctx.moveTo(X, Y);
      else ctx.lineTo(X, Y);
    });
    ctx.stroke();
  }

  const events = buildChartEvents({
    points: ptsFull,
    openTime,
    openPrice,
    highPrice,
    lowPrice,
    currentPrice,
  });

  const placed = layoutChartEventLabels(ctx, events, {
    font: EVENT_FONT,
    px,
    clampX,
    baseY: labelBaseY,
    minLabelX: CHART_PAD,
    maxLabelRight: w - CHART_PAD,
  });

  ctx.font = EVENT_FONT;
  drawChartEventGuidesAndLabels(ctx, placed, py, {
    plottedPts: pts,
    ringRadius: 5,
    ringWidth: 2,
  });

  if (pts.length) {
    const lp = pts[pts.length - 1];
    ctx.fillStyle = stroke;
    ctx.beginPath();
    ctx.arc(clampX(px(lp.t)), py(lp.c), 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawSpark(series, prev, change, quote) {
  const cvs = els.spark;
  const ctx = cvs.getContext("2d");
  // Clamp DPR to 2 — on TVs that report 3+ this avoids gigantic bitmaps that
  // can OOM constrained browsers (Xbox, smart TVs).
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = cvs.clientWidth;
  const h = cvs.clientHeight;
  cvs.width = w * dpr;
  cvs.height = h * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  // Reserve a strip at the bottom for the x-axis: tick marks, event labels
  // on up to two staggered rows, and hour labels on a row below those.
  // Sized for TV legibility.
  const EVENT_FONT = "600 18px 'Space Grotesk', system-ui, sans-serif";
  const HOUR_FONT = "500 15px 'Space Grotesk', system-ui, sans-serif";
  const AXIS_H = 108;
  const chartH = h - AXIS_H;
  const labelBaseY = chartH + 14;
  const HOUR_LBL_Y = chartH + 84;

  // X axis: regular trading session, 9:30 → 16:00 ET.
  const { open: openTime, close: closeTime } = tradingDayBounds();
  const xMin = openTime;
  const xMax = closeTime;

  const pts = series
    .filter((p) => Number.isFinite(p.c) && p.t >= openTime - 60_000 && p.t <= closeTime + 60_000)
    .sort((a, b) => a.t - b.t);

  const openPrice = Number.isFinite(quote?.open)
    ? quote.open
    : pts[0]?.c ?? null;
  if (pts.length === 0 && !Number.isFinite(openPrice)) return;

  const ys = pts.map((p) => p.c);
  const highPrice = Number.isFinite(quote?.dayHigh)
    ? quote.dayHigh
    : ys.length
      ? Math.max(...ys)
      : openPrice;
  const lowPrice = Number.isFinite(quote?.dayLow)
    ? quote.dayLow
    : ys.length
      ? Math.min(...ys)
      : openPrice;
  const currentPrice = pts.at(-1)?.c ?? null;

  const refs = [openPrice, highPrice, lowPrice, ...ys].filter(Number.isFinite);
  let yMin = Math.min(...refs);
  let yMax = Math.max(...refs);
  if (yMin === yMax) {
    yMin -= 0.5;
    yMax += 0.5;
  }
  const yPad = Math.max((yMax - yMin) * 0.15, 0.25);
  yMin -= yPad;
  yMax += yPad;

  const px = (t) => ((t - xMin) / Math.max(1, xMax - xMin)) * w;
  const py = (c) => chartH - ((c - yMin) / Math.max(0.0001, yMax - yMin)) * chartH;

  const up = change >= 0;
  const stroke = up ? "#2ee07a" : "#ff5470";
  const glow = up ? "rgba(46,224,122,0.5)" : "rgba(255,84,112,0.5)";
  const fill1 = up ? "rgba(46,224,122,0.22)" : "rgba(255,84,112,0.22)";

  // ---- Hourly gridlines + axis ticks + hour labels (Mountain Time).
  // NYSE regular session 9:30 AM – 4:00 PM ET = 7:30 AM – 2:00 PM MT.
  const hourLabel = (hour) =>
    hour === 12 ? "12 PM" : hour > 12 ? `${hour - 12} PM` : `${hour} AM`;

  ctx.save();
  ctx.font = HOUR_FONT;
  ctx.textBaseline = "top";
  for (let mtHour = 8; mtHour <= 14; mtHour++) {
    // MT hour H corresponds to (H - 7.5) hours after the 7:30 AM MT open.
    const t = openTime + (mtHour - 7.5) * 3600_000;
    const X = px(t);
    if (X < 0 || X > w) continue;
    ctx.strokeStyle = "rgba(255,255,255,0.04)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(X, 0);
    ctx.lineTo(X, chartH);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.beginPath();
    ctx.moveTo(X, chartH);
    ctx.lineTo(X, chartH + 4);
    ctx.stroke();
    let align = "center";
    if (X < 24) align = "left";
    else if (X > w - 24) align = "right";
    ctx.textAlign = align;
    ctx.fillStyle = "rgba(160, 180, 210, 0.55)";
    ctx.fillText(hourLabel(mtHour), X, HOUR_LBL_Y);
  }
  // Axis baseline
  ctx.strokeStyle = "rgba(255,255,255,0.1)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, chartH);
  ctx.lineTo(w, chartH);
  ctx.stroke();
  ctx.restore();

  // ---- Faint open reference line (no label — label is in the axis strip)
  if (Number.isFinite(openPrice)) {
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.setLineDash([4, 6]);
    ctx.lineWidth = 1;
    const Y = py(openPrice);
    ctx.beginPath();
    ctx.moveTo(0, Y);
    ctx.lineTo(w, Y);
    ctx.stroke();
    ctx.restore();
  }

  // ---- Filled area + glowing line
  if (pts.length >= 2) {
    const grad = ctx.createLinearGradient(0, 0, 0, chartH);
    grad.addColorStop(0, fill1);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(px(pts[0].t), chartH);
    pts.forEach((p) => ctx.lineTo(px(p.t), py(p.c)));
    ctx.lineTo(px(pts[pts.length - 1].t), chartH);
    ctx.closePath();
    ctx.fill();

    ctx.save();
    ctx.shadowColor = glow;
    ctx.shadowBlur = 18;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    pts.forEach((p, i) => {
      const X = px(p.t);
      const Y = py(p.c);
      if (i === 0) ctx.moveTo(X, Y);
      else ctx.lineTo(X, Y);
    });
    ctx.stroke();
    ctx.restore();
  }

  // ---- Event markers (open / high / low) — vertical guide + label in axis strip.
  const events = buildChartEvents({
    points: pts,
    openTime,
    openPrice,
    highPrice,
    lowPrice,
    currentPrice,
  });

  // Clamp event X positions to a safe gutter so markers/rings never get cut
  // off at the canvas edges.
  const EDGE = 8;
  function clampX(rawX) {
    return Math.max(EDGE, Math.min(w - EDGE, rawX));
  }

  const placed = layoutChartEventLabels(ctx, events, {
    font: EVENT_FONT,
    px,
    clampX,
    baseY: labelBaseY,
    minLabelX: EDGE + 2,
    maxLabelRight: w - EDGE,
  });

  ctx.font = EVENT_FONT;
  drawChartEventGuidesAndLabels(ctx, placed, py, {
    plottedPts: pts,
    ringRadius: 6,
    ringWidth: 2.2,
    glow: true,
  });

  // ---- Current price end-dot
  if (pts.length) {
    const lp = pts[pts.length - 1];
    ctx.save();
    ctx.fillStyle = stroke;
    ctx.shadowColor = glow;
    ctx.shadowBlur = 28;
    ctx.beginPath();
    ctx.arc(px(lp.t), py(lp.c), 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// ---------- Weather (Open-Meteo, no key needed) ----------
const WX_CODES = {
  0:  ["Clear",            "☀"],
  1:  ["Mainly Clear",     "🌤"],
  2:  ["Partly Cloudy",    "⛅"],
  3:  ["Overcast",         "☁"],
  45: ["Fog",              "🌫"],
  48: ["Rime Fog",         "🌫"],
  51: ["Light Drizzle",    "🌦"],
  53: ["Drizzle",          "🌦"],
  55: ["Heavy Drizzle",    "🌧"],
  61: ["Light Rain",       "🌦"],
  63: ["Rain",             "🌧"],
  65: ["Heavy Rain",       "🌧"],
  66: ["Freezing Rain",    "🌧"],
  67: ["Freezing Rain",    "🌧"],
  71: ["Light Snow",       "🌨"],
  73: ["Snow",             "❄"],
  75: ["Heavy Snow",       "❄"],
  77: ["Snow Grains",      "❄"],
  80: ["Rain Showers",     "🌦"],
  81: ["Rain Showers",     "🌧"],
  82: ["Heavy Showers",    "⛈"],
  85: ["Snow Showers",     "🌨"],
  86: ["Snow Showers",     "❄"],
  95: ["Thunderstorm",     "⛈"],
  96: ["Thunder + Hail",   "⛈"],
  99: ["Severe Storm",     "⛈"],
};

async function fetchWeather() {
  try {
    diag.set("weather", "fetching…");
    const url =
      "https://api.open-meteo.com/v1/forecast" +
      "?latitude=39.7392&longitude=-104.9903" +
      "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,is_day" +
      "&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FDenver";
    const r = await fetchWithTimeout(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const c = data.current || {};
    const [desc, icon] = WX_CODES[c.weather_code] || ["—", "·"];
    els.wxTemp.textContent = `${Math.round(c.temperature_2m)}°`;
    els.wxIcon.textContent = icon;
    els.wxDesc.textContent = `${desc} · feels ${Math.round(c.apparent_temperature)}° · wind ${Math.round(c.wind_speed_10m)} mph`;
    diag.set("weather", `OK @ ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    els.wxDesc.textContent = "Weather offline";
    diag.set("weather", `FAIL: ${(err && err.message) || err}`);
  }
}

// ---------- Ambient background ----------
// Tuned for low-end displays (Xbox/Smart TV browsers). Key constraints:
//   * Canvas bitmap is pinned to DPR=1 — the bg is intentionally blurry, so a
//     1:1 backing store saves a LOT of memory on 4K @ DPR=2 (~130 MB → ~32 MB).
//   * Frame rate capped to ~30 fps to halve CPU vs. requestAnimationFrame's
//     native 60 fps.
//   * Star count hard-capped so 4K resolutions don't generate ~900 particles.
//   * Animation pauses when the tab/window is hidden.
function ambientBg() {
  const cvs = els.bg;
  const ctx = cvs.getContext("2d");
  let w, h;
  let running = true;
  const stars = [];
  const MAX_STARS = 320;
  const FRAME_INTERVAL_MS = 1000 / 30;

  function resize() {
    w = window.innerWidth;
    h = window.innerHeight;
    cvs.style.width = w + "px";
    cvs.style.height = h + "px";
    cvs.width = w;
    cvs.height = h;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    stars.length = 0;
    const N = Math.min(MAX_STARS, Math.floor((w * h) / 9000));
    for (let i = 0; i < N; i++) {
      stars.push({
        x: Math.random() * w,
        y: Math.random() * h,
        r: Math.random() * 1.4 + 0.2,
        a: Math.random() * 0.6 + 0.2,
        v: Math.random() * 0.02 + 0.005,
        phase: Math.random() * Math.PI * 2,
      });
    }
  }
  resize();
  window.addEventListener("resize", resize);

  let t = 0;
  let lastFrame = 0;
  function frame(now) {
    if (!running) return;
    requestAnimationFrame(frame);
    if (document.hidden) return;
    if (now - lastFrame < FRAME_INTERVAL_MS) return;
    lastFrame = now;
    t += 0.033;
    ctx.clearRect(0, 0, w, h);

    ctx.save();
    ctx.strokeStyle = "rgba(122, 162, 255, 0.05)";
    ctx.lineWidth = 1;
    const gap = 80;
    const ox = (t * 6) % gap;
    const oy = (t * 4) % gap;
    ctx.beginPath();
    for (let x = -gap + ox; x < w; x += gap) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    for (let y = -gap + oy; y < h; y += gap) {
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();
    ctx.restore();

    for (const s of stars) {
      s.phase += s.v;
      const a = s.a * (0.6 + 0.4 * Math.sin(s.phase));
      ctx.fillStyle = `rgba(200, 215, 255, ${a})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  requestAnimationFrame(frame);

  return () => {
    running = false;
    window.removeEventListener("resize", resize);
  };
}
// ---------- News ticker ----------
const HTML_ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => HTML_ESC[c]);

function newsItemsForTicker(items) {
  return (items || []).slice(0, NEWS_TICKER_LIMIT);
}

function readNewsCache() {
  try {
    const raw = sessionStorage.getItem(NEWS_CACHE_KEY);
    if (!raw) return null;
    const { items, at } = JSON.parse(raw);
    if (!Array.isArray(items) || Date.now() - at > 5 * 60_000) return null;
    return newsItemsForTicker(items);
  } catch {
    return null;
  }
}

function writeNewsCache(items) {
  try {
    sessionStorage.setItem(
      NEWS_CACHE_KEY,
      JSON.stringify({ items: newsItemsForTicker(items), at: Date.now() }),
    );
  } catch {
    /* private mode / quota */
  }
}

function tickerItemHtml(it) {
  return `
    <span class="ticker-item">
      ${it.source ? `<span class="src">${escapeHtml(it.source)}</span><span class="sep">·</span>` : ""}
      <span class="title">${escapeHtml(it.title)}</span>
    </span>`;
}

/** Start / restart the scroll animation (keyframes move -50% = one copy of the duplicated track). */
function applyTickerAnimation(track) {
  if (!track) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const loopWidth = Math.max(1, track.scrollWidth / 2);
      const seconds = Math.max(
        NEWS_TICKER_MIN_LOOP_SEC,
        Math.round(loopWidth / NEWS_TICKER_PX_PER_SEC),
      );
      track.style.animationDuration = `${seconds}s`;
    });
  });
}

function showNewsPlaceholder(message = "Loading headlines…") {
  if (!els.tickerTrack) return;
  const item = `<span class="ticker-item"><span class="title">${escapeHtml(message)}</span></span>`;
  const block = new Array(4).fill(item).join("");
  els.tickerTrack.innerHTML = block + block;
  applyTickerAnimation(els.tickerTrack);
}

/** @returns {number} headlines placed in the ticker */
function renderNews(items) {
  if (!els.tickerTrack) return 0;
  if (!items || !items.length) {
    showNewsPlaceholder("No headlines available");
    return 0;
  }
  const list = newsItemsForTicker(items);
  lastNewsItems = list;
  const block = list.map((it) => tickerItemHtml(it)).join("");
  els.tickerTrack.innerHTML = block + block;
  applyTickerAnimation(els.tickerTrack);
  return list.length;
}

function formatNewsDiag({ shown, apiCount, fromCache, refreshing }) {
  const parts = [];
  if (fromCache) parts.push("cached");
  parts.push(`${shown}/${NEWS_TICKER_LIMIT} in ticker`);
  if (Number.isFinite(apiCount) && apiCount !== shown) {
    parts.push(`API sent ${apiCount}`);
  }
  if (refreshing) parts.push("refreshing");
  return `${parts.join(" · ")} @ ${new Date().toLocaleTimeString()}`;
}

async function fetchNews() {
  try {
    diag.set("news", "fetching…");
    const r = await fetchWithTimeout(api("/api/news"), 10_000);
    if (!r.ok) {
      diag.set("news", `HTTP ${r.status}`);
      return;
    }
    const json = await r.json();
    const apiItems = json.items || [];
    const shown = renderNews(apiItems);
    writeNewsCache(apiItems);
    diag.set("news", `OK · ${formatNewsDiag({ shown, apiCount: apiItems.length })}`);
  } catch (err) {
    diag.set("news", `FAIL: ${(err && err.message) || err}`);
  }
}

// ---------- Boot ----------
// Settings + clock first so the UI is interactive before any heavy work.
function boot() {
  initSettings();

  if (!liteMode) startAmbientBg();

  const cachedNews = readNewsCache();
  if (cachedNews?.length) {
    const shown = renderNews(cachedNews);
    diag.set("news", formatNewsDiag({ shown, fromCache: true, refreshing: true }));
  } else {
    showNewsPlaceholder();
  }
  // Weather + news start immediately; quote shortly after so settings stay responsive.
  fetchWeather();
  fetchNews();
  setTimeout(fetchQuote, liteMode ? 300 : 50);

  setInterval(fetchQuote, 10_000);
  setInterval(fetchWeather, 10 * 60_000);
  setInterval(fetchNews, 5 * 60_000);
}
boot();

// Re-draw sparkline on resize (debounced)
let resizeT;
window.addEventListener("resize", () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(fetchQuote, 200);
});

// Click anywhere to force a refresh (handy on the TV remote / browser).
// Ignore clicks on settings controls.
document.body.addEventListener("click", (e) => {
  if (e.target.closest(".settings-btn, .settings-panel")) return;
  fetchQuote();
  fetchWeather();
});

// Auto-hide cursor after a few seconds of inactivity (true screensaver feel,
// but still usable when you wiggle the mouse).
let idleTimer;
function bumpActivity() {
  document.body.classList.remove("idle");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add("idle"), 3000);
}
["mousemove", "mousedown", "keydown", "touchstart"].forEach((ev) =>
  window.addEventListener(ev, bumpActivity, { passive: true }),
);
bumpActivity();

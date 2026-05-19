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
  return false;
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
    const { change } = quoteDayChange(q);
    scheduleSparkDraw(q.series, change, q);
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
/** Top band for OPEN / HIGH / LOW / CLOSE labels (above the plot). */
const CHART_EVENT_BAND_H = 72;
/** Gap between the plot top edge and the bottom of the nearest label row. */
const CHART_LABEL_GAP_ABOVE_PLOT = 6;
/** Minimum Y for label tops (keeps text off the canvas edge). */
const CHART_LABEL_TOP_INSET = 8;
/** Horizontal inset so edge markers (OPEN ring, end dot) are not clipped. */
const CHART_PLOT_INSET_X = 12;
/** Extra time-axis space to the left for the CLOSE (prev session) marker. */
const CHART_PREV_SLOT_MS = 22 * 60_000;
/** Minimum width of the horizontal tick on event guide lines. */
const CHART_GUIDE_CAP_W = 7;
/** Gap between the horizontal tick end and the label text. */
const CHART_GUIDE_CAP_TEXT_GAP = 10;
/** Bottom band for hour tick marks + labels under the plot. */
const CHART_TIME_AXIS_H = 48;
const CHART_TIME_TICK_LEN = 14;
const CHART_TIME_LABEL_GAP = 12;

function chartPlotLayout(h, { lite = false } = {}) {
  const eventBandH = lite ? 56 : CHART_EVENT_BAND_H;
  const chartTop = eventBandH;
  const plotH = Math.max(40, h - eventBandH - CHART_TIME_AXIS_H);
  const chartBottom = chartTop + plotH;
  return {
    chartTop,
    plotH,
    chartBottom,
    // Bottom edge of row-0 label ink (labels sit just above the plot).
    labelBaseY: chartTop - CHART_LABEL_GAP_ABOVE_PLOT,
    labelMinY: CHART_LABEL_TOP_INSET,
    timeTickLen: CHART_TIME_TICK_LEN,
    hourLblY: chartBottom + CHART_TIME_TICK_LEN + CHART_TIME_LABEL_GAP,
  };
}

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
const NEWS_COUNT_STORAGE_KEY = "rop-screensaver:newsCount";
const NEWS_COUNT_DEFAULT = 5;
const NEWS_COUNT_MIN = 1;
const NEWS_COUNT_MAX = 15;
const NEWS_CACHE_KEY = "rop-screensaver:news-v2";
const NEWS_TICKER_MIN_LOOP_SEC = 45;
const NEWS_TICKER_PX_PER_SEC = 42;

function loadNewsTickerLimit() {
  try {
    const v = parseInt(localStorage.getItem(NEWS_COUNT_STORAGE_KEY), 10);
    if (Number.isFinite(v) && v >= NEWS_COUNT_MIN && v <= NEWS_COUNT_MAX) return v;
  } catch {
    /* ignore */
  }
  return NEWS_COUNT_DEFAULT;
}

function saveNewsTickerLimit(n) {
  try {
    localStorage.setItem(NEWS_COUNT_STORAGE_KEY, String(n));
  } catch {
    /* ignore */
  }
}

let newsTickerLimit = loadNewsTickerLimit();
let lastNewsApiItems = null;

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

const CHART_LINE_GREEN = "#2ee07a";
const CHART_LINE_RED = "#ff5470";
const CHART_FILL_GREEN = "rgba(46,224,122,0.22)";
const CHART_FILL_RED = "rgba(255,84,112,0.22)";
const CHART_GLOW_GREEN = "rgba(46,224,122,0.5)";
const CHART_GLOW_RED = "rgba(255,84,112,0.5)";

/** Walk the series in runs above/below `openPrice`, calling `onRun(run, aboveOpen)`. */
function forEachOpenColoredRun(pts, openPrice, onRun) {
  if (!pts.length) return;
  if (!Number.isFinite(openPrice)) {
    onRun(pts, pts[pts.length - 1].c >= pts[0].c);
    return;
  }
  let run = [{ t: pts[0].t, c: pts[0].c }];
  let above = pts[0].c >= openPrice;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const bAbove = b.c >= openPrice;
    if ((a.c >= openPrice) === bAbove) {
      run.push(b);
      continue;
    }
    const denom = b.c - a.c;
    const u = denom !== 0 ? (openPrice - a.c) / denom : 0.5;
    const cross = { t: a.t + u * (b.t - a.t), c: openPrice };
    run.push(cross);
    onRun(run, above);
    run = [cross, b];
    above = bAbove;
  }
  if (run.length >= 2) onRun(run, above);
}

const CHART_FILL_VS_OPEN_KEY = "rop-screensaver:chartFillVsOpen";

function loadChartFillVsOpen() {
  try {
    return localStorage.getItem(CHART_FILL_VS_OPEN_KEY) === "1";
  } catch {
    /* ignore */
  }
  return false;
}

function saveChartFillVsOpen(on) {
  try {
    localStorage.setItem(CHART_FILL_VS_OPEN_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

let chartFillVsOpen = loadChartFillVsOpen();

function applyChartFillVsOpen(on) {
  chartFillVsOpen = !!on;
  saveChartFillVsOpen(chartFillVsOpen);
  if (lastQuoteData) {
    const q = lastQuoteData;
    const { change } = quoteDayChange(q);
    scheduleSparkDraw(q.series, change, q);
  }
  if (diag.isDebugEnabled()) diag.refresh();
}

function fillPlottedSeriesVsOpen(ctx, pts, px, py, openPrice, chartH) {
  if (!Number.isFinite(openPrice)) {
    const up = pts[pts.length - 1].c >= pts[0].c;
    ctx.fillStyle = up ? CHART_FILL_GREEN : CHART_FILL_RED;
    ctx.beginPath();
    ctx.moveTo(px(pts[0].t), chartH);
    pts.forEach((p) => ctx.lineTo(px(p.t), py(p.c)));
    ctx.lineTo(px(pts[pts.length - 1].t), chartH);
    ctx.closePath();
    ctx.fill();
    return;
  }
  const openY = py(openPrice);
  forEachOpenColoredRun(pts, openPrice, (run, above) => {
    if (run.length < 2) return;
    ctx.fillStyle = above ? CHART_FILL_GREEN : CHART_FILL_RED;
    ctx.beginPath();
    ctx.moveTo(px(run[0].t), openY);
    run.forEach((p) => ctx.lineTo(px(p.t), py(p.c)));
    const last = run[run.length - 1];
    ctx.lineTo(px(last.t), openY);
    ctx.closePath();
    ctx.fill();
  });
}

function strokePlottedSeriesVsOpen(ctx, pts, px, py, openPrice, { glow = false } = {}) {
  forEachOpenColoredRun(pts, openPrice, (run, above) => {
    if (run.length < 2) return;
    ctx.strokeStyle = above ? CHART_LINE_GREEN : CHART_LINE_RED;
    if (glow) {
      ctx.shadowColor = above ? CHART_GLOW_GREEN : CHART_GLOW_RED;
      ctx.shadowBlur = 18;
    }
    ctx.beginPath();
    run.forEach((p, i) => {
      const X = px(p.t);
      const Y = py(p.c);
      if (i === 0) ctx.moveTo(X, Y);
      else ctx.lineTo(X, Y);
    });
    ctx.stroke();
  });
}

function priceVsRefColor(price, refPrice, fallbackUp) {
  if (Number.isFinite(refPrice) && Number.isFinite(price)) {
    return price >= refPrice ? CHART_LINE_GREEN : CHART_LINE_RED;
  }
  return fallbackUp ? CHART_LINE_GREEN : CHART_LINE_RED;
}

/** Price level used to color the line green/red (prev close, else session open). */
function chartLineColorRef(openPrice, prevClose) {
  return Number.isFinite(prevClose) ? prevClose : openPrice;
}

/** Area under the line: subtle day fade by default; optional green/red vs open. */
function drawChartSeriesFill(ctx, pts, px, py, chartH, { up, gradient, refPrice }) {
  if (pts.length < 2) return;
  if (chartFillVsOpen && Number.isFinite(refPrice)) {
    fillPlottedSeriesVsOpen(ctx, pts, px, py, refPrice, chartH);
    return;
  }
  const fillTop = up ? "rgba(46,224,122,0.22)" : "rgba(255,84,112,0.22)";
  const fillLite = up ? "rgba(46,224,122,0.18)" : "rgba(255,84,112,0.18)";
  if (gradient) {
    const grad = ctx.createLinearGradient(0, 0, 0, chartH);
    grad.addColorStop(0, fillTop);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
  } else {
    ctx.fillStyle = fillLite;
  }
  ctx.beginPath();
  ctx.moveTo(px(pts[0].t), chartH);
  pts.forEach((p) => ctx.lineTo(px(p.t), py(p.c)));
  ctx.lineTo(px(pts[pts.length - 1].t), chartH);
  ctx.closePath();
  ctx.fill();
}

/** Start the plotted line at market open so the OPEN ring aligns with 7:30 AM. */
function chartSeriesWithOpenAnchor(pts, marketOpen, openPrice) {
  if (!pts.length || !Number.isFinite(openPrice)) return pts;
  const head = { t: marketOpen, c: openPrice };
  if (pts[0].t <= marketOpen + 120_000) return [head, ...pts.slice(1)];
  return [head, ...pts];
}

/** Pre-market from intraday series when API omits extendedSeries (e.g. older worker). */
function chartExtendedFromSeries(series, marketOpen) {
  if (!Array.isArray(series)) return null;
  const pts = series
    .filter((p) => Number.isFinite(p.c) && p.t < marketOpen - 60_000)
    .sort((a, b) => a.t - b.t);
  return pts.length >= 2 ? pts : null;
}

function chartExtendedSource(series, marketOpen, quote) {
  if (quote?.extendedSeries?.length >= 2) return quote.extendedSeries;
  return chartExtendedFromSeries(series, marketOpen);
}

/** Map after-hours / pre-market into the narrow slot before today's open. */
function chartCompressExtendedSeries(pts, targetStart, targetEnd, maxPts = 48) {
  if (!pts?.length) return [];
  const sorted = [...pts].sort((a, b) => a.t - b.t);
  const t0 = sorted[0].t;
  const t1 = sorted[sorted.length - 1].t;
  const span = Math.max(1, t1 - t0);
  return downsampleSeries(sorted, maxPts).map((p) => ({
    t: targetStart + ((p.t - t0) / span) * (targetEnd - targetStart),
    c: p.c,
  }));
}

/** Prev-close anchor + condensed extended hours + regular session. */
function chartMergePlotSeries(marketOpen, openPrice, prevClose, sessionPts, extendedPts) {
  const slot = chartPrevCloseSlotTime(marketOpen);
  const session = chartSeriesWithOpenAnchor(sessionPts, marketOpen, openPrice);
  const bridge = [];
  if (Number.isFinite(prevClose)) bridge.push({ t: slot, c: prevClose });
  if (extendedPts?.length >= 2) {
    const compressed = chartCompressExtendedSeries(extendedPts, slot, marketOpen);
    const startIdx = compressed[0]?.t <= slot + 1000 ? 1 : 0;
    for (let i = startIdx; i < compressed.length; i++) {
      const p = compressed[i];
      const last = bridge[bridge.length - 1];
      if (last && Math.abs(p.c - last.c) < 0.001 && p.t - last.t < 120_000) continue;
      bridge.push(p);
    }
  }
  const sess = session.filter((p) => p.t >= marketOpen - 60_000);
  if (!bridge.length) return sess;
  const lastB = bridge[bridge.length - 1];
  const firstS = sess[0];
  if (
    firstS &&
    Math.abs(lastB.c - firstS.c) < 0.02 &&
    lastB.t >= firstS.t - 120_000
  ) {
    return [...bridge.slice(0, -1), ...sess];
  }
  return [...bridge, ...sess];
}

function chartSessionSlice(plotted, marketOpen) {
  const extended = [];
  const session = [];
  for (const p of plotted) {
    if (p.t < marketOpen) extended.push(p);
    else session.push(p);
  }
  return { extended, session };
}

/** White bridge through the OPEN price; session line starts after the handoff. */
function chartBridgeStrokePoints(extPts, marketOpen, openPrice) {
  if (!extPts.length || !Number.isFinite(openPrice)) return extPts;
  const out = extPts.filter((p) => p.t < marketOpen);
  const tail = { t: marketOpen, c: openPrice };
  const last = out[out.length - 1];
  if (last && marketOpen - last.t < 120_000) out.pop();
  return [...out, tail];
}

function chartSessionStrokePoints(session, marketOpen, openPrice) {
  const after = session.filter((p) => p.t > marketOpen + 30_000);
  if (!Number.isFinite(openPrice)) return session;
  if (!after.length) return session;
  return [{ t: marketOpen, c: openPrice }, ...after];
}

function strokeChartBridge(ctx, pts, px, py) {
  if (pts.length < 2) return;
  ctx.save();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
  ctx.setLineDash([]);
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

function chartPrevCloseSlotTime(marketOpen) {
  return marketOpen - CHART_PREV_SLOT_MS;
}

function chartTimeAxisMin(marketOpen, hasPrevClose) {
  return hasPrevClose ? chartPrevCloseSlotTime(marketOpen) : marketOpen;
}

/** Prior NYSE session date label (e.g. 5/18) for the time axis. */
function previousSessionLabelDate(marketOpenMs) {
  let t = marketOpenMs - 86_400_000;
  for (let i = 0; i < 5; i++) {
    const wd = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
    }).format(new Date(t));
    if (wd !== "Sat" && wd !== "Sun") break;
    t -= 86_400_000;
  }
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "numeric",
    day: "numeric",
  }).format(new Date(t));
}

function strokeChartReferenceLine(ctx, price, py, x0, x1) {
  if (!Number.isFinite(price)) return;
  ctx.save();
  ctx.strokeStyle = "rgba(160, 180, 210, 0.22)";
  ctx.setLineDash([4, 6]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x0, py(price));
  ctx.lineTo(x1, py(price));
  ctx.stroke();
  ctx.restore();
}

/**
 * Position OPEN/HIGH/LOW labels beside the guide (X + pad), stagger rows on
 * overlap, and compute how far each guide line extends (lower rows run longer).
 */
function layoutChartEventLabels(ctx, events, options) {
  const {
    font,
    px,
    baseY,
    labelsAbove = true,
    rowStep = CHART_LABEL_ROW_STEP,
    overlapGap = 12,
    maxRows = 3,
    minLabelX = 0,
    maxLabelRight = Infinity,
    labelPadLeft = CHART_LABEL_PAD_LEFT,
    labelMinY = CHART_LABEL_TOP_INSET,
  } = options;

  ctx.save();
  ctx.font = font;

  const placed = [...events]
    .sort((a, b) => px(a.t) - px(b.t))
    .map((ev) => {
      const guideX = px(ev.t);
      const { width: tw, inkAscent, inkHeight } = measureLabelInk(ctx, ev.label);
      // Room for the horizontal tick + gap before the label text.
      const padLeft =
        labelsAbove ? labelPadLeft + CHART_GUIDE_CAP_TEXT_GAP : labelPadLeft;
      let labelX = guideX + padLeft;
      if (labelX < minLabelX) labelX = minLabelX;
      return {
        ev,
        guideX,
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

  const applyLabelRow = (p) => {
    if (labelsAbove) {
      p.lblY = Math.max(labelMinY, baseY - p.inkHeight - p.row * rowStep);
    } else {
      p.lblY = baseY + p.row * rowStep;
    }
    p.drawY = p.lblY + p.inkAscent;
    p.maskTop = p.lblY - CHART_LABEL_MASK_PAD_Y;
    p.maskBottom = p.lblY + p.inkHeight + CHART_LABEL_MASK_PAD_Y;
    p.lineEndY = labelsAbove ? p.maskBottom : p.lblY + p.inkHeight / 2;
  };

  for (const p of placed) applyLabelRow(p);

  // CLOSE sits left of OPEN; when rows stagger, keep CLOSE above OPEN.
  const closeLbl = placed.find((p) => p.ev.atRefPrice);
  const openLbl = placed.find((p) => p.ev.isOpen);
  if (closeLbl && openLbl && closeLbl.row < openLbl.row) {
    const r = closeLbl.row;
    closeLbl.row = openLbl.row;
    openLbl.row = r;
    applyLabelRow(closeLbl);
    applyLabelRow(openLbl);
  }

  ctx.restore();
  return placed;
}

function drawChartEventGuidesAndLabels(
  ctx,
  placed,
  py,
  { plottedPts, ringRadius = 5, ringWidth = 2, glow = false, labelsAbove = true },
) {
  const markerY = (p) =>
    p.ev.atRefPrice
      ? py(p.ev.price)
      : chartYOnPlottedSeries(plottedPts, p.ev.t, py) ?? py(p.ev.price);

  ctx.setLineDash([3, 4]);
  ctx.lineWidth = 1;
  for (const p of placed) {
    const Y = markerY(p);
    ctx.strokeStyle = p.ev.lineColor;
    ctx.beginPath();
    if (labelsAbove) {
      const yCenter = p.lblY + p.inkHeight / 2;
      strokeVerticalGuide(ctx, p.guideX, yCenter, Y, placed, p);
    } else {
      const yTop = Y;
      const yBottom = p.lineEndY;
      strokeVerticalGuide(ctx, p.guideX, yTop, yBottom, placed, p);
    }
    ctx.stroke();
    if (labelsAbove) {
      const yCenter = p.lblY + p.inkHeight / 2;
      const capEndX = p.labelX - CHART_GUIDE_CAP_TEXT_GAP;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(p.guideX, yCenter);
      ctx.lineTo(capEndX, yCenter);
      ctx.stroke();
      ctx.setLineDash([3, 4]);
    }
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
    ctx.arc(p.guideX, Y, ringRadius, 0, Math.PI * 2);
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

function buildChartEvents({
  points,
  openTime,
  openPrice,
  prevClose,
  highPrice,
  lowPrice,
  currentPrice,
}) {
  const events = [];
  const sameish = (a, b) => Math.abs(a - b) < 0.005;
  if (Number.isFinite(prevClose)) {
    events.push({
      t: chartPrevCloseSlotTime(openTime),
      price: prevClose,
      atRefPrice: true,
      color: "rgba(180, 198, 230, 0.95)",
      lineColor: "rgba(160, 180, 210, 0.55)",
      label: `CLOSE $${prevClose.toFixed(2)}`,
    });
  }
  if (Number.isFinite(openPrice)) {
    const openUp =
      Number.isFinite(prevClose) ? openPrice >= prevClose : true;
    events.push({
      t: openTime,
      price: openPrice,
      isOpen: true,
      color: openUp ? "#2ee07a" : "#ff5470",
      lineColor: openUp ? "rgba(46,224,122,0.6)" : "rgba(255,84,112,0.6)",
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
      `Build:   v58 · ${liteMode ? "lite" : "full"}${isDebugUrl() ? " · /debug" : ""} · API: ${API_BASE || "(same-origin)"}`,
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
  const dock = document.getElementById("settingsDock");
  const btn = document.getElementById("settingsBtn");
  const panel = document.getElementById("settingsPanel");
  const debugToggle = document.getElementById("debugToggle");
  const liteToggle = document.getElementById("liteToggle");
  const chartFillToggle = document.getElementById("chartFillToggle");
  const newsCountSelect = document.getElementById("newsCountSelect");
  if (!btn || !panel) return;

  if (debugToggle) debugToggle.checked = diag.isDebugEnabled();
  if (liteToggle) liteToggle.checked = liteMode;
  if (chartFillToggle) chartFillToggle.checked = chartFillVsOpen;
  if (newsCountSelect) {
    newsCountSelect.value = String(newsTickerLimit);
    newsCountSelect.addEventListener("change", () => {
      applyNewsTickerLimit(newsCountSelect.value);
    });
  }

  function setPanelOpen(open) {
    panel.classList.toggle("hidden", !open);
    panel.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    dock?.classList.toggle("is-open", open);
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

  if (chartFillToggle) {
    chartFillToggle.addEventListener("change", () => {
      applyChartFillVsOpen(chartFillToggle.checked);
    });
  }

  document.addEventListener("click", (e) => {
    if (panel.hidden) return;
    if (dock?.contains(e.target)) return;
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
  prevClose: $("prevClose"),
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
const fmtSigned = (v) =>
  Number.isFinite(v)
    ? (v >= 0 ? "+" : "-") + "$" + fmtMoney(Math.abs(v))
    : "—";
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

/** Change vs previous session close. */
function quoteDayChange(q) {
  const price = q?.price;
  const ref = q?.previousClose;
  if (!Number.isFinite(price) || !Number.isFinite(ref)) {
    return { change: NaN, changePct: NaN, ref: NaN };
  }
  const change = price - ref;
  return {
    change,
    changePct: ref !== 0 ? (change / ref) * 100 : NaN,
    ref,
  };
}

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
  const { change, changePct } = quoteDayChange(q);

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

  if (els.prevClose) {
    const pc = q.previousClose;
    els.prevClose.textContent = Number.isFinite(pc)
      ? `Previous close $${fmtMoney(pc)}`
      : "Previous close unavailable";
  }

  scheduleSparkDraw(q.series, change, q);
}

let sparkDrawPending = 0;
function scheduleSparkDraw(series, change, quote) {
  if (sparkDrawPending) cancelAnimationFrame(sparkDrawPending);
  sparkDrawPending = requestAnimationFrame(() => {
    sparkDrawPending = 0;
    if (liteMode) drawSparkLite(series, change, quote);
    else drawSpark(series, change, quote);
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

const DENVER_TZ = "America/Denver";

/** Map a Denver local wall-clock time on the chart's NYSE day to UTC ms. */
function msForDenverLocal(y, month, day, hour, minute = 0) {
  const wantMin = hour * 60 + minute;
  const dayFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: DENVER_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const base = Date.UTC(y, month - 1, day, 12, 0);
  for (let delta = -16 * 3600_000; delta <= 16 * 3600_000; delta += 60_000) {
    const ms = base + delta;
    const p = Object.fromEntries(dayFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    if (+p.year !== y || +p.month !== month || +p.day !== day) continue;
    const gotMin = parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10);
    if (gotMin === wantMin) return ms;
  }
  return base;
}

function denverDateParts(ms) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: DENVER_TZ,
      year: "numeric",
      month: "numeric",
      day: "numeric",
    })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  return { y: +p.year, mo: +p.month, d: +p.day };
}

/** Denver hour labels: prior date (e.g. 5/18), open (7:30 AM), then hourly … close. */
function chartDenverHourTicks(marketOpen, marketClose, { showPrevDate = false } = {}) {
  const { y, mo, d } = denverDateParts(marketOpen);
  const hourFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: DENVER_TZ,
    hour: "numeric",
    hour12: false,
  });
  const hourLabelFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: DENVER_TZ,
    hour: "numeric",
    hour12: true,
  });
  const openTimeFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: DENVER_TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const openHour = parseInt(hourFmt.format(new Date(marketOpen)), 10);
  const closeHour = parseInt(hourFmt.format(new Date(marketClose)), 10);

  const ticks = [];
  if (showPrevDate) {
    ticks.push({
      t: chartPrevCloseSlotTime(marketOpen),
      label: previousSessionLabelDate(marketOpen),
    });
  }
  ticks.push({ t: marketOpen, label: openTimeFmt.format(new Date(marketOpen)) });
  for (let h = openHour + 1; h <= closeHour; h++) {
    const t = msForDenverLocal(y, mo, d, h, 0);
    if (t > marketClose + 30 * 60_000) break;
    ticks.push({ t, label: hourLabelFmt.format(new Date(t)) });
  }
  return ticks;
}

// Lightweight chart for Performance mode — same OPEN/HIGH/LOW markers + vertical
// guide lines as the full chart, without shadows or expensive compositing.
function drawSparkLite(series, change, quote) {
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
  const { chartTop, plotH, chartBottom, labelBaseY, labelMinY, hourLblY } = chartPlotLayout(h, {
    lite: true,
  });
  const { open: openTime, close: closeTime } = tradingDayBounds();
  const prevClose = Number.isFinite(quote?.previousClose) ? quote.previousClose : null;
  const xMax = closeTime;
  const xMin = chartTimeAxisMin(openTime, Number.isFinite(prevClose));
  const CHART_PAD = Math.max(56, Math.min(96, w * 0.06));

  let sessionPts = (series || [])
    .filter((p) => Number.isFinite(p.c) && p.t >= openTime - 60_000 && p.t <= closeTime + 60_000)
    .sort((a, b) => a.t - b.t);
  const openPriceEarly = Number.isFinite(quote?.open) ? quote.open : sessionPts[0]?.c ?? null;
  const ptsFull = chartSeriesWithOpenAnchor(sessionPts, openTime, openPriceEarly);
  const plotted = chartMergePlotSeries(
    openTime,
    openPriceEarly,
    prevClose,
    sessionPts,
    quote?.extendedSeries,
  );
  let { extended: extPts, session: pts } = chartSessionSlice(plotted, openTime);
  extPts = downsampleSeries(extPts, 28);
  pts = downsampleSeries(pts, 72);

  const openPrice = openPriceEarly;
  if (pts.length === 0 && !Number.isFinite(openPrice) && !Number.isFinite(prevClose)) return;

  const highPrice = Number.isFinite(quote?.dayHigh)
    ? quote.dayHigh
    : ptsFull.length
      ? Math.max(...ptsFull.map((p) => p.c))
      : openPrice;
  const lowPrice = Number.isFinite(quote?.dayLow)
    ? quote.dayLow
    : ptsFull.length
      ? Math.min(...ptsFull.map((p) => p.c))
      : openPrice;
  const currentPrice = ptsFull.at(-1)?.c ?? null;

  const refs = [
    openPrice,
    prevClose,
    highPrice,
    lowPrice,
    ...ptsFull.map((p) => p.c),
    ...extPts.map((p) => p.c),
  ].filter(Number.isFinite);
  let yMin = Math.min(...refs);
  let yMax = Math.max(...refs);
  if (yMin === yMax) {
    yMin -= 0.5;
    yMax += 0.5;
  }
  const yPad = Math.max((yMax - yMin) * 0.12, 0.25);
  yMin -= yPad;
  yMax += yPad;

  const plotX0 = CHART_PAD;
  const plotX1 = w - CHART_PAD;
  const plotW = Math.max(1, plotX1 - plotX0);
  const px = (t) => plotX0 + ((t - xMin) / Math.max(1, xMax - xMin)) * plotW;
  const py = (c) =>
    chartBottom - ((c - yMin) / Math.max(0.0001, yMax - yMin)) * plotH;
  const clampX = (x) => Math.max(plotX0, Math.min(plotX1, x));

  const up = change >= 0;
  const lineRef = chartLineColorRef(openPrice, prevClose);

  ctx.strokeStyle = "rgba(255,255,255,0.1)";
  ctx.beginPath();
  ctx.moveTo(plotX0, chartBottom);
  ctx.lineTo(plotX1, chartBottom);
  ctx.stroke();

  strokeChartReferenceLine(ctx, prevClose, py, plotX0, plotX1);

  const bridgeStroke = chartBridgeStrokePoints(extPts, openTime, openPrice);
  const sessionStroke = chartSessionStrokePoints(pts, openTime, openPrice);
  if (bridgeStroke.length >= 2) strokeChartBridge(ctx, bridgeStroke, px, py);
  if (sessionStroke.length >= 2) {
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    drawChartSeriesFill(ctx, sessionStroke, px, py, chartBottom, {
      up,
      gradient: false,
      refPrice: lineRef,
    });
    strokePlottedSeriesVsOpen(ctx, sessionStroke, px, py, lineRef);
  }

  const events = buildChartEvents({
    points: ptsFull,
    openTime,
    openPrice,
    prevClose,
    highPrice,
    lowPrice,
    currentPrice,
  });

  const placed = layoutChartEventLabels(ctx, events, {
    font: EVENT_FONT,
    px,
    baseY: labelBaseY,
    labelMinY,
    labelsAbove: true,
    minLabelX: plotX0 + 2,
    maxLabelRight: plotX1,
  });

  ctx.font = EVENT_FONT;
  const guidePts =
    bridgeStroke.length >= 2
      ? [...bridgeStroke, ...sessionStroke]
      : sessionStroke.length
        ? sessionStroke
        : pts;
  drawChartEventGuidesAndLabels(ctx, placed, py, {
    plottedPts: guidePts,
    ringRadius: 5,
    ringWidth: 2,
    labelsAbove: true,
  });

  if (pts.length) {
    const lp = pts[pts.length - 1];
    ctx.fillStyle = priceVsRefColor(lp.c, lineRef, up);
    ctx.beginPath();
    ctx.arc(clampX(px(lp.t)), py(lp.c), 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawSpark(series, change, quote) {
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

  // OPEN/HIGH/LOW above the plot; hour labels tight under the plot bottom.
  const EVENT_FONT = "600 18px 'Space Grotesk', system-ui, sans-serif";
  const HOUR_FONT = "500 15px 'Space Grotesk', system-ui, sans-serif";
  const { chartTop, plotH, chartBottom, labelBaseY, labelMinY, hourLblY, timeTickLen } =
    chartPlotLayout(h);

  // X axis: prior date slot + NYSE 9:30–16:00 ET (Denver hour labels).
  const { open: marketOpen, close: marketClose } = tradingDayBounds();
  const prevClose = Number.isFinite(quote?.previousClose) ? quote.previousClose : null;
  const xMax = marketClose;
  const xMin = chartTimeAxisMin(marketOpen, Number.isFinite(prevClose));

  let sessionPts = series
    .filter(
      (p) =>
        Number.isFinite(p.c) &&
        p.t >= marketOpen - 60_000 &&
        p.t <= marketClose + 60_000,
    )
    .sort((a, b) => a.t - b.t);

  const openPrice = Number.isFinite(quote?.open)
    ? quote.open
    : sessionPts[0]?.c ?? null;
  const ptsFull = chartSeriesWithOpenAnchor(sessionPts, marketOpen, openPrice);
  const plotted = chartMergePlotSeries(
    marketOpen,
    openPrice,
    prevClose,
    sessionPts,
    chartExtendedSource(series, marketOpen, quote),
  );
  const { extended: extPts, session: pts } = chartSessionSlice(plotted, marketOpen);
  if (
    pts.length === 0 &&
    extPts.length === 0 &&
    !Number.isFinite(openPrice) &&
    !Number.isFinite(prevClose)
  )
    return;

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

  const refs = [
    openPrice,
    prevClose,
    highPrice,
    lowPrice,
    ...ys,
    ...extPts.map((p) => p.c),
  ].filter(Number.isFinite);
  let yMin = Math.min(...refs);
  let yMax = Math.max(...refs);
  if (yMin === yMax) {
    yMin -= 0.5;
    yMax += 0.5;
  }
  const yPad = Math.max((yMax - yMin) * 0.15, 0.25);
  yMin -= yPad;
  yMax += yPad;

  const plotX0 = CHART_PLOT_INSET_X;
  const plotX1 = w - CHART_PLOT_INSET_X;
  const plotW = Math.max(1, plotX1 - plotX0);
  const px = (t) => plotX0 + ((t - xMin) / Math.max(1, xMax - xMin)) * plotW;
  const py = (c) =>
    chartBottom - ((c - yMin) / Math.max(0.0001, yMax - yMin)) * plotH;

  const up = change >= 0;
  const lineRef = chartLineColorRef(openPrice, prevClose);

  // ---- Hourly gridlines + axis ticks (Denver): open at 7:30 AM, then 8 AM … close.
  ctx.save();
  ctx.font = HOUR_FONT;
  ctx.textBaseline = "top";
  for (const tick of chartDenverHourTicks(marketOpen, marketClose, {
    showPrevDate: Number.isFinite(prevClose),
  })) {
    const X = px(tick.t);
    if (X < -8 || X > w + 8) continue;
    ctx.strokeStyle = "rgba(255,255,255,0.04)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(X, chartTop);
    ctx.lineTo(X, chartBottom);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.beginPath();
    ctx.moveTo(X, chartBottom);
    ctx.lineTo(X, chartBottom + timeTickLen);
    ctx.stroke();
    let align = "center";
    if (X < 24) align = "left";
    else if (X > w - 24) align = "right";
    ctx.textAlign = align;
    ctx.fillStyle = "rgba(160, 180, 210, 0.55)";
    ctx.fillText(tick.label, X, hourLblY);
  }
  // Axis baseline
  ctx.strokeStyle = "rgba(255,255,255,0.1)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(plotX0, chartBottom);
  ctx.lineTo(plotX1, chartBottom);
  ctx.stroke();
  ctx.restore();

  strokeChartReferenceLine(ctx, prevClose, py, plotX0, plotX1);

  const bridgeStroke = chartBridgeStrokePoints(extPts, marketOpen, openPrice);
  const sessionStroke = chartSessionStrokePoints(pts, marketOpen, openPrice);
  if (bridgeStroke.length >= 2) strokeChartBridge(ctx, bridgeStroke, px, py);

  // ---- Filled area + glowing line (green above prev close, red below)
  if (sessionStroke.length >= 2) {
    ctx.save();
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    drawChartSeriesFill(ctx, sessionStroke, px, py, chartBottom, {
      up,
      gradient: true,
      refPrice: lineRef,
    });
    strokePlottedSeriesVsOpen(ctx, sessionStroke, px, py, lineRef, { glow: true });
    ctx.restore();
  }

  // ---- Event markers (open / high / low) — labels above, guides down to the line.
  const events = buildChartEvents({
    points: ptsFull,
    openTime: marketOpen,
    openPrice,
    prevClose,
    highPrice,
    lowPrice,
    currentPrice,
  });

  const placed = layoutChartEventLabels(ctx, events, {
    font: EVENT_FONT,
    px,
    baseY: labelBaseY,
    labelMinY,
    labelsAbove: true,
    minLabelX: plotX0 + 2,
    maxLabelRight: plotX1,
  });

  ctx.font = EVENT_FONT;
  const guidePts =
    bridgeStroke.length >= 2
      ? [...bridgeStroke, ...sessionStroke]
      : sessionStroke.length
        ? sessionStroke
        : pts;
  drawChartEventGuidesAndLabels(ctx, placed, py, {
    plottedPts: guidePts,
    ringRadius: 6,
    ringWidth: 2.2,
    glow: true,
    labelsAbove: true,
  });

  // ---- Current price end-dot
  if (pts.length) {
    const lp = pts[pts.length - 1];
    const dotColor = priceVsRefColor(lp.c, lineRef, up);
    const dotGlow =
      dotColor === CHART_LINE_GREEN ? CHART_GLOW_GREEN : CHART_GLOW_RED;
    ctx.save();
    ctx.fillStyle = dotColor;
    ctx.shadowColor = dotGlow;
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
  return (items || []).slice(0, newsTickerLimit);
}

function applyNewsTickerLimit(n) {
  newsTickerLimit = Math.max(
    NEWS_COUNT_MIN,
    Math.min(NEWS_COUNT_MAX, parseInt(n, 10) || NEWS_COUNT_DEFAULT),
  );
  saveNewsTickerLimit(newsTickerLimit);
  const select = document.getElementById("newsCountSelect");
  if (select) select.value = String(newsTickerLimit);
  if (lastNewsApiItems?.length >= newsTickerLimit) {
    renderNews(lastNewsApiItems);
  } else {
    fetchNews();
  }
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
      JSON.stringify({ items: items || [], at: Date.now() }),
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
  lastNewsApiItems = items || [];
  if (!lastNewsApiItems.length) {
    showNewsPlaceholder("No headlines available");
    return 0;
  }
  const list = newsItemsForTicker(lastNewsApiItems);
  lastNewsItems = list;
  const block = list.map((it) => tickerItemHtml(it)).join("");
  els.tickerTrack.innerHTML = block + block;
  applyTickerAnimation(els.tickerTrack);
  return list.length;
}

function formatNewsDiag({ shown, apiCount, fromCache, refreshing }) {
  const parts = [];
  if (fromCache) parts.push("cached");
  parts.push(`${shown}/${newsTickerLimit} in ticker`);
  if (Number.isFinite(apiCount) && apiCount !== shown) {
    parts.push(`API sent ${apiCount}`);
  }
  if (refreshing) parts.push("refreshing");
  return `${parts.join(" · ")} @ ${new Date().toLocaleTimeString()}`;
}

async function fetchNews() {
  try {
    diag.set("news", "fetching…");
    const r = await fetchWithTimeout(api(`/api/news?limit=${newsTickerLimit}`), 10_000);
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
  if (e.target.closest(".settings-dock")) return;
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

// ---------- Config ----------
// API_BASE comes from public/config.js. Empty string = same-origin (the
// bundled Express server). Set to your Cloudflare Worker URL when deploying
// to GitHub Pages / any other static host.
const API_BASE = (
  (typeof window !== "undefined" && window.APP_CONFIG && window.APP_CONFIG.API_BASE) ||
  ""
).replace(/\/$/, "");
const api = (path) => `${API_BASE}${path}`;

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
    const r = await fetch(api("/api/quote?symbol=ROP&range=1d&interval=2m"));
    if (!r.ok) return;
    const q = await r.json();
    renderQuote(q);
  } catch {
    // Silent: keep showing last known values. The next tick will retry.
  }
}

function renderQuote(q) {
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

  drawSpark(q.series, prev, change, q);
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
  const AXIS_H = 96;
  const chartH = h - AXIS_H;
  const EVENT_ROW_Y = [chartH + 16, chartH + 44]; // staggered label rows
  const EVENT_ROW_H = 22;
  const HOUR_LBL_Y = chartH + 74;

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

  // ---- Event markers (open / high / low) — each with a vertical reference
  // line down to the axis strip and a label below the chart.
  const events = [];
  if (Number.isFinite(openPrice)) {
    events.push({
      t: openTime,
      price: openPrice,
      color: "rgba(220, 230, 250, 0.95)",
      lineColor: "rgba(255,255,255,0.5)",
      label: `OPEN $${openPrice.toFixed(2)}`,
    });
  }
  const sameish = (a, b) => Math.abs(a - b) < 0.005;
  if (
    Number.isFinite(highPrice) &&
    !(Number.isFinite(openPrice) && sameish(highPrice, openPrice)) &&
    !(Number.isFinite(currentPrice) && sameish(highPrice, currentPrice))
  ) {
    const pt = pts.reduce(
      (best, p) => (p.c > best.c ? p : best),
      pts[0] || { t: openTime, c: highPrice },
    );
    events.push({
      t: pt.t,
      price: highPrice,
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
    const pt = pts.reduce(
      (best, p) => (p.c < best.c ? p : best),
      pts[0] || { t: openTime, c: lowPrice },
    );
    events.push({
      t: pt.t,
      price: lowPrice,
      color: "#ff5470",
      lineColor: "rgba(255,84,112,0.6)",
      label: `LOW $${lowPrice.toFixed(2)}`,
    });
  }

  // Clamp event X positions to a safe gutter so markers/rings never get cut
  // off at the canvas edges.
  const EDGE = 8;
  function clampX(rawX) {
    return Math.max(EDGE, Math.min(w - EDGE, rawX));
  }

  // Assign each event a row (0 or 1) so labels don't overlap horizontally.
  ctx.save();
  ctx.font = EVENT_FONT;
  const placed = [...events]
    .sort((a, b) => px(a.t) - px(b.t))
    .map((ev) => {
      const X = clampX(px(ev.t));
      const tw = ctx.measureText(ev.label).width;
      let align = "center";
      if (X < 80) align = "left";
      else if (X > w - 80) align = "right";
      const left =
        align === "left" ? X : align === "right" ? X - tw : X - tw / 2;
      const right = left + tw;
      return { ev, X, align, left, right, tw, row: 0 };
    });
  for (let i = 0; i < placed.length; i++) {
    for (let j = 0; j < i; j++) {
      if (placed[j].row !== placed[i].row) continue;
      const overlap =
        placed[i].left - 8 < placed[j].right &&
        placed[i].right + 8 > placed[j].left;
      if (overlap) {
        placed[i].row = 1 - placed[i].row;
        j = -1;
      }
    }
  }
  ctx.restore();

  // 1) Draw each event's full-length dashed line — from marker on the chart
  //    all the way down past its row to bottom of the axis strip. We'll mask
  //    out the parts that sit under labels in step 3.
  for (const p of placed) {
    const X = p.X;
    const Y = py(p.ev.price);
    const lblY = EVENT_ROW_Y[Math.min(p.row, EVENT_ROW_Y.length - 1)];
    ctx.save();
    ctx.strokeStyle = p.ev.lineColor;
    ctx.setLineDash([3, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(X, Y);
    ctx.lineTo(X, lblY + EVENT_ROW_H - 2);
    ctx.stroke();
    ctx.restore();
  }

  // 2) Punch out the chart canvas in the rectangles where labels will appear,
  //    so the dashed lines appear to disappear *behind* the text — revealing
  //    the page background through the canvas.
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = "#000";
  for (const p of placed) {
    const lblY = EVENT_ROW_Y[Math.min(p.row, EVENT_ROW_Y.length - 1)];
    ctx.fillRect(p.left - 3, lblY - 1, p.tw + 6, EVENT_ROW_H);
  }
  ctx.restore();

  // 3) Marker rings on the chart, drawn last so the glow sits over the line.
  for (const p of placed) {
    const X = p.X;
    const Y = py(p.ev.price);
    ctx.save();
    ctx.strokeStyle = p.ev.color;
    ctx.lineWidth = 2.2;
    ctx.shadowColor = p.ev.color;
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(X, Y, 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // 4) Labels in their assigned rows.
  ctx.save();
  ctx.font = EVENT_FONT;
  ctx.textBaseline = "top";
  for (const p of placed) {
    const lblY = EVENT_ROW_Y[Math.min(p.row, EVENT_ROW_Y.length - 1)];
    ctx.textAlign = p.align;
    ctx.fillStyle = p.ev.color;
    ctx.fillText(p.ev.label, p.X, lblY);
  }
  ctx.restore();

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
    const url =
      "https://api.open-meteo.com/v1/forecast" +
      "?latitude=39.7392&longitude=-104.9903" +
      "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,is_day" +
      "&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FDenver";
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const c = data.current || {};
    const [desc, icon] = WX_CODES[c.weather_code] || ["—", "·"];
    els.wxTemp.textContent = `${Math.round(c.temperature_2m)}°`;
    els.wxIcon.textContent = icon;
    els.wxDesc.textContent =
      `${desc} · feels ${Math.round(c.apparent_temperature)}° · wind ${Math.round(c.wind_speed_10m)} mph`;
  } catch (err) {
    els.wxDesc.textContent = "Weather offline";
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
    requestAnimationFrame(frame);
    if (document.hidden) return; // pause entirely when offscreen
    if (now - lastFrame < FRAME_INTERVAL_MS) return; // throttle to ~30 fps
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
}
try {
  ambientBg();
} catch (err) {
  console.warn("ambient bg disabled:", err);
}

// ---------- News ticker ----------
const HTML_ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => HTML_ESC[c]);

function renderNews(items) {
  if (!els.tickerTrack) return;
  if (!items || !items.length) {
    els.tickerTrack.innerHTML = "";
    return;
  }
  const block = items
    .map(
      (it) => `
        <span class="ticker-item">
          ${it.source ? `<span class="src">${escapeHtml(it.source)}</span><span class="sep">·</span>` : ""}
          <span class="title">${escapeHtml(it.title)}</span>
        </span>`,
    )
    .join("");
  // Duplicate the content so the keyframe `translateX(-50%)` produces a
  // seamless loop.
  els.tickerTrack.innerHTML = block + block;

  // Scale the scroll duration to the rendered width so the speed stays
  // consistent regardless of how many headlines we have.
  requestAnimationFrame(() => {
    const trackWidth = els.tickerTrack.scrollWidth;
    // ~80 pixels per second feels readable on a TV.
    const seconds = Math.max(60, Math.round(trackWidth / 80));
    els.tickerTrack.style.animationDuration = `${seconds}s`;
  });
}

async function fetchNews() {
  try {
    const r = await fetch(api("/api/news"));
    if (!r.ok) return;
    const json = await r.json();
    renderNews(json.items || []);
  } catch {
    /* leave previous ticker contents on error */
  }
}

// ---------- Boot ----------
fetchQuote();
fetchWeather();
fetchNews();
setInterval(fetchQuote, 10_000);            // every 10s
setInterval(fetchWeather, 10 * 60_000);     // every 10 min
setInterval(fetchNews, 5 * 60_000);         // every 5 min

// Re-draw sparkline on resize (debounced)
let resizeT;
window.addEventListener("resize", () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(fetchQuote, 200);
});

// Click anywhere to force a refresh (handy on the TV remote / browser)
document.body.addEventListener("click", () => {
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

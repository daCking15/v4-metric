// Cloudflare Worker proxy for the Roper screensaver.
//
// Exposes two endpoints, both returning JSON with permissive CORS so a static
// site (GitHub Pages, S3, etc.) can call them from the browser:
//
//   GET /api/quote?symbol=ROP  → live quote + intraday series (Nasdaq → Yahoo → Stooq fallback)
//   GET /api/news              → Google News RSS for the watchlist topics
//
// Deploy with: `npx wrangler deploy` (uses wrangler.toml) or paste this file
// into the Cloudflare dashboard's Workers editor and click Deploy.

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const json = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": init.cacheControl || "public, max-age=8",
      ...CORS,
    },
  });

// ---------- Tiny in-memory cache (per isolate) ----------
// Workers can keep state for the lifetime of an isolate (typically a few
// minutes to hours of warm requests), so this still helps reduce upstream load.
const cache = new Map();
const cacheGet = (key, ttlMs) => {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t > ttlMs) return null;
  return hit.v;
};
const cachePut = (key, v) => cache.set(key, { v, t: Date.now() });

// ---------- Time helpers ----------
function tradingDayBoundsET() {
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
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const etMin = parseInt(o.hour, 10) * 60 + parseInt(o.minute, 10);
  let diff = utcMin - etMin;
  if (diff < -12 * 60) diff += 24 * 60;
  if (diff > 12 * 60) diff -= 24 * 60;
  const offsetMs = diff * 60_000;
  return {
    open: Date.UTC(y, mo - 1, d, 9, 30) + offsetMs,
    close: Date.UTC(y, mo - 1, d, 16, 0) + offsetMs,
    offsetMs,
  };
}

function etParts(ms) {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hour12: false,
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
}

function etWallMs(y, mo, d, hour, minute, offsetMs) {
  return Date.UTC(y, mo - 1, d, hour, minute) + offsetMs;
}

function previousTradingDayMs(fromMs) {
  let t = fromMs - 86_400_000;
  for (let i = 0; i < 5; i++) {
    const wd = etParts(t).weekday;
    if (wd !== "Sat" && wd !== "Sun") return t;
    t -= 86_400_000;
  }
  return t;
}

/** After-hours + pre-market between prior session close and today's open. */
function extractExtendedBridge(series, marketOpen, offsetMs) {
  const prev = etParts(previousTradingDayMs(marketOpen));
  const bridgeStart = etWallMs(+prev.year, +prev.month, +prev.day, 16, 0, offsetMs) - 30 * 60_000;
  const bridgeEnd = marketOpen;
  return series
    .filter((p) => p.t >= bridgeStart && p.t < bridgeEnd - 60_000)
    .sort((a, b) => a.t - b.t);
}

async function fetchYahooChartSeries(symbol, range, interval) {
  const tryOnce = async () => {
    const { cookie, crumb } = await getYahooSession();
    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
      `?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}` +
      `&includePrePost=true&events=div%2Csplit&crumb=${encodeURIComponent(crumb)}`;
    return fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json,text/plain,*/*",
        "Accept-Language": "en-US,en;q=0.9",
        Cookie: cookie,
        Origin: "https://finance.yahoo.com",
        Referer: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`,
      },
    });
  };
  let r = await tryOnce();
  if (r.status === 401 || r.status === 403 || r.status === 429) {
    yahooSession = null;
    r = await tryOnce();
  }
  if (!r.ok) throw new Error(`Yahoo HTTP ${r.status}`);
  const data = await r.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error("Yahoo: no result");
  const ts = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  return ts
    .map((t, i) => ({ t: t * 1000, c: closes[i] }))
    .filter((p) => Number.isFinite(p.c));
}

async function attachExtendedSeries(snap) {
  if (!Number.isFinite(snap?.previousClose)) return snap;
  const { open, offsetMs } = tradingDayBoundsET();
  if (Array.isArray(snap.series) && snap.series.length) {
    const fromNasdaq = extractExtendedBridge(snap.series, open, offsetMs);
    if (fromNasdaq.length >= 2) {
      snap.extendedSeries = fromNasdaq;
      return snap;
    }
  }
  try {
    const series = await fetchYahooChartSeries(snap.symbol, "5d", "5m");
    const bridge = extractExtendedBridge(series, open, offsetMs);
    if (bridge.length >= 2) snap.extendedSeries = bridge;
  } catch (e) {
    console.warn(`Extended hours for ${snap.symbol}:`, e?.message || e);
  }
  return snap;
}

const parseDollars = (v) => {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return NaN;
  const n = parseFloat(v.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : NaN;
};

// ---------- Nasdaq.com (primary) ----------
async function fetchNasdaq(symbol) {
  const sym = symbol.toUpperCase();
  const headers = {
    "User-Agent": UA,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Origin: "https://www.nasdaq.com",
    Referer: "https://www.nasdaq.com/",
  };
  const base = `https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}`;
  const [chartRes, infoRes] = await Promise.all([
    fetch(`${base}/chart?assetclass=stocks`, { headers }),
    fetch(`${base}/info?assetclass=stocks`, { headers }),
  ]);
  if (!chartRes.ok) throw new Error(`Nasdaq chart ${chartRes.status}`);
  const chartJson = await chartRes.json();
  const data = chartJson?.data || {};
  if (!Array.isArray(data.chart)) throw new Error("Nasdaq: no chart array");
  const infoData = infoRes.ok ? (await infoRes.json())?.data || {} : {};
  const primary = infoData.primaryData || {};
  const stats = infoData.keyStats || {};

  const { open: openMs, offsetMs } = tradingDayBoundsET();
  const series = data.chart
    .map((p) => ({ t: p.x + offsetMs, c: p.y }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.c))
    .sort((a, b) => a.t - b.t);

  const openPt = series.find((p) => p.t >= openMs - 60_000);
  const openPrice = openPt?.c ?? null;

  let dayHigh = NaN;
  let dayLow = NaN;
  if (typeof stats.dayrange?.value === "string") {
    const m = stats.dayrange.value.match(/([\d.,]+)\s*-\s*([\d.,]+)/);
    if (m) {
      dayLow = parseDollars(m[1]);
      dayHigh = parseDollars(m[2]);
    }
  }
  let w52High = NaN;
  let w52Low = NaN;
  if (typeof stats.fiftyTwoWeekHighLow?.value === "string") {
    const m = stats.fiftyTwoWeekHighLow.value.match(/([\d.,]+)\s*-\s*([\d.,]+)/);
    if (m) {
      w52Low = parseDollars(m[1]);
      w52High = parseDollars(m[2]);
    }
  }

  const price =
    parseDollars(data.lastSalePrice) ||
    parseDollars(primary.lastSalePrice) ||
    series.at(-1)?.c ||
    null;
  const previousClose =
    parseDollars(data.previousClose) || parseDollars(primary.previousClose) || null;

  return {
    symbol: sym,
    currency: "USD",
    exchangeName: data.exchange || infoData.exchange || "",
    marketState: infoData.marketStatus || "",
    price,
    open: openPrice,
    previousClose,
    dayHigh: Number.isFinite(dayHigh) ? dayHigh : null,
    dayLow: Number.isFinite(dayLow) ? dayLow : null,
    fiftyTwoWeekHigh: Number.isFinite(w52High) ? w52High : null,
    fiftyTwoWeekLow: Number.isFinite(w52Low) ? w52Low : null,
    regularMarketTime: Date.now(),
    series,
    fetchedAt: Date.now(),
    source: "nasdaq",
  };
}

// ---------- Yahoo (secondary) ----------
// Stateless within this worker — we re-issue the cookie/crumb dance per call if
// Nasdaq fails. Cheap because it only runs when the primary chain is down.
let yahooSession = null;

function parseSetCookie(setCookieHeader) {
  if (!setCookieHeader) return "";
  return setCookieHeader
    .split(/,(?=[^;]+?=)/g)
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

async function getYahooSession(force = false) {
  if (!force && yahooSession && Date.now() - yahooSession.t < 30 * 60_000) {
    return yahooSession;
  }
  const browserHeaders = {
    "User-Agent": UA,
    "Accept-Language": "en-US,en;q=0.9",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  };
  const cookieRes = await fetch("https://finance.yahoo.com/quote/AAPL/", {
    headers: browserHeaders,
    redirect: "follow",
  });
  const cookie = parseSetCookie(cookieRes.headers.get("set-cookie"));
  if (!cookie) throw new Error("Could not obtain Yahoo cookie");
  const crumbRes = await fetch(
    "https://query1.finance.yahoo.com/v1/test/getcrumb",
    {
      headers: {
        "User-Agent": UA,
        Accept: "text/plain,*/*",
        "Accept-Language": "en-US,en;q=0.9",
        Cookie: cookie,
        Origin: "https://finance.yahoo.com",
        Referer: "https://finance.yahoo.com/",
      },
    },
  );
  if (!crumbRes.ok) throw new Error(`Crumb fetch failed: ${crumbRes.status}`);
  const crumb = (await crumbRes.text()).trim();
  if (!crumb) throw new Error("Empty crumb");
  yahooSession = { cookie, crumb, t: Date.now() };
  return yahooSession;
}

async function fetchYahoo(symbol) {
  const tryOnce = async () => {
    const { cookie, crumb } = await getYahooSession();
    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
      `?range=1d&interval=2m&includePrePost=true&events=div%2Csplit&crumb=${encodeURIComponent(crumb)}`;
    return fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json,text/plain,*/*",
        "Accept-Language": "en-US,en;q=0.9",
        Cookie: cookie,
        Origin: "https://finance.yahoo.com",
        Referer: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`,
      },
    });
  };
  let r = await tryOnce();
  if (r.status === 401 || r.status === 403 || r.status === 429) {
    yahooSession = null;
    r = await tryOnce();
  }
  if (!r.ok) throw new Error(`Yahoo HTTP ${r.status}`);
  const data = await r.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error("Yahoo: no result");
  const meta = result.meta || {};
  const ts = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const series = ts
    .map((t, i) => ({ t: t * 1000, c: closes[i] }))
    .filter((p) => Number.isFinite(p.c));
  return {
    symbol: meta.symbol || symbol.toUpperCase(),
    currency: meta.currency || "USD",
    exchangeName: meta.fullExchangeName || meta.exchangeName || "",
    marketState: meta.marketState || "",
    price: meta.regularMarketPrice ?? series.at(-1)?.c ?? null,
    open: meta.regularMarketOpen ?? series[0]?.c ?? null,
    previousClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
    dayHigh: meta.regularMarketDayHigh ?? null,
    dayLow: meta.regularMarketDayLow ?? null,
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? null,
    fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? null,
    regularMarketTime: (meta.regularMarketTime || 0) * 1000,
    series,
    fetchedAt: Date.now(),
    source: "yahoo",
  };
}

// ---------- Stooq (last resort) ----------
function parseStooqDate(d, t) {
  if (!d || d === "N/D") return Date.now();
  return Date.parse(`${d}T${t || "00:00:00"}Z`);
}

async function fetchStooq(symbol) {
  const s = symbol.toLowerCase().includes(".")
    ? symbol.toLowerCase()
    : `${symbol.toLowerCase()}.us`;
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(s)}&f=sd2t2ohlcv&h&e=csv`;
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`Stooq ${r.status}`);
  const text = await r.text();
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error("Stooq empty payload");
  const [, row] = lines;
  const [, date, time, open, high, low, close] = row.split(",");
  const price = parseFloat(close);
  if (!Number.isFinite(price)) throw new Error("Stooq no price");
  return {
    symbol: symbol.toUpperCase(),
    currency: "USD",
    exchangeName: "Stooq (delayed)",
    marketState: "DELAYED",
    price,
    open: parseFloat(open),
    previousClose: parseFloat(open),
    dayHigh: parseFloat(high),
    dayLow: parseFloat(low),
    fiftyTwoWeekHigh: null,
    fiftyTwoWeekLow: null,
    regularMarketTime: parseStooqDate(date, time),
    series: [],
    fetchedAt: Date.now(),
    source: "stooq",
  };
}

// ---------- Rolling intraday history (Stooq fallback only) ----------
// Workers isolates can disappear between requests, so the rolling buffer here
// is best-effort — Nasdaq + Yahoo both already return a real series.
const HISTORY_MAX = 720;
const histories = new Map();
function pushHistory(symbol, t, c) {
  if (!Number.isFinite(c)) return;
  let arr = histories.get(symbol);
  if (!arr) {
    arr = [];
    histories.set(symbol, arr);
  }
  const last = arr[arr.length - 1];
  if (last && Math.abs(last.t - t) < 1000) return;
  arr.push({ t, c });
  if (arr.length > HISTORY_MAX) arr.splice(0, arr.length - HISTORY_MAX);
}

async function refreshSymbol(symbol) {
  let snap = null;
  try {
    snap = await fetchNasdaq(symbol);
  } catch (e) {
    console.warn(`Nasdaq failed for ${symbol}:`, e?.message || e);
  }
  if (!snap) {
    try {
      snap = await fetchYahoo(symbol);
    } catch (e) {
      console.warn(`Yahoo failed for ${symbol}:`, e?.message || e);
    }
  }
  if (!snap) {
    snap = await fetchStooq(symbol);
  }
  if (Array.isArray(snap.series) && snap.series.length > 1) {
    histories.set(symbol, snap.series.slice(-HISTORY_MAX));
  } else {
    pushHistory(symbol, snap.regularMarketTime || Date.now(), snap.price);
  }
  return attachExtendedSeries(snap);
}

async function handleQuote(url) {
  const symbol = (url.searchParams.get("symbol") || "ROP").toUpperCase();
  const cacheKey = `quote:${symbol}`;
  let snap = cacheGet(cacheKey, 8_000);
  if (!snap) {
    try {
      snap = await refreshSymbol(symbol);
      cachePut(cacheKey, snap);
    } catch (err) {
      return json({ error: String(err?.message || err) }, { status: 502 });
    }
  }
  const series = histories.get(symbol) || [];
  return json({ ...snap, series });
}

// ---------- News (Google News RSS) ----------
// Single RSS request (faster cold start than 3 parallel Google News fetches).
const NEWS_QUERY = "Roper Technologies";
const NEWS_ITEM_MAX = 15;
const NEWS_ITEM_DEFAULT = 5;

function newsLimitFromUrl(url) {
  const n = parseInt(url.searchParams.get("limit"), 10);
  if (!Number.isFinite(n)) return NEWS_ITEM_DEFAULT;
  return Math.max(1, Math.min(NEWS_ITEM_MAX, n));
}

const HTML_ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};
const decodeEntities = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (m) => HTML_ENTITIES[m] || m);
const stripTags = (s) => s.replace(/<[^>]+>/g, "").trim();

function parseRss(xml, maxItems = 12) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const pick = (tag) => {
      const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(block);
      return r ? decodeEntities(r[1]).trim() : "";
    };
    let title = stripTags(pick("title"));
    const link = stripTags(pick("link"));
    const pubDateRaw = pick("pubDate");
    const sourceRaw = pick("source");
    let source = sourceRaw;
    if (!source) {
      const dashIdx = title.lastIndexOf(" - ");
      if (dashIdx > 0) source = title.slice(dashIdx + 3);
    }
    title = title.replace(new RegExp(`\\s*-\\s*${source}\\s*$`), "").trim();
    items.push({
      title,
      link,
      source,
      pubDate: pubDateRaw ? Date.parse(pubDateRaw) || null : null,
    });
    if (items.length >= maxItems) break;
  }
  return items;
}

async function fetchGoogleNews(query) {
  const url =
    "https://news.google.com/rss/search?" +
    `q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`Google News ${r.status}`);
  const xml = await r.text();
  return parseRss(xml).map((it) => ({ ...it, query }));
}

async function handleNews(url) {
  const limit = newsLimitFromUrl(url);
  const cacheKey = "news-v2";
  const cached = cacheGet(cacheKey, 5 * 60_000);
  if (cached) {
    return json(
      {
        ...cached,
        items: (cached.items || []).slice(0, limit),
        limit,
      },
      { cacheControl: "public, max-age=300" },
    );
  }
  try {
    const flat = await fetchGoogleNews(NEWS_QUERY).catch(() => []);
    const seen = new Set();
    const unique = [];
    for (const it of flat) {
      const key = it.title.toLowerCase().replace(/\s+/g, " ").trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      unique.push(it);
    }
    unique.sort((a, b) => (b.pubDate || 0) - (a.pubDate || 0));
    const items = unique.slice(0, NEWS_ITEM_MAX);
    const payload = {
      items,
      limit,
      fetchedAt: Date.now(),
    };
    cachePut(cacheKey, payload);
    return json(
      { ...payload, items: items.slice(0, limit) },
      { cacheControl: "public, max-age=300" },
    );
  } catch (err) {
    return json({ error: String(err?.message || err) }, { status: 500 });
  }
}

// ---------- Worker entry point ----------
export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, { status: 405 });
    }
    const url = new URL(request.url);
    if (url.pathname === "/api/quote") return handleQuote(url);
    if (url.pathname === "/api/news") return handleNews(url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        ok: true,
        endpoints: ["/api/quote?symbol=ROP", "/api/news"],
      });
    }
    return json({ error: "Not found" }, { status: 404 });
  },
};

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Tiny in-memory cache so we don't hammer Yahoo when running on a TV all day.
const cache = new Map();
const get = (key, ttlMs) => {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t > ttlMs) return null;
  return hit.v;
};
const put = (key, v) => cache.set(key, { v, t: Date.now() });

// ---------- Yahoo auth (cookie + crumb) ----------
// Yahoo's public endpoints started returning 401/429 without a session cookie
// + matching crumb token. We grab them once and refresh on demand.
let yahooSession = null; // { cookie, crumb, t }

function parseSetCookie(setCookieHeader) {
  if (!setCookieHeader) return "";
  // node's fetch returns multiple Set-Cookie joined by ", " — split carefully
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

  // 1) Hit the actual quote page; it sets A1/A1S/A3 cookies.
  const cookieRes = await fetch("https://finance.yahoo.com/quote/AAPL/", {
    headers: browserHeaders,
    redirect: "follow",
  });
  const cookie = parseSetCookie(cookieRes.headers.get("set-cookie"));
  if (!cookie) throw new Error("Could not obtain Yahoo cookie");

  // 2) Exchange the cookie for a crumb token.
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
  if (!crumbRes.ok) {
    throw new Error(`Crumb fetch failed: ${crumbRes.status}`);
  }
  const crumb = (await crumbRes.text()).trim();
  if (!crumb) throw new Error("Empty crumb");
  yahooSession = { cookie, crumb, t: Date.now() };
  return yahooSession;
}

async function fetchYahooChart(symbol, range, interval) {
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
  return r;
}

// ---------- Nasdaq.com (primary) ----------
// Free, no key, real-time public API used by nasdaq.com itself. Returns full
// intraday minute bars + authoritative day/52w stats for any US-listed ticker.
const parseDollars = (v) => {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return NaN;
  const n = parseFloat(v.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : NaN;
};

// Today's 9:30 ET / 16:00 ET as true ms-since-epoch.
// Also returns offsetMs = how many ms behind UTC ET currently is.
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

  // Nasdaq sends timestamps as "ET wall-clock pretending to be UTC". Convert
  // to true UTC ms by adding the current ET-behind-UTC offset.
  const { open: openMs, offsetMs } = tradingDayBoundsET();
  const series = data.chart
    .map((p) => ({ t: p.x + offsetMs, c: p.y }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.c))
    .sort((a, b) => a.t - b.t);

  // Today's open = first series point at-or-after 9:30 ET.
  const openPt = series.find((p) => p.t >= openMs - 60_000);
  const openPrice = openPt?.c ?? null;

  // Day range "319.13 - 329.97"
  let dayHigh = NaN;
  let dayLow = NaN;
  if (typeof stats.dayrange?.value === "string") {
    const m = stats.dayrange.value.match(/([\d.,]+)\s*-\s*([\d.,]+)/);
    if (m) {
      dayLow = parseDollars(m[1]);
      dayHigh = parseDollars(m[2]);
    }
  }
  // 52w range
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

// ---------- Stooq fallback ----------
// Stooq is a free, no-key European data provider; quotes are typically delayed
// ~15 minutes but the CSV endpoint is rock-solid and CORS-permissive.
function parseStooqDate(d, t) {
  // d=YYYY-MM-DD, t=HH:MM:SS, treated as US Eastern (Stooq uses local exchange)
  if (!d || d === "N/D") return Date.now();
  return Date.parse(`${d}T${t || "00:00:00"}Z`);
}

async function fetchStooqQuote(symbol) {
  // .us suffix is required for US tickers on Stooq
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
  const [, date, time, open, high, low, close /*, volume */] = row.split(",");
  const price = parseFloat(close);
  if (!Number.isFinite(price)) throw new Error("Stooq no price");

  return {
    symbol: symbol.toUpperCase(),
    currency: "USD",
    exchangeName: "Stooq (delayed)",
    marketState: "DELAYED",
    price,
    open: parseFloat(open),
    previousClose: parseFloat(open), // best available without a paid history feed
    dayHigh: parseFloat(high),
    dayLow: parseFloat(low),
    fiftyTwoWeekHigh: null,
    fiftyTwoWeekLow: null,
    regularMarketTime: parseStooqDate(date, time),
    fetchedAt: Date.now(),
    source: "stooq",
  };
}

// ---------- Rolling intraday history ----------
// We keep ~6h of snapshots per symbol in memory so the client can render a
// proper sparkline even when only snapshot APIs are available.
const HISTORY_MAX = 720; // 720 * 30s = 6h
const histories = new Map(); // symbol -> [{t, c}, ...]
const snapshots = new Map(); // symbol -> last snapshot payload

function pushHistory(symbol, t, c) {
  if (!Number.isFinite(c)) return;
  let arr = histories.get(symbol);
  if (!arr) {
    arr = [];
    histories.set(symbol, arr);
  }
  const last = arr[arr.length - 1];
  if (last && Math.abs(last.t - t) < 1000) return; // dedupe
  arr.push({ t, c });
  if (arr.length > HISTORY_MAX) arr.splice(0, arr.length - HISTORY_MAX);
}

async function refreshSymbol(symbol) {
  let snap = null;

  // 1) Nasdaq.com — real-time intraday minute bars, no key, no auth dance.
  try {
    snap = await fetchNasdaq(symbol);
  } catch (err) {
    console.warn(`Nasdaq error for ${symbol}: ${err?.message || err}`);
  }

  // 2) Yahoo — only useful if its crumb endpoint is currently happy.
  if (!snap) {
    try {
      const r = await fetchYahooChart(symbol, "1d", "2m");
      if (!r.ok) console.warn(`Yahoo HTTP ${r.status} for ${symbol}`);
      if (r.ok) {
        const json = await r.json();
        const result = json?.chart?.result?.[0];
        if (result) {
          const meta = result.meta || {};
          const ts = result.timestamp || [];
          const closes = result.indicators?.quote?.[0]?.close || [];
          const series = ts
            .map((t, i) => ({ t: t * 1000, c: closes[i] }))
            .filter((p) => Number.isFinite(p.c));
          snap = {
            symbol: meta.symbol || symbol,
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
      }
    } catch (err) {
      console.warn(`Yahoo error for ${symbol}: ${err?.message || err}`);
    }
  }

  // 3) Stooq — snapshot-only fallback.
  if (!snap) {
    try {
      snap = await fetchStooqQuote(symbol);
    } catch (err) {
      const prior = snapshots.get(symbol);
      if (prior) return prior;
      throw err;
    }
  }

  // For sources that include a series, replace any rolling buffer with the
  // authoritative one. For snapshot-only sources (Stooq), accumulate.
  if (Array.isArray(snap.series) && snap.series.length > 1) {
    histories.set(symbol, snap.series.slice(-HISTORY_MAX));
  } else {
    pushHistory(symbol, snap.regularMarketTime || Date.now(), snap.price);
  }
  snapshots.set(symbol, snap);
  return snap;
}

app.get("/api/quote", async (req, res) => {
  const symbol = (req.query.symbol || "ROP").toUpperCase();
  const cacheKey = `quote:${symbol}`;

  // Cache for ~8s so the screensaver feels live without hammering upstream.
  let snap = get(cacheKey, 8_000);
  if (!snap) {
    try {
      snap = await refreshSymbol(symbol);
      put(cacheKey, snap);
    } catch (err) {
      return res.status(502).json({ error: String(err?.message || err) });
    }
  }

  const series = histories.get(symbol) || [];
  res.json({ ...snap, series });
});

// ---------- News (Google News RSS) ----------
const NEWS_QUERY = "Roper Technologies";
const NEWS_ITEM_MAX = 15;
const NEWS_ITEM_DEFAULT = 5;

function newsLimitFromQuery(req) {
  const n = parseInt(req.query.limit, 10);
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
    // Google often appends " - <Source>" at the end of the title; if a
    // <source> tag is present we can prefer that.
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

app.get("/api/news", async (req, res) => {
  const limit = newsLimitFromQuery(req);
  const cacheKey = "news-v2";
  const cached = get(cacheKey, 5 * 60_000); // refresh every 5 min
  if (cached) {
    return res.json({
      ...cached,
      items: (cached.items || []).slice(0, limit),
      limit,
    });
  }
  try {
    const flat = await fetchGoogleNews(NEWS_QUERY).catch(() => []);
    // Dedupe by lowercased + collapsed title.
    const seen = new Set();
    const unique = [];
    for (const it of flat) {
      const key = it.title.toLowerCase().replace(/\s+/g, " ").trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      unique.push(it);
    }
    // Sort newest first.
    unique.sort((a, b) => (b.pubDate || 0) - (a.pubDate || 0));
    const items = unique.slice(0, NEWS_ITEM_MAX);
    const payload = {
      items,
      limit,
      fetchedAt: Date.now(),
    };
    put(cacheKey, payload);
    res.json({ ...payload, items: items.slice(0, limit) });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

// Background poller: keep ROP fresh and grow the rolling sparkline buffer.
const TRACKED = ["ROP"];
async function pollAll() {
  for (const sym of TRACKED) {
    try {
      await refreshSymbol(sym);
    } catch (err) {
      console.warn(`Poll ${sym} failed:`, err?.message || err);
    }
  }
}
setInterval(pollAll, 15_000);
pollAll();

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Roper screensaver running → http://localhost:${PORT}`);
});

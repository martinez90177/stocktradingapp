/**
 * Records the real option chain, minute by minute, while the market is open.
 *
 *   node tools/record-options.mjs --check       # what does each feed give, and how fresh?
 *   node tools/record-options.mjs               # record until the 4:00 bell
 *   node tools/record-options.mjs --symbols QQQ,SPY --expiries 1
 *
 * Why this exists. The candles in the practice terminal are recorded; the
 * option prices were modelled, because no free feed serves option history. A
 * model can be made honest -- see tools/calibrate-vol.mjs and
 * tools/measure-intraday-variance.mjs -- but it cannot be made exact, and a
 * size you cannot scale from is worse than useless. So this records what the
 * model would otherwise guess: the real bid and ask of every strike near the
 * money, every minute, filed beside the candles.
 *
 * FRESHNESS IS THE WHOLE GAME. A quote recorded at 10:07 is worthless if the
 * feed handed out 9:52's prices, and a free feed usually does exactly that --
 * Yahoo's option chain is widely delayed, and nothing in its response says so.
 * So every feed here is asked for its own timestamp, the difference from the
 * clock is measured on every sweep, and that lag is written into the file
 * beside the quotes. Where several feeds are configured each minute goes to
 * the first that answers fresh, falling back down the list, and the file
 * records which feed supplied which minute. No feed is taken at its word about
 * its own timeliness.
 *
 * Run --check first. It sweeps every configured feed once and prints what came
 * back -- spot, lag, expiries, strikes, a sample quote -- so you can see which
 * are actually live before committing a session to them.
 *
 * Credentials come from the environment, and a feed without them is skipped:
 *   TRADIER_TOKEN            api.tradier.com; real-time with a brokerage account
 *   TRADIER_ENV=sandbox      ... or the free sandbox, which is delayed
 *   POLYGON_KEY              api.polygon.io
 *   ALPACA_KEY, ALPACA_SECRET        data.alpaca.markets
 *   ALPACA_OPTIONS_FEED=opra         ... real-time rather than the free indicative feed
 *   (yahoo needs nothing, and is the fallback of last resort)
 *
 * Writes options/<SYMBOL>/<YYYY-MM-DD>.json; the shape is defined, and the
 * merging done, in src/optionsfile.ts.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { authedJson } = await import(pathToFileURL(join(ROOT, "src", "catalysts.ts")).href);
const { emptyDay, merge, cents, typicalLag, sourceShare } =
  await import(pathToFileURL(join(ROOT, "src", "optionsfile.ts")).href);

const OPEN = 570, CLOSE = 960;   // minutes into the day, New York

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
};
const num = (name, fallback) => {
  const v = Number(flag(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/**
 * What to keep, and what it costs. A session of three expiries across seven
 * tickers is roughly 1.6 MB a day in the repository once git has compressed
 * it. `--expiries 1` records only what expires today and cuts that to a third;
 * `--band` narrows the strikes; `--symbols` limits the tickers.
 */
const BAND = num("band", 0.015);
const MAX_SIDE = num("max-strikes", 20);
const EXPIRIES = num("expiries", 3);
const SPACING_MS = num("spacing", 400);
/** A quote older than this is not this minute's price, so the next feed is tried. */
const MAX_LAG_S = num("max-lag", 90);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (x) => typeof x === "number" && Number.isFinite(x) && x >= 0;

const et = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
/** The date and minute-of-day in New York, whatever the machine's clock is set to. */
function nowET(ms = Date.now()) {
  const o = {};
  for (const p of et.formatToParts(ms)) o[p.type] = p.value;
  return { date: `${o.year}-${o.month}-${o.day}`, min: (+o.hour % 24) * 60 + +o.minute, sec: +o.second };
}
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

async function getJson(url, headers) {
  try {
    const r = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/**
 * Reduces one expiry, however a feed described it, to the strikes near the
 * money as flat [bid, ask] pairs in cents. `rows` are { strike, type, bid, ask }
 * in any order; a strike the feed quoted nothing for comes out as -1, -1.
 */
function band(rows, spot) {
  const lo = spot * (1 - BAND), hi = spot * (1 + BAND);
  const near = rows.filter((r) => r.strike >= lo && r.strike <= hi);
  const strikes = [...new Set(near.map((r) => r.strike))].sort((a, b) => a - b);
  if (!strikes.length) return null;
  // A band on a cheap stock can be hundreds of strikes wide; keep the middle.
  let mid = 0;
  strikes.forEach((k, i) => { if (Math.abs(k - spot) < Math.abs(strikes[mid] - spot)) mid = i; });
  const kept = strikes.slice(Math.max(0, mid - MAX_SIDE), mid + MAX_SIDE + 1);
  const at = new Map();
  for (const r of near) at.set(`${r.strike}|${r.type}`, r);
  const side = (type) => kept.flatMap((k) => {
    const r = at.get(`${k}|${type}`);
    return r && ok(r.bid) && ok(r.ask) && r.ask > 0 ? [cents(r.bid), cents(r.ask)] : [-1, -1];
  });
  return { strikes: kept, call: side("call"), put: side("put") };
}

/* ================= the feeds =================
 * Each returns { spot, at, expiries:[{date,strikes,call,put}] }, or null where
 * it could not be read. `at` is the feed's own timestamp in epoch ms and is
 * what makes the lag measurable; a feed that will not say gets -1 recorded
 * against it, which is itself worth knowing.
 */

/** Yahoo. No credentials, and no promise of freshness: usually delayed. */
async function yahoo(symbol) {
  const base = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}`;
  const first = await authedJson(base);
  const r0 = first?.optionChain?.result?.[0];
  const spot = r0?.quote?.regularMarketPrice;
  if (!r0?.options?.length || !(spot > 0)) return null;
  const at = r0.quote.regularMarketTime ? r0.quote.regularMarketTime * 1000 : null;
  const out = [];
  for (const exp of (r0.expirationDates ?? []).slice(0, EXPIRIES)) {
    let o = exp === r0.expirationDates[0] ? r0.options[0] : null;
    if (!o) {
      await sleep(SPACING_MS);
      o = (await authedJson(`${base}?date=${exp}`))?.optionChain?.result?.[0]?.options?.[0];
    }
    if (!o) continue;
    const rows = [
      ...(o.calls ?? []).map((c) => ({ strike: c.strike, type: "call", bid: c.bid, ask: c.ask })),
      ...(o.puts ?? []).map((c) => ({ strike: c.strike, type: "put", bid: c.bid, ask: c.ask })),
    ];
    const b = band(rows, spot);
    if (b) out.push({ date: new Date(o.expirationDate * 1000).toISOString().slice(0, 10), ...b });
  }
  return out.length ? { spot, at, expiries: out } : null;
}

/** Tradier. Real-time with a funded brokerage account; the free sandbox is delayed. */
async function tradier(symbol) {
  const token = process.env.TRADIER_TOKEN;
  if (!token) return null;
  const base = process.env.TRADIER_ENV === "sandbox"
    ? "https://sandbox.tradier.com/v1" : "https://api.tradier.com/v1";
  const H = { Authorization: `Bearer ${token}` };
  const q = await getJson(`${base}/markets/quotes?symbols=${encodeURIComponent(symbol)}`, H);
  const quote = q?.quotes?.quote;
  const spot = quote?.last ?? quote?.close;
  if (!(spot > 0)) return null;
  const at = quote.trade_date ?? quote.bid_date ?? null;
  const ex = await getJson(`${base}/markets/options/expirations?symbol=${encodeURIComponent(symbol)}`, H);
  const dates = [].concat(ex?.expirations?.date ?? []).slice(0, EXPIRIES);
  const out = [];
  for (const d of dates) {
    await sleep(SPACING_MS);
    const j = await getJson(`${base}/markets/options/chains?symbol=${encodeURIComponent(symbol)}&expiration=${d}`, H);
    const list = [].concat(j?.options?.option ?? []);
    if (!list.length) continue;
    const b = band(list.map((c) => ({ strike: c.strike, type: c.option_type, bid: c.bid, ask: c.ask })), spot);
    if (b) out.push({ date: d, ...b });
  }
  return out.length ? { spot, at, expiries: out } : null;
}

/** Polygon. One snapshot call covers every expiry it returns. */
async function polygon(symbol) {
  const key = process.env.POLYGON_KEY;
  if (!key) return null;
  const today = nowET().date;
  const j = await getJson(`https://api.polygon.io/v3/snapshot/options/${encodeURIComponent(symbol)}` +
    `?expiration_date.gte=${today}&limit=250&sort=expiration_date&apiKey=${encodeURIComponent(key)}`);
  const res = j?.results;
  if (!Array.isArray(res) || !res.length) return null;
  const spot = res.find((r) => r?.underlying_asset?.price > 0)?.underlying_asset?.price;
  if (!(spot > 0)) return null;
  // Polygon stamps in nanoseconds.
  const stamps = res.map((r) => r?.last_quote?.last_updated).filter((n) => n > 0).sort((a, b) => b - a);
  const at = stamps.length ? Math.round(stamps[0] / 1e6) : null;
  const byExp = new Map();
  for (const r of res) {
    const d = r?.details?.expiration_date;
    if (!d) continue;
    if (!byExp.has(d)) byExp.set(d, []);
    byExp.get(d).push({
      strike: r.details.strike_price, type: r.details.contract_type,
      bid: r.last_quote?.bid, ask: r.last_quote?.ask,
    });
  }
  const out = [];
  for (const d of [...byExp.keys()].sort().slice(0, EXPIRIES)) {
    const b = band(byExp.get(d), spot);
    if (b) out.push({ date: d, ...b });
  }
  return out.length ? { spot, at, expiries: out } : null;
}

/** An OCC contract symbol: root, then yymmdd, then C or P, then the strike in thousandths. */
const OCC = /^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;

/** Alpaca. The indicative feed is free and delayed; the OPRA feed is real-time and paid. */
async function alpaca(symbol) {
  const key = process.env.ALPACA_KEY, secret = process.env.ALPACA_SECRET;
  if (!key || !secret) return null;
  const H = { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret };
  const feed = process.env.ALPACA_OPTIONS_FEED || "indicative";
  const t = await getJson(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/trades/latest`, H);
  const spot = t?.trade?.p;
  if (!(spot > 0)) return null;
  let token = null, at = null;
  const rows = [];
  for (let page = 0; page < 8; page++) {
    const j = await getJson(`https://data.alpaca.markets/v1beta1/options/snapshots/${encodeURIComponent(symbol)}` +
      `?feed=${encodeURIComponent(feed)}&limit=1000${token ? `&page_token=${encodeURIComponent(token)}` : ""}`, H);
    const snaps = j?.snapshots;
    if (!snaps) break;
    for (const [occ, snap] of Object.entries(snaps)) {
      const m = OCC.exec(occ);
      const q = snap?.latestQuote;
      if (!m || !q) continue;
      const ts = q.t ? Date.parse(q.t) : NaN;
      if (Number.isFinite(ts) && (at == null || ts > at)) at = ts;
      rows.push({
        date: `20${m[2]}-${m[3]}-${m[4]}`, strike: Number(m[6]) / 1000,
        type: m[5] === "C" ? "call" : "put", bid: q.bp, ask: q.ap,
      });
    }
    token = j?.next_page_token;
    if (!token) break;
    await sleep(SPACING_MS);
  }
  if (!rows.length) return null;
  const today = nowET().date;
  const out = [];
  for (const d of [...new Set(rows.map((r) => r.date))].filter((x) => x >= today).sort().slice(0, EXPIRIES)) {
    const b = band(rows.filter((r) => r.date === d), spot);
    if (b) out.push({ date: d, ...b });
  }
  return out.length ? { spot, at, expiries: out } : null;
}

/**
 * In order of how likely they are to be telling you about right now. Yahoo is
 * last on purpose: it costs nothing and is usually a quarter of an hour behind,
 * which makes it a fallback rather than a source.
 */
const FEEDS = [
  { name: "tradier", read: tradier, needs: ["TRADIER_TOKEN"] },
  { name: "polygon", read: polygon, needs: ["POLYGON_KEY"] },
  { name: "alpaca", read: alpaca, needs: ["ALPACA_KEY", "ALPACA_SECRET"] },
  { name: "yahoo", read: yahoo, needs: [] },
];

function chosenFeeds() {
  const asked = flag("source");
  const wanted = typeof asked === "string" ? asked.split(",").map((s) => s.trim().toLowerCase()) : null;
  const pool = wanted ? wanted.map((n) => FEEDS.find((f) => f.name === n)).filter(Boolean) : FEEDS;
  return pool.filter((f) => {
    const missing = f.needs.filter((k) => !process.env[k]);
    if (missing.length && wanted) console.warn(`  ~ ${f.name} skipped: ${missing.join(", ")} not set`);
    return !missing.length;
  });
}

async function symbols() {
  const fromFlag = flag("symbols");
  if (typeof fromFlag === "string") return fromFlag.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  try {
    const w = JSON.parse(await readFile(join(ROOT, "watchlist.json"), "utf8"));
    return (w.symbols ?? []).map((s) => s.trim().toUpperCase()).filter(Boolean);
  } catch {
    return ["SPY", "QQQ"];
  }
}

/**
 * One symbol, from the first feed that answers fresh. A feed that answers but
 * is stale is kept rather than thrown away: a late quote, recorded with its
 * lag beside it, still beats no quote at all.
 */
async function readFresh(feeds, symbol) {
  let stale = null;
  for (const f of feeds) {
    const sweep = await f.read(symbol).catch(() => null);
    await sleep(SPACING_MS);
    if (!sweep) continue;
    const lagS = sweep.at ? (Date.now() - sweep.at) / 1000 : null;
    const tagged = { ...sweep, source: f.name, lagS };
    if (lagS == null || lagS <= MAX_LAG_S) return tagged;
    if (!stale || (stale.lagS ?? 1e9) > lagS) stale = tagged;
  }
  return stale;
}

/** The feeds themselves, exported so their field mapping can be tested without a market. */
export { FEEDS, band, yahoo, tradier, polygon, alpaca, readFresh };

async function main() {
  const feeds = chosenFeeds();
  const syms = await symbols();

  if (!feeds.length) {
    console.error("No feed is configured. Set TRADIER_TOKEN, POLYGON_KEY or ALPACA_KEY/ALPACA_SECRET, or use --source yahoo.");
    process.exit(1);
  }

  /* --check: one sweep of every feed, side by side, so you can see which is live. */
  if (flag("check") === true) {
    const sym = syms[0];
    console.log(`Checking ${feeds.map((f) => f.name).join(", ")} on ${sym}\n`);
    console.log("feed          spot         lag  expiries  strikes  a sample quote");
    for (const f of feeds) {
      const t0 = Date.now();
      let s = null, err = null;
      try { s = await f.read(sym); } catch (e) { err = e.message; }
      if (!s) { console.log(`${f.name.padEnd(12)} ${err ? `failed: ${err}` : "no data"}`); continue; }
      const lag = s.at ? `${((Date.now() - s.at) / 1000).toFixed(0)}s` : "not said";
      const e0 = s.expiries[0], mid = Math.floor(e0.strikes.length / 2);
      const bid = e0.call[mid * 2], ask = e0.call[mid * 2 + 1];
      console.log(`${f.name.padEnd(12)}${s.spot.toFixed(2).padStart(8)}${lag.padStart(12)}` +
        `${String(s.expiries.length).padStart(10)}${String(e0.strikes.length).padStart(9)}  ` +
        `${e0.date} ${e0.strikes[mid]}c ${bid < 0 ? "none" : `${(bid / 100).toFixed(2)}/${(ask / 100).toFixed(2)}`}` +
        `   (${Date.now() - t0}ms)`);
    }
    console.log(`\nA lag over ${MAX_LAG_S}s means that feed is not telling you about this minute.`);
    console.log("Put whichever reads freshest first with --source, or let the order above decide.");
    return;
  }

  async function sweepAll(minute, date) {
    let done = 0;
    const failed = [], lags = [], used = new Set();
    for (const symbol of syms) {
      const sweep = await readFresh(feeds, symbol);
      if (!sweep) { failed.push(symbol); continue; }
      const dir = join(ROOT, "options", symbol.replace(/[^A-Z0-9_.-]/gi, "_"));
      await mkdir(dir, { recursive: true });
      const file = join(dir, `${date}.json`);
      let day = null;
      try { day = JSON.parse(await readFile(file, "utf8")); } catch { /* first sweep of the day */ }
      await writeFile(file, JSON.stringify(merge(day ?? emptyDay(symbol, date), minute, sweep)), "utf8");
      done++;
      used.add(sweep.source);
      if (sweep.lagS != null) lags.push(sweep.lagS);
    }
    return {
      done, failed, used: [...used],
      lag: lags.length ? Math.round(lags.reduce((a, b) => a + b, 0) / lags.length) : null,
    };
  }

  console.log(`Recording ${syms.length} symbol(s): ${syms.join(", ")}`);
  console.log(`  feeds, in order: ${feeds.map((f) => f.name).join(" -> ")}`);
  console.log(`  ${EXPIRIES} expiry/expiries, strikes within ${(BAND * 100).toFixed(1)}% of spot, anything over ${MAX_LAG_S}s old falls through`);
  console.log(`  roughly ${(0.54 * EXPIRIES * syms.length / 7).toFixed(1)} MB a day in the repository at this setting`);
  console.log("  Leave this running until the 4:00 bell. Ctrl-C stops it; restarting merges into the same file.\n");

  let warnedLag = false, quiet = 0;
  for (;;) {
    const { date, min } = nowET();
    if (min >= OPEN && min < CLOSE) {
      const t = await sweepAll(min - OPEN, date);
      if (t.done) {
        quiet = 0;
        console.log(`  ${hhmm(min)}  minute ${String(min - OPEN).padStart(3)}  ${t.done}/${syms.length} from ${t.used.join("+")}` +
          `${t.lag != null ? `, ${t.lag}s behind` : ""}${t.failed.length ? `  (nothing for ${t.failed.join(", ")})` : ""}`);
        if (!warnedLag && t.lag != null && t.lag > MAX_LAG_S) {
          warnedLag = true;
          console.warn(`  ! every feed is more than ${MAX_LAG_S}s behind. They are being recorded with their lag beside them,\n` +
            "    but these are not this minute's prices. Run --check, and consider a feed that is real-time for your account.");
        }
      } else if (++quiet % 5 === 1) {
        console.warn(`  ${hhmm(min)}  nothing could be read (${t.failed.join(", ")}) -- still trying`);
      }
    } else if (min >= CLOSE) {
      console.log(`  ${hhmm(min)}  the bell. ${date} is recorded.`);
      for (const symbol of syms) {
        try {
          const day = JSON.parse(await readFile(join(ROOT, "options", symbol, `${date}.json`), "utf8"));
          const lag = typicalLag(day);
          console.log(`    ${symbol.padEnd(6)} ${day.minutes.length}/390 minutes, ` +
            `${Object.entries(sourceShare(day)).map(([k, v]) => `${k} ${v}`).join(", ")}` +
            `${lag == null ? "" : `, typically ${lag}s behind`}`);
        } catch { /* nothing recorded for it */ }
      }
      break;
    } else if (quiet++ % 10 === 0) {
      console.log(`  ${hhmm(min)}  waiting for the 9:30 open`);
    }
    // Wake a moment after the turn of the next minute, so a sweep is filed under
    // the minute it was actually read in.
    await sleep(Math.max(2000, (61 - nowET().sec) * 1000));
  }
}

// Imported by a test, this file defines feeds and nothing else; run directly, it records.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();

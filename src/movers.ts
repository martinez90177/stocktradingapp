import type { Bar, Mover, Series } from "./types.ts";
import { fetchSeries, mapPool } from "./yahoo.ts";
import { atr, findPivots, lastOf, mergePivots, sma } from "./ta.ts";
import { readPriorSession } from "./session.ts";
import { buildCatalysts, fetchFundamentals, fetchNews } from "./catalysts.ts";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Yahoo's saved screeners, and what each one is good for. */
const SCREENS: { id: string; label: string }[] = [
  { id: "day_gainers", label: "Gainers" },
  { id: "day_losers", label: "Losers" },
  { id: "most_actives", label: "Most active" },
  { id: "small_cap_gainers", label: "Small-cap gainers" },
];

interface RawQuote {
  symbol: string;
  name: string;
  price: number;
  changePct: number;
  volume: number;
  avgVolume: number;
  marketCap: number | null;
  source: string[];
}

async function fetchScreen(id: string, count: number): Promise<any[]> {
  const url =
    `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved` +
    `?scrIds=${encodeURIComponent(id)}&count=${count}`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return [];
    const j = await r.json();
    return j?.finance?.result?.[0]?.quotes ?? [];
  } catch {
    return [];
  }
}

export interface MoverOptions {
  exclude: string[];
  limit: number;
  minPrice: number;
  /** Minimum average daily turnover in dollars. Filters out names you cannot get filled in. */
  minDollarVolume: number;
  cacheDir: string | null;
}

/**
 * Builds the side watchlist: what the market is actually moving today, filtered
 * to names liquid enough to trade, then read the same way the main watchlist is.
 */
export async function discoverMovers(opts: MoverOptions): Promise<{ movers: Mover[]; scanned: number; notes: string[] }> {
  const notes: string[] = [];
  const exclude = new Set(opts.exclude.map((s) => s.toUpperCase()));
  const bySymbol = new Map<string, RawQuote>();

  const screens = await Promise.all(SCREENS.map((s) => fetchScreen(s.id, 40)));
  let scanned = 0;

  screens.forEach((quotes, i) => {
    const label = SCREENS[i].label;
    if (quotes.length === 0) {
      notes.push(`The ${label.toLowerCase()} screen returned nothing this run.`);
      return;
    }
    for (const q of quotes) {
      scanned++;
      const symbol = String(q.symbol ?? "").toUpperCase();
      if (!symbol || exclude.has(symbol)) continue;
      if (q.quoteType !== "EQUITY") continue;

      const price = Number(q.regularMarketPrice);
      const changePct = Number(q.regularMarketChangePercent);
      const volume = Number(q.regularMarketVolume) || 0;
      const avgVolume = Number(q.averageDailyVolume3Month) || 0;
      if (!Number.isFinite(price) || !Number.isFinite(changePct)) continue;

      // Liquidity gates. A 40% mover on $2M of turnover is not tradeable size,
      // and sub-$3 names behave differently enough to be their own game.
      if (price < opts.minPrice) continue;
      if (avgVolume * price < opts.minDollarVolume) continue;

      const existing = bySymbol.get(symbol);
      if (existing) {
        if (!existing.source.includes(label)) existing.source.push(label);
        continue;
      }
      bySymbol.set(symbol, {
        symbol,
        name: String(q.shortName ?? q.longName ?? symbol),
        price, changePct, volume, avgVolume,
        marketCap: Number.isFinite(Number(q.marketCap)) ? Number(q.marketCap) : null,
        source: [label],
      });
    }
  });

  // Rank on the blend that decides whether a name is worth a look: how far it
  // moved, and how much conviction the volume behind it shows.
  const ranked = [...bySymbol.values()]
    .map((q) => {
      const rel = q.avgVolume > 0 ? q.volume / q.avgVolume : 0;
      return { q, pre: Math.abs(q.changePct) * 1.0 + Math.min(rel, 6) * 3.2 };
    })
    .sort((a, b) => b.pre - a.pre)
    .slice(0, opts.limit)
    .map((x) => x.q);

  if (ranked.length === 0) {
    notes.push("No screened name cleared the price and turnover filters.");
    return { movers: [], scanned, notes };
  }

  const movers = await mapPool(ranked, 3, async (q): Promise<Mover> => {
    const errors: string[] = [];
    let bars: Bar[] = [];
    let atrPct: number | null = null;
    let rangePos52w: number | null = null;
    let trend: string | null = null;
    let session = null as Mover["session"];

    try {
      const daily: Series = await fetchSeries(q.symbol, {
        range: "1y", interval: "1d", cacheDir: opts.cacheDir ?? undefined, cacheTtl: 3600,
      });
      bars = daily.bars;
      const closes = bars.map((b) => b.c);
      const a = lastOf(atr(bars, 14));
      atrPct = a != null && q.price > 0 ? (a / q.price) * 100 : null;

      const hi = daily.meta.fiftyTwoWeekHigh;
      const lo = daily.meta.fiftyTwoWeekLow;
      rangePos52w = hi > lo ? ((q.price - lo) / (hi - lo)) * 100 : null;

      const avgVol = bars.length >= 20
        ? bars.slice(-20).reduce((s, b) => s + b.v, 0) / 20
        : q.avgVolume;
      session = readPriorSession(bars, a ?? q.price * 0.02, avgVol);

      const s20 = lastOf(sma(closes, 20));
      const s50 = lastOf(sma(closes, 50));
      const pivots = mergePivots([findPivots(bars, 5), findPivots(bars, 10)]);
      const highs = pivots.filter((p) => p.kind === "high").slice(-2);
      const lows = pivots.filter((p) => p.kind === "low").slice(-2);
      const hh = highs.length === 2 && highs[1].price > highs[0].price;
      const hl = lows.length === 2 && lows[1].price > lows[0].price;
      const lh = highs.length === 2 && highs[1].price < highs[0].price;
      const ll = lows.length === 2 && lows[1].price < lows[0].price;
      trend = hh && hl ? "uptrend" : lh && ll ? "downtrend" : "range";
      if (s20 != null && s50 != null) {
        trend += q.price > s20 && s20 > s50 ? ", above stacked 20/50"
          : q.price < s20 && s20 < s50 ? ", below stacked 20/50" : "";
      }
    } catch (e) {
      errors.push(`Daily history unavailable (${(e as Error).message}).`);
    }

    let catalysts: Mover["catalysts"] = null;
    try {
      const [fund, news] = await Promise.all([
        fetchFundamentals(q.symbol, opts.cacheDir),
        fetchNews(q.symbol, opts.cacheDir, 900, 6, q.name),
      ]);
      catalysts = buildCatalysts(fund, news, fund != null);
    } catch {
      errors.push("Catalyst lookup failed.");
    }

    /* ---- lean ---- */

    let score = 0;
    const why: string[] = [];

    if (session) {
      score += session.pressure === "buyers" ? session.strength * 2.4
        : session.pressure === "sellers" ? -session.strength * 2.4 : 0;
      if (session.pressure !== "balanced") why.push(`${session.pressure} closed it`);
    }
    if (q.changePct > 3) { score += 1.0; why.push(`up ${q.changePct.toFixed(1)}%`); }
    else if (q.changePct < -3) { score -= 1.0; why.push(`down ${Math.abs(q.changePct).toFixed(1)}%`); }

    if (trend?.startsWith("uptrend")) { score += 0.9; why.push("higher highs and lows"); }
    else if (trend?.startsWith("downtrend")) { score -= 0.9; why.push("lower highs and lows"); }

    if (catalysts?.headlineLean === "bullish") { score += 0.7; why.push("headlines skew bullish"); }
    else if (catalysts?.headlineLean === "bearish") { score -= 0.7; why.push("headlines skew bearish"); }

    if (rangePos52w != null && rangePos52w > 95) { score += 0.5; why.push("near 52-week highs"); }
    else if (rangePos52w != null && rangePos52w < 5) { score -= 0.5; why.push("near 52-week lows"); }

    const spf = catalysts?.fundamentals?.shortPercentOfFloat;
    if (spf != null && spf >= 0.15) why.push(`${(spf * 100).toFixed(0)}% of float short, so squeezes are violent`);

    if (catalysts?.nextEarnings && catalysts.nextEarnings.inDays <= 1) {
      why.push("earnings land inside a day, which overrides the chart");
    }

    const relVolume = q.avgVolume > 0 ? q.volume / q.avgVolume : null;

    return {
      symbol: q.symbol, name: q.name, price: q.price, changePct: q.changePct,
      volume: q.volume, avgVolume: q.avgVolume, relVolume,
      dollarVolume: q.price * q.volume, marketCap: q.marketCap, source: q.source,
      rangePos52w, atrPct, session, catalysts, trend,
      lean: score > 1.1 ? "long-side" : score < -1.1 ? "short-side" : "unclear",
      leanWhy: why.length > 0 ? why.join("; ").replace(/^./, (c) => c.toUpperCase()) + "." : "Nothing leaning either way.",
      score,
      bars,
      errors,
    };
  });

  return { movers, scanned, notes };
}

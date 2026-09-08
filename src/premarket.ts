import type { Bar, Series } from "./types.ts";
import { fetchSeries, mapPool } from "./yahoo.ts";
import { atr, lastOf } from "./ta.ts";
import { etDate, sanitizeIntraday, splitSessions } from "./intraday.ts";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const ET = "America/New_York";

/**
 * The premarket scan, and why it is not the movers scan.
 *
 * `discoverMovers` ranks on `regularMarketChangePercent`, which before the open
 * is the *previous* session's change -- Yahoo does not roll it until 9:30. So at
 * 7am the movers board is a list of yesterday's movers, which is exactly when a
 * premarket board is supposed to be useful. This module ranks on premarket
 * movement instead, measured from one-minute pre/post bars rather than read off
 * a quote field.
 *
 * Relative strength here means the spread between a name's premarket gap and the
 * benchmark's: SPY up 0.4% with a name up 0.4% is a name going nowhere on its
 * own. The spread is then divided by the name's own ATR, because 1% out of a
 * name that covers 1% a day is a bigger statement than 1% out of one that
 * covers 5%.
 */

/** ET wall clock for an instant, as minutes since midnight. */
export function etMinutes(at: Date): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: ET, hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(at);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? "0");
  // en-US with hour12:false renders midnight as 24; fold it back to 0.
  return (g("hour") % 24) * 60 + g("minute");
}

const PRE_OPEN = 4 * 60;        // 4:00am ET, when Yahoo's premarket tape starts
const REG_OPEN = 9 * 60 + 30;   // 9:30am ET

export type WindowState = "premarket" | "before-premarket" | "regular-or-later" | "weekend";

/**
 * Which side of the premarket window we are on, decided in ET rather than UTC.
 *
 * The workflow cron cannot do this itself: GitHub runs cron in UTC only, so a
 * fixed UTC schedule slides by an hour twice a year. The schedule is therefore
 * deliberately wider than the window and this guard is what actually decides
 * whether a run does any work.
 */
export function windowState(at: Date): WindowState {
  const dow = new Intl.DateTimeFormat("en-US", { timeZone: ET, weekday: "short" }).format(at);
  if (dow === "Sat" || dow === "Sun") return "weekend";
  const m = etMinutes(at);
  if (m < PRE_OPEN) return "before-premarket";
  if (m >= REG_OPEN) return "regular-or-later";
  return "premarket";
}

export interface PremarketRead {
  symbol: string;
  name: string;
  /** "watchlist", or the screens that surfaced it. */
  source: string[];
  prevClose: number;
  /** Last premarket trade. Null when nothing has traded yet. */
  last: number | null;
  high: number | null;
  low: number | null;
  volume: number;
  dollarVolume: number;
  bars: number;
  /** Premarket move against the prior close, in percent. */
  gapPct: number | null;
  atrPct: number | null;
  /** gapPct expressed in daily ATRs -- how big the move is *for this name*. */
  gapAtr: number | null;
  /** Premarket gap minus the benchmark's, in percent. */
  rsSpy: number | null;
  rsQqq: number | null;
  /** rsSpy in ATRs. This is what the board ranks on. */
  rsAtr: number | null;
  score: number | null;
  lean: "long-side" | "short-side" | "unclear" | "untraded";
  why: string;
  errors: string[];
}

export interface PremarketScan {
  generatedAt: number;
  window: WindowState;
  sessionDate: string | null;
  benchmarks: { symbol: string; gapPct: number | null }[];
  names: PremarketRead[];
  /** Names measured and then withheld, with the reason. Never silently dropped. */
  skipped: { symbol: string; reason: string }[];
  screensScanned: number;
  notes: string[];
}

/* ------------------------------------------------------------------ *
 * Measurement
 * ------------------------------------------------------------------ */

interface Measured {
  prevClose: number;
  last: number | null;
  high: number | null;
  low: number | null;
  volume: number;
  dollarVolume: number;
  bars: number;
  gapPct: number | null;
  atrPct: number | null;
  sessionDate: string | null;
}

/**
 * Measures one symbol's premarket from bars.
 *
 * Two fetches: the daily series for the prior close and ATR, and one-minute
 * pre/post bars for the premarket itself. The daily series is what makes the
 * prior close authoritative -- the intraday feed's first day is usually partial,
 * and `meta.previousClose` has been seen to roll early on some symbols.
 */
async function measure(
  symbol: string,
  cacheDir: string | null,
  intraTtl: number,
  dailyTtl: number,
): Promise<Measured> {
  const daily = await fetchSeries(symbol, {
    range: "1y", interval: "1d",
    cacheDir: cacheDir ?? undefined, cacheTtl: dailyTtl,
  });

  const intraRaw: Series = await fetchSeries(symbol, {
    range: "2d", interval: "1m", prePost: true,
    cacheDir: cacheDir ?? undefined, cacheTtl: intraTtl,
  });

  // Extended-hours feeds carry zero-volume bars whose wicks came from a stale
  // spread rather than a trade. Left in, one of them invents a premarket high.
  const { bars: cleanBars } = sanitizeIntraday(intraRaw.bars);
  const sessions = splitSessions({ ...intraRaw, bars: cleanBars });
  const latest = sessions[sessions.length - 1] ?? null;

  const a = lastOf(atr(daily.bars, 14));

  // The prior close is the newest daily bar strictly before today's session. The
  // daily feed can already carry a partial row for today once premarket prints,
  // and using that row as the prior close would report a gap of roughly zero.
  const sessionDate = latest?.date ?? null;
  const priorBars = sessionDate
    ? daily.bars.filter((b) => etDate(b.t) < sessionDate)
    : daily.bars;
  const priorBar = priorBars[priorBars.length - 1] ?? daily.bars[daily.bars.length - 1];
  const prevClose = priorBar.c;

  const atrPct = a != null && prevClose > 0 ? (a / prevClose) * 100 : null;

  const pre: Bar[] = latest?.pre ?? [];
  if (pre.length === 0) {
    return {
      prevClose, last: null, high: null, low: null, volume: 0, dollarVolume: 0,
      bars: 0, gapPct: null, atrPct, sessionDate,
    };
  }

  const high = Math.max(...pre.map((b) => b.h));
  const low = Math.min(...pre.map((b) => b.l));
  const last = pre[pre.length - 1].c;
  const volume = pre.reduce((s, b) => s + b.v, 0);
  // Turnover uses each bar's own typical price, so a name that gapped and then
  // faded is not credited at its best print.
  const dollarVolume = pre.reduce((s, b) => s + ((b.h + b.l + b.c) / 3) * b.v, 0);
  const gapPct = prevClose > 0 ? ((last - prevClose) / prevClose) * 100 : null;

  return { prevClose, last, high, low, volume, dollarVolume, bars: pre.length, gapPct, atrPct, sessionDate };
}

/* ------------------------------------------------------------------ *
 * Candidate discovery
 * ------------------------------------------------------------------ */

const SCREENS: { id: string; label: string }[] = [
  { id: "day_gainers", label: "Gainers" },
  { id: "day_losers", label: "Losers" },
  { id: "most_actives", label: "Most active" },
];

interface Candidate {
  symbol: string;
  name: string;
  source: string[];
  /** The quote's premarket change, used only to pick who is worth measuring. */
  hintPct: number | null;
  avgDollarVolume: number;
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

/**
 * Yahoo publishes no premarket screener, so the candidate pool comes from the
 * regular-hours screens -- a reasonable proxy for "liquid and in play" -- and is
 * then narrowed by the quote's premarket field.
 *
 * That field is a hint only. Everything the board reports is re-measured from
 * bars in `measure`, because the quote's premarket number has no volume behind
 * it and cannot tell a real gap from a single odd-lot print.
 */
async function discoverCandidates(opts: {
  exclude: Set<string>;
  minPrice: number;
  minDollarVolume: number;
  minHintPct: number;
}): Promise<{ candidates: Candidate[]; scanned: number; notes: string[] }> {
  const notes: string[] = [];
  const bySymbol = new Map<string, Candidate>();
  let scanned = 0;

  const screens = await Promise.all(SCREENS.map((s) => fetchScreen(s.id, 100)));

  screens.forEach((quotes, i) => {
    const label = SCREENS[i].label;
    if (quotes.length === 0) {
      notes.push(`The ${label.toLowerCase()} screen returned nothing this run.`);
      return;
    }
    for (const q of quotes) {
      scanned++;
      const symbol = String(q.symbol ?? "").toUpperCase();
      if (!symbol || opts.exclude.has(symbol)) continue;
      if (q.quoteType !== "EQUITY") continue;

      const price = Number(q.regularMarketPrice);
      const avgVolume = Number(q.averageDailyVolume3Month) || 0;
      if (!Number.isFinite(price) || price < opts.minPrice) continue;
      if (avgVolume * price < opts.minDollarVolume) continue;

      const existing = bySymbol.get(symbol);
      if (existing) {
        if (!existing.source.includes(label)) existing.source.push(label);
        continue;
      }

      const hint = Number(q.preMarketChangePercent);
      bySymbol.set(symbol, {
        symbol,
        name: String(q.shortName ?? q.longName ?? symbol),
        source: [label],
        hintPct: Number.isFinite(hint) ? hint : null,
        avgDollarVolume: avgVolume * price,
      });
    }
  });

  const withHint = [...bySymbol.values()].filter(
    (c) => c.hintPct != null && Math.abs(c.hintPct) >= opts.minHintPct,
  );

  if (withHint.length === 0 && bySymbol.size > 0) {
    notes.push(
      "No screened name carried a premarket quote this run, so the board is the " +
      "watchlist only. Yahoo populates the premarket field once the 4am tape starts.",
    );
  }

  return {
    candidates: withHint.sort((a, b) => Math.abs(b.hintPct!) - Math.abs(a.hintPct!)),
    scanned,
    notes,
  };
}

/* ------------------------------------------------------------------ *
 * The scan
 * ------------------------------------------------------------------ */

export interface PremarketOptions {
  /** Always measured, and always reported even when they have not traded. */
  watchlist: string[];
  /** Benchmarks for relative strength. The first is the one rsAtr uses. */
  benchmarks: string[];
  /** How many discovered names to measure on top of the watchlist. */
  limit: number;
  minPrice: number;
  minDollarVolume: number;
  /** Quote-level premarket move a name needs before it is worth measuring. */
  minHintPct: number;
  /** Premarket turnover a discovered name needs before it is shown. */
  minPremarketDollarVolume: number;
  cacheDir: string | null;
  intraTtl: number;
  dailyTtl: number;
  onProgress?: (line: string) => void;
}

export async function scanPremarket(opts: PremarketOptions, now = new Date()): Promise<PremarketScan> {
  const notes: string[] = [];
  const skipped: { symbol: string; reason: string }[] = [];
  const window = windowState(now);

  const watchlist = opts.watchlist.map((s) => s.toUpperCase());
  const benchmarks = opts.benchmarks.map((s) => s.toUpperCase());

  // Benchmarks first: nothing else can be expressed relative to them until they
  // are measured, and a failure here costs relative strength but not the board.
  const benchMeasured = new Map<string, Measured>();
  for (const b of benchmarks) {
    try {
      benchMeasured.set(b, await measure(b, opts.cacheDir, opts.intraTtl, opts.dailyTtl));
    } catch (e) {
      notes.push(`${b} could not be measured, so relative strength against it is unavailable (${(e as Error).message}).`);
    }
  }

  const spyGap = benchMeasured.get(benchmarks[0])?.gapPct ?? null;
  const qqqGap = benchmarks[1] ? benchMeasured.get(benchmarks[1])?.gapPct ?? null : null;

  const exclude = new Set<string>([...watchlist, ...benchmarks]);
  let candidates: Candidate[] = [];
  let screensScanned = 0;

  if (opts.limit > 0) {
    const found = await discoverCandidates({
      exclude,
      minPrice: opts.minPrice,
      minDollarVolume: opts.minDollarVolume,
      minHintPct: opts.minHintPct,
    });
    candidates = found.candidates.slice(0, opts.limit);
    screensScanned = found.scanned;
    notes.push(...found.notes);
  }

  // The watchlist is carried as its own set of candidates so that one code path
  // measures everything and the only difference is whether a thin name is shown.
  const all: Candidate[] = [
    ...watchlist.map((s) => ({ symbol: s, name: s, source: ["watchlist"], hintPct: null, avgDollarVolume: 0 })),
    ...candidates,
  ];

  let sessionDate: string | null = null;

  const reads = await mapPool(all, 3, async (c): Promise<PremarketRead | null> => {
    const isWatchlist = c.source.includes("watchlist");
    let m: Measured;
    try {
      m = await measure(c.symbol, opts.cacheDir, opts.intraTtl, opts.dailyTtl);
    } catch (e) {
      // A name whose log cannot be fetched is reported as skipped, not filled in.
      skipped.push({ symbol: c.symbol, reason: (e as Error).message });
      return null;
    }
    if (m.sessionDate && !sessionDate) sessionDate = m.sessionDate;

    // A gap with no turnover behind it is a quote artifact, not a move. Watchlist
    // names stay on the board either way -- an untraded watchlist name is
    // information -- but a discovered name has to earn its row.
    if (!isWatchlist && m.dollarVolume < opts.minPremarketDollarVolume) {
      skipped.push({
        symbol: c.symbol,
        reason: `only $${Math.round(m.dollarVolume).toLocaleString()} traded premarket, under the $${Math.round(opts.minPremarketDollarVolume).toLocaleString()} floor`,
      });
      return null;
    }

    const gapAtr = m.gapPct != null && m.atrPct != null && m.atrPct > 0 ? m.gapPct / m.atrPct : null;
    const rsSpy = m.gapPct != null && spyGap != null ? m.gapPct - spyGap : null;
    const rsQqq = m.gapPct != null && qqqGap != null ? m.gapPct - qqqGap : null;
    const rsAtr = rsSpy != null && m.atrPct != null && m.atrPct > 0 ? rsSpy / m.atrPct : null;

    const why: string[] = [];
    let score: number | null = null;
    let lean: PremarketRead["lean"] = "untraded";

    if (m.bars === 0 || m.gapPct == null) {
      why.push("nothing has traded premarket yet");
    } else {
      // Ranked on relative strength in ATRs, with turnover as the tiebreak: the
      // move has to be big for the name, not just big, and someone has to be
      // trading it.
      const rsTerm = rsAtr != null ? rsAtr : gapAtr ?? 0;
      const liq = Math.min(Math.log10(Math.max(m.dollarVolume, 1)) / 7, 1);
      score = rsTerm * 2.2 + Math.sign(rsTerm) * liq * 0.8;

      if (rsSpy != null) {
        const word = rsSpy >= 0 ? "outpacing" : "lagging";
        why.push(`${word} ${benchmarks[0]} by ${Math.abs(rsSpy).toFixed(2)}pt`);
      }
      if (gapAtr != null) why.push(`${m.gapPct >= 0 ? "up" : "down"} ${Math.abs(gapAtr).toFixed(2)} ATR`);
      if (m.dollarVolume > 0) why.push(`$${(m.dollarVolume / 1e6).toFixed(1)}M premarket turnover`);

      lean = score > 0.9 ? "long-side" : score < -0.9 ? "short-side" : "unclear";
    }

    opts.onProgress?.(
      `  ${c.symbol.padEnd(6)} ${(m.last ?? m.prevClose).toFixed(2).padStart(9)} ` +
      `${((m.gapPct ?? 0) >= 0 ? "+" : "") + (m.gapPct?.toFixed(2) ?? "--")}%`.padStart(9) +
      `  rs ${rsAtr != null ? (rsAtr >= 0 ? "+" : "") + rsAtr.toFixed(2) : " --"} ATR  ${lean}`,
    );

    return {
      symbol: c.symbol,
      name: c.name,
      source: c.source,
      prevClose: m.prevClose,
      last: m.last, high: m.high, low: m.low,
      volume: m.volume, dollarVolume: m.dollarVolume, bars: m.bars,
      gapPct: m.gapPct, atrPct: m.atrPct, gapAtr,
      rsSpy, rsQqq, rsAtr,
      score, lean,
      why: why.length > 0 ? why.join("; ").replace(/^./, (ch) => ch.toUpperCase()) + "." : "",
      errors: [],
    };
  });

  const names = reads
    .filter((r): r is PremarketRead => r != null)
    .sort((a, b) => {
      // Untraded names sink to the bottom rather than being dropped.
      if (a.score == null && b.score == null) return a.symbol.localeCompare(b.symbol);
      if (a.score == null) return 1;
      if (b.score == null) return -1;
      return Math.abs(b.score) - Math.abs(a.score);
    });

  if (window !== "premarket") {
    notes.push(
      window === "regular-or-later"
        ? "The regular session has opened, so this is the last premarket state rather than a live one."
        : window === "before-premarket"
          ? "The premarket tape has not started yet; there is nothing to measure before 4:00am ET."
          : "Weekend -- no premarket session.",
    );
  }

  return {
    generatedAt: now.getTime(),
    window,
    sessionDate,
    benchmarks: benchmarks.map((s) => ({ symbol: s, gapPct: benchMeasured.get(s)?.gapPct ?? null })),
    names,
    skipped,
    screensScanned,
    notes,
  };
}

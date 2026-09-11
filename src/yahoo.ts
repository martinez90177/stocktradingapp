import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Bar, Series, TradingPeriod } from "./types.ts";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const HOSTS = ["https://query2.finance.yahoo.com", "https://query1.finance.yahoo.com"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Yahoo returns arrays that are parallel to `timestamp` but can contain nulls
 * where a bar has no trade (common in pre/post market). Those bars are dropped
 * rather than interpolated -- a fabricated bar would corrupt every level
 * computed downstream.
 */
function normalize(json: any, symbol: string): Series {
  const result = json?.chart?.result?.[0];
  if (!result) {
    const desc = json?.chart?.error?.description ?? "no result in response";
    throw new Error(`${symbol}: ${desc}`);
  }
  const ts: number[] = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const bars: Bar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) continue;
    bars.push({ t: ts[i] * 1000, o, h, l, c, v: Number.isFinite(q.volume?.[i]) ? q.volume[i] : 0 });
  }
  if (bars.length === 0) throw new Error(`${symbol}: no usable bars returned`);

  // tradingPeriods arrives either as TradingPeriod[][] (one row per day) or,
  // for daily bars, not at all.
  let periods: TradingPeriod[] | undefined;
  const raw = result.meta?.tradingPeriods;
  if (Array.isArray(raw)) {
    const rows: any[] = Array.isArray(raw[0]) ? raw.map((r: any[]) => r[0]) : raw;
    const byDay = new Map<string, TradingPeriod>();
    for (const row of rows) {
      if (!row?.start) continue;
      const key = String(row.start);
      if (byDay.has(key)) continue;
      byDay.set(key, {
        preStart: 0, preEnd: 0,
        regStart: row.start * 1000,
        regEnd: row.end * 1000,
        postStart: 0, postEnd: 0,
      });
    }
    periods = [...byDay.values()].sort((a, b) => a.regStart - b.regStart);
  }

  const m = result.meta ?? {};
  return {
    symbol: m.symbol ?? symbol,
    name: m.longName ?? m.shortName ?? symbol,
    currency: m.currency ?? "USD",
    exchange: m.fullExchangeName ?? m.exchangeName ?? "",
    bars,
    periods,
    meta: {
      regularMarketPrice: m.regularMarketPrice ?? bars[bars.length - 1].c,
      previousClose: m.previousClose ?? m.chartPreviousClose ?? bars[bars.length - 1].c,
      fiftyTwoWeekHigh: m.fiftyTwoWeekHigh ?? Math.max(...bars.map((b) => b.h)),
      fiftyTwoWeekLow: m.fiftyTwoWeekLow ?? Math.min(...bars.map((b) => b.l)),
      regularMarketVolume: m.regularMarketVolume ?? 0,
    },
  };
}

interface FetchOpts {
  range: string;
  interval: string;
  /**
   * An explicit window in epoch seconds, used instead of `range`. Yahoo keeps
   * about 30 days of 1-minute bars but hands out at most 7 per request, so
   * anything older than a week has to be asked for a window at a time.
   */
  period1?: number;
  period2?: number;
  prePost?: boolean;
  cacheDir?: string;
  /** Seconds a cached response stays fresh. 0 disables the cache. */
  cacheTtl?: number;
}

export async function fetchSeries(symbol: string, opts: FetchOpts): Promise<Series> {
  const key = `${symbol}_${opts.period1 ? `${opts.period1}-${opts.period2}` : opts.range}_${opts.interval}${opts.prePost ? "_pp" : ""}`
    .replace(/[^a-zA-Z0-9_.-]/g, "_");
  const cacheFile = opts.cacheDir ? join(opts.cacheDir, `${key}.json`) : null;
  const ttl = opts.cacheTtl ?? 0;

  if (cacheFile && ttl > 0) {
    try {
      const raw = await readFile(cacheFile, "utf8");
      const wrapped = JSON.parse(raw);
      if (Date.now() - wrapped.fetchedAt < ttl * 1000) {
        return normalize(wrapped.body, symbol);
      }
    } catch {
      /* cache miss or unreadable -- fall through to network */
    }
  }

  const qs = new URLSearchParams({
    ...(opts.period1 ? { period1: String(opts.period1), period2: String(opts.period2) } : { range: opts.range }),
    interval: opts.interval,
    includePrePost: opts.prePost ? "true" : "false",
    events: "div,split",
  });

  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    const host = HOSTS[attempt % HOSTS.length];
    const url = `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${qs}`;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20_000);
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      if (res.status === 404) throw new Error(`${symbol}: not found on Yahoo Finance`);
      if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);

      const body = await res.json();
      const series = normalize(body, symbol);
      if (cacheFile) {
        await mkdir(opts.cacheDir!, { recursive: true });
        await writeFile(cacheFile, JSON.stringify({ fetchedAt: Date.now(), body }));
      }
      return series;
    } catch (err) {
      lastErr = err;
      if (String(err).includes("not found")) break;
      await sleep(400 * Math.pow(2, attempt) + Math.random() * 300);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`${symbol}: fetch failed`);
}

/** Runs `worker` over `items` with bounded concurrency, so Yahoo is not hammered. */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
      await sleep(120 + Math.random() * 180);
    }
  });
  await Promise.all(runners);
  return out;
}

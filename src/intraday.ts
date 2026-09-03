import type { Bar, IntradayContext, Series } from "./types.ts";
import { floorPivots } from "./levels.ts";
import { typicalPrice } from "./ta.ts";

const ET = "America/New_York";

const dayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: ET,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** ET calendar date for an epoch-ms timestamp, as YYYY-MM-DD. */
export function etDate(t: number): string {
  return dayFmt.format(new Date(t));
}

export const etTime = (t: number) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(t));

export interface SessionDay {
  date: string;
  regStart: number;
  regEnd: number;
  pre: Bar[];
  regular: Bar[];
  post: Bar[];
}

/**
 * Splits intraday bars into ET trading days, using Yahoo's declared regular
 * session boundaries rather than assuming 9:30-16:00 -- half days and holiday
 * schedules would otherwise put real bars in the wrong bucket.
 */
export function splitSessions(series: Series): SessionDay[] {
  const byDate = new Map<string, SessionDay>();

  for (const p of series.periods ?? []) {
    const date = etDate(p.regStart);
    byDate.set(date, { date, regStart: p.regStart, regEnd: p.regEnd, pre: [], regular: [], post: [] });
  }

  for (const bar of series.bars) {
    const date = etDate(bar.t);
    let day = byDate.get(date);
    if (!day) {
      // No declared period for this date (rare). Fall back to standard hours so
      // the bars are still classified instead of silently dropped.
      const base = new Date(bar.t);
      const guessOpen = Date.parse(`${date}T09:30:00-04:00`);
      const guessClose = Date.parse(`${date}T16:00:00-04:00`);
      day = {
        date,
        regStart: Number.isFinite(guessOpen) ? guessOpen : base.getTime(),
        regEnd: Number.isFinite(guessClose) ? guessClose : base.getTime(),
        pre: [], regular: [], post: [],
      };
      byDate.set(date, day);
    }
    if (bar.t < day.regStart) day.pre.push(bar);
    else if (bar.t < day.regEnd) day.regular.push(bar);
    else day.post.push(bar);
  }

  return [...byDate.values()]
    .filter((d) => d.pre.length + d.regular.length + d.post.length > 0)
    .sort((a, b) => a.regStart - b.regStart);
}

/**
 * Extended-hours feeds carry quote artifacts: bars with no volume whose high or
 * low sits far outside their own open/close, because the wick came from a stale
 * spread rather than a trade. Left in, one of these invents a premarket high
 * that never traded and drags every level near it.
 *
 * Such bars are dropped, not clamped -- trimming a wick would be substituting a
 * number the market never printed. Zero volume alone is not enough to drop a
 * bar, because Yahoo reports 0 for plenty of genuine pre/post-market bars.
 */
export function sanitizeIntraday(bars: Bar[]): { bars: Bar[]; dropped: number } {
  if (bars.length < 10) return { bars, dropped: 0 };

  const traded = bars.filter((b) => b.v > 0);
  const sample = (traded.length >= 10 ? traded : bars).map((b) => b.h - b.l).sort((a, b) => a - b);
  const median = sample[Math.floor(sample.length / 2)];
  if (!(median > 0)) return { bars, dropped: 0 };

  const limit = median * 6;
  const kept = bars.filter((b) => {
    if (b.v > 0) return true;
    const body = { hi: Math.max(b.o, b.c), lo: Math.min(b.o, b.c) };
    return b.h - body.hi <= limit && body.lo - b.l <= limit;
  });

  return { bars: kept, dropped: bars.length - kept.length };
}

function vwap(bars: Bar[]): number | null {
  let pv = 0;
  let vol = 0;
  for (const b of bars) {
    if (b.v <= 0) continue;
    pv += typicalPrice(b) * b.v;
    vol += b.v;
  }
  return vol > 0 ? pv / vol : null;
}

function ohlc(bars: Bar[]) {
  return {
    o: bars[0].o,
    h: Math.max(...bars.map((b) => b.h)),
    l: Math.min(...bars.map((b) => b.l)),
    c: bars[bars.length - 1].c,
    v: bars.reduce((a, b) => a + b.v, 0),
  };
}

/**
 * Builds the intraday reference levels a day trader wants at the open.
 *
 * `dailyBars` supplies the authoritative prior-day OHLC; the intraday feed only
 * covers a few days and its first day is usually partial.
 */
export function buildIntradayContext(
  intraday: Series | null,
  dailyBars: Bar[],
  openRangeMinutes = 30,
): IntradayContext {
  const empty: IntradayContext = {
    priorDay: null,
    premarket: null,
    openingRange: null,
    sessionVwap: null,
    premarketVwap: null,
    gapPct: null,
    floorPivots: null,
  };
  if (dailyBars.length < 2) return empty;

  const sessions = intraday ? splitSessions(intraday) : [];
  const now = Date.now();

  // "Today" is the newest session whose premarket has begun. If the intraday
  // feed has not rolled to the next day yet, the newest session is the last
  // completed one and there is no live premarket to report.
  const latest = sessions[sessions.length - 1] ?? null;
  const todayIsLive = latest != null && (latest.pre.length > 0 || latest.regular.length > 0);

  // The prior completed daily bar. If the daily feed already includes today,
  // step back one more.
  const lastDaily = dailyBars[dailyBars.length - 1];
  const priorIsToday = latest != null && etDate(lastDaily.t) === latest.date && latest.regular.length > 0;
  const priorBar = priorIsToday ? dailyBars[dailyBars.length - 2] : lastDaily;

  const priorDay = {
    date: etDate(priorBar.t),
    o: priorBar.o,
    h: priorBar.h,
    l: priorBar.l,
    c: priorBar.c,
    v: priorBar.v,
  };

  let premarket: IntradayContext["premarket"] = null;
  let premarketVwap: number | null = null;
  if (todayIsLive && latest.pre.length > 0 && latest.date !== priorDay.date) {
    const p = ohlc(latest.pre);
    premarket = {
      date: latest.date,
      high: p.h,
      low: p.l,
      volume: p.v,
      last: p.c,
      bars: latest.pre.length,
    };
    premarketVwap = vwap(latest.pre);
  }

  // Opening range: today's if the session has run long enough, otherwise the
  // most recent completed one, flagged as reference rather than live.
  let openingRange: IntradayContext["openingRange"] = null;
  const orSource = sessions
    .slice()
    .reverse()
    .find((s) => s.regular.length > 0);
  if (orSource) {
    const cutoff = orSource.regStart + openRangeMinutes * 60_000;
    const orBars = orSource.regular.filter((b) => b.t < cutoff);
    const complete = now >= cutoff && orBars.length > 0;
    if (orBars.length > 0) {
      const r = ohlc(orBars);
      openingRange = {
        minutes: openRangeMinutes,
        high: r.h,
        low: r.l,
        date: orSource.date,
        pending: !complete,
      };
    }
  }

  const vwapSource = sessions
    .slice()
    .reverse()
    .find((s) => s.regular.length > 0);
  const sessionVwap = vwapSource ? vwap(vwapSource.regular) : null;

  const lastPrice = premarket?.last ?? dailyBars[dailyBars.length - 1].c;
  const gapPct = priorDay.c > 0 ? ((lastPrice - priorDay.c) / priorDay.c) * 100 : null;

  return {
    priorDay,
    premarket,
    openingRange,
    sessionVwap,
    premarketVwap,
    gapPct: premarket ? gapPct : null,
    floorPivots: floorPivots(priorDay.h, priorDay.l, priorDay.c),
  };
}

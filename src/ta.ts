import type { Bar, Pivot } from "./types.ts";

export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's ATR. */
export function atr(bars: Bar[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  if (bars.length < period + 1) return out;
  const tr: number[] = [bars[0].h - bars[0].l];
  for (let i = 1; i < bars.length; i++) {
    const prevClose = bars[i - 1].c;
    tr.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - prevClose), Math.abs(bars[i].l - prevClose)));
  }
  let prev = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  out[period] = prev;
  for (let i = period + 1; i < bars.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI. */
export function rsi(values: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period + 1) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let ag = gain / period, al = loss / period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

/** Bollinger bandwidth as a percentage of the middle band -- the squeeze metric. */
export function bollingerWidthPct(values: number[], period = 20, mult = 2): (number | null)[] {
  const mid = sma(values, period);
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const m = mid[i];
    if (m == null) continue;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) sq += (values[j] - m) ** 2;
    const sd = Math.sqrt(sq / period);
    out[i] = m === 0 ? null : ((2 * mult * sd) / m) * 100;
  }
  return out;
}

/**
 * Percentile rank of the final value within the trailing window.
 * 0 = tightest reading in the window (a squeeze), 100 = widest.
 */
export function percentileRankOfLast(values: (number | null)[], window: number): number | null {
  const tail = values.slice(-window).filter((v): v is number => v != null);
  if (tail.length < 10) return null;
  const last = tail[tail.length - 1];
  const below = tail.filter((v) => v < last).length;
  return (below / tail.length) * 100;
}

/**
 * Fractal swing pivots. Bar i is a pivot high when its high is the strict
 * maximum of the +/- k window. Bars within k of the right edge cannot be
 * confirmed, so the most recent k bars never produce a pivot -- that is
 * correct, not a gap to paper over.
 */
export function findPivots(bars: Bar[], k: number): Pivot[] {
  const out: Pivot[] = [];
  for (let i = k; i < bars.length - k; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (bars[j].h >= bars[i].h) isHigh = false;
      if (bars[j].l <= bars[i].l) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) out.push({ index: i, t: bars[i].t, price: bars[i].h, kind: "high", strength: k });
    if (isLow) out.push({ index: i, t: bars[i].t, price: bars[i].l, kind: "low", strength: k });
  }
  return out;
}

/** Merges pivot sets from several fractal widths, keeping the strongest at each bar. */
export function mergePivots(sets: Pivot[][]): Pivot[] {
  const best = new Map<string, Pivot>();
  for (const set of sets) {
    for (const p of set) {
      const key = `${p.index}:${p.kind}`;
      const existing = best.get(key);
      if (!existing || p.strength > existing.strength) best.set(key, p);
    }
  }
  return [...best.values()].sort((a, b) => a.index - b.index);
}

/** Least-squares fit over [x, y] points. Returns slope and intercept. */
export function linreg(points: [number, number][]): { slope: number; intercept: number } {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: points[0]?.[1] ?? 0 };
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (const [x, y] of points) { sx += x; sy += y; sxy += x * y; sxx += x * x; }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { slope: 0, intercept: sy / n };
  const slope = (n * sxy - sx * sy) / denom;
  return { slope, intercept: (sy - slope * sx) / n };
}

export function typicalPrice(b: Bar): number {
  return (b.h + b.l + b.c) / 3;
}

/**
 * Aggregates bars into fixed clock-aligned buckets (open = first, high = max,
 * low = min, close = last, volume = summed). Used only to draw a readable
 * chart: 380 five-minute candles across a 980px pane are 2px hairlines. Every
 * measurement still runs on the raw bars, because aggregating first would move
 * a premarket high onto the wrong timestamp.
 *
 * Buckets are keyed by absolute time, so an overnight gap produces no bucket
 * rather than one bar welded across the session boundary.
 */
export function resample(bars: Bar[], bucketMinutes: number): Bar[] {
  if (bars.length === 0 || bucketMinutes <= 0) return bars;
  const size = bucketMinutes * 60_000;
  const out: Bar[] = [];
  let key = NaN;
  let cur: Bar | null = null;

  for (const b of bars) {
    const k = Math.floor(b.t / size);
    if (cur === null || k !== key) {
      if (cur) out.push(cur);
      key = k;
      cur = { t: k * size, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * VWAP anchored at `fromIndex`. Bars with zero reported volume (common
 * pre/post market) contribute price but no weight, so the series continues
 * instead of breaking.
 */
export function anchoredVwap(bars: Bar[], fromIndex: number): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  let pv = 0, vol = 0;
  for (let i = Math.max(0, fromIndex); i < bars.length; i++) {
    const v = bars[i].v > 0 ? bars[i].v : 0;
    pv += typicalPrice(bars[i]) * v;
    vol += v;
    out[i] = vol > 0 ? pv / vol : null;
  }
  return out;
}

export const lastOf = <T,>(arr: (T | null)[]): T | null => {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i] as T;
  return null;
};

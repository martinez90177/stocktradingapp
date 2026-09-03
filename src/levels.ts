import type { Bar, FibSet, Level, LevelSource, Pivot } from "./types.ts";

/* ------------------------------------------------------------------ *
 * Volume profile
 * ------------------------------------------------------------------ */

export function volumeProfile(bars: Bar[], binCount = 60) {
  if (bars.length < 5) return null;
  const hi = Math.max(...bars.map((b) => b.h));
  const lo = Math.min(...bars.map((b) => b.l));
  if (!(hi > lo)) return null;
  const step = (hi - lo) / binCount;
  const vols = new Array(binCount).fill(0);

  // Volume is spread across every bin the bar's range covers, rather than
  // dumped at the close. A wide bar genuinely traded across that whole range.
  for (const b of bars) {
    if (b.v <= 0) continue;
    const from = Math.max(0, Math.min(binCount - 1, Math.floor((b.l - lo) / step)));
    const to = Math.max(0, Math.min(binCount - 1, Math.floor((b.h - lo) / step)));
    const span = to - from + 1;
    for (let i = from; i <= to; i++) vols[i] += b.v / span;
  }

  const total = vols.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  const bins = vols.map((v, i) => ({ price: lo + step * (i + 0.5), volume: v }));

  let pocIdx = 0;
  for (let i = 1; i < binCount; i++) if (vols[i] > vols[pocIdx]) pocIdx = i;

  // Value area: expand outward from the POC until 70% of volume is enclosed.
  let lower = pocIdx;
  let upper = pocIdx;
  let acc = vols[pocIdx];
  const target = total * 0.7;
  while (acc < target && (lower > 0 || upper < binCount - 1)) {
    const below = lower > 0 ? vols[lower - 1] : -1;
    const above = upper < binCount - 1 ? vols[upper + 1] : -1;
    if (above >= below) {
      upper++;
      acc += vols[upper];
    } else {
      lower--;
      acc += vols[lower];
    }
  }

  return { bins, poc: bins[pocIdx].price, vah: bins[upper].price, val: bins[lower].price };
}

/** High-volume nodes: local peaks in the profile, which act as shelves. */
export function highVolumeNodes(
  profile: { bins: { price: number; volume: number }[] },
  count = 3,
) {
  const { bins } = profile;
  const avg = bins.reduce((a, b) => a + b.volume, 0) / bins.length;
  const peaks: { price: number; volume: number }[] = [];
  for (let i = 2; i < bins.length - 2; i++) {
    const v = bins[i].volume;
    if (
      v > avg * 1.25 &&
      v >= bins[i - 1].volume &&
      v >= bins[i + 1].volume &&
      v > bins[i - 2].volume &&
      v > bins[i + 2].volume
    ) {
      peaks.push(bins[i]);
    }
  }
  return peaks.sort((a, b) => b.volume - a.volume).slice(0, count);
}

/* ------------------------------------------------------------------ *
 * Fibonacci
 * ------------------------------------------------------------------ */

const RETRACEMENTS = [0.236, 0.382, 0.5, 0.618, 0.702, 0.786];
const EXTENSIONS = [1.272, 1.414, 1.618, 2.0, 2.618];

function buildFib(
  label: string,
  lowPivot: { price: number; t: number; index: number },
  highPivot: { price: number; t: number; index: number },
): FibSet {
  const range = highPivot.price - lowPivot.price;
  // The later pivot sets direction: if the high came last, the leg is an
  // up-impulse and retracements fall from the high back toward the low.
  const direction: "up" | "down" = highPivot.index > lowPivot.index ? "up" : "down";

  const retracements = RETRACEMENTS.map((ratio) => ({
    ratio,
    price: direction === "up" ? highPivot.price - range * ratio : lowPivot.price + range * ratio,
  }));
  const extensions = EXTENSIONS.map((ratio) => ({
    ratio,
    price: direction === "up" ? lowPivot.price + range * ratio : highPivot.price - range * ratio,
  }));

  const gp =
    direction === "up"
      ? { a: highPivot.price - range * 0.65, b: highPivot.price - range * 0.618 }
      : { a: lowPivot.price + range * 0.618, b: lowPivot.price + range * 0.65 };

  return {
    label,
    direction,
    anchorHigh: highPivot.price,
    anchorLow: lowPivot.price,
    anchorHighT: highPivot.t,
    anchorLowT: lowPivot.t,
    retracements,
    extensions,
    goldenPocket: { low: Math.min(gp.a, gp.b), high: Math.max(gp.a, gp.b) },
  };
}

/**
 * Picks the leg a trader would actually draw fibs on: the largest recent
 * low-to-high (or high-to-low) move, scored by size in ATR, how recently the
 * leg ended, and how cleanly it ran. A grinding six-month drift scores below a
 * sharp three-week impulse of the same size.
 */
export function dominantFib(bars: Bar[], pivots: Pivot[], atrValue: number): FibSet | null {
  const majors = pivots.filter((p) => p.strength >= 8);
  if (majors.length < 2 || atrValue <= 0) return null;
  const n = bars.length;

  let best: { score: number; low: Pivot; high: Pivot } | null = null;
  for (let i = 0; i < majors.length; i++) {
    for (let j = i + 1; j < majors.length; j++) {
      const a = majors[i];
      const b = majors[j];
      if (a.kind === b.kind) continue;
      const low = a.kind === "low" ? a : b;
      const high = a.kind === "high" ? a : b;
      const range = high.price - low.price;
      if (range <= 0) continue;

      const sizeAtr = range / atrValue;
      if (sizeAtr < 3) continue; // too small to be a meaningful leg

      const endIdx = Math.max(a.index, b.index);
      const recency = Math.exp(-(n - 1 - endIdx) / 90);
      const spanBars = Math.abs(a.index - b.index);
      const cleanliness = spanBars > 0 ? Math.min(1, 60 / spanBars) : 0;

      const score = sizeAtr * recency * (0.55 + 0.45 * cleanliness);
      if (!best || score > best.score) best = { score, low, high };
    }
  }
  if (!best) return null;
  return buildFib("Dominant swing", best.low, best.high);
}

/** A slower fib drawn across the full lookback range. */
export function rangeFib(bars: Bar[], label = "52-week range"): FibSet | null {
  if (bars.length < 30) return null;
  let hiIdx = 0;
  let loIdx = 0;
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].h > bars[hiIdx].h) hiIdx = i;
    if (bars[i].l < bars[loIdx].l) loIdx = i;
  }
  if (hiIdx === loIdx) return null;
  return buildFib(
    label,
    { price: bars[loIdx].l, t: bars[loIdx].t, index: loIdx },
    { price: bars[hiIdx].h, t: bars[hiIdx].t, index: hiIdx },
  );
}

/* ------------------------------------------------------------------ *
 * Floor-trader pivots
 * ------------------------------------------------------------------ */

export function floorPivots(h: number, l: number, c: number) {
  const pp = (h + l + c) / 3;
  const range = h - l;
  return {
    pp,
    r1: 2 * pp - l,
    s1: 2 * pp - h,
    r2: pp + range,
    s2: pp - range,
    r3: h + 2 * (pp - l),
    s3: l - 2 * (h - pp),
  };
}

/* ------------------------------------------------------------------ *
 * Unfilled gaps
 * ------------------------------------------------------------------ */

export interface Gap {
  from: number;
  to: number;
  index: number;
  t: number;
  direction: "up" | "down";
}

export function unfilledGaps(bars: Bar[], atrValue: number, lookback = 90, minAtrFrac = 0.4): Gap[] {
  const out: Gap[] = [];
  const start = Math.max(1, bars.length - lookback);
  for (let i = start; i < bars.length; i++) {
    const prev = bars[i - 1];
    const cur = bars[i];
    if (cur.l > prev.h && cur.l - prev.h > atrValue * minAtrFrac) {
      // A gap up survives only while nothing has traded back down into it.
      const filled = bars.slice(i + 1).some((b) => b.l <= prev.h);
      if (!filled) out.push({ from: prev.h, to: cur.l, index: i, t: cur.t, direction: "up" });
    } else if (cur.h < prev.l && prev.l - cur.h > atrValue * minAtrFrac) {
      const filled = bars.slice(i + 1).some((b) => b.h >= prev.l);
      if (!filled) out.push({ from: cur.h, to: prev.l, index: i, t: cur.t, direction: "down" });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Round numbers
 * ------------------------------------------------------------------ */

/** Whole-dollar and half-dollar levels near price, scaled to the price band. */
export function roundNumbers(price: number, atrValue: number): number[] {
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(price, 1))));
  const step = magnitude / 10; // e.g. $10 steps near $300, $1 steps near $30
  const reach = Math.max(atrValue * 3, price * 0.05);
  const out: number[] = [];
  const first = Math.ceil((price - reach) / step) * step;
  for (let p = first; p <= price + reach; p += step) {
    if (p > 0) out.push(Number(p.toFixed(4)));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Confluence clustering
 * ------------------------------------------------------------------ */

/**
 * Merges candidates sitting within `tolerance` into one level. Score is summed
 * weight plus a bonus per *distinct* method, because agreement across
 * independent methods is the real signal: five old pivots at one price rank
 * below a fib + moving average + POC + pivot stack.
 */
export function clusterLevels(
  sources: LevelSource[],
  price: number,
  tolerance: number,
  atrValue: number,
): Level[] {
  if (sources.length === 0) return [];
  const sorted = [...sources].sort((a, b) => a.price - b.price);

  const groups: LevelSource[][] = [];
  let current: LevelSource[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const anchor = current.reduce((a, s) => a + s.price, 0) / current.length;
    if (Math.abs(sorted[i].price - anchor) <= tolerance) current.push(sorted[i]);
    else {
      groups.push(current);
      current = [sorted[i]];
    }
  }
  groups.push(current);

  const levels: Level[] = groups.map((g) => {
    const totalWeight = g.reduce((a, s) => a + s.weight, 0);
    const center = g.reduce((a, s) => a + s.price * s.weight, 0) / totalWeight;
    const methods = [...new Set(g.map((s) => s.method))];
    const distancePct = ((center - price) / price) * 100;
    return {
      price: center,
      low: Math.min(...g.map((s) => s.price)),
      high: Math.max(...g.map((s) => s.price)),
      score: totalWeight + (methods.length - 1) * 2.2,
      methods,
      labels: [...new Set(g.map((s) => s.label))],
      side: Math.abs(distancePct) < 0.15 ? "at-price" : center > price ? "resistance" : "support",
      distancePct,
      distanceAtr: atrValue > 0 ? (center - price) / atrValue : 0,
    };
  });

  return levels.sort((a, b) => b.score - a.score);
}

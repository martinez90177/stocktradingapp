import type { Bar, Pattern, Pivot } from "./types.ts";
import { linreg } from "./ta.ts";

interface Ctx {
  bars: Bar[];
  pivots: Pivot[];
  atr: number;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  sma50Series: (number | null)[];
  sma200Series: (number | null)[];
  bbSqueezeRank: number | null;
  price: number;
}

/* ------------------------------------------------------------------ *
 * Trend structure
 * ------------------------------------------------------------------ */

function trendStructure(ctx: Ctx): Pattern | null {
  const majors = ctx.pivots.filter((p) => p.strength >= 5).slice(-8);
  const highs = majors.filter((p) => p.kind === "high").slice(-3);
  const lows = majors.filter((p) => p.kind === "low").slice(-3);
  if (highs.length < 2 || lows.length < 2) return null;

  const hh = highs[highs.length - 1].price > highs[highs.length - 2].price;
  const hl = lows[lows.length - 1].price > lows[lows.length - 2].price;
  const lh = highs[highs.length - 1].price < highs[highs.length - 2].price;
  const ll = lows[lows.length - 1].price < lows[lows.length - 2].price;

  const stackUp = ctx.sma20 != null && ctx.sma50 != null && ctx.sma200 != null &&
    ctx.sma20 > ctx.sma50 && ctx.sma50 > ctx.sma200;
  const stackDown = ctx.sma20 != null && ctx.sma50 != null && ctx.sma200 != null &&
    ctx.sma20 < ctx.sma50 && ctx.sma50 < ctx.sma200;

  if (hh && hl) {
    return {
      name: "Uptrend structure",
      direction: "bullish",
      confidence: stackUp ? 0.9 : 0.65,
      status: "forming",
      description: `Higher highs and higher lows${stackUp ? ", with 20 > 50 > 200 SMA stacked up" : ""}. Last higher low at ${lows[lows.length - 1].price.toFixed(2)}.`,
      invalidation: lows[lows.length - 1].price,
    };
  }
  if (lh && ll) {
    return {
      name: "Downtrend structure",
      direction: "bearish",
      confidence: stackDown ? 0.9 : 0.65,
      status: "forming",
      description: `Lower highs and lower lows${stackDown ? ", with 20 < 50 < 200 SMA stacked down" : ""}. Last lower high at ${highs[highs.length - 1].price.toFixed(2)}.`,
      invalidation: highs[highs.length - 1].price,
    };
  }
  return {
    name: "Range / no clear trend",
    direction: "neutral",
    confidence: 0.5,
    status: "forming",
    description: `Swing highs and lows are not making a consistent series. Working between roughly ${Math.min(...lows.map((l) => l.price)).toFixed(2)} and ${Math.max(...highs.map((h) => h.price)).toFixed(2)}.`,
  };
}

/* ------------------------------------------------------------------ *
 * Moving-average crosses
 * ------------------------------------------------------------------ */

function maCross(ctx: Ctx): Pattern | null {
  const { sma50Series: a, sma200Series: b, bars } = ctx;
  const n = bars.length;
  for (let i = n - 1; i >= Math.max(1, n - 15); i--) {
    const a0 = a[i - 1], a1 = a[i], b0 = b[i - 1], b1 = b[i];
    if (a0 == null || a1 == null || b0 == null || b1 == null) continue;
    if (a0 <= b0 && a1 > b1) {
      return {
        name: "Golden cross",
        direction: "bullish",
        confidence: 0.7,
        status: "recent",
        description: `50 SMA crossed above the 200 SMA ${n - 1 - i} session(s) ago, near ${a1.toFixed(2)}.`,
        from: i,
        to: n - 1,
      };
    }
    if (a0 >= b0 && a1 < b1) {
      return {
        name: "Death cross",
        direction: "bearish",
        confidence: 0.7,
        status: "recent",
        description: `50 SMA crossed below the 200 SMA ${n - 1 - i} session(s) ago, near ${a1.toFixed(2)}.`,
        from: i,
        to: n - 1,
      };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Volatility squeeze / contraction
 * ------------------------------------------------------------------ */

function squeeze(ctx: Ctx): Pattern | null {
  const rank = ctx.bbSqueezeRank;
  if (rank == null || rank > 15) return null;
  const recent = ctx.bars.slice(-20);
  const hi = Math.max(...recent.map((b) => b.h));
  const lo = Math.min(...recent.map((b) => b.l));
  return {
    name: "Volatility squeeze",
    direction: "neutral",
    confidence: 0.55 + (15 - rank) / 40,
    status: "forming",
    description: `Bollinger bandwidth is in the tightest ${rank.toFixed(0)}% of the last 6 months. The 20-session range is ${lo.toFixed(2)} to ${hi.toFixed(2)}; expansion out of a coil like this usually resolves as a range break.`,
    trigger: hi,
    invalidation: lo,
    from: ctx.bars.length - 20,
    to: ctx.bars.length - 1,
  };
}

/* ------------------------------------------------------------------ *
 * Inside day / narrow range
 * ------------------------------------------------------------------ */

function narrowRange(ctx: Ctx): Pattern | null {
  const { bars } = ctx;
  const n = bars.length;
  if (n < 8) return null;
  const last = bars[n - 1];
  const prev = bars[n - 2];
  const ranges = bars.slice(-7).map((b) => b.h - b.l);
  const isNr7 = ranges[ranges.length - 1] === Math.min(...ranges);
  const isInside = last.h <= prev.h && last.l >= prev.l;
  if (!isNr7 && !isInside) return null;

  const tags = [isInside ? "inside day" : null, isNr7 ? "narrowest range in 7" : null]
    .filter(Boolean)
    .join(" and ");
  return {
    name: "Range contraction",
    direction: "neutral",
    confidence: isNr7 && isInside ? 0.7 : 0.5,
    status: "forming",
    description: `Last session was an ${tags}. Break of ${last.h.toFixed(2)} or ${last.l.toFixed(2)} sets the near-term direction.`,
    trigger: last.h,
    invalidation: last.l,
    from: n - 2,
    to: n - 1,
  };
}

/* ------------------------------------------------------------------ *
 * Flags
 * ------------------------------------------------------------------ */

function flag(ctx: Ctx): Pattern | null {
  const { bars, atr } = ctx;
  const n = bars.length;
  if (n < 25 || atr <= 0) return null;

  // Search recent consolidations: a sharp pole followed by a shallow drift.
  for (let flagLen = 3; flagLen <= 18; flagLen++) {
    const flagStart = n - flagLen;
    if (flagStart < 12) break;
    for (let poleLen = 4; poleLen <= 12; poleLen++) {
      const poleStart = flagStart - poleLen;
      if (poleStart < 0) continue;

      const poleFrom = bars[poleStart].c;
      const poleTo = bars[flagStart - 1].c;
      const poleMove = poleTo - poleFrom;
      const poleAtr = Math.abs(poleMove) / atr;
      if (poleAtr < 3.5) continue;

      const flagBars = bars.slice(flagStart);
      const fHigh = Math.max(...flagBars.map((b) => b.h));
      const fLow = Math.min(...flagBars.map((b) => b.l));
      const flagRange = fHigh - fLow;
      if (flagRange > Math.abs(poleMove) * 0.55) continue; // pullback too deep

      // Volume should dry up through the flag relative to the pole.
      const poleVol = bars.slice(poleStart, flagStart).reduce((a, b) => a + b.v, 0) / poleLen;
      const flagVol = flagBars.reduce((a, b) => a + b.v, 0) / flagBars.length;
      const volDries = poleVol > 0 ? flagVol < poleVol * 0.95 : false;

      const drift = linreg(flagBars.map((b, i) => [i, b.c] as [number, number])).slope;
      const bullish = poleMove > 0;
      // A flag drifts against the pole, or sideways -- never with it.
      if (bullish && drift > 0.15 * atr) continue;
      if (!bullish && drift < -0.15 * atr) continue;

      const conf = Math.min(0.92, 0.42 + Math.min(poleAtr, 9) / 22 + (volDries ? 0.16 : 0));
      if (conf < 0.55) continue;

      return {
        name: bullish ? "Bull flag" : "Bear flag",
        direction: bullish ? "bullish" : "bearish",
        confidence: conf,
        status: "forming",
        description: `A ${poleAtr.toFixed(1)} ATR ${bullish ? "advance" : "decline"} over ${poleLen} sessions, then ${flagLen} sessions of ${bullish ? "shallow pullback" : "shallow bounce"}${volDries ? " on lighter volume" : ""}. Flag range ${fLow.toFixed(2)} to ${fHigh.toFixed(2)}.`,
        trigger: bullish ? fHigh : fLow,
        invalidation: bullish ? fLow : fHigh,
        from: poleStart,
        to: n - 1,
        lines: [
          { points: [[poleStart, poleFrom], [flagStart - 1, poleTo]], style: "solid" },
          { points: [[flagStart, bullish ? fHigh : fLow], [n - 1, bullish ? fHigh : fLow]], style: "dashed" },
        ],
      };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Triangles / wedges
 * ------------------------------------------------------------------ */

function triangle(ctx: Ctx): Pattern | null {
  const { bars, pivots, atr } = ctx;
  const n = bars.length;
  if (n < 30 || atr <= 0) return null;

  const window = 70;
  const start = Math.max(0, n - window);
  const inWindow = pivots.filter((p) => p.index >= start);
  const highs = inWindow.filter((p) => p.kind === "high");
  const lows = inWindow.filter((p) => p.kind === "low");
  if (highs.length < 2 || lows.length < 2) return null;

  const hFit = linreg(highs.map((p) => [p.index, p.price] as [number, number]));
  const lFit = linreg(lows.map((p) => [p.index, p.price] as [number, number]));

  const first = Math.min(highs[0].index, lows[0].index);
  const widthStart = (hFit.slope * first + hFit.intercept) - (lFit.slope * first + lFit.intercept);
  const widthNow = (hFit.slope * (n - 1) + hFit.intercept) - (lFit.slope * (n - 1) + lFit.intercept);
  if (widthStart <= 0 || widthNow <= 0) return null;
  const contraction = 1 - widthNow / widthStart;
  if (contraction < 0.25) return null; // not actually converging

  // Slope significance is measured in ATR per bar so it scales across tickers.
  const hSlopeAtr = (hFit.slope / atr) * 10;
  const lSlopeAtr = (lFit.slope / atr) * 10;
  const flat = 0.25;

  let name: string;
  let direction: Pattern["direction"];
  if (Math.abs(hSlopeAtr) < flat && lSlopeAtr > flat) {
    name = "Ascending triangle";
    direction = "bullish";
  } else if (Math.abs(lSlopeAtr) < flat && hSlopeAtr < -flat) {
    name = "Descending triangle";
    direction = "bearish";
  } else if (hSlopeAtr < -flat && lSlopeAtr > flat) {
    name = "Symmetrical triangle";
    direction = "neutral";
  } else if (hSlopeAtr > flat && lSlopeAtr > flat && hSlopeAtr < lSlopeAtr) {
    name = "Rising wedge";
    direction = "bearish";
  } else if (hSlopeAtr < -flat && lSlopeAtr < -flat && hSlopeAtr > lSlopeAtr) {
    name = "Falling wedge";
    direction = "bullish";
  } else {
    return null;
  }

  const upper = hFit.slope * (n - 1) + hFit.intercept;
  const lower = lFit.slope * (n - 1) + lFit.intercept;
  const touches = highs.length + lows.length;

  return {
    name,
    direction,
    confidence: Math.min(0.88, 0.35 + contraction * 0.5 + Math.min(touches, 8) * 0.03),
    status: "forming",
    description: `${touches} pivot touches over ${n - first} sessions, range contracted ${(contraction * 100).toFixed(0)}%. Upper line now ~${upper.toFixed(2)}, lower line ~${lower.toFixed(2)}.`,
    trigger: direction === "bearish" ? lower : upper,
    invalidation: direction === "bearish" ? upper : lower,
    from: first,
    to: n - 1,
    lines: [
      { points: [[first, hFit.slope * first + hFit.intercept], [n - 1, upper]], style: "solid" },
      { points: [[first, lFit.slope * first + lFit.intercept], [n - 1, lower]], style: "solid" },
    ],
  };
}

/* ------------------------------------------------------------------ *
 * Double top / double bottom
 * ------------------------------------------------------------------ */

function doubleTopBottom(ctx: Ctx): Pattern | null {
  const { pivots, atr, bars } = ctx;
  const n = bars.length;
  if (atr <= 0) return null;
  const majors = pivots.filter((p) => p.strength >= 5 && p.index >= n - 130);

  for (const kind of ["high", "low"] as const) {
    const same = majors.filter((p) => p.kind === kind);
    for (let i = same.length - 1; i >= 1; i--) {
      const second = same[i];
      const first = same[i - 1];
      if (second.index - first.index < 10) continue;
      // The two peaks must be near-equal: within 1 ATR of each other.
      if (Math.abs(second.price - first.price) > atr * 1.0) continue;

      const between = majors.filter(
        (p) => p.kind !== kind && p.index > first.index && p.index < second.index,
      );
      if (between.length === 0) continue;
      const neck = kind === "high"
        ? Math.min(...between.map((p) => p.price))
        : Math.max(...between.map((p) => p.price));
      const depth = Math.abs(second.price - neck);
      if (depth < atr * 2.5) continue; // too shallow to be a real reversal shape

      const barsSince = n - 1 - second.index;
      if (barsSince > 40) continue;

      const isTop = kind === "high";
      // Price through the peaks voids the shape: a "double top" the market has
      // already traded above is a failed top, not a setup.
      const peakHigh = Math.max(first.price, second.price);
      const peakLow = Math.min(first.price, second.price);
      if (isTop && ctx.price > peakHigh) continue;
      if (!isTop && ctx.price < peakLow) continue;

      return {
        name: isTop ? "Double top" : "Double bottom",
        direction: isTop ? "bearish" : "bullish",
        confidence: Math.min(0.85, 0.5 + Math.max(0, 1 - Math.abs(second.price - first.price) / atr) * 0.25),
        status: (isTop ? ctx.price < neck : ctx.price > neck) ? "triggered" : "forming",
        description: `Two ${isTop ? "highs" : "lows"} at ${first.price.toFixed(2)} and ${second.price.toFixed(2)}, ${second.index - first.index} sessions apart, with the neckline at ${neck.toFixed(2)}. ${isTop ? "Loss of" : "Reclaim of"} the neckline completes the shape.`,
        trigger: neck,
        invalidation: isTop ? peakHigh : peakLow,
        from: first.index,
        to: n - 1,
        lines: [{ points: [[first.index, neck], [n - 1, neck]], style: "dashed" }],
      };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Base / range breakout
 * ------------------------------------------------------------------ */

function baseBreakout(ctx: Ctx): Pattern | null {
  const { bars, atr, price } = ctx;
  const n = bars.length;
  if (n < 30 || atr <= 0) return null;

  let bestLen = 0;
  let bestHigh = 0;
  let bestLow = 0;
  for (const len of [15, 20, 25, 30, 40, 50]) {
    if (n - 1 - len < 0) continue;
    // Measure the base up to the previous bar, so today can break out of it.
    const seg = bars.slice(n - 1 - len, n - 1);
    const hi = Math.max(...seg.map((b) => b.h));
    const lo = Math.min(...seg.map((b) => b.l));
    if ((hi - lo) / atr <= 7.5 && len > bestLen) {
      bestLen = len;
      bestHigh = hi;
      bestLow = lo;
    }
  }
  if (bestLen === 0) return null;

  const nearTop = (bestHigh - price) / atr;
  const nearBottom = (price - bestLow) / atr;

  if (price > bestHigh) {
    return {
      name: "Base breakout",
      direction: "bullish",
      confidence: 0.75,
      status: "triggered",
      description: `Trading above a ${bestLen}-session base that capped at ${bestHigh.toFixed(2)}. Base floor ${bestLow.toFixed(2)}.`,
      trigger: bestHigh,
      invalidation: bestLow,
      from: n - 1 - bestLen,
      to: n - 1,
      lines: [{ points: [[n - 1 - bestLen, bestHigh], [n - 1, bestHigh]], style: "dashed" }],
    };
  }
  if (price < bestLow) {
    return {
      name: "Base breakdown",
      direction: "bearish",
      confidence: 0.75,
      status: "triggered",
      description: `Trading below a ${bestLen}-session base that floored at ${bestLow.toFixed(2)}. Base ceiling ${bestHigh.toFixed(2)}.`,
      trigger: bestLow,
      invalidation: bestHigh,
      from: n - 1 - bestLen,
      to: n - 1,
      lines: [{ points: [[n - 1 - bestLen, bestLow], [n - 1, bestLow]], style: "dashed" }],
    };
  }
  if (nearTop < 1.0 || nearBottom < 1.0) {
    const atTop = nearTop < nearBottom;
    return {
      name: atTop ? "Coiling at base high" : "Coiling at base low",
      direction: atTop ? "bullish" : "bearish",
      confidence: 0.6,
      status: "forming",
      description: `${bestLen}-session base between ${bestLow.toFixed(2)} and ${bestHigh.toFixed(2)}; price is ${(atTop ? nearTop : nearBottom).toFixed(2)} ATR from the ${atTop ? "ceiling" : "floor"}.`,
      trigger: atTop ? bestHigh : bestLow,
      invalidation: atTop ? bestLow : bestHigh,
      from: n - 1 - bestLen,
      to: n - 1,
      lines: [
        { points: [[n - 1 - bestLen, bestHigh], [n - 1, bestHigh]], style: "dashed" },
        { points: [[n - 1 - bestLen, bestLow], [n - 1, bestLow]], style: "dashed" },
      ],
    };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export function detectPatterns(ctx: Ctx): Pattern[] {
  const found = [
    trendStructure(ctx),
    maCross(ctx),
    flag(ctx),
    triangle(ctx),
    doubleTopBottom(ctx),
    baseBreakout(ctx),
    squeeze(ctx),
    narrowRange(ctx),
  ].filter((p): p is Pattern => p != null);

  const rank = { triggered: 0, forming: 1, recent: 2 };
  return found.sort((a, b) => rank[a.status] - rank[b.status] || b.confidence - a.confidence);
}

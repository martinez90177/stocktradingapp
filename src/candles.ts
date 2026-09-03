import type { Bar, CandleSignal } from "./types.ts";

/**
 * Candlestick pattern detection.
 *
 * Two ideas run through all of it. First, everything is measured against ATR
 * rather than in dollars, so a shape means the same thing on a $9 stock and a
 * $900 one. Second, several of these shapes are identical in isolation and only
 * differ by what came before -- a hammer after a decline is a reversal, the
 * same candle after an advance is a hanging man and means close to the
 * opposite. Prior trend is therefore an input, not an afterthought.
 */

interface Geo {
  range: number;
  body: number;
  bodyPct: number;
  upper: number;
  lower: number;
  upperPct: number;
  lowerPct: number;
  green: boolean;
  bodyTop: number;
  bodyBottom: number;
  mid: number;
}

function geo(b: Bar): Geo {
  const range = Math.max(b.h - b.l, 1e-9);
  const bodyTop = Math.max(b.o, b.c);
  const bodyBottom = Math.min(b.o, b.c);
  const body = bodyTop - bodyBottom;
  const upper = b.h - bodyTop;
  const lower = bodyBottom - b.l;
  return {
    range, body,
    bodyPct: body / range,
    upper, lower,
    upperPct: upper / range,
    lowerPct: lower / range,
    green: b.c >= b.o,
    bodyTop, bodyBottom,
    mid: (b.h + b.l) / 2,
  };
}

/**
 * Direction of the run leading into the pattern, excluding the pattern bars
 * themselves. Reversal shapes need something to reverse.
 */
function priorTrend(bars: Bar[], endExclusive: number, atr: number, look = 6): "up" | "down" | "flat" {
  const to = endExclusive;
  const from = Math.max(0, to - look);
  if (to - from < 3 || atr <= 0) return "flat";
  const move = bars[to - 1].c - bars[from].c;
  if (move > atr * 1.0) return "up";
  if (move < -atr * 1.0) return "down";
  return "flat";
}

export function detectCandleSignals(bars: Bar[], atr: number, avgVol: number): CandleSignal[] {
  const n = bars.length;
  if (n < 4) return [];

  const c0 = bars[n - 1];
  const c1 = bars[n - 2];
  const c2 = bars[n - 3];
  const g0 = geo(c0);
  const g1 = geo(c1);
  const g2 = geo(c2);

  const rangeAtr = atr > 0 ? g0.range / atr : 1;
  const volRatio = avgVol > 0 && c0.v > 0 ? c0.v / avgVol : null;
  const trend = priorTrend(bars, n - 1, atr);
  const trend2 = priorTrend(bars, n - 2, atr);

  const out: CandleSignal[] = [];

  /**
   * Wide range and heavy volume are what separate a shape that mattered from
   * the same shape drawn on a quiet day.
   */
  const rate = (base: "strong" | "moderate" | "weak"): CandleSignal["reliability"] => {
    let score = base === "strong" ? 2 : base === "moderate" ? 1 : 0;
    if (rangeAtr >= 1.2) score++;
    if (volRatio != null && volRatio >= 1.4) score++;
    if (rangeAtr < 0.6) score--;
    if (volRatio != null && volRatio < 0.7) score--;
    return score >= 3 ? "strong" : score >= 1 ? "moderate" : "weak";
  };

  const add = (
    name: string,
    barsUsed: 1 | 2 | 3,
    direction: CandleSignal["direction"],
    meaning: string,
    base: "strong" | "moderate" | "weak" = "moderate",
  ) => out.push({ name, bars: barsUsed, direction, meaning, reliability: rate(base) });

  /* ---- three-bar shapes, checked first: they outrank their parts ---- */

  const bigBody = (g: Geo) => atr > 0 && g.body > atr * 0.6;

  // Morning star: heavy selling, a stalled small-bodied bar, then buyers take
  // back most of the first bar.
  if (
    trend2 === "down" && !g2.green && bigBody(g2) &&
    g1.bodyPct < 0.4 && g1.body < g2.body * 0.5 &&
    g0.green && bigBody(g0) && c0.c > g2.bodyBottom + g2.body * 0.5
  ) {
    add("Morning star", 3, "bullish",
      "A heavy down bar, a stalled bar, then buyers reclaiming over half of the decline. A three-session bottoming shape.", "strong");
  }

  if (
    trend2 === "up" && g2.green && bigBody(g2) &&
    g1.bodyPct < 0.4 && g1.body < g2.body * 0.5 &&
    !g0.green && bigBody(g0) && c0.c < g2.bodyBottom + g2.body * 0.5
  ) {
    add("Evening star", 3, "bearish",
      "A strong up bar, a stalled bar, then sellers giving back over half of the advance. A three-session topping shape.", "strong");
  }

  const soldiers =
    g2.green && g1.green && g0.green &&
    c0.c > c1.c && c1.c > c2.c &&
    g2.bodyPct > 0.55 && g1.bodyPct > 0.55 && g0.bodyPct > 0.55;
  if (soldiers) {
    add("Three white soldiers", 3, "bullish",
      "Three straight strong closes, each building on the last. Sustained accumulation rather than a single spike.", "strong");
  }

  const crows =
    !g2.green && !g1.green && !g0.green &&
    c0.c < c1.c && c1.c < c2.c &&
    g2.bodyPct > 0.55 && g1.bodyPct > 0.55 && g0.bodyPct > 0.55;
  if (crows) {
    add("Three black crows", 3, "bearish",
      "Three straight weak closes, each below the last. Sustained distribution rather than one bad day.", "strong");
  }

  /* ---- two-bar shapes ---------------------------------------------- */

  if (g0.green && !g1.green && c0.c >= g1.bodyTop && c0.o <= g1.bodyBottom && g0.body > g1.body) {
    add("Bullish engulfing", 2, "bullish",
      "Today's up body completely covers yesterday's down body. Buyers erased a full session of selling.", "strong");
  }
  if (!g0.green && g1.green && c0.c <= g1.bodyBottom && c0.o >= g1.bodyTop && g0.body > g1.body) {
    add("Bearish engulfing", 2, "bearish",
      "Today's down body completely covers yesterday's up body. Sellers erased a full session of buying.", "strong");
  }

  // Piercing line and dark cloud cover: an opening push through the prior
  // extreme that gets fully rejected by the close.
  if (trend === "down" && !g1.green && g0.green && c0.o < c1.l && c0.c > g1.bodyBottom + g1.body * 0.5 && c0.c < c1.o) {
    add("Piercing line", 2, "bullish",
      "Opened below yesterday's low and closed back above the midpoint of its body. An early flush that buyers bought.", "moderate");
  }
  if (trend === "up" && g1.green && !g0.green && c0.o > c1.h && c0.c < g1.bodyBottom + g1.body * 0.5 && c0.c > c1.o) {
    add("Dark cloud cover", 2, "bearish",
      "Opened above yesterday's high and closed back below the midpoint of its body. An early push that sellers faded.", "moderate");
  }

  const harami = g0.bodyTop <= g1.bodyTop && g0.bodyBottom >= g1.bodyBottom && g1.body > g0.body * 1.8 && bigBody(g1);
  if (harami && !g1.green && trend === "down") {
    add("Bullish harami", 2, "bullish",
      "A small body held entirely inside yesterday's large down body. Selling pressure stalled rather than reversed.", "weak");
  } else if (harami && g1.green && trend === "up") {
    add("Bearish harami", 2, "bearish",
      "A small body held entirely inside yesterday's large up body. Buying pressure stalled rather than reversed.", "weak");
  }

  if (atr > 0 && Math.abs(c0.h - c1.h) < atr * 0.12 && trend === "up") {
    add("Tweezer top", 2, "bearish",
      "Two sessions rejected from almost exactly the same high. A price sellers are defending.", "moderate");
  }
  if (atr > 0 && Math.abs(c0.l - c1.l) < atr * 0.12 && trend === "down") {
    add("Tweezer bottom", 2, "bullish",
      "Two sessions held at almost exactly the same low. A price buyers are defending.", "moderate");
  }

  /* ---- single-bar shapes ------------------------------------------- */

  if (g0.bodyPct > 0.85) {
    add(g0.green ? "Bullish marubozu" : "Bearish marubozu", 1, g0.green ? "bullish" : "bearish",
      g0.green
        ? "Almost the entire range is body, with barely any wick. One side controlled the session start to finish."
        : "Almost the entire range is body, with barely any wick. Sellers controlled the session start to finish.",
      "strong");
  }

  if (g0.bodyPct < 0.09) {
    if (g0.lowerPct > 0.6) {
      add("Dragonfly doji", 1, trend === "down" ? "bullish" : "neutral",
        "Sold off hard and closed back at the open, leaving a long lower tail. Buyers absorbed everything offered.", "moderate");
    } else if (g0.upperPct > 0.6) {
      add("Gravestone doji", 1, trend === "up" ? "bearish" : "neutral",
        "Ran up and closed back at the open, leaving a long upper tail. Sellers absorbed everything bid.", "moderate");
    } else {
      add("Doji", 1, "neutral",
        "Opened and closed at effectively the same price. Genuine indecision, and often a pause before the next move.", "weak");
    }
  } else if (g0.lowerPct > 0.5 && g0.upperPct < 0.2 && g0.bodyPct < 0.4) {
    // Same candle, opposite meaning depending on what preceded it.
    if (trend === "down") {
      add("Hammer", 1, "bullish",
        "A long lower wick after a decline: price was pushed well below where it closed, and buyers took it back.", "moderate");
    } else if (trend === "up") {
      add("Hanging man", 1, "bearish",
        "The same shape as a hammer, but after an advance. Selling appeared intraday even though the close recovered.", "weak");
    }
  } else if (g0.upperPct > 0.5 && g0.lowerPct < 0.2 && g0.bodyPct < 0.4) {
    if (trend === "up") {
      add("Shooting star", 1, "bearish",
        "A long upper wick after an advance: price ran higher and was sold back down into the close.", "moderate");
    } else if (trend === "down") {
      add("Inverted hammer", 1, "bullish",
        "A long upper wick after a decline: buyers tested higher, and while it faded, the attempt itself is new.", "weak");
    }
  } else if (g0.bodyPct < 0.32 && g0.upperPct > 0.25 && g0.lowerPct > 0.25) {
    add("Spinning top", 1, "neutral",
      "A small body between two meaningful wicks. Both sides pushed and neither finished ahead.", "weak");
  }

  if (c0.h <= c1.h && c0.l >= c1.l) {
    add("Inside day", 1, "neutral",
      "The whole session fits inside yesterday's range. Coiling; the break of either side usually sets the next direction.", "moderate");
  } else if (c0.h > c1.h && c0.l < c1.l) {
    add("Outside day", 1, g0.green ? "bullish" : "bearish",
      g0.green
        ? "Took out both sides of yesterday's range and closed up. Sellers were trapped on the low."
        : "Took out both sides of yesterday's range and closed down. Buyers were trapped on the high.",
      "moderate");
  }

  // Strongest and most specific first: three-bar shapes outrank one-bar ones,
  // and a confirmed shape outranks a tentative one.
  const rel = { strong: 0, moderate: 1, weak: 2 };
  return out.sort((a, b) => rel[a.reliability] - rel[b.reliability] || b.bars - a.bars).slice(0, 4);
}

/**
 * A plain-language description of the bar's geometry, always available.
 *
 * Most sessions do not print a textbook pattern -- on a broad trend day almost
 * nothing does. Rather than loosen the thresholds until ordinary bars get
 * named, which would invent patterns that are not there, the bar is described
 * for what it is: size, body, tails and where it closed.
 */
export function describeBar(bars: Bar[], atr: number): string | null {
  const n = bars.length;
  if (n < 2) return null;
  const b = bars[n - 1];
  const g = geo(b);
  const rangeAtr = atr > 0 ? g.range / atr : 1;
  const clv = ((b.c - b.l) - (b.h - b.c)) / g.range;

  const size = rangeAtr >= 1.4 ? "Wide-range" : rangeAtr <= 0.6 ? "Narrow-range" : "Average-range";
  const bodyWord =
    g.bodyPct > 0.7 ? "strong-bodied" : g.bodyPct > 0.4 ? "mid-bodied" : g.bodyPct > 0.15 ? "small-bodied" : "doji-like";
  const dir = g.green ? "up" : "down";

  let tail = "";
  if (g.upperPct > 0.32 && g.lowerPct > 0.32) tail = " with tails on both sides";
  else if (g.upperPct > 0.32) tail = " with a long upper tail";
  else if (g.lowerPct > 0.32) tail = " with a long lower tail";
  else if (g.bodyPct > 0.72) tail = " and barely any wick";

  const close = clv > 0.65 ? ", closing near its high" : clv < -0.65 ? ", closing near its low" : "";
  return `${size} ${bodyWord} ${dir} bar${tail}${close}`;
}

/** How many sessions in a row have closed the same way, including today. */
export function closeStreak(bars: Bar[]): { count: number; direction: "up" | "down" } | null {
  const n = bars.length;
  if (n < 3) return null;
  const dir = bars[n - 1].c >= bars[n - 2].c ? "up" : "down";
  let count = 0;
  for (let i = n - 1; i > 0; i--) {
    const up = bars[i].c >= bars[i - 1].c;
    if ((up ? "up" : "down") !== dir) break;
    count++;
  }
  return count >= 2 ? { count, direction: dir } : null;
}

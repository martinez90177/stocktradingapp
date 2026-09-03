import type { Analysis, Bar, Level, SessionRead, TradeGrade } from "./types.ts";
import { closeStreak, describeBar, detectCandleSignals } from "./candles.ts";

/* ------------------------------------------------------------------ *
 * Prior session candle read
 * ------------------------------------------------------------------ */

const pct = (v: number) => Math.round(v * 100);

/**
 * Reads the last completed daily bar the way a trader reads a candle: where it
 * closed inside its own range, how much of the range was body rather than wick,
 * whether the move carried volume, and how it finished against the session
 * before it.
 *
 * Close location value is the backbone. It runs -1 (closed on the low) to +1
 * (closed on the high), and it answers the only question that matters at the
 * bell: who had control when it counted.
 */
export function readPriorSession(
  bars: Bar[],
  atrValue: number,
  avgVol20: number,
): SessionRead | null {
  if (bars.length < 3) return null;
  const cur = bars[bars.length - 1];
  const prev = bars[bars.length - 2];

  const range = cur.h - cur.l;
  if (!(range > 0)) return null;

  const clv = ((cur.c - cur.l) - (cur.h - cur.c)) / range;
  const body = Math.abs(cur.c - cur.o) / range;
  const upperWick = (cur.h - Math.max(cur.o, cur.c)) / range;
  const lowerWick = (Math.min(cur.o, cur.c) - cur.l) / range;
  const rangeAtr = atrValue > 0 ? range / atrValue : 0;
  const volRatio = avgVol20 > 0 && cur.v > 0 ? cur.v / avgVol20 : null;
  const green = cur.c >= cur.o;
  const changePct = prev.c > 0 ? ((cur.c - prev.c) / prev.c) * 100 : 0;

  const closedAbovePriorHigh = cur.c > prev.h;
  const closedBelowPriorLow = cur.c < prev.l;
  const isInside = cur.h <= prev.h && cur.l >= prev.l;
  const isOutside = cur.h > prev.h && cur.l < prev.l;

  /* ---- named candle shapes ---------------------------------------- */

  const signals = detectCandleSignals(bars, atrValue, avgVol20);
  const shapes = signals.map((s) => s.name.toLowerCase());
  const barDescription = describeBar(bars, atrValue);
  // A named pattern when one fired, otherwise the geometry, so there is always
  // something concrete to say about the candle.
  const shapeSummary = signals[0]?.name ?? barDescription;

  const streakRaw = closeStreak(bars);
  const ordinal = ["", "", "second", "third", "fourth", "fifth", "sixth", "seventh"];
  const streak =
    streakRaw && streakRaw.count >= 3
      ? `${ordinal[Math.min(streakRaw.count, 7)] ?? `${streakRaw.count}th`} straight ${streakRaw.direction === "up" ? "higher" : "lower"} close`
      : null;

  /* ---- pressure ---------------------------------------------------- */

  // CLV carries the most weight, then how much of the range was body. Volume
  // and range size scale conviction rather than direction: a strong close on
  // no volume is a weaker statement than the same close on 2x volume.
  let score = clv * 0.6 + (green ? body : -body) * 0.4;
  const conviction =
    Math.min(1.4, 0.55 + (volRatio != null ? Math.min(volRatio, 2.5) * 0.22 : 0.25)) *
    Math.min(1.25, 0.7 + rangeAtr * 0.35);
  score *= conviction;
  if (closedAbovePriorHigh) score += 0.18;
  if (closedBelowPriorLow) score -= 0.18;
  score = Math.max(-1, Math.min(1, score));

  const pressure: SessionRead["pressure"] =
    score > 0.22 ? "buyers" : score < -0.22 ? "sellers" : "balanced";
  const strength = Math.abs(score);

  /* ---- narrative --------------------------------------------------- */

  const clauses: string[] = [];
  const where =
    clv > 0.75 ? `closed in the top ${Math.max(1, 100 - pct((cur.c - cur.l) / range))}% of its range`
    : clv > 0.3 ? `closed in the upper half of its range`
    : clv < -0.75 ? `closed in the bottom ${Math.max(1, pct((cur.c - cur.l) / range))}% of its range`
    : clv < -0.3 ? `closed in the lower half of its range`
    : `closed mid-range`;
  clauses.push(where);

  if (volRatio != null && volRatio >= 1.25) clauses.push(`on ${volRatio.toFixed(1)}x average volume`);
  else if (volRatio != null && volRatio <= 0.7) clauses.push(`on light volume (${volRatio.toFixed(1)}x average)`);

  if (rangeAtr >= 1.25) clauses.push(`across a wide ${rangeAtr.toFixed(1)} ATR range`);
  else if (rangeAtr <= 0.6) clauses.push(`inside a narrow ${rangeAtr.toFixed(1)} ATR range`);

  if (clv > 0.6 && upperWick < 0.12) clauses.push("with almost no upper wick, so sellers never pushed back late");
  if (clv < -0.6 && lowerWick < 0.12) clauses.push("with almost no lower wick, so buyers never stepped in late");
  if (lowerWick > 0.45 && clv > 0.2) clauses.push("after buyers reclaimed a deep intraday flush");
  if (upperWick > 0.45 && clv < 0.2) clauses.push("after sellers faded a push higher");

  if (closedAbovePriorHigh) clauses.push("and it finished above the prior session's high");
  else if (closedBelowPriorLow) clauses.push("and it finished below the prior session's low");

  // The wording tracks how decisive the finish actually was, so a mid-range
  // close is never described as control.
  const side = pressure === "buyers" ? "Buyers" : "Sellers";
  const lead =
    pressure === "balanced" ? "Neither side finished in control."
    : strength > 0.55 ? `${side} were firmly in control into the close.`
    : strength > 0.32 ? `${side} had the better of it into the close.`
    : `${side} edged it into the close.`;

  // The leading shape is named with what it means, rather than listing jargon.
  const top = signals[0];
  const shapeText = top
    ? ` ${top.name}: ${top.meaning}`
    : barDescription
      ? ` ${barDescription}, with no textbook candlestick shape.`
      : "";
  const others = signals.slice(1, 3).map((x) => x.name.toLowerCase());
  const alsoText = others.length > 0 ? ` Also reading as ${others.join(" and ")}.` : "";
  const streakText = streak ? ` This is the ${streak}.` : "";
  const narrative = `${lead} It ${clauses.join(", ")}.${streakText}${shapeText}${alsoText}`;

  return {
    date: new Date(cur.t).toISOString().slice(0, 10),
    clv, body, upperWick, lowerWick, rangeAtr, volRatio, changePct,
    green, closedAbovePriorHigh, closedBelowPriorLow,
    shapes, signals, barDescription, shapeSummary, streak, pressure, strength, narrative,
    open: cur.o, high: cur.h, low: cur.l, close: cur.c,
  };
}

/* ------------------------------------------------------------------ *
 * Day-trade setup grade
 * ------------------------------------------------------------------ */

/** Smoothly scores a value that is best inside a band, tapering outside it. */
function band(v: number, lo: number, best1: number, best2: number, hi: number, max: number): number {
  if (v <= lo || v >= hi) return 0;
  if (v >= best1 && v <= best2) return max;
  if (v < best1) return ((v - lo) / (best1 - lo)) * max;
  return ((hi - v) / (hi - best2)) * max;
}

/**
 * Grades how workable a name looks for an intraday trade, and separately which
 * side the pressure sits on.
 *
 * The grade is about tradeability, not desirability: liquidity to get filled,
 * daily range wide enough to pay for the spread, participation, a catalyst, and
 * room to the next level. A quiet mega-cap grades low even in a nice uptrend,
 * because there is nothing to trade intraday.
 */
export function gradeDayTrade(a: Analysis, session: SessionRead | null): TradeGrade {
  const ind = a.indicators;
  const parts: TradeGrade["components"] = [];

  /* Liquidity: dollar volume, log-scaled between $10M and $2B. */
  const dollarVol = (ind.avgVol20 ?? 0) * a.price;
  const liq = dollarVol <= 0 ? 0
    : Math.max(0, Math.min(20, ((Math.log10(dollarVol) - 7) / (9.3 - 7)) * 20));
  parts.push({
    label: "Liquidity",
    score: liq, max: 20,
    detail: dollarVol > 0 ? `$${(dollarVol / 1e6).toFixed(0)}M average daily turnover` : "unknown",
  });

  /* Range: too tight and there is nothing to capture; too wild and stops blow. */
  const atrPct = ind.atrPct ?? 0;
  const rng = band(atrPct, 0.4, 2.0, 5.0, 12, 20);
  parts.push({
    label: "Daily range",
    score: rng, max: 20,
    detail: `ATR is ${atrPct.toFixed(2)}% of price`,
  });

  /* Participation today versus its own norm. */
  const rv = ind.relVolume ?? 1;
  const part = Math.max(0, Math.min(20, (rv - 0.6) * 11));
  parts.push({
    label: "Participation",
    score: part, max: 20,
    detail: ind.relVolume != null ? `${rv.toFixed(2)}x its 20-day average volume` : "no volume reading yet",
  });

  /* A gap is the cleanest intraday catalyst: it guarantees an unsettled open. */
  const gap = Math.abs(a.intradayContext.gapPct ?? 0);
  const catScore = Math.min(15, gap * 3.8);
  parts.push({
    label: "Catalyst (gap)",
    score: catScore, max: 15,
    detail: a.intradayContext.gapPct == null
      ? "no premarket prints yet"
      : `${gap.toFixed(2)}% premarket gap`,
  });

  /* How decisively the prior session finished. */
  const conv = session ? session.strength * 15 : 0;
  parts.push({
    label: "Prior session conviction",
    score: conv, max: 15,
    detail: session
      ? `${session.shapeSummary ? `${session.shapeSummary}; ` : ""}${session.pressure} in control, close location ${session.clv >= 0 ? "+" : ""}${session.clv.toFixed(2)}`
      : "not enough bars",
  });

  /* Room: distance to the first level that would cap a move in the direction
     the prior session pointed. Running straight into resistance is a worse
     setup than the same stock with clear air above. */
  const dir = session?.pressure === "sellers" ? -1 : 1;
  const blocking = a.levels
    .filter((l) => (dir > 0 ? l.price > a.price : l.price < a.price))
    .sort((x, y) => Math.abs(x.price - a.price) - Math.abs(y.price - a.price))[0] as Level | undefined;
  const roomAtr = blocking && ind.atr14 ? Math.abs(blocking.price - a.price) / ind.atr14 : null;
  const room = roomAtr == null ? 5 : Math.max(0, Math.min(10, roomAtr * 7));
  parts.push({
    label: "Room to next level",
    score: room, max: 10,
    detail: roomAtr == null
      ? "no level mapped in that direction"
      : `${roomAtr.toFixed(2)} ATR to ${blocking!.price.toFixed(2)} (${blocking!.methods.length}-method)`,
  });

  const total = parts.reduce((s, p) => s + p.score, 0);
  const letter =
    total >= 78 ? "A+" : total >= 68 ? "A" : total >= 58 ? "B+" :
    total >= 48 ? "B" : total >= 38 ? "C+" : total >= 28 ? "C" : "D";

  /* ---- bias -------------------------------------------------------- */

  let biasScore = 0;
  const why: string[] = [];

  if (session) {
    biasScore += session.pressure === "buyers" ? session.strength * 2.2
      : session.pressure === "sellers" ? -session.strength * 2.2 : 0;
    if (session.pressure !== "balanced") {
      why.push(
        `prior session finished with ${session.pressure} in control${session.shapeSummary ? ` on a ${session.shapeSummary.toLowerCase()}` : ""}`,
      );
    }
  }

  const trend = a.patterns.find((p) => p.name.startsWith("Uptrend") || p.name.startsWith("Downtrend"));
  if (trend) {
    biasScore += trend.direction === "bullish" ? 1.1 : -1.1;
    why.push(trend.direction === "bullish" ? "daily structure is making higher highs and lows" : "daily structure is making lower highs and lows");
  }

  const triggered = a.patterns.find((p) => p.status === "triggered");
  if (triggered && triggered.direction !== "neutral") {
    biasScore += triggered.direction === "bullish" ? 1.2 : -1.2;
    why.push(`${triggered.name.toLowerCase()} has triggered`);
  }

  const g = a.intradayContext.gapPct;
  if (g != null && Math.abs(g) > 0.5) {
    biasScore += g > 0 ? 0.8 : -0.8;
    why.push(`gapping ${g > 0 ? "up" : "down"} ${Math.abs(g).toFixed(2)}% premarket`);
  }

  const cat = a.catalysts;
  if (cat) {
    if (cat.headlineLean === "bullish" && cat.freshCount > 0) {
      biasScore += 0.6;
      why.push("fresh headlines skew bullish");
    } else if (cat.headlineLean === "bearish" && cat.freshCount > 0) {
      biasScore -= 0.6;
      why.push("fresh headlines skew bearish");
    }
    const spf = cat.fundamentals?.shortPercentOfFloat;
    if (spf != null && spf >= 0.15) {
      why.push(`${(spf * 100).toFixed(0)}% of float is short, so upside moves tend to run further than the chart suggests`);
    }
  }

  if (roomAtr != null && roomAtr < 0.35) {
    why.push(`but it opens almost on top of ${blocking!.price.toFixed(2)}, so there is little room before that level`);
  }

  // An earnings gap reprices the stock on information no chart contains, so
  // whatever the levels said yesterday counts for much less today.
  if (cat?.nextEarnings && cat.nextEarnings.inDays <= 1) {
    biasScore *= 0.45;
    why.push(
      `earnings ${cat.nextEarnings.inDays === 0 ? "today" : "tomorrow"}, which overrides the technical picture`,
    );
  }

  const bias: TradeGrade["bias"] =
    biasScore > 1.4 ? "long-side" : biasScore < -1.4 ? "short-side" :
    Math.abs(biasScore) < 0.5 ? "unclear" : "two-sided";

  return {
    letter,
    total,
    components: parts,
    bias,
    biasWhy: why.length > 0
      ? why.join("; ").replace(/^./, (c) => c.toUpperCase()) + "."
      : "Nothing is leaning either way strongly enough to call a side.",
  };
}

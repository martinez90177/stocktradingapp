import type { Analysis, Bar, LevelSource, Series } from "./types.ts";
import {
  anchoredVwap, atr, bollingerWidthPct, ema, findPivots, lastOf,
  mergePivots, percentileRankOfLast, rsi, sma,
} from "./ta.ts";
import {
  clusterLevels, dominantFib, highVolumeNodes, rangeFib,
  roundNumbers, unfilledGaps, volumeProfile,
} from "./levels.ts";
import { detectPatterns } from "./patterns.ts";
import { buildIntradayContext, sanitizeIntraday } from "./intraday.ts";
import { gradeDayTrade, readPriorSession } from "./session.ts";

export function analyze(
  daily: Series,
  rawIntraday: Series | null,
  maxLevels: number,
  catalysts: Analysis["catalysts"] = null,
): Analysis {
  const bars: Bar[] = daily.bars;
  const closes = bars.map((b) => b.c);
  const n = bars.length;
  const errors: string[] = [];
  const notes: string[] = [];

  const sma20s = sma(closes, 20);
  const sma50s = sma(closes, 50);
  const sma200s = sma(closes, 200);
  const ema9s = ema(closes, 9);
  const ema21s = ema(closes, 21);
  const atrs = atr(bars, 14);
  const rsis = rsi(closes, 14);
  const bbw = bollingerWidthPct(closes, 20, 2);

  const price = daily.meta.regularMarketPrice || closes[n - 1];
  const atr14 = lastOf(atrs) ?? (price * 0.02);
  const sma20 = lastOf(sma20s);
  const sma50 = lastOf(sma50s);
  const sma200 = lastOf(sma200s);

  const avgVol20 = n >= 20
    ? bars.slice(-20).reduce((a, b) => a + b.v, 0) / 20
    : bars.reduce((a, b) => a + b.v, 0) / Math.max(n, 1);
  const lastVol = daily.meta.regularMarketVolume || bars[n - 1].v;

  const hi52 = daily.meta.fiftyTwoWeekHigh;
  const lo52 = daily.meta.fiftyTwoWeekLow;
  const rangePos52w = hi52 > lo52 ? ((price - lo52) / (hi52 - lo52)) * 100 : null;

  /* ---- structure -------------------------------------------------- */

  const pivots = mergePivots([findPivots(bars, 3), findPivots(bars, 8), findPivots(bars, 15)]);
  const profile = volumeProfile(bars.slice(-140), 60);
  const gaps = unfilledGaps(bars, atr14, 90, 0.4);

  const fibs = [dominantFib(bars, pivots, atr14), rangeFib(bars)].filter((f) => f != null);
  if (fibs.length === 0) notes.push("Not enough swing structure for a Fibonacci leg.");

  /* ---- anchored VWAPs --------------------------------------------- */

  const anchoredVwaps: Analysis["anchoredVwaps"] = [];
  const addAvwap = (label: string, fromIndex: number) => {
    if (fromIndex < 0 || fromIndex >= n - 1) return;
    const series = anchoredVwap(bars, fromIndex);
    const value = lastOf(series);
    if (value != null) anchoredVwaps.push({ label, price: value, fromIndex, series });
  };

  const window = bars.slice(-252);
  const offset = n - window.length;
  let hiIdx = 0;
  let loIdx = 0;
  for (let i = 1; i < window.length; i++) {
    if (window[i].h > window[hiIdx].h) hiIdx = i;
    if (window[i].l < window[loIdx].l) loIdx = i;
  }
  addAvwap("AVWAP from 52w high", offset + hiIdx);
  addAvwap("AVWAP from 52w low", offset + loIdx);

  // Anchor to the heaviest-volume session of the last quarter -- usually an
  // earnings or news gap, and the level that crowd is measured against.
  const recent = bars.slice(-63);
  if (recent.length > 5) {
    let volIdx = 0;
    for (let i = 1; i < recent.length; i++) if (recent[i].v > recent[volIdx].v) volIdx = i;
    addAvwap("AVWAP from volume spike", n - recent.length + volIdx);
  }

  /* ---- intraday --------------------------------------------------- */

  let intraday: Series | null = null;
  if (rawIntraday) {
    const clean = sanitizeIntraday(rawIntraday.bars);
    intraday = { ...rawIntraday, bars: clean.bars };
    if (clean.dropped > 0) {
      notes.push(
        `${clean.dropped} extended-hours bar${clean.dropped === 1 ? "" : "s"} dropped: no volume and a high or low far outside the bar body, which is a stale-quote artifact rather than a trade.`,
      );
    }
  } else {
    errors.push("Intraday feed unavailable; showing daily levels only.");
  }

  const intradayContext = buildIntradayContext(intraday, bars, 30);

  /* ---- level candidates ------------------------------------------- */

  const src: LevelSource[] = [];
  const push = (price: number, weight: number, method: string, label: string) => {
    if (Number.isFinite(price) && price > 0 && weight > 0) src.push({ price, weight, method, label });
  };

  for (const p of pivots) {
    if (p.index < n - 260) continue;
    const recency = Math.exp(-(n - 1 - p.index) / 130);
    const base = p.strength >= 15 ? 3.4 : p.strength >= 8 ? 2.4 : 1.2;
    push(p.price, base * (0.45 + 0.55 * recency), "swing", `Swing ${p.kind} ${p.price.toFixed(2)}`);
  }

  push(hi52, 4.2, "52w", `52-week high ${hi52.toFixed(2)}`);
  push(lo52, 4.2, "52w", `52-week low ${lo52.toFixed(2)}`);

  if (sma20 != null) push(sma20, 1.8, "ma", `20 SMA ${sma20.toFixed(2)}`);
  if (sma50 != null) push(sma50, 2.6, "ma", `50 SMA ${sma50.toFixed(2)}`);
  if (sma200 != null) push(sma200, 3.4, "ma", `200 SMA ${sma200.toFixed(2)}`);

  if (profile) {
    push(profile.poc, 3.2, "volume", `Volume POC ${profile.poc.toFixed(2)}`);
    push(profile.vah, 2.2, "volume", `Value area high ${profile.vah.toFixed(2)}`);
    push(profile.val, 2.2, "volume", `Value area low ${profile.val.toFixed(2)}`);
    for (const node of highVolumeNodes(profile, 3)) {
      push(node.price, 1.6, "volume", `High-volume node ${node.price.toFixed(2)}`);
    }
  }

  for (const fib of fibs) {
    const scale = fib.label === "Dominant swing" ? 1 : 0.72;
    for (const r of fib.retracements) {
      const golden = r.ratio === 0.618 || r.ratio === 0.702;
      push(r.price, (golden ? 3.6 : r.ratio === 0.5 || r.ratio === 0.382 ? 2.6 : 1.7) * scale,
        "fib", `${fib.label} ${(r.ratio * 100).toFixed(1)}% retrace`);
    }
    for (const e of fib.extensions) {
      if (e.ratio > 2.0) continue;
      push(e.price, (e.ratio === 1.618 ? 2.6 : 1.7) * scale,
        "fib", `${fib.label} ${e.ratio.toFixed(3)} extension`);
    }
  }

  for (const g of gaps) {
    push(g.direction === "up" ? g.from : g.to, 2.4, "gap",
      `Unfilled ${g.direction} gap edge ${(g.direction === "up" ? g.from : g.to).toFixed(2)}`);
  }

  for (const a of anchoredVwaps) push(a.price, 2.4, "avwap", `${a.label} ${a.price.toFixed(2)}`);

  for (const rn of roundNumbers(price, atr14)) push(rn, 0.9, "round", `Round number ${rn.toFixed(2)}`);

  const ic = intradayContext;
  if (ic.priorDay) {
    push(ic.priorDay.h, 2.8, "prior-day", `Prior day high ${ic.priorDay.h.toFixed(2)}`);
    push(ic.priorDay.l, 2.8, "prior-day", `Prior day low ${ic.priorDay.l.toFixed(2)}`);
    push(ic.priorDay.c, 2.2, "prior-day", `Prior close ${ic.priorDay.c.toFixed(2)}`);
  }
  if (ic.floorPivots) {
    const fp = ic.floorPivots;
    push(fp.pp, 2.4, "floor-pivot", `Pivot point ${fp.pp.toFixed(2)}`);
    push(fp.r1, 1.8, "floor-pivot", `R1 ${fp.r1.toFixed(2)}`);
    push(fp.s1, 1.8, "floor-pivot", `S1 ${fp.s1.toFixed(2)}`);
    push(fp.r2, 1.3, "floor-pivot", `R2 ${fp.r2.toFixed(2)}`);
    push(fp.s2, 1.3, "floor-pivot", `S2 ${fp.s2.toFixed(2)}`);
  }
  if (ic.premarket) {
    push(ic.premarket.high, 2.6, "premarket", `Premarket high ${ic.premarket.high.toFixed(2)}`);
    push(ic.premarket.low, 2.6, "premarket", `Premarket low ${ic.premarket.low.toFixed(2)}`);
  }
  if (ic.sessionVwap != null) push(ic.sessionVwap, 2.2, "vwap", `Session VWAP ${ic.sessionVwap.toFixed(2)}`);

  const tolerance = Math.max(atr14 * 0.32, price * 0.0015);
  const allLevels = clusterLevels(src, price, tolerance, atr14);

  // Keep the strongest levels, but guarantee the report shows the nearest
  // support and resistance even when they are individually weak -- a level you
  // will actually trade into today matters more than a strong distant one.
  const nearest = (side: "support" | "resistance") =>
    allLevels
      .filter((l) => l.side === side)
      .sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct))
      .slice(0, 2);
  const mustKeep = new Set([...nearest("support"), ...nearest("resistance")]);
  const levels = [
    ...allLevels.filter((l) => mustKeep.has(l)),
    ...allLevels.filter((l) => !mustKeep.has(l)).slice(0, Math.max(0, maxLevels - mustKeep.size)),
  ].sort((a, b) => b.price - a.price);

  /* ---- patterns --------------------------------------------------- */

  const bbSqueezeRank = percentileRankOfLast(bbw, 126);
  const patterns = detectPatterns({
    bars, pivots, atr: atr14, sma20, sma50, sma200,
    sma50Series: sma50s, sma200Series: sma200s, bbSqueezeRank, price,
  });

  /* ---- watch score ------------------------------------------------ */

  // Read the candle before the headline is written, since the shape is one of
  // the things worth leading with.
  const session = readPriorSession(bars, atr14, avgVol20);
  const relVolume = avgVol20 > 0 ? lastVol / avgVol20 : null;
  let watchScore = 0;
  const reasons: string[] = [];

  const closest = allLevels
    .filter((l) => Math.abs(l.distanceAtr) < 1.2)
    .sort((a, b) => b.score - a.score)[0];
  if (closest) {
    const proximity = Math.max(0, 1 - Math.abs(closest.distanceAtr) / 1.2);
    watchScore += Math.min(closest.score, 22) * proximity * 1.9;
    reasons.push(
      `${Math.abs(closest.distancePct).toFixed(2)}% ${closest.side === "resistance" ? "below" : closest.side === "support" ? "above" : "from"} a ${closest.methods.length}-method level at ${closest.price.toFixed(2)}`,
    );
  }

  if (session?.shapeSummary) reasons.push(session.shapeSummary);

  const topPattern = patterns.find((p) => p.name !== "Range / no clear trend");
  if (topPattern) {
    watchScore += topPattern.confidence * (topPattern.status === "triggered" ? 26 : 16);
    reasons.unshift(`${topPattern.name}${topPattern.status === "triggered" ? " (triggered)" : ""}`);
  }

  if (bbSqueezeRank != null && bbSqueezeRank < 15) watchScore += (15 - bbSqueezeRank) * 0.7;
  if (relVolume != null && relVolume > 1.5) watchScore += Math.min(relVolume, 4) * 3.2;
  if (ic.gapPct != null && Math.abs(ic.gapPct) > 0.75) {
    watchScore += Math.min(Math.abs(ic.gapPct), 8) * 2.4;
    reasons.unshift(`gapping ${ic.gapPct > 0 ? "up" : "down"} ${Math.abs(ic.gapPct).toFixed(2)}% premarket`);
  }
  if (rangePos52w != null && (rangePos52w > 97 || rangePos52w < 3)) {
    watchScore += 7;
    reasons.push(rangePos52w > 97 ? "at 52-week highs" : "at 52-week lows");
  }

  const headline = reasons.length > 0
    ? reasons.slice(0, 2).join("; ").replace(/^./, (c) => c.toUpperCase())
    : "No level or pattern within range; quiet setup.";

  const prevClose = intradayContext.priorDay?.c ?? bars[Math.max(0, n - 2)].c;

  const analysis: Analysis = {
    symbol: daily.symbol,
    name: daily.name,
    price,
    changePct: prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0,
    currency: daily.currency,
    daily,
    intraday,
    indicators: {
      sma20, sma50, sma200,
      ema9: lastOf(ema9s), ema21: lastOf(ema21s),
      atr14,
      atrPct: price > 0 ? (atr14 / price) * 100 : null,
      rsi14: lastOf(rsis),
      bbWidthPct: lastOf(bbw),
      bbSqueezeRank,
      relVolume,
      avgVol20,
      rangePos52w,
    },
    pivots,
    levels,
    fibs,
    patterns,
    volumeProfile: profile,
    anchoredVwaps,
    intradayContext,
    session,
    catalysts,
    options: null,
    grade: null as unknown as Analysis["grade"],
    watchScore,
    headline,
    notes,
    errors,
  };

  // The grade reads the finished picture -- levels, patterns and intraday
  // context all feed it -- so it is computed once the rest is assembled.
  analysis.grade = gradeDayTrade(analysis, session);

  return analysis;
}

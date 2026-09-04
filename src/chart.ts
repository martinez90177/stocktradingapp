import type { Bar, FibSet, Level, Pattern } from "./types.ts";

/**
 * Chart palette.
 *
 * Semantic colours (up, down, the amber of a fib zone) are held apart from the
 * indigo the interface uses as its accent, so a green line never has to be read
 * as "selected" and the accent never has to be read as "rising".
 */
export const C = {
  bg: "#0b1017",
  grid: "#19212c",
  gridStrong: "#243040",
  text: "#7b8695",
  textBright: "#d7dde6",
  up: "#2dd4a7",
  down: "#f4525f",
  upFill: "#2dd4a7",
  downFill: "#f4525f",
  ma20: "#f5a524",
  ma50: "#7b6cf6",
  ma200: "#ef5da8",
  vwap: "#4cc9f0",
  support: "#2dd4a7",
  resistance: "#f4525f",
  neutral: "#7b8695",
  fib: "#c08a2e",
  golden: "#f5a524",
  price: "#eef2f7",
};

/** Unique clipPath ids: a page holds many charts and duplicate ids collide. */
let clipSeq = 0;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function fmtPrice(p: number): string {
  const abs = Math.abs(p);
  if (abs >= 1000) return p.toFixed(1);
  if (abs >= 1) return p.toFixed(2);
  return p.toFixed(4);
}

function niceStep(range: number, targetLines: number): number {
  const raw = range / Math.max(targetLines, 1);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = norm >= 5 ? 10 : norm >= 2.5 ? 5 : norm >= 1.5 ? 2 : 1;
  return step * mag;
}

/** Pushes overlapping right-axis tags apart so every label stays readable. */
function decollide(items: { y: number; [k: string]: any }[], minGap: number, top: number, bottom: number) {
  const sorted = [...items].sort((a, b) => a.y - b.y);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].y - sorted[i - 1].y < minGap) sorted[i].y = sorted[i - 1].y + minGap;
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].y > bottom) sorted[i].y = bottom;
    if (i > 0 && sorted[i].y - sorted[i - 1].y < minGap) sorted[i - 1].y = sorted[i].y - minGap;
  }
  for (const it of sorted) it.y = Math.max(top, Math.min(bottom, it.y));
  return sorted;
}

export interface ChartOptions {
  bars: Bar[];
  mode: "daily" | "intraday";
  width?: number;
  height?: number;
  levels?: Level[];
  fib?: FibSet | null;
  patterns?: Pattern[];
  /** Series aligned to `bars`; nulls are gaps. */
  overlays?: { label: string; color: string; values: (number | null)[]; dashed?: boolean }[];
  /** Horizontal reference lines drawn without a full level treatment. */
  hlines?: { price: number; color: string; label: string; dashed?: boolean }[];
  price: number;
  /** Bar index the visible window starts at, for aligning pattern annotations. */
  indexOffset?: number;
  /**
   * Multiplies every label size. The SVG scales to its container, so a chart
   * shown at phone width shrinks its type along with everything else; the
   * phone variant is drawn on a narrower viewBox with this raised to keep
   * axis labels legible instead of decorative.
   */
  fontScale?: number;
  title?: string;
}

export function renderChart(o: ChartOptions): string {
  const W = o.width ?? 980;
  const H = o.height ?? 460;
  const k = o.fontScale ?? 1;
  const fs = (n: number) => (n * k).toFixed(1);
  // Axis captions need the full bump at phone width, but the price tags are
  // boxes competing with the chart for room -- scaling them as hard turns the
  // right edge into a wall of rectangles, so they grow at about half the rate.
  const tk = 1 + (k - 1) * 0.5;
  const tagH = 12.5 * tk;
  const padL = 8;
  const padR = Math.round(46 * tk + 18);
  const padT = 14;
  const padB = 26;
  const volH = Math.round((H - padT - padB) * 0.17);
  const plotW = W - padL - padR;
  const plotH = H - padT - padB - volH - 8;
  const volTop = padT + plotH + 8;
  const bars = o.bars;
  const offset = o.indexOffset ?? 0;

  if (bars.length < 2 || plotW <= 0 || plotH <= 0) {
    return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img"><rect width="${W}" height="${H}" fill="${C.bg}"/><text x="${W / 2}" y="${H / 2}" fill="${C.text}" font-size="13" text-anchor="middle">Not enough bars to draw a chart</text></svg>`;
  }

  /* ---- price scale ------------------------------------------------ */

  const baseLo = Math.min(...bars.map((b) => b.l));
  const baseHi = Math.max(...bars.map((b) => b.h));
  let lo = baseLo;
  let hi = baseHi;

  // The allowance is fixed against the traded range up front. Measuring it
  // against the running hi/lo instead lets each accepted value widen the span
  // and admit the next one, ratcheting the scale open until the candles
  // collapse into a strip -- which is what a long moving average below a short
  // window used to do here.
  const allow = (baseHi - baseLo) * 0.35;
  const consider = (p: number | null | undefined) => {
    if (p == null || !Number.isFinite(p)) return;
    if (p > hi && p <= baseHi + allow) hi = p;
    if (p < lo && p >= baseLo - allow) lo = p;
  };
  for (const l of o.levels ?? []) consider(l.price);
  for (const h of o.hlines ?? []) consider(h.price);
  for (const ov of o.overlays ?? []) for (const v of ov.values) consider(v);
  consider(o.price);

  const span = hi - lo || hi * 0.02 || 1;
  lo -= span * 0.06;
  hi += span * 0.06;
  const range = hi - lo;

  const x = (i: number) => padL + ((i + 0.5) / bars.length) * plotW;
  const y = (p: number) => padT + ((hi - p) / range) * plotH;
  const bw = plotW / bars.length;
  const body = Math.max(1, Math.min(bw * 0.68, 14));

  const maxVol = Math.max(...bars.map((b) => b.v), 1);
  const vy = (v: number) => volTop + volH - (v / maxVol) * volH;

  /* ---- right-axis tags, placed before anything is drawn ----------- */

  // Positions are resolved up front so the grid can skip any price label a tag
  // will cover. Drawing the labels first and stamping tags over them leaves
  // half-hidden numbers peeking out from behind the boxes.
  type Tag = { y: number; text: string; color: string; bold?: boolean };
  const inPane = (yy: number) => yy >= padT - 2 && yy <= padT + plotH + 2;

  // The price axis carries the grid and the last price, and nothing else.
  // Every level used to claim its own tag here, which stacked the right edge
  // into a wall of boxes and buried the one number that always matters. Levels
  // are now labelled on the line itself, inside the plot.
  const levels = o.levels ?? [];
  // Four is about what a reader takes in at a glance; the rest stay as faint
  // lines, and the full list is in the table under the chart.
  const maxLabels = Math.max(2, Math.min(4, Math.floor(plotH / 34)));
  const labelled = new Set(
    [...levels]
      .filter((l) => inPane(y(l.price)))
      .sort((a, b) => Math.abs(a.price - o.price) - Math.abs(b.price - o.price))
      .slice(0, maxLabels),
  );

  const priceY = y(o.price);
  const placedTags: Tag[] = inPane(priceY)
    ? [{ y: priceY, text: fmtPrice(o.price), color: C.price, bold: true }]
    : [];
  const coveredByTag = (yy: number) => placedTags.some((t) => Math.abs(t.y - yy) < tagH * 1.15);

  const out: string[] = [];
  out.push(
    `<svg viewBox="0 0 ${W} ${H}" class="chart" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(o.title ?? "price chart")}">`,
  );
  out.push(`<rect width="${W}" height="${H}" fill="${C.bg}"/>`);

  // Now that the scale is bounded, a moving average can legitimately run off
  // the pane. Clipping keeps it from drawing across the volume histogram and
  // the time axis.
  const clip = `pc${++clipSeq}`;
  out.push(`<defs><clipPath id="${clip}"><rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}"/></clipPath></defs>`);

  /* ---- horizontal grid + price axis ------------------------------- */

  const step = niceStep(range, 6);
  const first = Math.ceil(lo / step) * step;
  for (let p = first; p <= hi; p += step) {
    const yy = y(p);
    out.push(`<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${padL + plotW}" y2="${yy.toFixed(1)}" stroke="${C.grid}" stroke-width="1"/>`);
    if (!coveredByTag(yy)) {
      out.push(`<text x="${padL + plotW + 6}" y="${(yy + 3.5).toFixed(1)}" fill="${C.text}" font-size="${fs(10.5)}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">${fmtPrice(p)}</text>`);
    }
  }

  /* ---- vertical grid + time axis ---------------------------------- */

  const tFmt =
    o.mode === "daily"
      ? new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" })
      : new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hour12: true });
  const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

  const ticks: number[] = [];
  if (o.mode === "daily") {
    let lastMonth = "";
    for (let i = 0; i < bars.length; i++) {
      const m = dayKey.format(new Date(bars[i].t)).slice(0, 7);
      if (m !== lastMonth) { ticks.push(i); lastMonth = m; }
    }
  } else {
    let lastDay = "";
    for (let i = 0; i < bars.length; i++) {
      const d = dayKey.format(new Date(bars[i].t));
      if (d !== lastDay) { ticks.push(i); lastDay = d; }
    }
    const stride = Math.max(1, Math.floor(bars.length / 8));
    for (let i = 0; i < bars.length; i += stride) if (!ticks.includes(i)) ticks.push(i);
    ticks.sort((a, b) => a - b);
  }

  let lastLabelX = -Infinity;
  for (const i of ticks) {
    const xx = x(i);
    out.push(`<line x1="${xx.toFixed(1)}" y1="${padT}" x2="${xx.toFixed(1)}" y2="${volTop + volH}" stroke="${C.grid}" stroke-width="1"/>`);
    if (xx - lastLabelX > 54) {
      out.push(`<text x="${xx.toFixed(1)}" y="${H - 8}" fill="${C.text}" font-size="${fs(10.5)}" text-anchor="middle" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">${esc(tFmt.format(new Date(bars[i].t)))}</text>`);
      lastLabelX = xx;
    }
  }

  /* ---- fibonacci bands -------------------------------------------- */

  if (o.fib) {
    const rets = [...o.fib.retracements].sort((a, b) => b.price - a.price);
    for (let i = 0; i < rets.length - 1; i++) {
      const yTop = y(rets[i].price);
      const yBot = y(rets[i + 1].price);
      if (yBot < padT || yTop > padT + plotH) continue;
      out.push(`<rect x="${padL}" y="${Math.max(padT, yTop).toFixed(1)}" width="${plotW}" height="${Math.max(0, Math.min(padT + plotH, yBot) - Math.max(padT, yTop)).toFixed(1)}" fill="${C.fib}" opacity="${i % 2 === 0 ? 0.045 : 0.02}"/>`);
    }
    const gpTop = y(o.fib.goldenPocket.high);
    const gpBot = y(o.fib.goldenPocket.low);
    if (gpBot > padT && gpTop < padT + plotH) {
      out.push(`<rect x="${padL}" y="${Math.max(padT, gpTop).toFixed(1)}" width="${plotW}" height="${Math.max(1.5, Math.min(padT + plotH, gpBot) - Math.max(padT, gpTop)).toFixed(1)}" fill="${C.golden}" opacity="0.17"/>`);
    }
    // Labels are dropped where retracements bunch tighter than the type is
    // tall. The line still draws; only the overlapping caption is skipped.
    let lastFibLabelY = -Infinity;
    const fibGap = 11 * k;
    for (const r of o.fib.retracements) {
      const yy = y(r.price);
      if (yy < padT || yy > padT + plotH) continue;
      const strong = r.ratio === 0.618 || r.ratio === 0.5;
      out.push(`<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${padL + plotW}" y2="${yy.toFixed(1)}" stroke="${C.fib}" stroke-width="${strong ? 1.1 : 0.8}" stroke-dasharray="4 4" opacity="${strong ? 0.75 : 0.42}"/>`);
      if (yy - lastFibLabelY >= fibGap) {
        out.push(`<text x="${padL + 5}" y="${(yy - 3).toFixed(1)}" fill="${C.fib}" font-size="${fs(9.5)}" opacity="0.9" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">${(r.ratio * 100).toFixed(1)}% · ${fmtPrice(r.price)}</text>`);
        lastFibLabelY = yy;
      }
    }
  }

  /* ---- volume pane ------------------------------------------------ */

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (b.v <= 0) continue;
    const up = b.c >= b.o;
    out.push(`<rect x="${(x(i) - body / 2).toFixed(1)}" y="${vy(b.v).toFixed(1)}" width="${body.toFixed(1)}" height="${Math.max(0.5, volTop + volH - vy(b.v)).toFixed(1)}" fill="${up ? C.upFill : C.downFill}" opacity="0.34"/>`);
  }
  out.push(`<line x1="${padL}" y1="${volTop + volH}" x2="${padL + plotW}" y2="${volTop + volH}" stroke="${C.gridStrong}" stroke-width="1"/>`);

  /* ---- overlays (moving averages, vwap) --------------------------- */

  if ((o.overlays ?? []).length > 0) out.push(`<g clip-path="url(#${clip})">`);
  for (const ov of o.overlays ?? []) {
    const segments: string[] = [];
    let cur: string[] = [];
    for (let i = 0; i < bars.length; i++) {
      const v = ov.values[i];
      if (v == null || !Number.isFinite(v)) {
        if (cur.length > 1) segments.push(cur.join(" "));
        cur = [];
        continue;
      }
      cur.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    }
    if (cur.length > 1) segments.push(cur.join(" "));
    for (const pts of segments) {
      out.push(`<polyline points="${pts}" fill="none" stroke="${ov.color}" stroke-width="1.4" opacity="0.92"${ov.dashed ? ' stroke-dasharray="5 4"' : ""} stroke-linejoin="round"/>`);
    }
  }

  if ((o.overlays ?? []).length > 0) out.push("</g>");

  /* ---- candles ---------------------------------------------------- */

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const up = b.c >= b.o;
    const col = up ? C.up : C.down;
    const xx = x(i);
    out.push(`<line x1="${xx.toFixed(1)}" y1="${y(b.h).toFixed(1)}" x2="${xx.toFixed(1)}" y2="${y(b.l).toFixed(1)}" stroke="${col}" stroke-width="1"/>`);
    const top = y(Math.max(b.o, b.c));
    const h = Math.max(1, Math.abs(y(b.o) - y(b.c)));
    out.push(`<rect x="${(xx - body / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${body.toFixed(1)}" height="${h.toFixed(1)}" fill="${col}"/>`);
  }

  /* ---- pattern annotations ---------------------------------------- */

  for (const p of o.patterns ?? []) {
    for (const line of p.lines ?? []) {
      const pts = line.points
        .map(([idx, price]) => [idx - offset, price] as [number, number])
        .filter(([idx]) => idx >= -bars.length && idx < bars.length * 2)
        .map(([idx, price]) => `${x(Math.max(0, Math.min(bars.length - 1, idx))).toFixed(1)},${y(price).toFixed(1)}`);
      if (pts.length < 2) continue;
      const col = p.direction === "bullish" ? C.up : p.direction === "bearish" ? C.down : C.neutral;
      out.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${col}" stroke-width="1.3" opacity="0.85"${line.style === "dashed" ? ' stroke-dasharray="6 4"' : ""}/>`);
    }
  }

  /* ---- levels + right-axis tags ----------------------------------- */

  // Labels ride the right end of their own line, inside the plot, and are
  // de-collided among themselves so a cluster of levels stays readable.
  const lineLabels: { y: number; text: string; color: string }[] = [];

  for (const l of levels) {
    const yy = y(l.price);
    if (!inPane(yy)) continue;
    const col = l.side === "resistance" ? C.resistance : l.side === "support" ? C.support : C.price;
    const strong = labelled.has(l);
    const weight = strong ? Math.min(1.6, 0.75 + l.score / 22) : 0.7;
    const alpha = strong ? Math.min(0.7, 0.3 + l.score / 42) : 0.16;
    out.push(`<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${padL + plotW}" y2="${yy.toFixed(1)}" stroke="${col}" stroke-width="${weight.toFixed(2)}" opacity="${alpha.toFixed(2)}"/>`);
    if (strong) lineLabels.push({ y: yy, text: `${fmtPrice(l.price)}  ${l.methods.length}x`, color: col });
  }

  for (const h of o.hlines ?? []) {
    const yy = y(h.price);
    if (!inPane(yy)) continue;
    out.push(`<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${padL + plotW}" y2="${yy.toFixed(1)}" stroke="${h.color}" stroke-width="1.1" opacity="0.75"${h.dashed !== false ? ' stroke-dasharray="5 4"' : ""}/>`);
    out.push(`<text x="${padL + 5}" y="${(yy - 3).toFixed(1)}" fill="${h.color}" font-size="${fs(9.5)}" opacity="0.95" font-family="'IBM Plex Mono',ui-monospace,Menlo,monospace">${esc(h.label)} ${fmtPrice(h.price)}</text>`);
  }

  for (const t of decollide(lineLabels, 15 * tk, padT + 8, padT + plotH - 4)) {
    out.push(`<text x="${padL + plotW - 5}" y="${(t.y - 3.5).toFixed(1)}" fill="${t.color}" font-size="${(9.5 * tk).toFixed(1)}" text-anchor="end" opacity="0.95" font-family="'IBM Plex Mono',ui-monospace,Menlo,monospace" font-weight="600">${esc(t.text as string)}</text>`);
  }

  if (inPane(priceY)) {
    out.push(`<line x1="${padL}" y1="${priceY.toFixed(1)}" x2="${padL + plotW}" y2="${priceY.toFixed(1)}" stroke="${C.price}" stroke-width="1" stroke-dasharray="2 3" opacity="0.8"/>`);
  }

  for (const t of placedTags) {
    const w = Math.max(28 * tk, t.text.length * 5.7 * tk + 6);
    out.push(`<rect x="${padL + plotW + 3}" y="${(t.y - tagH / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${tagH.toFixed(1)}" rx="2" fill="${t.color}" opacity="${t.bold ? 1 : 0.85}"/>`);
    out.push(`<text x="${padL + plotW + 6}" y="${(t.y + 3.1 * tk).toFixed(1)}" fill="#0b0f18" font-size="${(9 * tk).toFixed(1)}" font-weight="650" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">${esc(t.text)}</text>`);
  }

  out.push("</svg>");
  return out.join("");
}

import type { Analysis, Catalysts, Level, Mover, TradeGrade } from "./types.ts";
import { C, renderChart } from "./chart.ts";
import { etTime } from "./intraday.ts";
import { resample, sma } from "./ta.ts";

const esc = (s: string) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const num = (v: number | null | undefined, digits = 2, suffix = "") =>
  v == null || !Number.isFinite(v) ? "&mdash;" : v.toFixed(digits) + suffix;

const signed = (v: number | null | undefined, digits = 2, suffix = "") =>
  v == null || !Number.isFinite(v) ? "&mdash;" : (v >= 0 ? "+" : "") + v.toFixed(digits) + suffix;

function compactVol(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "&mdash;";
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(0) + "K";
  return String(Math.round(v));
}

const METHOD_LABEL: Record<string, string> = {
  swing: "Swing pivot",
  "52w": "52-week extreme",
  ma: "Moving average",
  volume: "Volume profile",
  fib: "Fibonacci",
  gap: "Unfilled gap",
  avwap: "Anchored VWAP",
  round: "Round number",
  "prior-day": "Prior day",
  "floor-pivot": "Floor pivot",
  premarket: "Premarket",
  vwap: "Session VWAP",
};

/* ------------------------------------------------------------------ *
 * Market clock
 * ------------------------------------------------------------------ */

export function marketPhase(now = new Date()): { label: string; tone: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wd = get("weekday");
  const mins = Number(get("hour")) * 60 + Number(get("minute"));

  if (wd === "Sat" || wd === "Sun") return { label: "Weekend &middot; market closed", tone: "muted" };
  if (mins < 4 * 60) return { label: "Overnight", tone: "muted" };
  if (mins < 9 * 60 + 30) return { label: "Pre-market", tone: "pre" };
  if (mins < 16 * 60) return { label: "Regular session open", tone: "open" };
  if (mins < 20 * 60) return { label: "After hours", tone: "pre" };
  return { label: "Market closed", tone: "muted" };
}

/* ------------------------------------------------------------------ *
 * Fragments
 * ------------------------------------------------------------------ */

function levelRows(levels: Level[], price: number): string {
  if (levels.length === 0) return `<tr><td colspan="4" class="empty">No levels within range.</td></tr>`;
  return levels
    .map((l) => {
      const cls = l.side === "resistance" ? "res" : l.side === "support" ? "sup" : "at";
      // Joined with a literal middot, not the HTML entity: these strings pass
      // through esc(), which would turn an entity into visible "&middot;".
      const methods = l.methods.map((m) => METHOD_LABEL[m] ?? m).join(" · ");
      return `<tr class="${cls}">
        <td class="mono strong">${num(l.price)}</td>
        <td class="mono ${l.distancePct >= 0 ? "pos" : "neg"}">${signed(l.distancePct, 2, "%")}<span class="sub">${signed(l.distanceAtr, 2)} ATR</span></td>
        <td><span class="conf" style="--w:${Math.min(100, (l.score / 26) * 100).toFixed(0)}%"><b>${l.methods.length}</b></span></td>
        <td class="why"><span class="methods">${esc(methods)}</span><span class="labels">${esc(l.labels.slice(0, 4).join(" · "))}</span></td>
      </tr>`;
    })
    .join("");
}

function fibBlock(a: Analysis): string {
  if (a.fibs.length === 0) return `<p class="empty">No Fibonacci leg met the minimum swing size.</p>`;
  return a.fibs
    .map((f) => {
      const dirWord = f.direction === "up" ? "low &rarr; high" : "high &rarr; low";
      const rows = f.retracements
        .map((r) => {
          const dist = ((r.price - a.price) / a.price) * 100;
          const gp = r.ratio === 0.618 || r.ratio === 0.702;
          return `<tr class="${gp ? "gp" : ""}"><td class="mono">${(r.ratio * 100).toFixed(1)}%</td><td class="mono strong">${num(r.price)}</td><td class="mono ${dist >= 0 ? "pos" : "neg"}">${signed(dist, 2, "%")}</td></tr>`;
        })
        .join("");
      const exts = f.extensions
        .map((e) => `<tr><td class="mono">${e.ratio.toFixed(3)}</td><td class="mono strong">${num(e.price)}</td><td class="mono ${e.price >= a.price ? "pos" : "neg"}">${signed(((e.price - a.price) / a.price) * 100, 2, "%")}</td></tr>`)
        .join("");
      return `<div class="fibset">
        <div class="fibhead"><b>${esc(f.label)}</b><span>${num(f.anchorLow)} &rarr; ${num(f.anchorHigh)} &middot; ${dirWord}</span></div>
        <div class="fibcols">
          <table class="mini"><thead><tr><th>Retrace</th><th>Price</th><th>Dist</th></tr></thead><tbody>${rows}</tbody></table>
          <table class="mini"><thead><tr><th>Extension</th><th>Price</th><th>Dist</th></tr></thead><tbody>${exts}</tbody></table>
        </div>
        <div class="gpnote">Golden pocket ${num(f.goldenPocket.low)} &ndash; ${num(f.goldenPocket.high)}</div>
      </div>`;
    })
    .join("");
}

function patternBlock(a: Analysis): string {
  if (a.patterns.length === 0) return `<p class="empty">No pattern matched the detection thresholds.</p>`;
  return a.patterns
    .map((p) => {
      const tone = p.direction === "bullish" ? "bull" : p.direction === "bearish" ? "bear" : "neu";
      return `<div class="pat ${tone}">
        <div class="pathead">
          <span class="patname">${esc(p.name)}</span>
          <span class="badge ${p.status}">${esc(p.status)}</span>
          <span class="confbar" title="confidence ${(p.confidence * 100).toFixed(0)}%"><i style="width:${(p.confidence * 100).toFixed(0)}%"></i></span>
        </div>
        <p>${esc(p.description)}</p>
        ${p.trigger != null || p.invalidation != null
          ? `<div class="trig">${p.trigger != null ? `<span>Trigger <b class="mono">${num(p.trigger)}</b></span>` : ""}${p.invalidation != null ? `<span>Invalidation <b class="mono">${num(p.invalidation)}</b></span>` : ""}</div>`
          : ""}
      </div>`;
    })
    .join("");
}

function intradayBlock(a: Analysis): string {
  const ic = a.intradayContext;
  const cells: string[] = [];
  const cell = (label: string, value: string, extra = "") =>
    cells.push(`<div class="idcell ${extra}"><span>${label}</span><b class="mono">${value}</b></div>`);

  if (ic.priorDay) {
    cell("Prior high", num(ic.priorDay.h));
    cell("Prior low", num(ic.priorDay.l));
    cell("Prior close", num(ic.priorDay.c));
  }
  if (ic.premarket) {
    cell("Premkt high", num(ic.premarket.high), "hot");
    cell("Premkt low", num(ic.premarket.low), "hot");
    cell("Premkt VWAP", num(ic.premarketVwap));
  }
  if (ic.gapPct != null) cell("Gap", signed(ic.gapPct, 2, "%"), ic.gapPct >= 0 ? "pos" : "neg");
  if (ic.openingRange) {
    cell(`OR ${ic.openingRange.minutes}m high`, num(ic.openingRange.high), ic.openingRange.pending ? "pending" : "");
    cell(`OR ${ic.openingRange.minutes}m low`, num(ic.openingRange.low), ic.openingRange.pending ? "pending" : "");
  }
  if (ic.sessionVwap != null) cell("Session VWAP", num(ic.sessionVwap));
  if (ic.floorPivots) {
    const f = ic.floorPivots;
    cell("R2", num(f.r2)); cell("R1", num(f.r1)); cell("Pivot", num(f.pp), "hot");
    cell("S1", num(f.s1)); cell("S2", num(f.s2));
  }

  const stale = ic.openingRange?.pending
    ? `<p class="note">Opening range shown is from ${esc(ic.openingRange.date)} and is a reference only &mdash; today&rsquo;s first ${ic.openingRange.minutes} minutes have not printed yet.</p>`
    : "";
  const noPre = !ic.premarket
    ? `<p class="note">No premarket prints in the feed yet, so gap and premarket levels are unavailable for this run.</p>`
    : "";

  return `<div class="idgrid">${cells.join("")}</div>${stale}${noPre}`;
}

/**
 * A collapsible block.
 *
 * Keyed by kind rather than by symbol: collapsing "Charts" once collapses it
 * for every ticker, because the decision is about what you care about, not
 * about one stock. Built on <details>, so with scripting off every block is
 * simply open.
 */
function blk(key: string, title: string, note: string, content: string): string {
  return `<details class="blk" data-blk="${key}" open>
    <summary><span class="blktitle">${title}</span>${note ? `<span class="blknote">${note}</span>` : ""}</summary>
    <div class="blkbody">${content}</div>
  </details>`;
}

/**
 * Wraps a chart in a pan/zoom viewport.
 *
 * The container carries the chart's own aspect ratio, so at 1x it looks exactly
 * as before; zooming widens the SVG past the container and native overflow
 * scrolling does the panning. Leaning on native scroll rather than transforms
 * means touch dragging and momentum work on the phone without fighting the
 * browser for gestures.
 */
function zoomable(svg: string, w: number, h: number): string {
  return `<div class="cz" style="aspect-ratio:${w}/${h}">${svg}</div>
  <div class="czbar">
    <button type="button" data-z="-" aria-label="zoom out">&minus;</button>
    <button type="button" data-z="0">Reset</button>
    <button type="button" data-z="+" aria-label="zoom in">+</button>
    <span class="czlvl">1.0&times;</span>
    <i>drag to pan &middot; ctrl+scroll or double-click to zoom</i>
  </div>`;
}

/* ------------------------------------------------------------------ *
 * Compact summary fragments
 * ------------------------------------------------------------------ */

const gradeTone = (letter: string) =>
  letter.startsWith("A") ? "ga" : letter.startsWith("B") ? "gb" : letter.startsWith("C") ? "gc" : "gd";

function gradeBadge(g: TradeGrade): string {
  return `<div class="gradebadge ${gradeTone(g.letter)}" title="day-trade setup grade">
    <b>${esc(g.letter)}</b><span>${g.total.toFixed(0)}<i>/100</i></span>
  </div>`;
}

function gradeBreakdown(g: TradeGrade): string {
  const rows = g.components
    .map(
      (c) => `<div class="gcomp">
      <div class="gclabel"><span>${esc(c.label)}</span><b class="mono">${c.score.toFixed(0)}/${c.max}</b></div>
      <div class="gcbar"><i style="width:${((c.score / c.max) * 100).toFixed(0)}%"></i></div>
      <div class="gcdetail">${esc(c.detail)}</div>
    </div>`,
    )
    .join("");
  return `${rows}<p class="note">The grade measures how <i>tradeable</i> the session looks &mdash; liquidity, range, participation, a catalyst and room to the next level &mdash; not whether the trade is a good idea. A quiet mega-cap in a clean uptrend grades low because there is nothing to capture intraday.</p>`;
}

/**
 * The line a setup has to hold to still be working *today*.
 *
 * A pattern's own invalidation is a swing level and can sit 30% away, which is
 * no use before the open. A breakout that has already triggered fails the
 * moment price goes back through the level it broke, so that level is the one
 * worth watching; otherwise it is the first level behind price.
 */
function mustHold(a: Analysis): { price: number; why: string } | null {
  const atr = a.indicators.atr14 ?? 0;
  const long = a.grade.bias !== "short-side";

  const triggered = a.patterns.find((p) => p.status === "triggered" && p.trigger != null);
  if (triggered && atr > 0 && Math.abs(triggered.trigger! - a.price) / atr <= 2.5) {
    return { price: triggered.trigger!, why: `${triggered.name.toLowerCase()} fails back through here` };
  }

  const behind = long
    ? a.levels.filter((l) => l.side === "support").sort((x, y) => y.price - x.price)[0]
    : a.levels.filter((l) => l.side === "resistance").sort((x, y) => x.price - y.price)[0];
  if (behind) {
    return { price: behind.price, why: long ? "first support behind price" : "first resistance above price" };
  }

  const p = a.patterns.find((x) => x.invalidation != null);
  return p?.invalidation != null ? { price: p.invalidation, why: "pattern invalidation" } : null;
}

/** The six things worth knowing before the bell, in one row. */
function planStrip(a: Analysis): string {
  const res = a.levels.filter((l) => l.side === "resistance").sort((x, y) => x.price - y.price)[0];
  const sup = a.levels.filter((l) => l.side === "support").sort((x, y) => y.price - x.price)[0];
  const setup = a.patterns.find((p) => p.status === "triggered")
    ?? a.patterns.find((p) => p.name !== "Range / no clear trend" && p.trigger != null);
  const hold = mustHold(a);

  const biasTone =
    a.grade.bias === "long-side" ? "pos" : a.grade.bias === "short-side" ? "neg" : "dim";

  const cell = (label: string, value: string, tone = "", sub = "") =>
    `<div class="pcell"><span>${label}</span><b class="mono ${tone}">${value}</b>${sub ? `<i>${sub}</i>` : ""}</div>`;

  const atr = a.indicators.atr14;
  return `<div class="plan">
    ${cell("Bias", a.grade.bias.replace("-", " "), biasTone)}
    ${cell("Typical day", atr != null ? num(atr) : "&mdash;", "", atr != null ? `${num(a.indicators.atrPct, 2, "%")} of price` : "")}
    ${cell("First resistance", res ? num(res.price) : "&mdash;", "neg", res ? `${signed(res.distancePct, 2, "%")} &middot; ${res.methods.length} methods` : "")}
    ${cell("First support", sup ? num(sup.price) : "&mdash;", "pos", sup ? `${signed(sup.distancePct, 2, "%")} &middot; ${sup.methods.length} methods` : "")}
    ${cell("Must hold", hold ? num(hold.price) : "&mdash;", "", hold ? esc(hold.why) : "nothing mapped behind price")}
    <div class="pcell"><span>Setup</span><b class="setupname">${setup ? esc(setup.name) : "None active"}</b>${
      setup
        ? `<i>${esc(setup.status)}${
            // A triggered setup's level is already shown as "Must hold"; only a
            // setup still forming needs its trigger repeated here.
            setup.status === "forming" && setup.trigger != null ? ` &middot; needs ${num(setup.trigger)}` : ""
          }</i>`
        : ""
    }</div>
  </div>
  <p class="biaswhy">${esc(a.grade.biasWhy)}</p>`;
}

/* ------------------------------------------------------------------ *
 * Catalysts
 * ------------------------------------------------------------------ */

const AGO = (h: number | null) =>
  h == null ? "" : h < 1 ? `${Math.round(h * 60)}m ago` : h < 48 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`;

/** Compact catalyst chips shown right under the plan strip. */
function catalystChips(c: Catalysts | null): string {
  if (!c || c.flags.length === 0) return "";
  const chips = c.flags
    .map((f) => `<span class="cflag ${f.tone}" title="${esc(f.detail)}">${esc(f.label)}</span>`)
    .join("");
  return `<div class="cflags">${chips}</div>`;
}

/** Headlines are third-party text; they are escaped and shown, never acted on. */
function newsList(c: Catalysts | null, limit = 6): string {
  if (!c) return `<p class="empty">Catalyst lookup did not run for this symbol.</p>`;
  if (c.news.length === 0) return `<p class="empty">No headlines returned for this symbol.</p>`;
  return `<ul class="news">${c.news
    .slice(0, limit)
    .map((n) => {
      const tags = n.tags
        .map((t) => `<span class="ntag ${t.lean}">${esc(t.tag)}</span>`)
        .join("");
      const fresh = n.ageHours != null && n.ageHours <= 24 ? " fresh" : "";
      // A link is navigable, not a loaded resource, so the page still renders
      // fully offline; it just needs a connection to follow the story.
      const title = /^https?:\/\//.test(n.link)
        ? `<a class="ntitle" href="${esc(n.link)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a>`
        : `<div class="ntitle">${esc(n.title)}</div>`;
      return `<li class="${fresh.trim()}">
        <div class="nmeta">${esc(n.publisher)}${n.ageHours != null ? ` &middot; ${esc(AGO(n.ageHours))}` : ""}</div>
        ${title}
        ${tags ? `<div class="ntags">${tags}</div>` : ""}
      </li>`;
    })
    .join("")}</ul>`;
}

function catalystPanel(c: Catalysts | null): string {
  if (!c) return `<p class="empty">Catalyst lookup did not run.</p>`;
  if (!c.available) {
    return `<p class="empty">Yahoo refused the authenticated request this run, so earnings dates, float and short interest are unavailable. Headlines below are unaffected.</p>${newsList(c)}`;
  }
  const f = c.fundamentals;
  const cells: string[] = [];
  const cell = (label: string, value: string, tone = "") =>
    cells.push(`<div class="idcell ${tone}"><span>${label}</span><b class="mono">${value}</b></div>`);

  if (c.nextEarnings) {
    cell(
      "Next earnings",
      `${new Date(c.nextEarnings.date).toISOString().slice(5, 10)}`,
      c.nextEarnings.inDays <= 7 ? "hot" : "",
    );
    cell("In", `${c.nextEarnings.inDays}d${c.nextEarnings.estimated ? "*" : ""}`, c.nextEarnings.inDays <= 1 ? "neg" : "");
  }
  if (c.lastEarnings) cell("Last report", `${c.lastEarnings.agoDays}d ago`);
  if (f) {
    if (f.shortPercentOfFloat != null) cell("Short % float", `${(f.shortPercentOfFloat * 100).toFixed(1)}%`, f.shortPercentOfFloat >= 0.15 ? "hot" : "");
    if (f.shortRatio != null) cell("Days to cover", f.shortRatio.toFixed(1));
    if (f.sharesShort != null && f.sharesShortPriorMonth != null) {
      const d = ((f.sharesShort - f.sharesShortPriorMonth) / f.sharesShortPriorMonth) * 100;
      cell("Short vs prior mo", signed(d, 1, "%"), d > 0 ? "neg" : "pos");
    }
    if (f.floatShares != null) cell("Float", compactVol(f.floatShares), f.floatShares < 50e6 ? "hot" : "");
    if (f.marketCap != null) cell("Market cap", compactVol(f.marketCap));
    if (f.beta != null) cell("Beta", f.beta.toFixed(2), f.beta >= 2 ? "hot" : "");
    if (f.exDividendDate != null) cell("Ex-dividend", new Date(f.exDividendDate).toISOString().slice(5, 10));
  }

  const est = c.nextEarnings?.estimated
    ? `<p class="note">* Yahoo lists this earnings date as estimated, not confirmed by the company.</p>`
    : "";

  return `${cells.length ? `<div class="idgrid">${cells.join("")}</div>${est}` : ""}
    <h4 class="newshead">Recent headlines</h4>
    ${newsList(c)}
    <p class="note">Headline tags come from keyword matching on the title only, not from reading the article. They mark what a story is about; the headline is shown so you can judge it yourself.</p>`;
}

/**
 * The confluence cell: a count of independent methods agreeing at a price,
 * with dots so the strength reads without parsing the number.
 */
function confCell(l: Level): string {
  const n = l.methods.length;
  const tier = n >= 6 ? "c5" : n >= 5 ? "c4" : n >= 4 ? "c3" : n >= 3 ? "c2" : "c1";
  const dots = Array.from({ length: 6 }, (_, i) => `<i class="${i < n ? "on" : ""}"></i>`).join("");
  return `<span class="confbox ${tier}" title="${n} independent methods agree at ${l.price.toFixed(2)}">
    <b>${n}</b><span class="confdots">${dots}</span>
  </span>`;
}

/* ------------------------------------------------------------------ *
 * Options chain reference
 * ------------------------------------------------------------------ */

function optionsPanel(a: Analysis): string {
  const o = a.options;
  if (!o) {
    return `<p class="empty">No listed options chain was returned for ${esc(a.symbol)}.</p>`;
  }

  const cmp =
    o.impliedDayMove != null && o.atrDayMove != null
      ? (() => {
          const ratio = o.impliedDayMove / o.atrDayMove;
          const verdict =
            ratio > 1.25
              ? "Options are pricing a bigger daily move than the stock has actually been making, so premium is expensive relative to recent behaviour."
              : ratio < 0.8
                ? "Options are pricing a smaller daily move than the stock has actually been making, so premium is cheap relative to recent behaviour."
                : "Options are pricing roughly what the stock has actually been doing.";
          return `<p class="ivnote"><b>Implied ${num(o.impliedDayMove)}/day</b> vs <b>ATR ${num(o.atrDayMove)}/day</b>${o.atmIv != null ? ` &middot; ATM IV ${(o.atmIv * 100).toFixed(1)}%` : ""}. ${esc(verdict)}</p>`;
        })()
      : "";

  const groups = o.groups
    .map((g) => {
      const rows = g.ideas
        .map((i) => {
          const fits =
            i.moveRatio == null ? "" : i.moveRatio <= 0.6 ? "fit-good" : i.moveRatio <= 1 ? "fit-fair" : "fit-poor";
          return `<tr class="${i.kind}">
            <td><b class="mono">${esc(i.kind === "call" ? "C" : "P")} ${num(i.strike)}</b><span class="sub">${esc(i.label)}</span></td>
            <td class="mono">${num(i.mid)}<span class="sub">${num(i.bid)} / ${num(i.ask)}</span></td>
            <td class="mono">${num(i.breakeven)}<span class="sub">${signed(i.moveNeededPct, 2, "%")}</span></td>
            <td class="mono ${fits}">${i.moveRatio == null ? "&mdash;" : i.moveRatio.toFixed(2) + "&times;"}<span class="sub">of ${num(i.expectedMove)} typical</span></td>
            <td class="mono">${i.delta == null ? "&mdash;" : i.delta.toFixed(2)}<span class="sub">${i.iv != null ? `${(i.iv * 100).toFixed(0)}% IV` : ""}</span></td>
            <td><span class="liq ${i.liquidity.tier}">${esc(i.liquidity.tier)}</span><span class="sub">${esc(i.liquidity.why)}</span></td>
          </tr>`;
        })
        .join("");
      const d = new Date(g.expiry);
      return `<div class="optgroup">
        <div class="opthead"><b>${d.toISOString().slice(0, 10)}</b><span>${g.days < 1 ? "expires today" : `${Math.round(g.days)} days out`}</span></div>
        <div class="tablewrap"><table class="opts">
          <thead><tr><th>Contract</th><th>Mid (bid/ask)</th><th>Breakeven</th><th>Move needed</th><th>Delta</th><th>Liquidity</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>`;
    })
    .join("");

  return `${cmp}${groups}
    <p class="note"><b>How to read "move needed".</b> It is the move to breakeven divided by what this stock typically covers over the contract's life, measured from its own ATR. Under 1.00 means breakeven sits inside a normal move for that horizon; over 1.00 means the stock has to do something bigger than usual just for you to get your premium back. Liquidity is open interest and the bid-ask spread as a share of the premium &mdash; a wide spread on a contract nobody trades costs you on entry and again on exit.</p>
    <p class="note">Delta is computed from the quoted implied volatility, not reported by the exchange, so treat it as an estimate. This is the chain lined up against the measured levels, not a recommendation to buy anything.</p>`;
}

/** The prior-day candle read: who had control, and how clearly. */
function sessionBlock(a: Analysis): string {
  const s = a.session;
  if (!s) return "";
  const tone = s.pressure === "buyers" ? "bull" : s.pressure === "sellers" ? "bear" : "neu";

  // A compact visual of the bar itself: wick, body, and where it closed.
  const bar = `<span class="candle ${s.green ? "up" : "down"}" title="prior session bar">
    <i class="uw" style="height:${(s.upperWick * 100).toFixed(0)}%"></i>
    <i class="bd" style="height:${Math.max(4, s.body * 100).toFixed(0)}%"></i>
    <i class="lw" style="height:${(s.lowerWick * 100).toFixed(0)}%"></i>
  </span>`;

  // The read runs on the newest daily bar. Before the open that is genuinely
  // the prior session; run intraday it is today's bar, which is not final yet.
  const todayET = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const isToday = s.date === todayET;
  const live = isToday && marketPhase().tone === "open";
  const heading = live ? "Today so far" : isToday ? "Latest session" : "Prior session";

  const chips = [
    `Close location <b>${s.clv >= 0 ? "+" : ""}${s.clv.toFixed(2)}</b>`,
    `Range <b>${s.rangeAtr.toFixed(1)} ATR</b>`,
    s.volRatio != null ? `Volume <b>${s.volRatio.toFixed(1)}&times;</b>` : null,
    `Body <b>${(s.body * 100).toFixed(0)}%</b> of range`,
  ]
    .filter(Boolean)
    .map((c) => `<span>${c}</span>`)
    .join("");

  return `<div class="sess ${tone}">
    ${bar}
    <div class="sesstext">
      <div class="sesshead">${heading} &mdash; ${esc(s.date)} &middot; ${signed(s.changePct, 2, "%")}</div>
      <p>${esc(s.narrative)}</p>
      ${live ? `<p class="note">The session is still open, so this bar is not final and the read can change by the close.</p>` : ""}
      ${
        s.signals.length === 0 && s.barDescription
          ? `<div class="cshapes"><span class="cshape plain" title="No textbook candlestick shape fired, so this is the geometry of the bar.">${esc(s.barDescription)}</span></div>`
          : s.signals.length > 0
          ? `<div class="cshapes">${s.signals
              .map(
                (g) =>
                  `<span class="cshape ${g.direction}" title="${esc(g.meaning)}">${esc(g.name)}<i>${esc(g.reliability)}</i></span>`,
              )
              .join("")}</div>`
          : ""
      }
      <div class="sesschips">${chips}</div>
      ${s.signals.length > 0 ? `<ul class="cmeaning">${s.signals.slice(0, 2).map((g) => `<li><b>${esc(g.name)}</b> &mdash; ${esc(g.meaning)}</li>`).join("")}</ul>` : ""}
    </div>
  </div>`;
}

/** Only the levels price can realistically reach today. */
function keyLevelsBlock(a: Analysis): string {
  // A level five ATR away is not in play in a single session. Reach is capped
  // at 2.5 ATR, and only if nothing qualifies does it fall back to the nearest
  // level either side, so the block is never empty.
  const REACH = 2.5;
  const bySide = (side: "support" | "resistance", within: boolean, n: number) =>
    a.levels
      .filter((l) => l.side === side && (!within || Math.abs(l.distanceAtr) <= REACH))
      .sort((x, y) => Math.abs(x.distancePct) - Math.abs(y.distancePct))
      .slice(0, n);

  const near = (side: "support" | "resistance", n: number) => {
    const inReach = bySide(side, true, n);
    return inReach.length > 0 ? inReach : bySide(side, false, 1);
  };

  const rows = [...near("resistance", 3), ...near("support", 3)]
    .sort((x, y) => y.price - x.price)
    .map((l) => {
      const cls = l.side === "resistance" ? "res" : "sup";
      const methods = l.methods.map((m) => METHOD_LABEL[m] ?? m).join(" · ");
      return `<tr class="${cls}">
        <td class="mono strong">${num(l.price)}</td>
        <td class="mono ${l.distancePct >= 0 ? "pos" : "neg"}">${signed(l.distancePct, 2, "%")}</td>
        <td class="mono dimc">${signed(l.distanceAtr, 1)} ATR</td>
        <td>${confCell(l)}</td>
        <td class="whys">${esc(methods)}</td>
      </tr>`;
    })
    .join("");

  if (!rows) return "";
  return `<div class="keylv">
    <h3>Levels in play <i>&mdash; within about ${REACH} ATR of ${num(a.price)}</i></h3>
    <div class="tablewrap"><table class="levels">
      <thead><tr><th>Price</th><th>Dist</th><th>ATR</th><th class="confh">Confluence</th><th>What agrees</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="conflegend">Confluence counts how many <b>independent methods</b> land on that price &mdash; a Fibonacci level, a moving average, the volume point of control and a prior swing all at once is a level the market is watching from four directions. It rates the <b>price level</b>, not the trade. The trade rating is the letter grade at the top.</p>
  </div>`;
}

/* ------------------------------------------------------------------ *
 * Per-ticker section
 * ------------------------------------------------------------------ */

function tickerSection(a: Analysis, lookbackDays: number, intradayDays: number): string {
  const bars = a.daily.bars;
  const visible = bars.slice(-lookbackDays);
  const offset = bars.length - visible.length;

  const closes = bars.map((b) => b.c);
  const slice = <T,>(arr: T[]) => arr.slice(-visible.length);

  const overlays = [
    { label: "20 SMA", color: C.ma20, values: slice(sma(closes, 20)) },
    { label: "50 SMA", color: C.ma50, values: slice(sma(closes, 50)) },
    { label: "200 SMA", color: C.ma200, values: slice(sma(closes, 200)) },
  ];
  const avwap = a.anchoredVwaps[0];
  if (avwap) overlays.push({ label: avwap.label, color: C.vwap, values: slice(avwap.series), dashed: true } as any);

  const dailyBase = {
    mode: "daily" as const,
    levels: a.levels,
    fib: a.fibs[0] ?? null,
    patterns: a.patterns,
    price: a.price,
    title: `${a.symbol} daily`,
  };

  // Two renders of the same data. The SVG scales to its container, so one
  // drawing cannot serve both a 1000px pane and a phone -- at phone width the
  // desktop chart's axis labels shrink to noise. The phone variant uses a
  // narrower viewBox, fewer sessions and larger type.
  const mobBars = visible.slice(-Math.min(90, visible.length));
  const dailyChart =
    `<div class="c-desk">${zoomable(renderChart({ ...dailyBase, bars: visible, overlays, indexOffset: offset, width: 980, height: 470 }), 980, 470)}</div>` +
    `<div class="c-mob">${zoomable(renderChart({
      ...dailyBase,
      bars: mobBars,
      overlays: overlays.map((ov) => ({ ...ov, values: ov.values.slice(-mobBars.length) })),
      indexOffset: bars.length - mobBars.length,
      width: 520, height: 430, fontScale: 1.5,
    }), 520, 430)}</div>`;

  let intraChart = "";
  if (a.intraday && a.intraday.bars.length > 10) {
    const cutoff = Date.now() - intradayDays * 24 * 3600 * 1000;
    const ib = a.intraday.bars.filter((b) => b.t >= cutoff);
    const use = ib.length > 20 ? ib : a.intraday.bars.slice(-160);
    const ic = a.intradayContext;
    const hlines: { price: number; color: string; label: string }[] = [];
    if (ic.priorDay) {
      hlines.push({ price: ic.priorDay.h, color: C.resistance, label: "PDH" });
      hlines.push({ price: ic.priorDay.l, color: C.support, label: "PDL" });
      hlines.push({ price: ic.priorDay.c, color: C.neutral, label: "PDC" });
    }
    if (ic.premarket) {
      hlines.push({ price: ic.premarket.high, color: C.ma20, label: "PMH" });
      hlines.push({ price: ic.premarket.low, color: C.ma20, label: "PML" });
    }
    if (ic.floorPivots) hlines.push({ price: ic.floorPivots.pp, color: C.vwap, label: "Pivot" });
    if (ic.sessionVwap != null) hlines.push({ price: ic.sessionVwap, color: C.ma50, label: "VWAP" });

    const intraBase = { mode: "intraday" as const, hlines, price: a.price, title: `${a.symbol} intraday` };
    const deskBars = resample(use, 15);
    const mobBars = resample(use, 30);
    intraChart = `<div class="chartwrap"><div class="chartlabel">Intraday &middot; ${intradayDays}d &middot; <span class="c-desk">15</span><span class="c-mob">30</span>-minute candles</div>` +
      `<div class="c-desk">${zoomable(renderChart({ ...intraBase, bars: deskBars, width: 980, height: 330 }), 980, 330)}</div>` +
      `<div class="c-mob">${zoomable(renderChart({ ...intraBase, bars: mobBars, width: 520, height: 320, fontScale: 1.5 }), 520, 320)}</div>` +
      `</div>`;
  }

  const ind = a.indicators;
  const stats = [
    ["Last", num(a.price)],
    ["Change", signed(a.changePct, 2, "%")],
    ["ATR(14)", `${num(ind.atr14)} (${num(ind.atrPct, 2, "%")})`],
    ["RSI(14)", num(ind.rsi14, 1)],
    ["Rel volume", ind.relVolume == null ? "&mdash;" : num(ind.relVolume, 2, "&times;")],
    ["Avg vol 20d", compactVol(ind.avgVol20)],
    ["52w position", ind.rangePos52w == null ? "&mdash;" : num(ind.rangePos52w, 0, "%")],
    ["BB squeeze", ind.bbSqueezeRank == null ? "&mdash;" : `${num(ind.bbSqueezeRank, 0)}th pct`],
    ["20 SMA", num(ind.sma20)],
    ["50 SMA", num(ind.sma50)],
    ["200 SMA", num(ind.sma200)],
    ["Vol POC", a.volumeProfile ? num(a.volumeProfile.poc) : "&mdash;"],
  ]
    .map(([k, v]) => `<div class="stat"><span>${k}</span><b class="mono">${v}</b></div>`)
    .join("");

  const errs = a.errors.length
    ? `<div class="warn">${a.errors.map((e) => esc(e)).join("<br>")}</div>`
    : "";
  const notes = a.notes.length
    ? `<div class="datanote">${a.notes.map((nn) => esc(nn)).join("<br>")}</div>`
    : "";

  return `<section class="ticker" id="t-${esc(a.symbol)}">
    <header class="thead">
      <div class="tid">
        <h2>${esc(a.symbol)}</h2>
        <span class="tname">${esc(a.name)}</span>
      </div>
      <div class="tprice">
        <b class="mono">${num(a.price)}</b>
        <span class="mono ${a.changePct >= 0 ? "pos" : "neg"}">${signed(a.changePct, 2, "%")}</span>
      </div>
      ${gradeBadge(a.grade)}
    </header>
    ${errs}
    ${planStrip(a)}
    ${catalystChips(a.catalysts)}
    ${blk("session", "Prior session", a.session?.shapeSummary ?? "", sessionBlock(a))}
    ${blk("charts", "Charts", `${visible.length} daily sessions`, `<div class="chartwrap"><div class="chartlabel">Daily &middot; ${visible.length} sessions &middot; levels, fib and pattern overlay</div>${dailyChart}</div>
    <div class="legend">
      <span><i style="background:${C.ma20}"></i>20 SMA</span>
      <span><i style="background:${C.ma50}"></i>50 SMA</span>
      <span><i style="background:${C.ma200}"></i>200 SMA</span>
      <span><i style="background:${C.vwap}"></i>Anchored VWAP</span>
      <span><i style="background:${C.golden}"></i>Golden pocket</span>
      <span><i style="background:${C.support}"></i>Support</span>
      <span><i style="background:${C.resistance}"></i>Resistance</span>
    </div>
    ${intraChart}`)}
    ${blk("levels", "Levels in play", `${a.levels.length} mapped`, keyLevelsBlock(a))}
    <details class="more">
      <summary>Full detail &mdash; all levels, every pattern, Fibonacci tables, intraday reference, indicators</summary>
      <div class="stats">${stats}</div>
      ${notes}
      <div class="panels">
        <div class="panel">
          <h3>All confluence levels</h3>
          <div class="tablewrap"><table class="levels">
            <thead><tr><th>Price</th><th>Distance</th><th>Methods</th><th>What agrees here</th></tr></thead>
            <tbody>${levelRows(a.levels, a.price)}</tbody>
          </table></div>
        </div>
        <div class="panel">
          <h3>All patterns</h3>
          ${patternBlock(a)}
        </div>
        <div class="panel">
          <h3>Fibonacci</h3>
          ${fibBlock(a)}
        </div>
        <div class="panel">
          <h3>Intraday reference</h3>
          ${intradayBlock(a)}
        </div>
        <div class="panel wide">
          <h3>Options chain against these levels</h3>
          ${optionsPanel(a)}
        </div>
        <div class="panel">
          <h3>Catalysts &amp; context</h3>
          ${catalystPanel(a.catalysts)}
        </div>
        <div class="panel">
          <h3>How this graded ${a.grade.letter}</h3>
          ${gradeBreakdown(a.grade)}
        </div>
      </div>
    </details>
    <a class="totop" href="#top">Back to top</a>
  </section>`;
}

/* ------------------------------------------------------------------ *
 * Movers board
 * ------------------------------------------------------------------ */

/** A bare line chart: enough shape to judge a name at a glance, no furniture. */
function sparkline(bars: { c: number }[], up: boolean, w = 150, h = 34): string {
  const pts = bars.slice(-70).map((b) => b.c);
  if (pts.length < 2) return "";
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  const span = hi - lo || 1;
  const d = pts
    .map((p, i) => `${((i / (pts.length - 1)) * w).toFixed(1)},${(h - ((p - lo) / span) * (h - 4) - 2).toFixed(1)}`)
    .join(" ");
  const col = up ? C.up : C.down;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${d}" fill="none" stroke="${col}" stroke-width="1.4"/></svg>`;
}

function moversSection(movers: Mover[], scanned: number, notes: string[]): string {
  if (movers.length === 0) {
    return `<h2 class="sec">Movers board</h2>
      <p class="empty">${notes.length ? esc(notes.join(" ")) : "No movers cleared the filters this run."}</p>`;
  }

  const rows = movers
    .map((m) => {
      const leanTone = m.lean === "long-side" ? "pos" : m.lean === "short-side" ? "neg" : "dim";
      const flags = (m.catalysts?.flags ?? [])
        .slice(0, 3)
        .map((f) => `<span class="cflag ${f.tone}" title="${esc(f.detail)}">${esc(f.label)}</span>`)
        .join("");
      const top = m.catalysts?.news?.[0];
      const fresh = top && top.ageHours != null && top.ageHours <= 24;

      return `<article class="mv">
        <div class="mvtop">
          <b class="mvsym">${esc(m.symbol)}</b>
          <span class="mvname">${esc(m.name)}</span>
          <span class="mvlean ${leanTone}">${esc(m.lean.replace("-", " "))}</span>
        </div>
        <div class="mvnums">
          <span class="mono strong">${num(m.price)}</span>
          <span class="mono ${m.changePct >= 0 ? "pos" : "neg"}">${signed(m.changePct, 2, "%")}</span>
          <span class="mono dimc">${m.relVolume != null ? `${m.relVolume.toFixed(1)}&times; vol` : "&mdash;"}</span>
          <span class="mono dimc">${compactVol(m.dollarVolume)} traded</span>
          ${m.atrPct != null ? `<span class="mono dimc">${m.atrPct.toFixed(1)}% ATR</span>` : ""}
          ${sparkline(m.bars, m.changePct >= 0)}
        </div>
        ${flags ? `<div class="cflags">${flags}</div>` : ""}
        ${
          m.session?.signals?.length
            ? `<div class="cshapes">${m.session.signals.slice(0, 2).map((g) => `<span class="cshape ${g.direction}" title="${esc(g.meaning)}">${esc(g.name)}</span>`).join("")}</div>`
            : m.session?.barDescription
              ? `<div class="cshapes"><span class="cshape plain">${esc(m.session.barDescription)}</span></div>`
              : ""
        }
        <p class="mvwhy">${esc(m.leanWhy)}</p>
        ${m.session ? `<p class="mvsess">${esc(m.session.narrative)}</p>` : ""}
        ${top ? `<div class="mvnews ${fresh ? "fresh" : ""}"><span>${esc(top.publisher)}${top.ageHours != null ? ` &middot; ${esc(AGO(top.ageHours))}` : ""}</span>${esc(top.title)}</div>` : ""}
        <div class="mvsrc">${m.source.map((s) => `<i>${esc(s)}</i>`).join("")}${m.errors.map((e) => `<u>${esc(e)}</u>`).join("")}</div>
      </article>`;
    })
    .join("");

  return `<h2 class="sec">Movers board <i>&mdash; ${movers.length} of ${scanned} screened names, filtered for price and turnover</i></h2>
    ${notes.length ? `<p class="note">${esc(notes.join(" "))}</p>` : ""}
    <div class="mvgrid">${rows}</div>`;
}

/* ------------------------------------------------------------------ *
 * Document
 * ------------------------------------------------------------------ */

export interface ReportInput {
  analyses: Analysis[];
  movers: Mover[];
  moversScanned: number;
  moversNotes: string[];
  failures: { symbol: string; reason: string }[];
  generatedAt: Date;
  lookbackDays: number;
  intradayDays: number;
  /** Overrides the page heading, used by the ad-hoc lookup. */
  title?: string;
}

export function renderReport(input: ReportInput): string {
  const { analyses, failures, generatedAt } = input;
  // Ranked by the day-trade grade, since that is what the list is scanned for
  // before the open; the watch score breaks ties.
  const ranked = [...analyses].sort(
    (a, b) => b.grade.total - a.grade.total || b.watchScore - a.watchScore,
  );
  const phase = marketPhase(generatedAt);

  const dateLine = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", year: "numeric",
  }).format(generatedAt);

  // The picker drives which single ticker's charts are on screen. Rendered as
  // links so it still navigates with scripting off, where every section shows.
  const nav = ranked
    .map(
      (a) => `<a href="#t-${esc(a.symbol)}" class="navchip ${a.changePct >= 0 ? "pos" : "neg"}" data-sym="${esc(a.symbol)}">
      <b>${esc(a.symbol)}</b><span>${signed(a.changePct, 2, "%")}</span><i class="${gradeTone(a.grade.letter)}">${esc(a.grade.letter)}</i></a>`,
    )
    .join("");

  const cards = ranked
    .map((a, i) => {
      const trig = a.patterns.find((p) => p.trigger != null);
      const nearestRes = a.levels.filter((l) => l.side === "resistance").sort((x, y) => x.price - y.price)[0];
      const nearestSup = a.levels.filter((l) => l.side === "support").sort((x, y) => y.price - x.price)[0];
      const biasTone = a.grade.bias === "long-side" ? "pos" : a.grade.bias === "short-side" ? "neg" : "dim";
      const s = a.session;
      const lead = !s
        ? a.headline
        : s.pressure === "balanced"
          ? "Prior session closed with neither side in control."
          : `${s.shapeSummary ? `${s.shapeSummary}. ` : ""}${s.pressure === "buyers" ? "Buyers" : "Sellers"} ${s.strength > 0.55 ? "firmly ahead" : "ahead"} into the close` +
            `${s.volRatio != null && s.volRatio >= 1.25 ? ` on ${s.volRatio.toFixed(1)}x volume` : ""}` +
            `${s.closedAbovePriorHigh ? ", above the prior high" : s.closedBelowPriorLow ? ", below the prior low" : ""}.`;
      return `<a class="card" href="#t-${esc(a.symbol)}">
        <div class="cardtop">
          <span class="rank">${i + 1}</span>
          <b>${esc(a.symbol)}</b>
          <span class="mono ${a.changePct >= 0 ? "pos" : "neg"}">${signed(a.changePct, 2, "%")}</span>
          <span class="cardgrade ${gradeTone(a.grade.letter)}">${esc(a.grade.letter)}</span>
        </div>
        <div class="cardbias ${biasTone}">${esc(a.grade.bias.replace("-", " "))}</div>
        <p>${esc(lead)}</p>
        <div class="cardlv">
          <span class="res">R <b class="mono">${nearestRes ? num(nearestRes.price) : "&mdash;"}</b></span>
          <span class="px">${num(a.price)}</span>
          <span class="sup">S <b class="mono">${nearestSup ? num(nearestSup.price) : "&mdash;"}</b></span>
        </div>
        ${trig ? `<div class="cardtrig">${esc(trig.name)} &middot; trigger <b class="mono">${num(trig.trigger)}</b></div>` : ""}
      </a>`;
    })
    .join("");

  const failBlock = failures.length
    ? `<div class="failures"><b>${failures.length} symbol${failures.length > 1 ? "s" : ""} could not be analyzed:</b> ${failures.map((f) => `${esc(f.symbol)} <span>(${esc(f.reason)})</span>`).join(", ")}</div>`
    : "";

  const sections = ranked.map((a) => tickerSection(a, input.lookbackDays, input.intradayDays)).join("");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>${esc(input.title ?? "Market Prep")} &middot; ${esc(dateLine)}</title>
<style>
:root{
  --bg:#0a0e17; --panel:#111725; --panel2:#0f1420; --line:#1e2637; --line2:#2a3448;
  --text:#e6eaf2; --dim:#8b95a8; --dim2:#6b7488;
  --up:#26a69a; --down:#ef5350; --gold:#e6b422; --accent:#3f7fff;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 var(--sans);padding-bottom:60px}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.pos{color:var(--up)} .neg{color:var(--down)} .strong{font-weight:650}
.wrap{max-width:1120px;margin:0 auto;padding:0 16px}
a{color:inherit;text-decoration:none}

header.top{border-bottom:1px solid var(--line);background:linear-gradient(180deg,#0d1220,#0a0e17);padding:22px 0 0}
.brand{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.brand h1{margin:0;font-size:19px;letter-spacing:-.2px;font-weight:680}
.brand .date{color:var(--dim);font-size:13px}
.phase{margin-left:auto;font-size:11.5px;padding:3px 9px;border-radius:999px;border:1px solid var(--line2);color:var(--dim);text-transform:uppercase;letter-spacing:.6px}
.phase.open{color:var(--up);border-color:rgba(38,166,154,.45);background:rgba(38,166,154,.1)}
.phase.pre{color:var(--gold);border-color:rgba(230,180,34,.4);background:rgba(230,180,34,.09)}
.gen{color:var(--dim2);font-size:12px;margin:6px 0 0}
.navrow{display:flex;gap:6px;overflow-x:auto;padding:14px 0 12px;scrollbar-width:thin}
.navchip{flex:0 0 auto;border:1px solid var(--line2);border-radius:7px;padding:5px 9px;display:flex;gap:7px;align-items:baseline;background:var(--panel2);font-size:12px}
.navchip b{font-size:12.5px;letter-spacing:.2px}
.navchip span{font-family:var(--mono);font-size:11px}
.navchip:hover{border-color:var(--accent)}
.navchip i{font-style:normal;font-family:var(--mono);font-size:10px;font-weight:750;padding:0 4px;border-radius:3px;border:1px solid var(--line2)}
.navchip i.ga{color:var(--up);border-color:rgba(38,166,154,.5)}
.navchip i.gb{color:#6f9dff;border-color:rgba(63,127,255,.45)}
.navchip i.gc{color:var(--gold);border-color:rgba(230,180,34,.4)}
.navchip i.gd{color:var(--dim2)}
.navchip.on{border-color:var(--accent);background:rgba(63,127,255,.14)}
.navchip.on b{color:var(--text)}

.detailbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.detailbar h2.sec{margin-bottom:12px}
.dnav{display:flex;align-items:center;gap:8px;margin-left:auto;margin-bottom:8px}
.dnav button{font:600 13px/1 var(--mono);color:var(--dim);background:var(--panel);border:1px solid var(--line2);border-radius:6px;padding:5px 10px;cursor:pointer}
.dnav button:hover{color:var(--text);border-color:var(--accent)}
#symLabel{font:650 13px/1 var(--sans);min-width:64px;text-align:center}
.showall{display:flex;align-items:center;gap:5px;font-size:11.5px;color:var(--dim2);cursor:pointer;margin-left:6px}
.showall input{accent-color:var(--accent);cursor:pointer}
/* Without scripting every section stays visible; the class is added by JS. */
.detailhost.single>section.ticker{display:none}
.detailhost.single>section.ticker.active{display:block}

h2.sec{font-size:12px;text-transform:uppercase;letter-spacing:1.2px;color:var(--dim2);margin:30px 0 12px;font-weight:600}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(255px,1fr));gap:10px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px;display:block;transition:border-color .12s}
.card:hover{border-color:var(--accent)}
.cardtop{display:flex;align-items:center;gap:8px}
.cardtop b{font-size:15px;letter-spacing:.2px}
.rank{width:19px;height:19px;border-radius:5px;background:var(--line);color:var(--dim);font-size:11px;display:grid;place-items:center;font-family:var(--mono)}
.cardgrade{margin-left:auto;font-family:var(--mono);font-size:12px;border-radius:4px;padding:1px 7px;font-weight:750;border:1px solid var(--line2)}
.cardgrade.ga{color:var(--up);border-color:rgba(38,166,154,.5);background:rgba(38,166,154,.12)}
.cardgrade.gb{color:#6f9dff;border-color:rgba(63,127,255,.45);background:rgba(63,127,255,.1)}
.cardgrade.gc{color:var(--gold);border-color:rgba(230,180,34,.4);background:rgba(230,180,34,.09)}
.cardgrade.gd{color:var(--dim)}
.cardbias{margin-top:7px;font-size:10px;text-transform:uppercase;letter-spacing:.9px;font-weight:650}
.cardbias.pos{color:var(--up)} .cardbias.neg{color:var(--down)} .cardbias.dim{color:var(--dim2)}
.card p{margin:5px 0 10px;font-size:12.5px;color:var(--dim);line-height:1.45;min-height:34px}
.cardlv{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dim2);border-top:1px solid var(--line);padding-top:8px}
.cardlv .res{color:var(--down)} .cardlv .sup{color:var(--up)}
.cardlv .px{margin-left:auto;font-family:var(--mono);color:var(--text);font-weight:650}
.cardtrig{margin-top:7px;font-size:11px;color:var(--gold)}

.failures{margin:16px 0;padding:10px 12px;border:1px solid rgba(239,83,80,.35);background:rgba(239,83,80,.07);border-radius:8px;font-size:12.5px}
.failures span{color:var(--dim2)}

section.ticker{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px;margin:14px 0;scroll-margin-top:12px}
.thead{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.tid{display:flex;align-items:baseline;gap:9px;min-width:0}
.tid h2{margin:0;font-size:20px;letter-spacing:-.3px}
.tname{color:var(--dim2);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:34ch}
.tprice{margin-left:auto;display:flex;align-items:baseline;gap:9px}
.tprice b{font-size:18px}
.headline{margin:9px 0 13px;font-size:13px;color:var(--text);opacity:.86;line-height:1.5}

.gradebadge{display:flex;align-items:baseline;gap:6px;border-radius:8px;padding:4px 10px;border:1px solid var(--line2);background:var(--panel2)}
.gradebadge b{font-size:19px;font-weight:750;letter-spacing:-.5px}
.gradebadge span{font-family:var(--mono);font-size:11px;color:var(--dim2)}
.gradebadge i{font-style:normal;opacity:.6}
.gradebadge.ga{border-color:rgba(38,166,154,.55);background:rgba(38,166,154,.12)} .gradebadge.ga b{color:var(--up)}
.gradebadge.gb{border-color:rgba(63,127,255,.5);background:rgba(63,127,255,.1)} .gradebadge.gb b{color:#6f9dff}
.gradebadge.gc{border-color:rgba(230,180,34,.45);background:rgba(230,180,34,.1)} .gradebadge.gc b{color:var(--gold)}
.gradebadge.gd{border-color:var(--line2)} .gradebadge.gd b{color:var(--dim)}

.plan{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:9px;overflow:hidden;margin:12px 0 0}
.pcell{background:var(--panel2);padding:9px 11px;display:flex;flex-direction:column;gap:2px}
.pcell span{font-size:9.5px;text-transform:uppercase;letter-spacing:.75px;color:var(--dim2)}
.pcell b{font-size:15px;font-weight:660;text-transform:capitalize}
.pcell b.setupname{font-family:var(--sans);font-size:13px;text-transform:none;line-height:1.3}
.pcell b.dim{color:var(--dim)}
.pcell i{font-style:normal;font-size:10.5px;color:var(--dim2);font-family:var(--mono)}
.biaswhy{margin:9px 0 13px;font-size:12.5px;color:var(--dim);line-height:1.55}

.sess{display:flex;gap:13px;align-items:stretch;border:1px solid var(--line);border-left-width:2px;border-radius:9px;padding:11px 13px;margin-bottom:13px;background:var(--panel2)}
.sess.bull{border-left-color:var(--up)} .sess.bear{border-left-color:var(--down)} .sess.neu{border-left-color:var(--dim2)}
.candle{flex:0 0 16px;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:62px}
.candle i{display:block;width:2px;background:currentColor}
.candle i.bd{width:12px;border-radius:1px}
.candle.up{color:var(--up)} .candle.down{color:var(--down)}
.sesstext{min-width:0}
.sesshead{font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:var(--dim2);margin-bottom:4px}
.sess p{margin:0 0 7px;font-size:13px;line-height:1.55}
.sesschips{display:flex;flex-wrap:wrap;gap:6px}
.sesschips span{font-size:10.5px;color:var(--dim);background:var(--panel);border:1px solid var(--line);border-radius:5px;padding:2px 7px;font-family:var(--mono)}
.sesschips b{color:var(--text);font-weight:650}

.cshapes{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px}
.cshape{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:650;padding:3px 9px;border-radius:6px;
  border:1px solid var(--line2);background:var(--panel);color:var(--dim);cursor:help}
.cshape i{font-style:normal;font-size:9px;text-transform:uppercase;letter-spacing:.6px;opacity:.75;font-weight:600}
.cshape.bullish{color:var(--up);border-color:rgba(38,166,154,.5);background:rgba(38,166,154,.1)}
.cshape.bearish{color:var(--down);border-color:rgba(239,83,80,.45);background:rgba(239,83,80,.09)}
.cshape.neutral{color:var(--dim);border-color:var(--line2)}
.cshape.plain{color:var(--dim2);border-style:dashed;background:transparent;font-weight:600}
ul.cmeaning{list-style:none;margin:8px 0 0;padding:0;font-size:11.5px;color:var(--dim2);line-height:1.5}
ul.cmeaning li{margin-bottom:3px}
ul.cmeaning b{color:var(--dim)}

.keylv{margin-bottom:13px}
.keylv h3{margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:1.1px;color:var(--dim2);font-weight:620}
.keylv h3 i{font-style:normal;text-transform:none;letter-spacing:0;font-weight:400;font-size:11px;opacity:.75}
td.dimc{color:var(--dim2)}
td.whys{font-size:11.5px;color:var(--dim)}

details.blk{border:1px solid var(--line);border-radius:9px;background:var(--panel2);margin-bottom:11px;overflow:hidden}
details.blk>summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:9px;padding:10px 13px;user-select:none}
details.blk>summary::-webkit-details-marker{display:none}
details.blk>summary::before{content:"";width:0;height:0;border-left:5px solid var(--dim2);border-top:4px solid transparent;border-bottom:4px solid transparent;flex:0 0 auto;transition:transform .12s}
details.blk[open]>summary::before{transform:rotate(90deg)}
details.blk>summary:hover{background:rgba(255,255,255,.02)}
details.blk>summary:hover .blktitle{color:var(--text)}
.blktitle{font-size:11px;text-transform:uppercase;letter-spacing:1.1px;color:var(--dim2);font-weight:640}
.blknote{font-size:11px;color:var(--dim2);opacity:.8;margin-left:auto;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:52%}
.blkbody{padding:0 13px 13px}
details.blk[open]>summary{border-bottom:1px solid var(--line)}
details.blk[open]>summary{margin-bottom:12px}
.blkbody>.sess:last-child,.blkbody>.keylv:last-child{margin-bottom:0}
.collapsebtn{font:600 11.5px/1 var(--sans);color:var(--dim);background:var(--panel);border:1px solid var(--line2);border-radius:6px;padding:6px 11px;cursor:pointer;margin-left:6px}
.collapsebtn:hover{color:var(--text);border-color:var(--accent)}

details.more{border-top:1px solid var(--line);margin-top:4px}
details.more>summary{cursor:pointer;list-style:none;padding:10px 0 2px;font-size:11.5px;color:var(--dim2);display:flex;align-items:center;gap:7px}
details.more>summary::-webkit-details-marker{display:none}
details.more>summary::before{content:"+";font-family:var(--mono);font-size:13px;width:16px;height:16px;border:1px solid var(--line2);border-radius:4px;display:inline-grid;place-items:center;flex:0 0 auto}
details.more[open]>summary::before{content:"\\2212"}
details.more>summary:hover{color:var(--text)}
details.more[open]>summary{margin-bottom:10px}

.gcomp{margin-bottom:10px}
.gclabel{display:flex;justify-content:space-between;align-items:baseline;font-size:11.5px}
.gclabel b{font-size:11px;color:var(--dim)}
.gcbar{height:4px;background:var(--line);border-radius:2px;overflow:hidden;margin:4px 0 3px}
.gcbar i{display:block;height:100%;background:var(--accent)}
.gcdetail{font-size:10.5px;color:var(--dim2)}

.cflags{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 11px}
.cflag{font-size:10.5px;padding:3px 8px;border-radius:5px;border:1px solid var(--line2);color:var(--dim);background:var(--panel2);cursor:help}
.cflag.warn{color:var(--gold);border-color:rgba(230,180,34,.45);background:rgba(230,180,34,.09)}

h4.newshead{margin:14px 0 8px;font-size:10px;text-transform:uppercase;letter-spacing:.9px;color:var(--dim2);font-weight:620}
ul.news{list-style:none;margin:0;padding:0}
ul.news li{border-left:2px solid var(--line);padding:2px 0 2px 9px;margin-bottom:9px}
ul.news li.fresh{border-left-color:var(--accent)}
.nmeta{font-size:10px;color:var(--dim2);text-transform:uppercase;letter-spacing:.5px}
.ntitle{display:block;font-size:12.5px;line-height:1.45;margin-top:2px}
a.ntitle:hover{color:var(--accent);text-decoration:underline}
.ntags{display:flex;flex-wrap:wrap;gap:5px;margin-top:4px}
.ntag{font-size:9.5px;padding:1px 6px;border-radius:4px;background:var(--line);color:var(--dim)}
.ntag.bullish{background:rgba(38,166,154,.16);color:var(--up)}
.ntag.bearish{background:rgba(239,83,80,.16);color:var(--down)}

h2.sec i{font-style:normal;text-transform:none;letter-spacing:0;font-weight:400;opacity:.8}
.mvgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:11px}
.mv{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px}
.mvtop{display:flex;align-items:baseline;gap:8px}
.mvsym{font-size:15px;letter-spacing:.2px}
.mvname{color:var(--dim2);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.mvlean{font-size:9.5px;text-transform:uppercase;letter-spacing:.8px;font-weight:650;flex:0 0 auto}
.mvlean.pos{color:var(--up)} .mvlean.neg{color:var(--down)} .mvlean.dim{color:var(--dim2)}
.mvnums{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin:8px 0;font-size:12px}
.mvnums .dimc{color:var(--dim2);font-size:11px}
svg.spark{width:100px;height:26px;margin-left:auto;flex:0 0 auto}
.mvwhy{margin:0 0 6px;font-size:12px;color:var(--dim);line-height:1.5}
.mvsess{margin:0 0 8px;font-size:11.5px;color:var(--dim2);line-height:1.5}
.mvnews{font-size:11.5px;line-height:1.45;border-top:1px solid var(--line);padding-top:7px;color:var(--text)}
.mvnews.fresh{color:var(--text)}
.mvnews span{display:block;font-size:9.5px;text-transform:uppercase;letter-spacing:.5px;color:var(--dim2);margin-bottom:2px}
.mvsrc{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
.mvsrc i{font-style:normal;font-size:9.5px;color:var(--dim2);border:1px solid var(--line);border-radius:4px;padding:1px 6px}
.mvsrc u{text-decoration:none;font-size:9.5px;color:var(--gold)}
.warn{border:1px solid rgba(230,180,34,.35);background:rgba(230,180,34,.07);color:var(--gold);border-radius:7px;padding:8px 10px;font-size:12px;margin-bottom:11px}
.datanote{border-left:2px solid var(--line2);padding:2px 0 2px 9px;margin:0 0 12px;font-size:11.5px;color:var(--dim2);line-height:1.55}

.chartwrap{background:${C.bg};border:1px solid var(--line);border-radius:9px;overflow:hidden;margin-bottom:10px}
.chartlabel{font-size:10.5px;text-transform:uppercase;letter-spacing:.9px;color:var(--dim2);padding:8px 11px 0}
svg.chart{display:block;width:100%;height:auto}
.c-mob{display:none}
span.c-desk{display:inline}

.cz{overflow:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;background:${C.bg};width:100%}
.cz svg.chart{width:var(--z,100%);max-width:none;height:auto}
.cz.zoomed{cursor:grab}
.cz.grabbing{cursor:grabbing}
.cz::-webkit-scrollbar{height:8px;width:8px}
.cz::-webkit-scrollbar-thumb{background:var(--line2);border-radius:4px}
.cz::-webkit-scrollbar-track{background:transparent}
.czbar{display:flex;align-items:center;gap:6px;padding:6px 10px;border-top:1px solid var(--line);flex-wrap:wrap}
.czbar button{font:600 12px/1 var(--mono);color:var(--dim);background:var(--panel);border:1px solid var(--line2);border-radius:5px;padding:4px 9px;cursor:pointer;min-width:30px}
.czbar button:hover{color:var(--text);border-color:var(--accent)}
.czlvl{font:600 11px/1 var(--mono);color:var(--text);min-width:34px}
.czbar i{font-style:normal;font-size:10.5px;color:var(--dim2);margin-left:auto}
@media(max-width:720px){.czbar i{display:none}}
.legend{display:flex;flex-wrap:wrap;gap:12px;font-size:11px;color:var(--dim);margin:0 0 14px;padding:0 2px}
.legend span{display:flex;align-items:center;gap:5px}
.legend i{width:11px;height:2.5px;border-radius:2px;display:inline-block}

.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:9px;overflow:hidden;margin-bottom:14px}
.stat{background:var(--panel2);padding:8px 10px;display:flex;flex-direction:column;gap:2px}
.stat span{font-size:10px;text-transform:uppercase;letter-spacing:.7px;color:var(--dim2)}
.stat b{font-size:13px;font-weight:620}

.panels{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}
.panel{background:var(--panel2);border:1px solid var(--line);border-radius:9px;padding:12px}
.panel h3{margin:0 0 10px;font-size:11px;text-transform:uppercase;letter-spacing:1.1px;color:var(--dim2);font-weight:620}
.empty{color:var(--dim2);font-size:12.5px;margin:0}

.tablewrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{border-collapse:collapse;width:100%;font-size:12px}
th{text-align:left;color:var(--dim2);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.7px;padding:0 8px 7px 0;border-bottom:1px solid var(--line)}
td{padding:7px 8px 7px 0;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
table.levels tr.res td:first-child{box-shadow:inset 2px 0 0 var(--down);padding-left:9px}
table.levels tr.sup td:first-child{box-shadow:inset 2px 0 0 var(--up);padding-left:9px}
table.levels tr.at td:first-child{box-shadow:inset 2px 0 0 var(--gold);padding-left:9px}
td .sub{display:block;font-size:10px;color:var(--dim2)}
.conf{display:inline-flex;align-items:center;justify-content:center;width:26px;height:20px;border-radius:4px;background:linear-gradient(90deg,var(--accent) var(--w),var(--line) var(--w));font-family:var(--mono);font-size:11px;font-weight:700}

th.confh{min-width:86px}
.confbox{display:inline-flex;flex-direction:column;align-items:center;gap:3px;padding:4px 8px;border-radius:7px;border:1px solid var(--line2);background:var(--panel);min-width:52px;cursor:help}
.confbox b{font-family:var(--mono);font-size:19px;font-weight:750;line-height:1}
.confdots{display:flex;gap:2px}
.confdots i{width:5px;height:5px;border-radius:50%;background:var(--line2);display:block}
.confbox.c1 b{color:var(--dim)} .confbox.c1 .confdots i.on{background:var(--dim)}
.confbox.c2{border-color:rgba(63,127,255,.35)} .confbox.c2 b{color:#6f9dff} .confbox.c2 .confdots i.on{background:#6f9dff}
.confbox.c3{border-color:rgba(63,127,255,.55);background:rgba(63,127,255,.08)} .confbox.c3 b{color:#7fb0ff} .confbox.c3 .confdots i.on{background:#7fb0ff}
.confbox.c4{border-color:rgba(230,180,34,.55);background:rgba(230,180,34,.09)} .confbox.c4 b{color:var(--gold)} .confbox.c4 .confdots i.on{background:var(--gold)}
.confbox.c5{border-color:rgba(38,166,154,.6);background:rgba(38,166,154,.12)} .confbox.c5 b{color:var(--up)} .confbox.c5 .confdots i.on{background:var(--up)}
.conflegend{margin:9px 0 0;font-size:11.5px;color:var(--dim2);line-height:1.55}
.conflegend b{color:var(--dim)}

.views{display:flex;gap:8px;padding:14px 0 0}
.viewbtn{display:flex;align-items:center;gap:7px;background:var(--panel2);border:1px solid var(--line2);border-radius:8px;
  color:var(--dim);font:650 13px/1 var(--sans);padding:9px 14px;cursor:pointer}
.viewbtn:hover{color:var(--text);border-color:var(--accent)}
.viewbtn.on{color:var(--text);border-color:var(--accent);background:rgba(63,127,255,.14)}
.viewbtn i{font-style:normal;font-family:var(--mono);font-size:11px;font-weight:700;color:var(--bg);background:var(--dim);border-radius:4px;padding:1px 6px}
.viewbtn.on i{background:var(--accent);color:#fff}

.panel.wide{grid-column:1/-1}
.ivnote{margin:0 0 11px;font-size:12.5px;color:var(--dim);line-height:1.55}
.ivnote b{color:var(--text)}
.optgroup{margin-bottom:14px}
.opthead{display:flex;align-items:baseline;gap:8px;margin-bottom:6px;font-size:12.5px}
.opthead span{color:var(--dim2);font-size:11px;font-family:var(--mono)}
table.opts td{padding:7px 10px 7px 0;font-size:12px}
table.opts tr.call td:first-child{box-shadow:inset 2px 0 0 var(--up);padding-left:9px}
table.opts tr.put td:first-child{box-shadow:inset 2px 0 0 var(--down);padding-left:9px}
.fit-good{color:var(--up)} .fit-fair{color:var(--gold)} .fit-poor{color:var(--down)}
.liq{font-size:10px;text-transform:uppercase;letter-spacing:.6px;padding:2px 7px;border-radius:4px;font-weight:650}
.liq.good{background:rgba(38,166,154,.16);color:var(--up)}
.liq.fair{background:rgba(230,180,34,.16);color:var(--gold)}
.liq.thin{background:rgba(239,83,80,.16);color:var(--down)}
.why .methods{display:block;color:var(--text);font-size:11.5px}
.why .labels{display:block;color:var(--dim2);font-size:10.5px;margin-top:2px}

.pat{border-left:2px solid var(--dim2);padding:2px 0 2px 10px;margin-bottom:12px}
.pat.bull{border-color:var(--up)} .pat.bear{border-color:var(--down)} .pat.neu{border-color:var(--dim2)}
.pathead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.patname{font-weight:640;font-size:13px}
.badge{font-size:9.5px;text-transform:uppercase;letter-spacing:.7px;padding:2px 6px;border-radius:4px;background:var(--line);color:var(--dim)}
.badge.triggered{background:rgba(230,180,34,.16);color:var(--gold)}
.confbar{flex:1;min-width:44px;height:3px;background:var(--line);border-radius:2px;overflow:hidden;max-width:90px}
.confbar i{display:block;height:100%;background:var(--accent)}
.pat p{margin:5px 0 6px;font-size:12px;color:var(--dim);line-height:1.5}
.trig{display:flex;gap:14px;font-size:11px;color:var(--dim2);flex-wrap:wrap}
.trig b{color:var(--text)}

.fibset{margin-bottom:14px}
.fibhead{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;margin-bottom:7px;font-size:12px}
.fibhead span{color:var(--dim2);font-size:11px;font-family:var(--mono)}
.fibcols{display:grid;grid-template-columns:1fr 1fr;gap:12px}
table.mini th{font-size:9.5px}
table.mini td{padding:4px 6px 4px 0;font-size:11.5px}
table.mini tr.gp td{background:rgba(230,180,34,.1)}
.gpnote{margin-top:6px;font-size:11px;color:var(--gold);font-family:var(--mono)}

.idgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:8px;overflow:hidden}
.idcell{background:var(--panel);padding:7px 9px;display:flex;flex-direction:column;gap:2px}
.idcell span{font-size:9.5px;text-transform:uppercase;letter-spacing:.6px;color:var(--dim2)}
.idcell b{font-size:12.5px}
.idcell.hot b{color:var(--gold)} .idcell.pos b{color:var(--up)} .idcell.neg b{color:var(--down)}
.idcell.pending{opacity:.55}
.note{font-size:11px;color:var(--dim2);margin:8px 0 0;line-height:1.5}

.totop{display:inline-block;margin-top:14px;font-size:11px;color:var(--dim2);border:1px solid var(--line);border-radius:6px;padding:4px 9px}
.totop:hover{border-color:var(--accent);color:var(--text)}

footer{border-top:1px solid var(--line);margin-top:34px;padding:18px 0 0;color:var(--dim2);font-size:11.5px;line-height:1.6}

@media(max-width:720px){
  .wrap{padding:0 11px}
  section.ticker{padding:12px;border-radius:10px}
  .panels{grid-template-columns:1fr}
  .fibcols{grid-template-columns:1fr}
  .tid h2{font-size:18px}
  .tname{display:none}
  .stats{grid-template-columns:repeat(auto-fill,minmax(96px,1fr))}
  .c-desk{display:none}
  .c-mob{display:block}
  /* Matches the specificity of the base span.c-desk rule, which would
     otherwise keep the desktop span visible and print both values. */
  span.c-desk{display:none}
  span.c-mob{display:inline}
}
@media print{
  body{background:#fff}
  .navrow,.totop{display:none}
}
</style>
</head><body><a id="top"></a>
<header class="top"><div class="wrap">
  <div class="brand">
    <h1>${esc(input.title ?? "Market Prep")}</h1>
    <span class="date">${esc(dateLine)}</span>
    <span class="phase ${phase.tone}">${phase.label}</span>
  </div>
  <p class="gen">Generated ${esc(etTime(generatedAt.getTime()))} ET &middot; ${analyses.length} symbol${analyses.length === 1 ? "" : "s"} analyzed &middot; measured from Yahoo Finance OHLCV</p>
  <div class="views">
    <button type="button" class="viewbtn on" data-view="watchlist">Watchlist <i>${ranked.length}</i></button>
    <button type="button" class="viewbtn" data-view="movers">Movers board <i>${input.movers.length}</i></button>
  </div>
  <nav class="navrow" id="tickerNav">${nav}</nav>
</div></header>

<main class="wrap">
  ${failBlock}
  <div id="viewWatchlist">
  ${blk("board", "Watchlist board", "ranked by day-trade setup grade", `<div class="cards">${cards}</div>`)}
  <div class="detailbar">
    <h2 class="sec">Charts &amp; detail</h2>
    <div class="dnav">
      <button type="button" id="prevSym" aria-label="previous symbol">&larr;</button>
      <span id="symLabel"></span>
      <button type="button" id="nextSym" aria-label="next symbol">&rarr;</button>
      <label class="showall"><input type="checkbox" id="showAll"> show all</label>
      <button type="button" id="collapseAll" class="collapsebtn">Collapse all</button>
    </div>
  </div>
  <div class="detailhost" id="detailhost">${sections}</div>
  </div>
  <div id="viewMovers" hidden>
  ${moversSection(input.movers, input.moversScanned, input.moversNotes)}
  </div>
</main>

<footer class="wrap">
  <p><b>How the ranking works.</b> Each symbol scores on how close price sits to a high-confluence level, whether a pattern is triggered or forming, how compressed volatility is, relative volume, and any premarket gap. Confluence counts <i>distinct methods</i> that agree at a price, so a level backed by a Fibonacci retracement, a moving average, the volume POC and a prior swing outranks four old swings at the same price.</p>
  <p>Every number here is computed from real OHLCV bars. Where a level or pattern could not be measured, the report says so rather than substituting an estimate.</p>
  <p>Technical analysis output for your own research. Not investment advice, and not a recommendation to buy or sell anything.</p>
</footer>
<script>
/* Collapsible blocks. State is stored per block kind, so collapsing "Charts"
   once collapses it on every ticker and the choice survives a reload. */
(function () {
  var KEY = "mpBlocks";
  var state = {};
  try { state = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch (e) { state = {}; }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }

  function all() { return [].slice.call(document.querySelectorAll("details.blk")); }

  function apply() {
    all().forEach(function (d) {
      var k = d.getAttribute("data-blk");
      if (k && Object.prototype.hasOwnProperty.call(state, k)) d.open = !!state[k];
    });
  }

  document.addEventListener("toggle", function (e) {
    var d = e.target;
    if (!d || !d.classList || !d.classList.contains("blk")) return;
    var k = d.getAttribute("data-blk");
    if (!k) return;
    state[k] = d.open;
    save();
    // Every block of the same kind moves together.
    all().forEach(function (o) { if (o !== d && o.getAttribute("data-blk") === k) o.open = d.open; });
    syncButton();
  }, true);

  var btn = document.getElementById("collapseAll");
  function syncButton() {
    if (!btn) return;
    var anyOpen = all().some(function (d) { return d.open; });
    btn.textContent = anyOpen ? "Collapse all" : "Expand all";
  }
  if (btn) {
    btn.addEventListener("click", function () {
      var anyOpen = all().some(function (d) { return d.open; });
      all().forEach(function (d) {
        d.open = !anyOpen;
        var k = d.getAttribute("data-blk");
        if (k) state[k] = !anyOpen;
      });
      save();
      syncButton();
    });
  }

  apply();
  syncButton();
})();

/* Top-level view switch: the watchlist, or the movers board. Both are in the
   document, so switching is instant and works offline. */
(function () {
  var buttons = [].slice.call(document.querySelectorAll(".viewbtn"));
  var panes = { watchlist: document.getElementById("viewWatchlist"), movers: document.getElementById("viewMovers") };
  var tickerNav = document.getElementById("tickerNav");
  if (buttons.length === 0 || !panes.watchlist || !panes.movers) return;

  function show(name) {
    Object.keys(panes).forEach(function (k) { panes[k].hidden = k !== name; });
    buttons.forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-view") === name); });
    // The ticker picker belongs to the watchlist only.
    if (tickerNav) tickerNav.style.display = name === "watchlist" ? "" : "none";
    try { sessionStorage.setItem("mpView", name); } catch (e) {}
  }

  buttons.forEach(function (b) {
    b.addEventListener("click", function () { show(b.getAttribute("data-view")); window.scrollTo({ top: 0, behavior: "smooth" }); });
  });

  var saved = null;
  try { saved = sessionStorage.getItem("mpView"); } catch (e) {}
  // A #t- link always means a watchlist ticker, so it wins over the saved view.
  show(/^#t-/.test(location.hash) ? "watchlist" : saved === "movers" ? "movers" : "watchlist");
})();

/* Single-symbol chart view. One ticker's charts are on screen at a time,
   chosen from the picker, the board cards, or the arrows. With scripting off
   the "single" class is never added and every section renders as a long page,
   which is the correct fallback rather than a blank one. */
(function () {
  var host = document.getElementById("detailhost");
  if (!host) return;
  var sections = [].slice.call(host.querySelectorAll("section.ticker"));
  if (sections.length === 0) return;
  var syms = sections.map(function (s) { return s.id.replace(/^t-/, ""); });
  var chips = [].slice.call(document.querySelectorAll(".navchip"));
  var label = document.getElementById("symLabel");
  var showAll = document.getElementById("showAll");
  var current = 0;

  host.classList.add("single");

  function render(scroll) {
    sections.forEach(function (s, i) { s.classList.toggle("active", i === current); });
    chips.forEach(function (c) { c.classList.toggle("on", c.getAttribute("data-sym") === syms[current]); });
    if (label) label.textContent = syms[current];
    var chip = chips.filter(function (c) { return c.getAttribute("data-sym") === syms[current]; })[0];
    if (chip && chip.scrollIntoView) chip.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (scroll) {
      var top = host.getBoundingClientRect().top + window.scrollY - 12;
      window.scrollTo({ top: top, behavior: "smooth" });
    }
  }

  function select(sym, scroll) {
    var i = syms.indexOf(sym);
    if (i < 0) return false;
    current = i;
    render(scroll);
    return true;
  }

  chips.forEach(function (c) {
    c.addEventListener("click", function (e) {
      if (showAll && showAll.checked) return;
      e.preventDefault();
      if (select(c.getAttribute("data-sym"), true)) {
        history.replaceState(null, "", "#t-" + syms[current]);
      }
    });
  });

  // Board cards are plain anchors, so the hash change picks them up.
  window.addEventListener("hashchange", function () {
    var m = /^#t-(.+)$/.exec(location.hash);
    if (m) select(decodeURIComponent(m[1]), true);
  });

  var prev = document.getElementById("prevSym");
  var next = document.getElementById("nextSym");
  if (prev) prev.addEventListener("click", function () { current = (current - 1 + syms.length) % syms.length; render(false); history.replaceState(null, "", "#t-" + syms[current]); });
  if (next) next.addEventListener("click", function () { current = (current + 1) % syms.length; render(false); history.replaceState(null, "", "#t-" + syms[current]); });

  if (showAll) {
    showAll.addEventListener("change", function () {
      host.classList.toggle("single", !showAll.checked);
      if (!showAll.checked) render(false);
    });
  }

  // Arrow keys move between symbols, unless focus is in a field.
  document.addEventListener("keydown", function (e) {
    if (showAll && showAll.checked) return;
    var t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.key === "ArrowLeft" && prev) { prev.click(); e.preventDefault(); }
    else if (e.key === "ArrowRight" && next) { next.click(); e.preventDefault(); }
  });

  var m = /^#t-(.+)$/.exec(location.hash);
  if (!(m && select(decodeURIComponent(m[1]), false))) render(false);
})();

/* Chart pan and zoom. Everything below is progressive enhancement: with
   scripting off the charts still render, just fixed at 1x. */
(function () {
  var MIN = 1, MAX = 8;
  document.querySelectorAll(".czbar").forEach(function (bar) {
    var cz = bar.previousElementSibling;
    if (!cz || !cz.classList.contains("cz")) return;
    var lvl = bar.querySelector(".czlvl");
    var z = 1;

    function apply() {
      cz.style.setProperty("--z", (z * 100).toFixed(2) + "%");
      lvl.textContent = z.toFixed(1) + "\\u00d7";
      cz.classList.toggle("zoomed", z > 1.001);
    }

    /* Zoom about a point, keeping whatever sits under it in place. */
    function setZ(next, ax, ay) {
      next = Math.max(MIN, Math.min(MAX, next));
      if (Math.abs(next - z) < 0.001) return;
      var r = cz.getBoundingClientRect();
      if (!r.width) { z = next; apply(); return; }
      var cx = ax == null ? r.width / 2 : ax;
      var cy = ay == null ? r.height / 2 : ay;
      var fx = (cz.scrollLeft + cx) / (r.width * z);
      var fy = (cz.scrollTop + cy) / (r.height * z);
      z = next;
      apply();
      cz.scrollLeft = fx * r.width * z - cx;
      cz.scrollTop = fy * r.height * z - cy;
    }

    bar.addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (!b) return;
      var d = b.getAttribute("data-z");
      if (d === "+") setZ(z * 1.5);
      else if (d === "-") setZ(z / 1.5);
      else { z = 1; apply(); cz.scrollTo(0, 0); }
    });

    /* Plain wheel keeps scrolling the page; only ctrl/cmd zooms, which is the
       same convention as every map and chart tool. */
    cz.addEventListener("wheel", function (e) {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      var r = cz.getBoundingClientRect();
      setZ(z * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    cz.addEventListener("dblclick", function (e) {
      var r = cz.getBoundingClientRect();
      setZ(z > 1.001 ? 1 : 2.5, e.clientX - r.left, e.clientY - r.top);
    });

    /* Mouse drag to pan. Touch is left to native scrolling, which already
       gives one-finger panning with momentum. */
    var drag = false, sx = 0, sy = 0, sl = 0, st = 0;
    cz.addEventListener("pointerdown", function (e) {
      if (z <= 1.001 || e.pointerType === "touch" || e.button !== 0) return;
      drag = true; sx = e.clientX; sy = e.clientY;
      sl = cz.scrollLeft; st = cz.scrollTop;
      cz.setPointerCapture(e.pointerId);
      cz.classList.add("grabbing");
      e.preventDefault();
    });
    cz.addEventListener("pointermove", function (e) {
      if (!drag) return;
      cz.scrollLeft = sl - (e.clientX - sx);
      cz.scrollTop = st - (e.clientY - sy);
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach(function (ev) {
      cz.addEventListener(ev, function () { drag = false; cz.classList.remove("grabbing"); });
    });

    apply();
  });
})();
</script>
</body></html>`;
}

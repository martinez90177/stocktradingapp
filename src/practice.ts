import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadForEmbed } from "./replay.ts";
import { FONT_CSS } from "./fonts.ts";
import type { VolEmbed, Calibration, Events } from "./volindex.ts";
import type { RuleBook } from "./types.ts";

/**
 * Real volatility for the option prices: index levels per replayed day, and
 * the per-ticker calibrations. `rulebook` is Alex's Rules from rules.json,
 * shown in the Rules tab beside the numbers the simulator enforces.
 */
export interface PracticeVol { embed: VolEmbed; calibrations: Calibration[]; events?: Events; rulebook?: RuleBook | null }
import type { ReplaySession, ExtBar } from "./replay.ts";

/**
 * The practice terminal, re-skinned to match the report.
 *
 * The app's own markup, stylesheet and script are kept verbatim. The build
 * adds the report's fonts and a masthead, fills three markers in the markup
 * (the masthead, the link back to the report, the data note for a phone),
 * and embeds the recorded days.
 *
 * The candles are recorded and the option quotes are modelled, and the page
 * says so: behind a chip in the masthead on a desktop, at the top of the
 * Session pane on a phone.
 */

const SKIN = `
${FONT_CSS}
/* ---- masthead: one slim row above the terminal, desktop only ------- */
.mp-head{display:flex;align-items:center;gap:14px;height:46px;padding:0 14px;border-bottom:1px solid var(--line);
  background:var(--panel);flex:0 0 auto;position:relative;z-index:30}
.mp-brand{display:flex;align-items:baseline;gap:10px;min-width:0}
.mp-brand b{font-size:15px;letter-spacing:-.3px;white-space:nowrap}
.mp-brand span{color:var(--dim);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sim{position:relative;margin-left:auto;min-width:0}
.sim summary{list-style:none;cursor:pointer;font-size:12px;font-weight:600;color:var(--fib);white-space:nowrap;padding:6px 11px;
  border:1px solid rgba(245,165,36,.4);background:rgba(245,165,36,.08);border-radius:8px}
.sim.real summary{color:var(--up);border-color:rgba(45,212,167,.38);background:rgba(45,212,167,.07)}
.sim summary::-webkit-details-marker{display:none}
.sim summary i{font-style:normal;color:var(--dim);font-weight:500;margin-left:6px}
.sim>div{position:absolute;right:0;top:calc(100% + 8px);width:min(540px,calc(100vw - 28px));background:var(--panel);
  border:1px solid var(--line2);border-radius:10px;padding:12px 14px;font-size:12.5px;line-height:1.55;color:var(--dim);
  box-shadow:0 18px 50px rgba(0,0,0,.6)}
.sim>div b{display:block;color:var(--text);margin-bottom:4px} .sim>div strong{color:var(--text)}
.mp-guide{display:inline-flex;align-items:center;border:1px solid var(--acc);border-radius:8px;padding:0 12px;min-height:32px;
  background:var(--accs);color:var(--text);font-weight:650;font-size:12.5px;white-space:nowrap}
.mp-back{display:inline-flex;align-items:center;gap:6px;text-decoration:none;border:1px solid var(--line2);border-radius:8px;
  padding:0 12px;min-height:32px;color:var(--dim);font-weight:650;font-size:12.5px;white-space:nowrap}
.mp-back:hover{color:var(--text);border-color:var(--acc);background:var(--accs)}
/* On a phone the masthead is gone: the report link and the data note sit in
   the Session pane instead, and the guide opens from the ? beside them. */
.simx{display:none}
@media(max-width:899px){
  .mp-head{display:none}
  .side[data-tab=setup] .simx{display:block}
}
@media(min-width:900px){a.sbtn.mp-back2{display:none}}
@media(max-width:1180px){.mp-brand span{display:none}}
`;

/**
 * The banner says which kind of data is actually loaded, because the answer
 * changes: with recorded sessions embedded the candles are measured, and only
 * the option quotes are modelled. Claiming "simulated" over real bars would be
 * as wrong as the reverse.
 */
function dataNote(sessions: ReplaySession[], vol?: PracticeVol): { title: string; sub: string; body: string; real: boolean } {
  const symbols = [...new Set(sessions.map((s) => s.symbol))];
  const dates = sessions.map((s) => s.date).sort();
  if (!sessions.length) {
    return {
      real: false,
      title: "Generated prices",
      sub: "no recorded days",
      body: `No recorded sessions are embedded yet, so this falls back to a seeded random walk.
       Run the tool once with a network connection to record real sessions; the library grows by a day per symbol per run.`,
    };
  }
  return {
    real: true,
    title: "Real candles, modelled options",
    sub: `${sessions.length} ${sessions.length === 1 ? "day" : "days"} &middot; ${symbols.length} ${symbols.length === 1 ? "symbol" : "symbols"}`,
    body: `Every candle is a measured 1-minute bar from an actual session, with the pre-market and after-hours in 5-minute bars &mdash;
       ${sessions.length} recorded ${sessions.length === 1 ? "day" : "days"} across
       ${symbols.length} ${symbols.length === 1 ? "symbol" : "symbols"}
       (${esc(symbols.slice(0, 8).join(", "))}), ${esc(dates[0])} to ${esc(dates[dates.length - 1])}
       to pick from, and <strong>Surprise me</strong> draws from the whole library beside the page &mdash; every day ever recorded, one you have not had before first.
       Option prices are modelled rather than quoted, but not guessed: the volatility in them is
       the market&rsquo;s own &mdash; that day&rsquo;s VXN or VIX, minute by minute &mdash; scaled to each
       ticker by how its options really traded${vol && vol.calibrations.length ? ` (measured ${esc(vol.calibrations[vol.calibrations.length - 1].date)})` : ""}.
       You buy at the ask and sell at the bid, on realistic spreads.`,
  };
}

/**
 * The masthead: one row on a desktop, with the data note behind a chip, so
 * the terminal opens straight onto the chart. A phone gets no masthead at
 * all; the same note and the report link go into the Session pane.
 */
function bannerFor(reportHref: string, sessions: ReplaySession[], vol?: PracticeVol): string {
  const n = dataNote(sessions, vol);
  return `<header class="mp-head">
  <div class="mp-brand"><b>Practice</b><span>Real days replayed bar by bar, on your account, under your rules</span></div>
  <details class="sim ${n.real ? "real" : ""}"><summary>${n.title}<i>${n.sub}</i></summary><div><b>${n.title}</b>${n.body}</div></details>
  <button type="button" class="mp-guide" id="guideOpen">How to use this page</button>
  <a class="mp-back" href="${reportHref}">&larr; Report</a>
</header>`;
}

/** The phone's copy of the note, at the top of the Session pane. */
function noteFor(sessions: ReplaySession[], vol?: PracticeVol): string {
  const n = dataNote(sessions, vol);
  return `<details class="simx ${n.real ? "real" : "gen"}"><summary>${n.title}</summary><div>${n.body}</div></details>`;
}

const esc = (s: string) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Builds the practice page from the vendored app: its body and script are
 * carried over untouched, wrapped in the report's chrome and stylesheet.
 */
/**
 * The same bars in a little under half the bytes, and exactly the same
 * numbers: prices become whole cents measured from the previous close, which
 * is lossless for two-decimal prices, and volume is kept whole. Twelve days
 * of seven tickers would otherwise add about a megabyte to a page opened on
 * a phone.
 */
function compactSession(s: ReplaySession, hist = false) {
  const z: number[] = [];
  const cents = (n: number) => Math.round(n * 100);
  const base = cents(s.bars[0][0]);
  let pc = base;
  // A history-only day is carried at 5-minute bars: the daily and 4H views
  // behind a pickable day need the shape of the day, not every minute of it,
  // and this is a fifth of the bytes.
  const rows: ReplaySession["bars"] = hist
    ? Array.from({ length: s.bars.length / 5 }, (_, i) => {
        const g = s.bars.slice(i * 5, i * 5 + 5);
        return [g[0][0], Math.max(...g.map((b) => b[1])), Math.min(...g.map((b) => b[2])), g[g.length - 1][3], g.reduce((a, b) => a + b[4], 0)];
      })
    : s.bars;
  for (const [o, h, l, c, v] of rows) {
    const O = cents(o), C = cents(c);
    z.push(O - pc, cents(h) - O, O - cents(l), C - O, Math.round(v));
    pc = C;
  }
  if (hist) return { symbol: s.symbol, date: s.date, carried: s.carried, p: base, z, d: 5, hist: true };
  // Extended hours the same way, in sixes: the 5-minute slot, then the open
  // as cents from the previous close (the first one absolute), and the rest.
  const ext = (rows: ExtBar[]) => {
    const out: number[] = [];
    let prev: number | null = null;
    for (const [m, o, h, l, c, v] of rows) {
      const O = cents(o), C = cents(c);
      out.push(m / 5, prev == null ? O : O - prev, cents(h) - O, O - cents(l), C - O, Math.round(v));
      prev = C;
    }
    return out;
  };
  const x = s.ext ? { pre: ext(s.ext.pre), post: ext(s.ext.post) } : undefined;
  return { symbol: s.symbol, date: s.date, carried: s.carried, p: base, z, ...(x ? { x } : {}) };
}

/**
 * The whole recorded library, as one pack per ticker beside the page, plus an
 * index of what is there. The page embeds only the newest days, so it stays
 * one file that opens from disk; "Surprise me" fetches a random day from the
 * packs instead -- any day ever recorded, with a fortnight of history behind
 * it -- and falls back to the embedded days where a fetch cannot work. The
 * library grows by a day per ticker per run and nothing ages out of it, which
 * is what keeps the surprise a surprise.
 */
export async function writeSessionPacks(sessionsDir: string, outDir: string): Promise<{ symbols: number; days: number }> {
  const all = await loadForEmbed(sessionsDir, 100000);
  const by = new Map<string, ReplaySession[]>();
  for (const s of all) {
    if (!by.has(s.symbol)) by.set(s.symbol, []);
    by.get(s.symbol)!.push(s);
  }
  await mkdir(outDir, { recursive: true });
  const index: Record<string, string[]> = {};
  for (const [sym, list] of by) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    index[sym] = list.map((s) => s.date);
    await writeFile(join(outDir, `${sym}.json`), JSON.stringify(list.map((s) => compactSession(s))), "utf8");
  }
  await writeFile(join(outDir, "index.json"), JSON.stringify(index), "utf8");
  return { symbols: by.size, days: all.length };
}

export async function renderPractice(
  vendorPath: string,
  reportHref = "latest.html",
  sessions: ReplaySession[] = [],
  vol?: PracticeVol,
): Promise<string> {
  const src = await readFile(vendorPath, "utf8");

  // The newest `PICKABLE` days of each ticker can be traded; anything older
  // that is embedded is history only, so the oldest pickable day still has a
  // real fortnight behind it on the daily and 4H views. It used to embed the
  // twelve and nothing else, and the twelfth opened on three candles.
  const PICKABLE = 12;
  const rank = new Map<string, number>();
  for (const s of sessions.slice().sort((a, b) => (a.symbol === b.symbol ? b.date.localeCompare(a.date) : a.symbol.localeCompare(b.symbol)))) {
    const n = rank.get(s.symbol) ?? 0;
    rank.set(s.symbol, n + 1);
    (s as ReplaySession & { hist?: boolean }).hist = n >= PICKABLE;
  }
  const isHist = (s: ReplaySession) => !!(s as ReplaySession & { hist?: boolean }).hist;
  const pickable = sessions.filter((s) => !isHist(s));

  const bodyOpen = src.search(/<body[^>]*>/i);
  const bodyClose = src.lastIndexOf("</body>");
  if (bodyOpen === -1 || bodyClose === -1) {
    throw new Error(`practice app: no <body> found in ${vendorPath}`);
  }
  const body = src
    .slice(src.indexOf(">", bodyOpen) + 1, bodyClose)
    .replace("<!--MP:HEAD-->", bannerFor(reportHref, pickable, vol))
    .replace("<!--MP:BACK-->", `<a class="sbtn sq mp-back2" href="${reportHref}" title="Back to the report" aria-label="Back to the report">&lsaquo;</a>`)
    .replace("<!--MP:NOTE-->", noteFor(pickable, vol));
  // The app's own stylesheet is the stylesheet. It used to be replaced by a
  // copy kept here, and the two drifted: what the file looked like opened from
  // disk and what the site served were different pages.
  const styleOpen = src.indexOf("<style>"), styleClose = src.indexOf("</style>");
  if (styleOpen === -1 || styleClose === -1) {
    throw new Error(`practice app: no <style> found in ${vendorPath}`);
  }
  const style = src.slice(styleOpen + "<style>".length, styleClose);

  // Embedded ahead of the app script, which reads window.MP_SESSIONS on load.
  // JSON.stringify cannot emit "</script>", but a symbol could in principle
  // carry a "<", so the sequence is escaped rather than trusted.
  const data = `<script>window.MP_SESSIONS=${JSON.stringify(sessions.map((s) => compactSession(s, isHist(s)))).replace(/</g, "\\u003c")};</script>`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#080b11">
<title>Practice &middot; Market Prep</title>
<style>${style}${SKIN}</style>
</head><body>
${data}
${vol ? `<script>window.MP_VOL=${JSON.stringify(vol.embed)};window.MP_VOLCAL=${JSON.stringify(vol.calibrations).replace(/</g, "\\u003c")};window.MP_EVENTS=${JSON.stringify(vol.events ?? {}).replace(/</g, "\\u003c")};window.MP_RULEBOOK=${JSON.stringify(vol.rulebook ?? null).replace(/</g, "\\u003c")};</script>` : ""}
${body}
</body></html>`;
}

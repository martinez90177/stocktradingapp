import type { PremarketScan } from "./premarket.ts";

/**
 * The premarket board.
 *
 * The page is deployed once and then refreshes itself: it fetches
 * `premarket/latest.json` on a timer and re-renders. That is what makes a
 * five-minute cadence affordable -- rebuilding and redeploying the whole site
 * twelve times an hour would mean re-measuring the full morning report each
 * time, and GitHub Pages replaces the site wholesale on every deploy.
 *
 * Row markup therefore lives in the client script only, and the server-rendered
 * first paint comes from the same function applied to an inlined scan. One
 * renderer, so the first paint and every refresh cannot drift apart.
 *
 * Fonts are the system stack rather than the report's embedded faces: this file
 * is fetched far more often than the report, and a 300KB base64 blob on a page
 * that reloads every five minutes is the wrong trade.
 */

const esc = (s: unknown): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Safe to drop inside a <script> block. */
const json = (v: unknown): string =>
  JSON.stringify(v).replace(/</g, "\\u003c").replace(/-->/g, "--\\u003e").replace(/\u2028|\u2029/g, "");

export interface PremarketPageOptions {
  /** Where the client polls for fresh scans. */
  dataUrl: string;
  /** Minutes between refreshes. Matches the workflow cadence. */
  refreshMinutes: number;
  /** Link back to the morning report. */
  reportHref: string;
}

export function renderPremarketPage(scan: PremarketScan, opts: PremarketPageOptions): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Premarket board</title>
<style>
:root{
  --bg:#080b11; --panel:#121826; --panel2:#0d1220; --line:#1d2637; --line2:#2b3547;
  --text:#e9edf5; --dim:#8994a6; --dim2:#67717f;
  --up:#2dd4a7; --down:#f4525f; --gold:#f5a524;
  --accent:#7b6cf6; --accent-soft:rgba(123,108,246,.14);
  color-scheme:dark;
  --mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --sans:'Archivo',-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 var(--sans);padding-bottom:60px}
a{color:inherit;text-decoration:none}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.pos{color:var(--up)} .neg{color:var(--down)} .flat{color:var(--dim)}
.wrap{max-width:1180px;margin:0 auto;padding:0 16px}

header.top{border-bottom:1px solid var(--line);padding:22px 0 16px;position:relative;overflow:hidden}
header.top::before{content:"";position:absolute;inset:-60% -20% auto -20%;height:220%;
  background:radial-gradient(50% 50% at 50% 40%,var(--accent-soft),transparent 70%);pointer-events:none}
h1{margin:0;font-size:21px;letter-spacing:-.3px;font-weight:700}
.sub{color:var(--dim);font-size:12px;font-family:var(--mono);margin-top:4px}
.navrow{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px}
.chip{font-family:var(--mono);font-size:11px;color:var(--dim);background:var(--panel);
  border:1px solid var(--line);border-radius:6px;padding:3px 9px}
.chip b{color:var(--text);font-weight:650}
.chip.live{border-color:rgba(45,212,167,.4);color:var(--up)}
.chip.closed{border-color:var(--line2);color:var(--dim2)}
.chip.stale{border-color:rgba(245,165,36,.5);color:var(--gold)}

.bar{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0 10px;align-items:center}
.bar h2{margin:0;font-size:13px;text-transform:uppercase;letter-spacing:.09em;color:var(--dim)}
.count{margin-left:auto;font-family:var(--mono);font-size:11px;color:var(--dim2)}

table{width:100%;border-collapse:collapse;font-size:13px}
thead th{text-align:right;font-family:var(--mono);font-size:10.5px;letter-spacing:.06em;
  text-transform:uppercase;color:var(--dim2);font-weight:600;padding:6px 8px;
  border-bottom:1px solid var(--line2);white-space:nowrap}
thead th:first-child,thead th:nth-child(2){text-align:left}
tbody td{padding:8px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
tbody td:first-child,tbody td:nth-child(2){text-align:left}
tbody tr:hover{background:var(--panel2)}
.sym{font-family:var(--mono);font-weight:700;font-size:13.5px;letter-spacing:-.2px}
.nm{color:var(--dim2);font-size:11px;display:block;font-weight:400;letter-spacing:0;
  max-width:190px;overflow:hidden;text-overflow:ellipsis}
.tag{font-family:var(--mono);font-size:9.5px;text-transform:uppercase;letter-spacing:.06em;
  border:1px solid var(--line2);border-radius:3px;padding:0 4px;color:var(--dim2);margin-left:5px}
.tag.wl{border-color:rgba(123,108,246,.45);color:var(--accent)}
.lean{font-family:var(--mono);font-size:10.5px;font-weight:700;border-radius:4px;padding:1px 7px;
  border:1px solid var(--line2);color:var(--dim)}
.lean.long{border-color:rgba(45,212,167,.45);color:var(--up)}
.lean.short{border-color:rgba(244,82,95,.45);color:var(--down)}
.lean.untraded{color:var(--dim2)}
.why{color:var(--dim);font-size:11.5px;text-align:left !important;white-space:normal;
  max-width:330px;line-height:1.4}
.rsbar{display:inline-block;width:52px;height:6px;border-radius:3px;background:var(--line);
  position:relative;vertical-align:middle;margin-right:7px;overflow:hidden}
.rsbar i{position:absolute;top:0;bottom:0;left:50%;display:block}

.note{background:var(--panel);border:1px solid var(--line);border-left:2px solid var(--gold);
  border-radius:6px;padding:9px 12px;color:var(--dim);font-size:12px;margin:8px 0}
.withheld{font-family:var(--mono);font-size:11.5px;color:var(--dim2);margin:4px 0 0}
.withheld b{color:var(--dim);font-weight:650}
.empty{color:var(--dim2);font-size:12.5px;padding:18px 0;font-style:italic}
footer{margin-top:26px;padding-top:14px;border-top:1px solid var(--line);
  color:var(--dim2);font-size:11px;font-family:var(--mono)}
@media(max-width:760px){
  .hide-sm{display:none}
  .why{display:none}
}
</style>
</head><body>

<header class="top"><div class="wrap">
  <h1>Premarket board</h1>
  <div class="sub" id="sub">&nbsp;</div>
  <div class="navrow" id="chips"></div>
</div></header>

<div class="wrap">
  <div class="bar">
    <h2>Relative strength</h2>
    <span class="count" id="count"></span>
  </div>
  <div id="notes"></div>
  <div id="board"></div>
  <div id="withheld"></div>
  <footer>
    Measured from Yahoo Finance one-minute pre/post bars. Relative strength is the
    premarket gap minus <span id="bmname">the benchmark</span>'s, divided by the
    name's own 14-day ATR. A name with no premarket turnover behind it is withheld,
    not estimated. &middot; <a href="${esc(opts.reportHref)}" style="color:var(--accent)">morning report</a>
  </footer>
</div>

<script>
const INITIAL = ${json(scan)};
const DATA_URL = ${json(opts.dataUrl)};
const REFRESH_MS = ${Math.max(1, Math.round(opts.refreshMinutes))} * 60 * 1000;

const el = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

const num = (v, d, suffix) => v == null || !isFinite(v)
  ? '<span class="flat">--</span>'
  : '<span class="' + (v > 0 ? "pos" : v < 0 ? "neg" : "flat") + '">' +
    (v > 0 ? "+" : "") + v.toFixed(d) + (suffix || "") + '</span>';

const plain = (v, d) => v == null || !isFinite(v) ? '<span class="flat">--</span>' : v.toFixed(d);

function money(v){
  if (v == null || !isFinite(v) || v <= 0) return '<span class="flat">--</span>';
  if (v >= 1e9) return (v/1e9).toFixed(1) + "B";
  if (v >= 1e6) return (v/1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v/1e3).toFixed(0) + "K";
  return v.toFixed(0);
}

/* The bar is centred: it grows right when a name leads the benchmark and left
   when it lags, so the column reads as a distribution at a glance. Clamped at
   three ATRs, which is already an enormous premarket dislocation. */
function rsBar(rsAtr){
  if (rsAtr == null || !isFinite(rsAtr)) return "";
  const clamped = Math.max(-3, Math.min(3, rsAtr));
  const half = Math.abs(clamped) / 3 * 50;
  const colour = clamped >= 0 ? "var(--up)" : "var(--down)";
  const style = clamped >= 0
    ? "left:50%;width:" + half + "%;background:" + colour
    : "left:" + (50 - half) + "%;width:" + half + "%;background:" + colour;
  return '<span class="rsbar"><i style="' + style + '"></i></span>';
}

function ago(ms){
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return s + "s ago";
  const m = Math.round(s / 60);
  if (m < 90) return m + "m ago";
  return Math.round(m / 60) + "h ago";
}

const etTime = (t) => new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hour12: true,
}).format(new Date(t));

function render(scan, fetchFailed){
  const age = Date.now() - scan.generatedAt;
  const live = scan.window === "premarket";
  // Two refresh periods with no new scan means the pipeline stopped, and saying so
  // is the whole point -- a board that quietly keeps showing 7:05am numbers at
  // 9:00am is worse than one that admits it is stale.
  const stale = live && age > REFRESH_MS * 2 + 60000;

  el("sub").innerHTML =
    (scan.sessionDate ? esc(scan.sessionDate) + " &middot; " : "") +
    "measured " + esc(etTime(scan.generatedAt)) + " ET &middot; " + esc(ago(age));

  const bm = (scan.benchmarks || []).map((b) =>
    '<span class="chip"><b>' + esc(b.symbol) + '</b> ' + num(b.gapPct, 2, "%") + '</span>').join("");

  const state = live
    ? '<span class="chip live">&#9679; premarket &middot; live</span>'
    : scan.window === "regular-or-later"
      ? '<span class="chip closed">market open &middot; final premarket state</span>'
      : scan.window === "before-premarket"
        ? '<span class="chip closed">before 4:00am ET</span>'
        : '<span class="chip closed">weekend</span>';

  el("chips").innerHTML = state + bm +
    (stale ? '<span class="chip stale">&#9888; no new scan in ' + esc(ago(age)) + '</span>' : "") +
    (fetchFailed ? '<span class="chip stale">&#9888; refresh failed</span>' : "") +
    (live ? '<span class="chip" id="next"></span>' : "");

  if (scan.benchmarks && scan.benchmarks[0]) el("bmname").textContent = scan.benchmarks[0].symbol;

  const names = scan.names || [];
  const traded = names.filter((n) => n.bars > 0).length;
  el("count").textContent = names.length + " names \\u00b7 " + traded + " trading" +
    (scan.screensScanned ? " \\u00b7 " + scan.screensScanned + " quotes screened" : "");

  el("notes").innerHTML = (scan.notes || [])
    .map((n) => '<div class="note">' + esc(n) + "</div>").join("");

  if (names.length === 0){
    el("board").innerHTML = '<p class="empty">No name could be measured this run. ' +
      'Nothing is shown rather than estimated.</p>';
  } else {
    const rows = names.map((n, i) => {
      const leanClass = n.lean === "long-side" ? "long"
        : n.lean === "short-side" ? "short"
        : n.lean === "untraded" ? "untraded" : "";
      const isWl = (n.source || []).indexOf("watchlist") !== -1;
      return '<tr>' +
        '<td class="mono" style="color:var(--dim2)">' + (i + 1) + '</td>' +
        '<td><span class="sym">' + esc(n.symbol) + '</span>' +
          '<span class="tag ' + (isWl ? "wl" : "") + '">' + esc(isWl ? "list" : (n.source || []).join(", ")) + '</span>' +
          (n.name && n.name !== n.symbol ? '<span class="nm">' + esc(n.name) + '</span>' : "") + '</td>' +
        '<td class="mono">' + plain(n.last != null ? n.last : n.prevClose, 2) + '</td>' +
        '<td class="mono strong">' + num(n.gapPct, 2, "%") + '</td>' +
        '<td class="mono hide-sm">' + num(n.gapAtr, 2, "") + '</td>' +
        '<td class="mono">' + rsBar(n.rsAtr) + num(n.rsAtr, 2, "") + '</td>' +
        '<td class="mono hide-sm">' + num(n.rsSpy, 2, "") + '</td>' +
        '<td class="mono hide-sm">' + money(n.dollarVolume) + '</td>' +
        '<td><span class="lean ' + leanClass + '">' + esc(n.lean) + '</span></td>' +
        '<td class="why">' + esc(n.why) + '</td>' +
      '</tr>';
    }).join("");

    el("board").innerHTML =
      '<table><thead><tr>' +
        '<th>#</th><th>Name</th><th>Last</th><th>Gap</th>' +
        '<th class="hide-sm">Gap ATR</th><th>RS ATR</th>' +
        '<th class="hide-sm">RS pt</th><th class="hide-sm">PM $vol</th>' +
        '<th>Lean</th><th class="why">Why</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  const skipped = scan.skipped || [];
  el("withheld").innerHTML = skipped.length === 0 ? "" :
    '<div class="bar"><h2>Withheld</h2></div>' +
    skipped.map((s) => '<p class="withheld"><b>' + esc(s.symbol) + '</b> &mdash; ' +
      esc(s.reason) + '</p>').join("");
}

let current = INITIAL;
let timer = null, countdown = null, nextAt = 0;

async function refresh(){
  try {
    // Cache-buster: the raw file host puts these behind a CDN whose TTL is close
    // to the refresh interval, so without it a poll can be served the scan it
    // already has.
    const res = await fetch(DATA_URL + (DATA_URL.indexOf("?") === -1 ? "?" : "&") + "t=" + Date.now(),
      { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const next = await res.json();
    if (next && typeof next.generatedAt === "number"){
      current = next;
      render(current, false);
    }
  } catch (e) {
    // The last good scan stays on screen, flagged. Blanking the board on a
    // transient network error would lose numbers that are still true.
    render(current, true);
  }
  schedule();
}

function schedule(){
  clearTimeout(timer);
  clearInterval(countdown);
  // Polling stops once the session opens: there is no further premarket to read,
  // and the board is then a record of how it ended.
  if (current.window !== "premarket") return;
  nextAt = Date.now() + REFRESH_MS;
  timer = setTimeout(refresh, REFRESH_MS);
  // Painted immediately as well as on the interval, or the chip sits empty for
  // the first second after every render.
  const tick = () => {
    const n = el("next");
    if (!n) return;
    const left = Math.max(0, nextAt - Date.now());
    const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
    n.textContent = "next in " + m + ":" + String(s).padStart(2, "0");
  };
  tick();
  countdown = setInterval(tick, 1000);
}

render(current, false);
schedule();
// A phone that slept through several refreshes should catch up on wake rather
// than waiting out the remainder of a timer that fired while it was suspended.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && current.window === "premarket" && Date.now() > nextAt) refresh();
});
</script>
</body></html>`;
}

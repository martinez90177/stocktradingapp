import { FONT_CSS } from "./fonts.ts";
import {
  MISTAKES, byDay, computeStats, groupStats, isClosed, rMultiple, riskOf,
  type Journal, type Stats, type Trade,
} from "./journal.ts";

const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const money = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "&mdash;" : (n < 0 ? "−$" : "$") + Math.abs(n).toFixed(2);

const pct = (n: number | null | undefined, d = 1) =>
  n == null || !Number.isFinite(n) ? "&mdash;" : n.toFixed(d) + "%";

const tone = (n: number | null | undefined) => (n == null ? "" : n > 0 ? "pos" : n < 0 ? "neg" : "flat");

/* ------------------------------------------------------------------ *
 * Equity curve
 * ------------------------------------------------------------------ */

function equityCurve(equity: number[], w = 900, h = 190): string {
  if (equity.length < 2) {
    return `<p class="empty">At least two closed trades are needed to draw an equity curve.</p>`;
  }
  const pad = { l: 8, r: 62, t: 12, b: 18 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;
  const lo = Math.min(0, ...equity);
  const hi = Math.max(0, ...equity);
  const span = hi - lo || 1;
  const x = (i: number) => pad.l + (i / (equity.length - 1)) * pw;
  const y = (v: number) => pad.t + ph * (1 - (v - lo) / span);

  const pts = equity.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${pad.l},${y(0).toFixed(1)} ${pts} ${x(equity.length - 1).toFixed(1)},${y(0).toFixed(1)}`;
  const end = equity[equity.length - 1];
  const col = end >= 0 ? "var(--up)" : "var(--down)";

  // Peak-to-trough shading, so the worst run is visible rather than inferred.
  let peak = -Infinity;
  let dd = { from: 0, to: 0, depth: 0 };
  let peakI = 0;
  equity.forEach((v, i) => {
    if (v > peak) { peak = v; peakI = i; }
    if (peak - v > dd.depth) dd = { from: peakI, to: i, depth: peak - v };
  });

  return `<svg class="eq" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="equity curve">
    <defs><linearGradient id="eqg" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="${end >= 0 ? "#2dd4a7" : "#f4525f"}" stop-opacity=".26"/>
      <stop offset="1" stop-color="${end >= 0 ? "#2dd4a7" : "#f4525f"}" stop-opacity="0"/>
    </linearGradient></defs>
    ${dd.depth > 0 ? `<rect x="${x(dd.from).toFixed(1)}" y="${pad.t}" width="${Math.max(1, x(dd.to) - x(dd.from)).toFixed(1)}" height="${ph}" fill="#f4525f" opacity=".07"/>` : ""}
    <line x1="${pad.l}" y1="${y(0).toFixed(1)}" x2="${pad.l + pw}" y2="${y(0).toFixed(1)}" stroke="#2b3547" stroke-width="1" stroke-dasharray="3 3"/>
    <polygon points="${area}" fill="url(#eqg)"/>
    <polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.8" stroke-linejoin="round"/>
    <circle cx="${x(equity.length - 1).toFixed(1)}" cy="${y(end).toFixed(1)}" r="3" fill="${col}"/>
    <text x="${pad.l + pw + 7}" y="${(y(hi) + 4).toFixed(1)}" fill="#67717f" font-size="10.5" font-family="'IBM Plex Mono',monospace">${money(hi)}</text>
    <text x="${pad.l + pw + 7}" y="${(y(lo) + 4).toFixed(1)}" fill="#67717f" font-size="10.5" font-family="'IBM Plex Mono',monospace">${money(lo)}</text>
  </svg>`;
}

/* ------------------------------------------------------------------ *
 * Calendar
 * ------------------------------------------------------------------ */

function calendar(days: Map<string, { net: number; trades: number }>): string {
  if (days.size === 0) return `<p class="empty">No closed trades yet.</p>`;

  const keys = [...days.keys()].sort();
  const months = [...new Set(keys.map((k) => k.slice(0, 7)))].slice(-3);
  const worst = Math.max(...[...days.values()].map((d) => Math.abs(d.net)), 1);

  return months
    .map((m) => {
      const [y, mo] = m.split("-").map(Number);
      const first = new Date(Date.UTC(y, mo - 1, 1));
      const total = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      const lead = first.getUTCDay();
      const monthNet = keys
        .filter((k) => k.startsWith(m))
        .reduce((a, k) => a + (days.get(k)?.net ?? 0), 0);

      const cells: string[] = [];
      for (let i = 0; i < lead; i++) cells.push(`<i class="pad"></i>`);
      for (let d = 1; d <= total; d++) {
        const key = `${m}-${String(d).padStart(2, "0")}`;
        const hit = days.get(key);
        if (!hit) {
          cells.push(`<i class="off"><b>${d}</b></i>`);
          continue;
        }
        // Opacity carries magnitude so a big day reads without reading the number.
        const strength = (0.18 + 0.72 * (Math.abs(hit.net) / worst)).toFixed(2);
        const c = hit.net >= 0 ? "45,212,167" : "244,82,95";
        cells.push(
          `<i class="on" style="background:rgba(${c},${strength})" title="${esc(key)}: ${money(hit.net).replace(/&mdash;/, "-")} over ${hit.trades} trade(s)">
            <b>${d}</b><u>${hit.net >= 0 ? "+" : "−"}${Math.abs(hit.net) >= 1000 ? (Math.abs(hit.net) / 1000).toFixed(1) + "k" : Math.abs(hit.net).toFixed(0)}</u>
          </i>`,
        );
      }

      const label = first.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
      return `<div class="cal">
        <div class="calhead"><b>${esc(label)}</b><span class="${tone(monthNet)}">${money(monthNet)}</span></div>
        <div class="caldow">${["S", "M", "T", "W", "T", "F", "S"].map((d) => `<span>${d}</span>`).join("")}</div>
        <div class="calgrid">${cells.join("")}</div>
      </div>`;
    })
    .join("");
}

/* ------------------------------------------------------------------ *
 * Stat tiles
 * ------------------------------------------------------------------ */

function tiles(s: Stats): string {
  const pf = s.profitFactor;
  const t = (label: string, value: string, cls = "", sub = "") =>
    `<div class="tile"><span>${label}</span><b class="${cls}">${value}</b>${sub ? `<i>${sub}</i>` : ""}</div>`;

  return `<div class="tiles">
    ${t("Net P&amp;L", money(s.net), tone(s.net), `${s.trades} closed`)}
    ${t("Win rate", pct(s.winRate), "", `${s.wins}W / ${s.losses}L${s.scratches ? ` / ${s.scratches}BE` : ""}`)}
    ${t("Profit factor", pf == null ? "&mdash;" : pf === Infinity ? "&infin;" : pf.toFixed(2), pf != null && pf !== Infinity ? (pf >= 1 ? "pos" : "neg") : "", "gross win ÷ gross loss")}
    ${t("Expectancy", money(s.expectancy), tone(s.expectancy), "per trade")}
    ${t("Avg R", s.expectancyR == null ? "&mdash;" : (s.expectancyR >= 0 ? "+" : "") + s.expectancyR.toFixed(2) + "R", tone(s.expectancyR), "needs a planned stop")}
    ${t("Avg win", money(s.avgWin), "pos", `best ${money(s.largestWin)}`)}
    ${t("Avg loss", money(s.avgLoss), "neg", `worst ${money(s.largestLoss)}`)}
    ${t("Max drawdown", money(-s.maxDrawdown), s.maxDrawdown > 0 ? "neg" : "", `${s.worstStreak} loss streak`)}
  </div>`;
}

/* ------------------------------------------------------------------ *
 * Tables
 * ------------------------------------------------------------------ */

function groupTable(rows: { key: string; stats: Stats }[], label: string, nameOf: (k: string) => string): string {
  if (rows.length === 0) return `<p class="empty">Nothing tagged yet.</p>`;
  return `<div class="tablewrap"><table>
    <thead><tr><th>${esc(label)}</th><th>Trades</th><th>Win rate</th><th>Net</th><th>Avg</th></tr></thead>
    <tbody>${rows
      .map(
        (r) => `<tr>
        <td class="strong">${esc(nameOf(r.key))}</td>
        <td class="mono">${r.stats.trades}</td>
        <td class="mono">${pct(r.stats.winRate, 0)}</td>
        <td class="mono ${tone(r.stats.net)}">${money(r.stats.net)}</td>
        <td class="mono ${tone(r.stats.expectancy)}">${money(r.stats.expectancy)}</td>
      </tr>`,
      )
      .join("")}</tbody></table></div>`;
}

function tradeRows(trades: Trade[], playbookName: (id: string | null) => string): string {
  if (trades.length === 0) {
    return `<tr><td colspan="9" class="empty">No trades yet. Import a statement, or add one by hand.</td></tr>`;
  }
  return trades
    .slice()
    .sort((a, b) => (b.exitTime ?? b.entryTime).localeCompare(a.exitTime ?? a.entryTime))
    .slice(0, 300)
    .map((t) => {
      const r = rMultiple(t);
      const open = !isClosed(t);
      return `<tr class="${t.practice ? "prac" : ""}">
      <td class="mono dim">${esc((t.exitTime ?? t.entryTime).slice(0, 10))}</td>
      <td class="strong">${esc(t.symbol)}${t.instrument === "option" ? `<i class="opt">${esc(t.option?.type ?? "")} ${esc(t.option?.strike ?? "")}</i>` : ""}</td>
      <td><span class="side ${t.side}">${t.side}</span></td>
      <td class="mono">${t.qty}</td>
      <td class="mono">${t.entryPrice.toFixed(2)}</td>
      <td class="mono">${t.exitPrice == null ? "<i class=\"dim\">open</i>" : t.exitPrice.toFixed(2)}</td>
      <td class="mono ${open ? "dim" : tone(t.pnl)}">${open ? "&mdash;" : money(t.pnl)}</td>
      <td class="mono ${tone(r)}">${r == null ? "&mdash;" : (r >= 0 ? "+" : "") + r.toFixed(2) + "R"}</td>
      <td class="tags">${t.setup ? `<span class="tag setup">${esc(playbookName(t.setup))}</span>` : ""}${t.mistakes
        .map((m) => `<span class="tag miss">${esc(MISTAKES.find((x) => x.id === m)?.label ?? m)}</span>`)
        .join("")}${t.practice ? `<span class="tag prac">practice</span>` : ""}</td>
    </tr>`;
    })
    .join("");
}

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export function renderJournal(j: Journal, reportHref = "latest.html"): string {
  const real = j.trades.filter((t) => !t.practice);
  const practice = j.trades.filter((t) => t.practice);
  const stats = computeStats(real);
  const pStats = computeStats(practice);

  const playbookName = (id: string | null) =>
    j.playbooks.find((p) => p.id === id)?.name ?? id ?? "Untagged";

  const bySetup = groupStats(real.filter(isClosed), (t) => (t.setup ? [t.setup] : ["(untagged)"]));
  const byMistake = groupStats(real.filter(isClosed), (t) => t.mistakes);
  const mistakeName = (id: string) => MISTAKES.find((m) => m.id === id)?.label ?? id;

  // Every tagged habit, worst first -- including the ones that happen to be up.
  // Filtering to losers only would hide a habit that got lucky, which is the
  // one most worth seeing: three chases where the winner covered two losers is
  // still a losing habit, and a positive total is how it stays invisible.
  const habitCost = byMistake.slice().sort((a, b) => a.stats.net - b.stats.net);

  const openTrades = real.filter((t) => !isClosed(t)).length;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>Journal &middot; Market Prep</title>
<style>
${FONT_CSS}
:root{
  --bg:#080b11; --panel:#121826; --panel2:#0d1220; --line:#1d2637; --line2:#2b3547;
  --text:#e9edf5; --dim:#8994a6; --dim2:#67717f;
  --up:#2dd4a7; --down:#f4525f; --gold:#f5a524; --accent:#7b6cf6;
  color-scheme:dark;
  --mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --sans:'Archivo',-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 var(--sans);padding-bottom:60px}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.pos{color:var(--up)} .neg{color:var(--down)} .flat{color:var(--dim)} .dim{color:var(--dim2)} .strong{font-weight:650}
.wrap{max-width:1220px;margin:0 auto;padding:0 16px}
a{color:inherit;text-decoration:none}

header.top{border-bottom:1px solid var(--line);padding:24px 0 0;position:relative;overflow:hidden}
header.top::before{content:"";position:absolute;inset:-60% -20% auto -20%;height:220%;
  background:radial-gradient(60% 55% at 18% 40%,rgba(123,108,246,.16),transparent 70%);pointer-events:none}
header.top>.wrap{position:relative}
.brand{display:flex;align-items:flex-end;gap:18px;flex-wrap:wrap}
.brand h1{margin:0;font-size:29px;line-height:1;letter-spacing:-1px;font-weight:700}
.brand p{margin:6px 0 0;color:var(--dim);font-size:12.5px}
.back{margin-left:auto;display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line2);
  border-radius:8px;padding:9px 14px;color:var(--dim);font-weight:650;font-size:13px}
.back:hover{color:var(--text);border-color:var(--accent);background:rgba(123,108,246,.1)}

h2.sec{font-size:11px;text-transform:uppercase;letter-spacing:1.2px;color:var(--dim2);margin:30px 0 12px;font-weight:650}
h2.sec i{font-style:normal;text-transform:none;letter-spacing:0;font-weight:400;opacity:.8}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:15px}
.empty{color:var(--dim2);font-size:13px;margin:0}

.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:1px;background:var(--line);
  border:1px solid var(--line);border-radius:11px;overflow:hidden}
.tile{background:var(--panel);padding:13px 15px;display:flex;flex-direction:column;gap:3px}
.tile span{font-size:9.5px;text-transform:uppercase;letter-spacing:1px;color:var(--dim2)}
.tile b{font-family:var(--mono);font-size:20px;font-weight:600;letter-spacing:-.5px}
.tile i{font-style:normal;font-size:10.5px;color:var(--dim2)}

svg.eq{display:block;width:100%;height:auto}

.calrow{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px}
.cal{background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:13px}
.calhead{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:9px;font-size:13px}
.calhead span{font-family:var(--mono);font-weight:650}
.caldow,.calgrid{display:grid;grid-template-columns:repeat(7,1fr);gap:3px}
.caldow span{text-align:center;font-size:9.5px;color:var(--dim2);padding-bottom:3px}
.calgrid i{aspect-ratio:1;border-radius:5px;display:flex;flex-direction:column;align-items:center;justify-content:center;
  font-style:normal;gap:1px;background:var(--panel2)}
.calgrid i.pad{background:transparent}
.calgrid i.off{color:var(--dim2)}
.calgrid i b{font-size:10px;font-weight:600;font-family:var(--mono)}
.calgrid i u{text-decoration:none;font-size:8.5px;font-family:var(--mono);opacity:.9}
.calgrid i.on{color:#08101a;font-weight:700}

.tablewrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:12.5px}
th{text-align:left;color:var(--dim2);font-weight:650;font-size:9.5px;text-transform:uppercase;letter-spacing:.8px;
  padding:0 10px 8px 0;border-bottom:1px solid var(--line2);white-space:nowrap}
td{padding:9px 10px 9px 0;border-bottom:1px solid var(--line);vertical-align:middle}
tr:last-child td{border-bottom:0}
tr.prac td{opacity:.62}
.side{font-size:9.5px;text-transform:uppercase;letter-spacing:.7px;font-weight:700;padding:2px 7px;border-radius:4px}
.side.long{color:var(--up);background:rgba(45,212,167,.14)}
.side.short{color:var(--down);background:rgba(244,82,95,.14)}
i.opt{display:block;font-style:normal;font-size:10px;color:var(--dim2);font-family:var(--mono)}
.tags{display:flex;gap:4px;flex-wrap:wrap}
.tag{font-size:9.5px;padding:2px 7px;border-radius:4px;white-space:nowrap}
.tag.setup{background:rgba(123,108,246,.16);color:#9d92f8}
.tag.miss{background:rgba(244,82,95,.14);color:var(--down)}
.tag.prac{background:var(--line);color:var(--dim2)}

.habit{display:flex;align-items:baseline;gap:12px;padding:11px 0;border-bottom:1px solid var(--line)}
.habit:last-child{border-bottom:0}
.habit b{font-family:var(--mono);font-size:17px;font-weight:600;min-width:96px;text-align:right}
.habit .h{font-weight:650;font-size:13.5px}
.habit .w{color:var(--dim2);font-size:11.5px;display:block;margin-top:2px}
.lead{margin:0 0 14px;font-size:13px;color:var(--dim);line-height:1.6;max-width:74ch}
.lead b{color:var(--text)}

.split{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:820px){.split{grid-template-columns:1fr}.brand h1{font-size:23px}.back{margin-left:0}}
.form{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:11px}
.form label{display:flex;flex-direction:column;gap:5px;font-size:9.5px;text-transform:uppercase;
  letter-spacing:.9px;color:var(--dim2);font-weight:600}
.form label.wide{grid-column:1/-1;text-transform:none;letter-spacing:0;font-size:11px}
.form input,.form select,.form textarea{background:var(--panel2);border:1px solid var(--line2);border-radius:7px;
  color:var(--text);padding:9px 10px;font:14px var(--mono);width:100%}
.form textarea{font-family:var(--sans);resize:vertical}
.form input:focus,.form select:focus,.form textarea:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:transparent}
.mchips{display:flex;flex-wrap:wrap;gap:6px}
.chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line2);border-radius:7px;
  padding:6px 10px;cursor:pointer;font-size:11.5px;text-transform:none;letter-spacing:0;color:var(--dim);font-weight:500}
.chip input{width:auto;accent-color:var(--down);margin:0}
.chip:has(input:checked){border-color:var(--down);background:rgba(244,82,95,.1);color:var(--down)}
.formfoot{grid-column:1/-1;display:flex;align-items:center;gap:12px}
.formfoot button{background:var(--accent);border:0;border-radius:8px;color:#fff;font:650 13.5px var(--sans);
  padding:11px 20px;cursor:pointer}
.formfoot button:disabled{opacity:.5;cursor:default}
#addMsg{font-size:12.5px}
#addMsg.ok{color:var(--up)} #addMsg.bad{color:var(--down)}
.note{font-size:11.5px;color:var(--dim2);margin:12px 0 0;line-height:1.55}
.note code{font-family:var(--mono);color:var(--dim)}
footer{border-top:1px solid var(--line);margin-top:34px;padding:18px 0 0;color:var(--dim2);font-size:11.5px;line-height:1.6}
</style>
</head><body>

<header class="top"><div class="wrap">
  <div class="brand">
    <div>
      <h1>Journal</h1>
      <p>${real.length} real ${real.length === 1 ? "trade" : "trades"}${openTrades ? ` &middot; ${openTrades} still open` : ""}${practice.length ? ` &middot; ${practice.length} from practice` : ""}</p>
    </div>
    <a class="back" href="${esc(reportHref)}">&larr; Back to the report</a>
  </div>
</div></header>

<main class="wrap">
  <h2 class="sec">Performance <i>&mdash; real trades only, practice excluded</i></h2>
  ${tiles(stats)}

  <h2 class="sec">Equity curve <i>&mdash; shaded band is the largest drawdown</i></h2>
  <div class="panel">${equityCurve(stats.equity)}</div>

  <h2 class="sec">Calendar</h2>
  <div class="calrow">${calendar(byDay(real))}</div>

  <h2 class="sec">What the habits cost</h2>
  <div class="panel">
    ${
      habitCost.length
        ? `<p class="lead">Every trade tagged with a mistake, totalled &mdash; the price of each habit in dollars. Habits showing a <b>profit</b> are listed too, on purpose: a chase that got lucky is still a chase, and a positive total is exactly how a bad habit stays invisible.</p>
           ${habitCost
             .map(
               (h) => `<div class="habit">
             <b class="${tone(h.stats.net)}">${money(h.stats.net)}</b>
             <div><span class="h">${esc(mistakeName(h.key))}</span>
               <span class="w">${h.stats.trades} trade${h.stats.trades === 1 ? "" : "s"} &middot; ${pct(h.stats.winRate, 0)} win rate &middot; ${esc(MISTAKES.find((m) => m.id === h.key)?.why ?? "")}</span>
             </div>
           </div>`,
             )
             .join("")}`
        : `<p class="empty">No trades are tagged with a mistake yet. Tag them as you log them and this becomes the most useful section on the page.</p>`
    }
  </div>

  <div class="split">
    <div>
      <h2 class="sec">By setup</h2>
      <div class="panel">${groupTable(bySetup, "Playbook", playbookName)}</div>
    </div>
    <div>
      <h2 class="sec">By mistake</h2>
      <div class="panel">${groupTable(byMistake, "Mistake", mistakeName)}</div>
    </div>
  </div>

  ${
    practice.length
      ? `<h2 class="sec">Practice <i>&mdash; rehearsal, kept out of the numbers above</i></h2>
         ${tiles(pStats)}`
      : ""
  }

  <h2 class="sec">Log a trade</h2>
  <div class="panel">
    <form id="addForm" class="form">
      <label><span>Symbol</span><input name="symbol" required placeholder="NVDA" autocomplete="off"></label>
      <label><span>Side</span><select name="side"><option value="long">Long</option><option value="short">Short</option></select></label>
      <label><span>Type</span><select name="instrument"><option value="shares">Shares</option><option value="option">Option</option></select></label>
      <label><span>Qty</span><input name="qty" type="number" step="any" min="0" required placeholder="100"></label>
      <label><span>Entry</span><input name="entryPrice" type="number" step="any" required placeholder="180.20"></label>
      <label><span>Exit</span><input name="exitPrice" type="number" step="any" placeholder="181.50"></label>
      <label><span>Planned stop</span><input name="plannedStop" type="number" step="any" placeholder="179.40"></label>
      <label><span>Entry time</span><input name="entryTime" type="datetime-local"></label>
      <label><span>Exit time</span><input name="exitTime" type="datetime-local"></label>
      <label><span>Setup</span><select name="setup"><option value="">Untagged</option>${j.playbooks
        .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`)
        .join("")}</select></label>
      <label class="wide"><span>Mistakes &mdash; tag honestly, this is what the habit section reads</span>
        <div class="mchips">${MISTAKES.map(
          (m) => `<label class="chip" title="${esc(m.why)}"><input type="checkbox" name="mistakes" value="${esc(m.id)}"><span>${esc(m.label)}</span></label>`,
        ).join("")}</div>
      </label>
      <label class="wide"><span>Notes</span><textarea name="notes" rows="2" placeholder="What was the read, and what actually happened?"></textarea></label>
      <div class="formfoot">
        <button type="submit">Add trade</button>
        <span id="addMsg"></span>
      </div>
    </form>
    <p class="note" id="addNote">Saving needs the local viewer running (<code>node serve.mjs</code>). Opened as a plain file, this form has nowhere to write.</p>
  </div>

  <h2 class="sec">Trades <i>&mdash; newest first</i></h2>
  <div class="panel"><div class="tablewrap"><table>
    <thead><tr><th>Date</th><th>Symbol</th><th>Side</th><th>Qty</th><th>In</th><th>Out</th><th>P&amp;L</th><th>R</th><th>Tags</th></tr></thead>
    <tbody>${tradeRows(j.trades, playbookName)}</tbody>
  </table></div></div>
</main>

<footer class="wrap">
  <p><b>R multiple</b> is profit divided by what was risked to the planned stop, so it says whether a trade was good <i>relative to the risk taken</i>. Dollars flatter a big position and punish a small one; R does not. It is blank on any trade with no planned stop recorded.</p>
  <p><b>Profit factor</b> is gross winnings over gross losses. Above 1.00 means the winners paid for the losers. <b>Expectancy</b> is the average dollars a trade returns, which is the figure that actually compounds.</p>
  <p>Practice trades are stored alongside real ones but are excluded from every statistic above, because a rehearsal P&amp;L mixed into a real win rate makes the number worse than not having one.</p>
</footer>
<script>
/* The form posts to the local viewer, which owns journal.json. Opened as a
   plain file there is no server to take the write, so the form says so up
   front rather than silently dropping the trade. */
(function(){
  var f=document.getElementById("addForm");
  if(!f)return;
  var msg=document.getElementById("addMsg");
  var note=document.getElementById("addNote");
  var live=location.protocol==="http:"||location.protocol==="https:";
  if(!live){
    f.querySelector("button[type=submit]").disabled=true;
    note.textContent="This page was opened as a file, so there is nowhere to save. Start the viewer (node serve.mjs) and open it from there to log trades.";
  }

  f.addEventListener("submit",async function(e){
    e.preventDefault();
    var btn=f.querySelector("button[type=submit]");
    var d=new FormData(f), t={};
    d.forEach(function(v,k){ if(k!=="mistakes") t[k]=v; });
    t.mistakes=d.getAll("mistakes");
    t.source="manual"; t.practice=false;
    btn.disabled=true; msg.className=""; msg.textContent="Saving…";
    try{
      var r=await fetch("/journal/add",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(t)});
      var j=await r.json();
      if(!r.ok||!j.added) throw new Error(j.error||"nothing was added — check symbol, quantity and entry price");
      msg.className="ok"; msg.textContent="Added. Reloading…";
      setTimeout(function(){location.reload();},600);
    }catch(err){
      msg.className="bad"; msg.textContent=String(err.message||err);
      btn.disabled=false;
    }
  });
})();
</script>
</body></html>`;
}

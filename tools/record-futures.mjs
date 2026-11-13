/**
 * Records real MNQ / MES futures bars for the futures practice page.
 *
 *   node tools/record-futures.mjs            # both symbols
 *   node tools/record-futures.mjs MNQ        # one symbol
 *
 * Yahoo serves one-minute history for about the last thirty days, at most seven
 * days per request, so each run walks that whole window in weekly chunks (a
 * missed run is made up by the next one) and every day it sees is merged into
 * futures/<SYM>/<date>.json and kept, so the library only grows. A run never deletes anything: bars are merged by timestamp, and a
 * bar already on file is only replaced by a fresher copy of the same minute.
 *
 * It also keeps two coarser files per symbol for context on the 1h / 4h / daily
 * charts, where Yahoo goes back much further:
 *   futures/<SYM>/ctx-60m.json   about two years of hourly bars
 *   futures/<SYM>/ctx-1d.json    about ten years of daily bars
 *
 * Nothing here is generated or filled in. A minute Yahoo has no trade for is
 * simply absent (the replay skips it), exactly as on a chart.
 *
 * A "trading date" is the CME Globex session: it opens 6:00pm ET the evening
 * before and closes 5:00pm ET on the date itself.
 */
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "futures");
// Micros and their full-size minis. Each is recorded from its own Yahoo series, not
// derived from the other: they trade separately and their prints differ.
const SYMBOLS = { MNQ: "MNQ=F", MES: "MES=F", NQ: "NQ=F", ES: "ES=F" };
const HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
const UA = { "User-Agent": "Mozilla/5.0" };

const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "shortOffset" });
const offCache = new Map();
/** Seconds to add to a UTC epoch to get New York wall-clock time. */
export function etOffset(t) {
  const k = Math.floor(t / 3600);
  let v = offCache.get(k);
  if (v === undefined) {
    const name = fmt.formatToParts(new Date(t * 1000)).find((p) => p.type === "timeZoneName").value; // GMT-5
    const m = /GMT([+-]\d+)(?::(\d+))?/.exec(name);
    v = m ? Number(m[1]) * 3600 + (m[2] ? Math.sign(Number(m[1])) * Number(m[2]) * 60 : 0) : -18000;
    offCache.set(k, v);
  }
  return v;
}

/** Globex trading date (YYYY-MM-DD) a bar belongs to. */
export function tradingDate(t) {
  const local = t + etOffset(t) + 6 * 3600;               // 18:00 ET rolls into the next date
  return new Date(Math.floor(local / 86400) * 86400 * 1000).toISOString().slice(0, 10);
}
const etSecOfDay = (t) => (((t + etOffset(t)) % 86400) + 86400) % 86400;

async function fetchBars(yahooSym, interval, range, win) {
  let lastErr;
  for (const host of HOSTS) {
    try {
      const r = await fetch(`${host}/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=${interval}&${win ? `period1=${win[0]}&period2=${win[1]}` : `range=${range}`}`, { headers: UA });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const res = j.chart?.result?.[0];
      if (!res?.timestamp) throw new Error("no timestamps");
      const q = res.indicators.quote[0];
      const out = [];
      for (let i = 0; i < res.timestamp.length; i++) {
        const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
        if (o == null || h == null || l == null || c == null) continue;      // no trade that minute: absent, not filled
        out.push([res.timestamp[i], r2(o), r2(h), r2(l), r2(c), q.volume[i] ?? 0]);
      }
      return out;
    } catch (e) { lastErr = e; }
  }
  throw new Error(`${yahooSym} ${interval}/${range}: ${lastErr?.message}`);
}
const r2 = (x) => Math.round(x * 100) / 100;

async function readJson(file) { try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; } }

function mergeBars(oldBars, newBars) {
  const m = new Map();
  for (const b of oldBars ?? []) m.set(b[0], b);
  for (const b of newBars) m.set(b[0], b);
  return [...m.values()].sort((a, b) => a[0] - b[0]);
}

async function recordSymbol(sym) {
  const dir = join(ROOT, sym);
  await mkdir(dir, { recursive: true });
  const ysym = SYMBOLS[sym];

  // --- one-minute bars, grouped into Globex sessions ---
  // The last ~29 days, a week per request; Yahoo refuses 1m data older than 30 days.
  const now = Math.floor(Date.now() / 1000), WEEK = 7 * 86400, FROM = now - 29 * 86400;
  let bars = [];
  for (let end = now; end > FROM; end -= WEEK) {
    try { bars = bars.concat(await fetchBars(ysym, "1m", null, [Math.max(end - WEEK, FROM), end])); }
    catch (e) { if (end === now) throw e; console.error(`${sym}: older chunk skipped (${e.message})`); }
  }
  // The newest bar is still forming (its timestamp is not on a minute boundary); wait for it to finish.
  bars = bars.filter((b) => b[0] % 60 === 0);
  const byDate = new Map();
  for (const b of bars) {
    const d = tradingDate(b[0]);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(b);
  }
  let wrote = 0;
  for (const [date, list] of byDate) {
    const file = join(dir, `${date}.json`);
    const prev = await readJson(file);
    const merged = mergeBars(prev?.bars, list);
    await writeFile(file, JSON.stringify({ symbol: sym, date, bars: merged }), "utf8");
    wrote++;
  }

  // --- coarse context ---
  for (const [name, interval, range] of [["ctx-60m", "60m", "2y"], ["ctx-1d", "1d", "10y"]]) {
    const file = join(dir, `${name}.json`);
    const prev = await readJson(file);
    let nb = await fetchBars(ysym, interval, range);
    if (interval === "60m") nb = nb.filter((b) => b[0] % 3600 === 0);       // drop a forming bar
    if (interval === "1d") nb = nb.slice(0, -1);                            // today's daily bar is still forming
    await writeFile(file, JSON.stringify({ symbol: sym, interval, bars: mergeBars(prev?.bars, nb) }), "utf8");
  }
  return wrote;
}

/** A day is practice-ready when it has bars right through the regular session (9:30 to 4:00pm ET). */
function usable(bars) {
  if (!bars.length) return false;
  const first = etSecOfDay(bars[0][0]), last = etSecOfDay(bars[bars.length - 1][0]);
  const startsEarly = first < 9.5 * 3600 || first >= 17 * 3600;           // from the evening open, or at least before 9:30
  return startsEarly && last >= 16 * 3600 && last <= 17 * 3600 + 120;
}

export async function buildManifest() {
  const manifest = { updated: new Date().toISOString(), symbols: {} };
  for (const sym of Object.keys(SYMBOLS)) {
    const dir = join(ROOT, sym);
    const files = (await readdir(dir).catch(() => [])).filter((f) => /^\d{4}-\d\d-\d\d\.json$/.test(f)).sort();
    const dates = [];
    for (const f of files) {
      const day = await readJson(join(dir, f));
      if (day && usable(day.bars)) dates.push({ date: day.date, bars: day.bars.length });
    }
    manifest.symbols[sym] = { dates, ctx: ["ctx-60m", "ctx-1d"] };
  }
  return manifest;
}

if (process.argv[1]?.endsWith("record-futures.mjs")) {
  const want = process.argv.slice(2).map((s) => s.toUpperCase()).filter((s) => SYMBOLS[s]);
  for (const sym of want.length ? want : Object.keys(SYMBOLS)) {
    try {
      const n = await recordSymbol(sym);
      console.log(`${sym}: ${n} sessions updated`);
    } catch (e) {
      console.error(`${sym}: ${e.message}`);
      process.exitCode = 1;
    }
  }
  const m = await buildManifest();
  await mkdir(ROOT, { recursive: true });
  await writeFile(join(ROOT, "manifest.json"), JSON.stringify(m), "utf8");
  for (const [s, v] of Object.entries(m.symbols)) console.log(`${s}: ${v.dates.length} practice-ready days (${v.dates[0]?.date ?? "-"} to ${v.dates.at(-1)?.date ?? "-"})`);
}

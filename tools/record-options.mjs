/**
 * Records the real option chain, minute by minute, while the market is open.
 *
 *   node tools/record-options.mjs              # record until the 4:00 bell
 *   node tools/record-options.mjs --symbols QQQ,SPY
 *   node tools/record-options.mjs --once       # a single sweep, then stop
 *
 * Why this exists. The candles in the practice terminal are recorded; the
 * option prices were modelled, because Yahoo serves only the chain as it
 * stands right now and no history at all. A model can be made honest -- see
 * tools/calibrate-vol.mjs and tools/measure-intraday-variance.mjs -- but it
 * cannot be made exact, and practising a size you cannot scale from is worse
 * than useless.
 *
 * So this records what a model would otherwise guess: the real bid and ask of
 * every strike near the money, every minute of the session, filed beside the
 * candles. From the first day it runs, the terminal quotes recorded prices for
 * the contracts it saw and says plainly where it did not see one.
 *
 * It is a long-running process, not a cron job: it must be started before the
 * open and left alone until the close. Yahoo keeps no history, so a session
 * nobody recorded is gone for good -- the same reason sessions/ is committed.
 * Stopping and restarting mid-session is safe: the file is merged, not
 * replaced, and only the minutes nobody was watching are missing.
 *
 * Writes options/<SYMBOL>/<YYYY-MM-DD>.json; the shape is defined, and the
 * merging done, in src/optionsfile.ts.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { authedJson } = await import(pathToFileURL(join(ROOT, "src", "catalysts.ts")).href);
const { emptyDay, merge, cents } = await import(pathToFileURL(join(ROOT, "src", "optionsfile.ts")).href);

const MPD = 390, OPEN = 570, CLOSE = 960;   // minutes into the day, New York

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
};
const num = (name, fallback) => {
  const v = Number(flag(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/**
 * What to keep, and what it costs. A session of three expiries across seven
 * tickers is roughly 1.6 MB a day in the repository once git has compressed
 * it, so about 400 MB a year. `--expiries 1` records only the contracts
 * expiring today and cuts that to a third; `--band` narrows the strikes.
 */
/** Which strikes to keep: this far either side of spot, as a fraction of it. */
const BAND = num("band", 0.015);
/** ... and never more than this many on each side, whatever the band works out to. */
const MAX_SIDE = num("max-strikes", 20);
/** How many expiries to follow: today's, and the next ones after it. */
const EXPIRIES = num("expiries", 3);
/** A pause between requests, so a session's worth of polling stays polite. */
const SPACING_MS = num("spacing", 400);

const et = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
/** The date and minute-of-day in New York, whatever the machine's own clock is set to. */
function nowET(ms = Date.now()) {
  const o = {};
  for (const p of et.formatToParts(ms)) o[p.type] = p.value;
  return { date: `${o.year}-${o.month}-${o.day}`, min: (+o.hour % 24) * 60 + +o.minute, sec: +o.second };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function symbols() {
  const fromFlag = flag("symbols");
  if (typeof fromFlag === "string") return fromFlag.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  try {
    const w = JSON.parse(await readFile(join(ROOT, "watchlist.json"), "utf8"));
    return (w.symbols ?? []).map((s) => s.trim().toUpperCase()).filter(Boolean);
  } catch {
    return ["SPY", "QQQ"];
  }
}

/**
 * One sweep of one symbol: the spot, and the bid and ask of every strike within
 * the band, for the first few expiries. Returns null where the chain could not
 * be read, so a hiccup costs one minute rather than the run.
 */
async function readChain(symbol) {
  const base = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}`;
  const first = await authedJson(base);
  const r0 = first?.optionChain?.result?.[0];
  if (!r0?.options?.length) return null;
  const spot = r0.quote?.regularMarketPrice;
  if (!(spot > 0)) return null;

  const wanted = (r0.expirationDates ?? []).slice(0, EXPIRIES);
  const out = { spot, expiries: [] };
  for (const exp of wanted) {
    let o;
    if (exp === r0.expirationDates[0]) {
      o = r0.options[0];
    } else {
      await sleep(SPACING_MS);
      const j = await authedJson(`${base}?date=${exp}`);
      o = j?.optionChain?.result?.[0]?.options?.[0];
    }
    if (!o) continue;
    const lo = spot * (1 - BAND), hi = spot * (1 + BAND);
    const near = (list) => (list ?? []).filter((c) => c.strike >= lo && c.strike <= hi);
    const calls = near(o.calls), puts = near(o.puts);
    const strikes = [...new Set([...calls, ...puts].map((c) => c.strike))].sort((a, b) => a - b);
    // A band on a cheap stock can be hundreds of strikes wide; keep the middle.
    const mid = strikes.reduce((best, k, i) => (Math.abs(k - spot) < Math.abs(strikes[best] - spot) ? i : best), 0);
    const kept = strikes.slice(Math.max(0, mid - MAX_SIDE), mid + MAX_SIDE + 1);
    const byStrike = (list) => {
      const m = new Map();
      for (const c of list) m.set(c.strike, c);
      return m;
    };
    const C = byStrike(calls), P = byStrike(puts);
    const quote = (m, k) => {
      const c = m.get(k);
      return c ? [cents(c.bid), cents(c.ask)] : [-1, -1];
    };
    out.expiries.push({
      date: new Date(o.expirationDate * 1000).toISOString().slice(0, 10),
      strikes: kept,
      call: kept.flatMap((k) => quote(C, k)),
      put: kept.flatMap((k) => quote(P, k)),
    });
  }
  return out.expiries.length ? out : null;
}

/** The day's file as it stands, or nothing where this is the first sweep of it. */
async function load(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function sweepAll(syms, minute, date) {
  let ok = 0, failed = [];
  for (const symbol of syms) {
    const sweep = await readChain(symbol).catch(() => null);
    if (!sweep) { failed.push(symbol); await sleep(SPACING_MS); continue; }
    const dir = join(ROOT, "options", symbol.replace(/[^A-Z0-9_.-]/gi, "_"));
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${date}.json`);
    const day = (await load(file)) ?? emptyDay(symbol, date);
    await writeFile(file, JSON.stringify(merge(day, minute, sweep)), "utf8");
    ok++;
    await sleep(SPACING_MS);
  }
  return { ok, failed };
}

const syms = await symbols();
const once = flag("once") === true;
console.log(`Recording ${syms.length} symbol(s): ${syms.join(", ")}`);
console.log(`  ${EXPIRIES} expiry/expiries, strikes within ${(BAND * 100).toFixed(1)}% of spot, to options/<SYM>/<date>.json`);
console.log(`  roughly ${(0.54 * EXPIRIES * syms.length / 7).toFixed(1)} MB a day in the repository at this setting`);
if (!once) console.log("  Leave this running until the 4:00 bell. Ctrl-C stops it; restarting merges into the same file.\n");

let quiet = 0;
for (;;) {
  const { date, min, sec } = nowET();
  if (min >= OPEN && min < CLOSE) {
    const minute = min - OPEN;
    const t = await sweepAll(syms, minute, date);
    const clock = `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
    if (t.ok) {
      quiet = 0;
      console.log(`  ${clock}  minute ${String(minute).padStart(3)}  ${t.ok}/${syms.length} recorded${t.failed.length ? `  (no chain: ${t.failed.join(", ")})` : ""}`);
    } else if (++quiet % 5 === 1) {
      console.warn(`  ${clock}  nothing could be read (${t.failed.join(", ")}) -- still trying`);
    }
  } else if (!once) {
    const clock = `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
    if (min >= CLOSE) { console.log(`  ${clock}  the bell. ${date} is recorded.`); break; }
    if (quiet++ % 10 === 0) console.log(`  ${clock}  waiting for the 9:30 open`);
  }
  if (once) break;
  // Wake a moment after the turn of the next minute, so a sweep is filed under
  // the minute it was actually read in.
  await sleep(Math.max(2000, (61 - nowET().sec) * 1000));
}

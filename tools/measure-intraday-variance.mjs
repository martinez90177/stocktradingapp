/**
 * Measures how a trading session's variance is spread across its minutes, and
 * how much of it the overnight gap is worth, from the recorded bars.
 *
 *   node tools/measure-intraday-variance.mjs
 *
 * Why this exists. An option's price is the variance still ahead of it. The
 * practice terminal used to assume that variance accrues evenly: a 0DTE at
 * 3pm, with a sixth of the session left, was priced on a sixth of the day's
 * variance. Measured from the sessions in this repo, a sixth of the session
 * left is more like a thirteenth of its variance -- the first half hour alone
 * carries about a third of the day. Pricing on the even clock charged the
 * morning's volatility all afternoon, and a QQQ 0DTE cost roughly three times
 * what the market charged for it by the close.
 *
 * Nothing here is a guess about the shape. It is the realized variance of the
 * recorded minute bars, and the realized overnight gaps beside them.
 *
 * Each session is normalised by its own total variance before being averaged,
 * so a loud day or a loud ticker cannot set the shape for everything else, and
 * the average is of shapes rather than of sizes. The level is not measured
 * here at all: that comes per ticker from real option prints, in
 * tools/calibrate-vol.mjs.
 *
 * Both numbers are measured per ticker as well as pooled, because they differ
 * by more than noise: the overnight gap is worth about a tenth of a session on
 * AAPL and a whole session on NVDA, and pooling them priced the index ETFs a
 * third too dear. A ticker with too few recorded days falls back to the pooled
 * curve, and the page says so.
 *
 * Writes volatility/intraday.json.
 */
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = join(ROOT, "sessions");
const MPD = 390;

/** Close-to-close log returns through a session; the first minute runs from its own open. */
function returns(bars) {
  const r = new Float64Array(MPD);
  r[0] = Math.log(bars[0][3] / bars[0][0]);
  for (let i = 1; i < MPD; i++) r[i] = Math.log(bars[i][3] / bars[i - 1][3]);
  return r;
}

/** A ticker needs this many recorded days before its own curve is trusted over the pooled one. */
const MIN_DAYS = 15;
/** ... and this many nights before its own overnight gap is. */
const MIN_GAPS = 10;

const shape = new Float64Array(MPD);          // summed per-session shapes, every ticker
const perSymbol = {};                          // and the same per ticker
const days = {};                               // symbol -> date -> { open, close, total }
const feeds = {};                              // which feed each measured session came from
let used = 0, skipped = 0, from = "9999", to = "0000";

/** Turns summed per-session shapes into the fraction still ahead at each minute. */
function remaining(sum, n) {
  const rem = new Array(MPD + 1).fill(0);
  for (let i = MPD - 1; i >= 0; i--) rem[i] = rem[i + 1] + sum[i] / n;
  const scale = rem[0] || 1;
  for (let i = 0; i <= MPD; i++) rem[i] = +(rem[i] / scale).toFixed(5);
  rem[0] = 1;
  rem[MPD] = 0;
  return rem;
}

let dirs = [];
try {
  dirs = await readdir(SESSIONS);
} catch {
  console.error("No sessions/ to measure. Record some days first (node run.ts).");
  process.exit(1);
}

for (const symbol of dirs.sort()) {
  let files;
  try {
    files = (await readdir(join(SESSIONS, symbol))).filter((f) => f.endsWith(".json")).sort();
  } catch {
    continue;
  }
  const own = new Float64Array(MPD);
  let ownN = 0;
  days[symbol] = {};
  for (const file of files) {
    let s;
    try {
      s = JSON.parse(await readFile(join(SESSIONS, symbol, file), "utf8"));
    } catch {
      continue;
    }
    if (!s.bars || s.bars.length !== MPD) { skipped++; continue; }
    const r = returns(s.bars);
    let total = 0;
    for (let i = 0; i < MPD; i++) total += r[i] * r[i];
    days[symbol][s.date] = { open: s.bars[0][0], close: s.bars[MPD - 1][3], total };
    // Sessions recorded before 2026-09-15 carry no tag and are all Yahoo's.
    const feed = s.source ?? "yahoo";
    feeds[feed] = (feeds[feed] ?? 0) + 1;
    // A session that never moved carries no shape; including it would divide by zero.
    if (!(total > 0)) { skipped++; continue; }
    for (let i = 0; i < MPD; i++) {
      const w = (r[i] * r[i]) / total;
      shape[i] += w;
      own[i] += w;
    }
    ownN++;
    used++;
    if (s.date < from) from = s.date;
    if (s.date > to) to = s.date;
  }
  if (ownN) perSymbol[symbol] = { days: ownN, own };
}

if (used < 10) {
  console.error(`Only ${used} usable session(s); not enough to measure a shape. Nothing written.`);
  process.exit(1);
}

// The fraction of a session's variance still ahead at each minute, 0 through 390.
// rem[0] is 1 by construction and rem[390] is 0: everything happens in between.
const rem = remaining(shape, used);

/**
 * Overnight gaps: the close of one recorded day to the open of the next, where
 * they are consecutive. Measured per ticker, since they are nothing like each
 * other, and pooled for a ticker with too few nights of its own.
 */
function gapsFor(symbols) {
  let gapSq = 0, gaps = 0, sessSq = 0, sessN = 0;
  for (const symbol of symbols) {
    const dates = Object.keys(days[symbol] ?? {}).sort();
    for (const d of dates) { sessSq += days[symbol][d].total; sessN++; }
    for (let i = 1; i < dates.length; i++) {
      const prev = days[symbol][dates[i - 1]], cur = days[symbol][dates[i]];
      // Only genuinely adjacent sessions: a hole in the library is not one night.
      const apart = (Date.parse(dates[i]) - Date.parse(dates[i - 1])) / 86400000;
      if (!(apart > 0 && apart <= 4)) continue;
      const r = Math.log(cur.open / prev.close);
      gapSq += r * r;
      gaps++;
    }
  }
  return { gaps, ratio: gaps && sessN ? +((gapSq / gaps) / (sessSq / sessN)).toFixed(4) : null };
}

const pooled = gapsFor(Object.keys(days));
const overnight = pooled.gaps >= MIN_GAPS ? pooled.ratio : null;
const gaps = pooled.gaps;

const checkpoints = {};
for (const m of [15, 30, 60, 120, 180, 240, 300, 360]) checkpoints[m] = rem[m];

// Per ticker: its own curve and its own night, where it has enough of each to
// be worth more than the pooled numbers.
const symbols = {};
for (const [sym, v] of Object.entries(perSymbol)) {
  const g = gapsFor([sym]);
  const own = v.days >= MIN_DAYS ? remaining(v.own, v.days) : null;
  symbols[sym] = {
    days: v.days,
    gaps: g.gaps,
    ...(own ? { rem: own } : {}),
    ...(g.gaps >= MIN_GAPS && g.ratio != null ? { overnight: g.ratio } : {}),
  };
}

const out = {
  measuredAt: new Date().toISOString(),
  sessions: used,
  from,
  to,
  /** Fraction of one session's variance still ahead at each minute from the 9:30 open. */
  rem,
  /** One overnight gap, in units of one session's variance. Null where too few gaps to measure. */
  overnight,
  gaps,
  checkpoints,
  symbols,
  /** Which feed the measured sessions came from. One name means one series. */
  feeds,
};

await mkdir(join(ROOT, "volatility"), { recursive: true });
await writeFile(join(ROOT, "volatility", "intraday.json"), JSON.stringify(out), "utf8");

const pct = (x) => (x * 100).toFixed(1).padStart(5) + "%";
const mix = Object.entries(feeds).map(([k, v]) => `${v} ${k}`).join(", ");
console.log(`  ${used} sessions, ${from} to ${to}${skipped ? `, ${skipped} skipped` : ""}  (${mix})`);
if (Object.keys(feeds).length > 1) {
  console.warn("  ! this curve is measured across more than one feed. node tools/compare-bars.mjs says how far");
  console.warn("    apart they are; node tools/refetch-bars.mjs re-records the library from Schwab alone.");
}
console.log(`  variance still ahead:  9:45 ${pct(rem[15])}   10:30 ${pct(rem[60])}   12:30 ${pct(rem[180])}   15:00 ${pct(rem[330])}`);
console.log(`  first 30 min carry ${pct(1 - rem[30])}, last 30 min ${pct(rem[360])}`);
console.log(`  overnight gap = ${overnight == null ? "not measured" : overnight.toFixed(3) + " x a session"} pooled (${gaps} gaps)`);
for (const [sym, v] of Object.entries(symbols)) {
  console.log(`    ${sym.padEnd(6)} ${v.rem ? `own curve (${v.days}d), ${pct(v.rem[180])} left at 12:30` : `pooled curve (${v.days}d)`}` +
    `   night ${v.overnight != null ? v.overnight.toFixed(3) : "pooled"}`);
}
console.log(`  -> volatility/intraday.json`);

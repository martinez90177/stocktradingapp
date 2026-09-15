/**
 * Re-records the session library from Schwab, so it is one feed rather than two.
 *
 *   node tools/refetch-bars.mjs              # say what would change, touch nothing
 *   node tools/refetch-bars.mjs --write      # actually replace them
 *   node tools/refetch-bars.mjs --days 60 --symbols QQQ
 *
 * Why. Everything recorded before 2026-09-15 came from Yahoo. The intraday
 * variance curve, the overnight gap ratios and the replay all read the library
 * as one series, and those numbers set option prices, so a library with two
 * vendors in it puts a seam inside the pricing. Schwab's minute history usually
 * reaches further back than the library does, which makes replacing the lot
 * possible rather than only going forward from here.
 *
 * It is careful about it. A day is only replaced where Schwab returns a session
 * that is at least as complete as the one on disk -- same 390 minutes, no more
 * minutes carried flat for want of a trade -- so a short or gappy answer can
 * never quietly degrade a good recording. Days Schwab cannot reach are left
 * exactly as they are and listed at the end, still marked as Yahoo's.
 *
 * It writes nothing without --write, and the library is committed to git, so a
 * replacement is reviewable as a diff and revertable.
 */
import { readFile, writeFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = join(ROOT, "sessions");
const SCHWAB = await import(pathToFileURL(join(ROOT, "src", "schwab.ts")).href);
const R = await import(pathToFileURL(join(ROOT, "src", "replay.ts")).href);

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : (argv[i + 1] ?? true); };
const write = argv.includes("--write");
const days = Number(flag("days", 60)) || 60;

let symbols;
if (typeof flag("symbols") === "string") {
  symbols = String(flag("symbols")).split(",").map((s) => s.trim().toUpperCase());
} else {
  try { symbols = (await readdir(SESSIONS)).sort(); } catch { symbols = []; }
}
if (!symbols.length) {
  console.error("No sessions/ to re-record.");
  process.exit(1);
}

let token = null;
try { token = await SCHWAB.accessToken(join(ROOT, SCHWAB.TOKEN_FILE)); } catch (e) { console.error(e.message); }
if (!token) {
  console.error("Schwab is not logged in. Run: node tools/schwab-login.mjs");
  process.exit(1);
}

console.log(write ? "Replacing the library with Schwab's bars.\n" : "Dry run: nothing will be written. Add --write to do it.\n");

const totals = { replaced: 0, already: 0, unreachable: 0, worse: 0, gappy: 0 };
const unreachable = [], gappy = [];

for (const symbol of symbols) {
  let files;
  try {
    files = (await readdir(join(SESSIONS, symbol))).filter((f) => f.endsWith(".json")).sort();
  } catch { continue; }
  if (!files.length) continue;

  const bars = await SCHWAB.minuteBars(symbol, days, join(ROOT, SCHWAB.TOKEN_FILE));
  if (!bars?.length) {
    console.log(`${symbol.padEnd(6)} schwab returned nothing; every day left as it is`);
    totals.unreachable += files.length;
    unreachable.push(`${symbol} (all ${files.length})`);
    continue;
  }
  const fresh = new Map(R.splitSessions(symbol, bars).map((s) => [s.date, s]));
  const ext = R.splitExtended(bars);
  // Which dates Schwab actually answered for, whether or not the answer was
  // complete enough to keep: "it had nothing" and "what it had was full of
  // holes" call for different things, and only one is worth retrying.
  const served = new Set();
  const etDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
  for (const b of bars) served.add(etDay.format(new Date(b.t)));

  const lines = [];
  for (const f of files) {
    const date = f.replace(/\.json$/, "");
    const file = join(SESSIONS, symbol, f);
    let old = null;
    try { old = JSON.parse(await readFile(file, "utf8")); } catch { /* unreadable; treat as replaceable */ }

    if (old?.source === "schwab") { totals.already++; continue; }

    const next = fresh.get(date);
    if (!next) {
      if (served.has(date)) { totals.gappy++; gappy.push(`${symbol} ${date}`); }
      else { totals.unreachable++; unreachable.push(`${symbol} ${date}`); }
      continue;
    }

    // Never trade a good recording for a worse one.
    if (old && (next.bars.length !== old.bars.length || next.carried > old.carried)) {
      totals.worse++;
      lines.push(`  ${date}  kept yahoo's: schwab's is ${next.bars.length} bars, ${next.carried} carried (on disk: ${old.bars.length}, ${old.carried})`);
      continue;
    }

    const x = ext.get(date);
    if (x && (x.pre.length || x.post.length)) { next.ext = x; next.extv = R.EXT_VERSION; }
    else if (old?.ext) { next.ext = old.ext; next.extv = old.extv; }   // keep what Yahoo had rather than lose it
    next.source = "schwab";

    // How far apart the two feeds were on this day, which is the thing worth
    // seeing before a library is replaced wholesale.
    let worst = 0;
    if (old?.bars?.length === next.bars.length) {
      for (let i = 0; i < next.bars.length; i++) worst = Math.max(worst, Math.abs(next.bars[i][3] - old.bars[i][3]));
    }
    lines.push(`  ${date}  ${write ? "replaced" : "would replace"}${old ? `, worst close ${worst < 0.005 ? `${(worst * 100).toFixed(2)}c` : `$${worst.toFixed(2)}`} apart` : ""}`);
    if (write) await writeFile(file, JSON.stringify(next), "utf8");
    totals.replaced++;
  }
  if (lines.length) {
    console.log(symbol);
    for (const l of lines) console.log(l);
  }
}

console.log(`\n${write ? "Replaced" : "Would replace"} ${totals.replaced} session(s).` +
  `${totals.already ? ` ${totals.already} already from schwab.` : ""}` +
  `${totals.worse ? ` ${totals.worse} left alone because schwab's answer was less complete.` : ""}`);
const listed = (xs) => `${xs.slice(0, 12).join(", ")}${xs.length > 12 ? `, and ${xs.length - 12} more` : ""}`;
if (totals.unreachable) {
  console.log(`\n${totals.unreachable} day(s) are past what schwab serves and stay on yahoo's bars:`);
  console.log(`  ${listed(unreachable)}`);
}
if (totals.gappy) {
  console.log(`\n${totals.gappy} day(s) schwab did serve but with too many minutes missing to use:`);
  console.log(`  ${listed(gappy)}`);
  console.log("  Worth running again later: a partial answer is usually the request, not the day.");
}
if (totals.unreachable || totals.gappy) {
  console.log("  Either way they keep their own source tag, so what is measured across the library can leave them out.");
}
if (!write && totals.replaced) console.log("\nRe-run with --write to do it. The library is in git, so it is a reviewable diff.");
if (write && totals.replaced) console.log("\nNow re-measure what is derived from the bars:  node tools/measure-intraday-variance.mjs");

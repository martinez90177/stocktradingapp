/**
 * Compares Schwab's minute bars against Yahoo's, on days both still serve.
 *
 *   node tools/compare-bars.mjs
 *   node tools/compare-bars.mjs --symbols QQQ,SPY --days 5
 *
 * Why this exists. Everything recorded before 2026-09-15 came from Yahoo, and
 * everything after comes from Schwab. The variance curve, the calibrations and
 * the replay all read the library as one thing, so it is worth knowing whether
 * the two feeds actually agree before trusting a library that mixes them.
 *
 * This fetches the same recent days from both and reports how far apart they
 * are: where the candles differ, by how much, and whether either is missing
 * minutes the other has. Pennies of difference on a few minutes is two vendors
 * consolidating the tape slightly differently and is nothing to worry about.
 * Dollars, or whole minutes missing on one side, means the seam is real and
 * the older days should be re-recorded from Schwab while they are still in
 * reach, or left out of what is measured across the library.
 *
 * Nothing is written. This only looks.
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHWAB = await import(pathToFileURL(join(ROOT, "src", "schwab.ts")).href);
const { splitSessions } = await import(pathToFileURL(join(ROOT, "src", "replay.ts")).href);
const REPLAY = await import(pathToFileURL(join(ROOT, "src", "replay.ts")).href);

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : (argv[i + 1] ?? true); };
const days = Number(flag("days", 5)) || 5;

const symbols = typeof flag("symbols") === "string"
  ? String(flag("symbols")).split(",").map((s) => s.trim().toUpperCase())
  : JSON.parse(await (await import("node:fs/promises")).readFile(join(ROOT, "watchlist.json"), "utf8")).symbols.slice(0, 3);

const token = await SCHWAB.accessToken(join(ROOT, SCHWAB.TOKEN_FILE)).catch((e) => { console.error(e.message); return null; });
if (!token) {
  console.error("Schwab is not logged in, so there is nothing to compare against. Run: node tools/schwab-login.mjs");
  process.exit(1);
}

const money = (x) => (x < 0.005 ? `${(x * 100).toFixed(2)}c` : `$${x.toFixed(2)}`);

for (const symbol of symbols) {
  console.log(`\n${symbol}`);
  const s = await SCHWAB.minuteBars(symbol, days + 2, join(ROOT, SCHWAB.TOKEN_FILE));
  const y = await REPLAY.fetchMinuteBars(symbol, days + 2, join(ROOT, "cache"), true).catch(() => null);
  if (!s?.length || !y?.length) {
    console.log(`  ${!s?.length ? "schwab" : "yahoo"} returned nothing; cannot compare`);
    continue;
  }
  const S = splitSessions(symbol, s), Y = splitSessions(symbol, y);
  const byDate = (list) => new Map(list.map((d) => [d.date, d]));
  const sm = byDate(S), ym = byDate(Y);
  const shared = [...sm.keys()].filter((d) => ym.has(d)).sort().slice(-days);
  if (!shared.length) {
    console.log(`  no day is complete on both (schwab ${[...sm.keys()].join(",") || "none"}; yahoo ${[...ym.keys()].join(",") || "none"})`);
    continue;
  }
  console.log("  date        worst close   median close   minutes apart   volume apart   carried s/y");
  for (const date of shared) {
    const a = sm.get(date), b = ym.get(date);
    const diffs = [], vol = [];
    let apart = 0;
    for (let i = 0; i < 390; i++) {
      const x = a.bars[i], z = b.bars[i];
      if (!x || !z) { apart++; continue; }
      diffs.push(Math.abs(x[3] - z[3]));
      if (z[4] > 0) vol.push(Math.abs(x[4] - z[4]) / z[4]);
    }
    diffs.sort((p, q) => p - q);
    vol.sort((p, q) => p - q);
    const med = diffs.length ? diffs[Math.floor(diffs.length / 2)] : NaN;
    const worst = diffs.length ? diffs[diffs.length - 1] : NaN;
    const vmed = vol.length ? vol[Math.floor(vol.length / 2)] : NaN;
    console.log(`  ${date}  ${money(worst).padStart(11)}  ${money(med).padStart(13)}  ` +
      `${String(apart).padStart(13)}  ${(vmed * 100).toFixed(1).padStart(12)}%  ${String(a.carried).padStart(5)}/${b.carried}`);
  }
}

console.log(`
Pennies apart on the close, and volume within a few percent, is two vendors
consolidating the same tape and is fine to mix. Dollars apart, or minutes one
feed has and the other does not, means the library should not be treated as
one series -- re-record the older days from Schwab while they are in reach.`);

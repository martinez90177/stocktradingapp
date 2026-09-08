/**
 * The premarket scan, run on its own cadence.
 *
 * Deliberately separate from `run.ts`. The morning report measures eleven names
 * over a year of daily bars plus option chains, fundamentals and news; it takes
 * minutes and is worth running twice. This runs every five minutes, so it does
 * one thing and writes a few kilobytes:
 *
 *   node run-premarket.ts              # scan, if inside the premarket window
 *   node run-premarket.ts --force      # scan regardless of the clock
 *   node run-premarket.ts --symbols TSLA,AMD
 *
 * Output is premarket/latest.json. There is no HTML here on purpose: the page
 * that reads this is deployed once and fetches the JSON on a timer, so a
 * five-minute refresh does not need a five-minute site rebuild.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanPremarket, windowState } from "./src/premarket.ts";

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, "premarket");
const CACHE = join(ROOT, "cache");

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const [k, inline] = a.slice(2).split("=");
    if (inline !== undefined) flags[k] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith("--")) flags[k] = argv[++i];
    else flags[k] = true;
  }
  return flags;
}

const flags = parseArgs(process.argv.slice(2));
const now = new Date();
const state = windowState(now);

// The cron is wider than the premarket window on purpose -- GitHub runs cron in
// UTC only, so a fixed schedule slides by an hour when the clocks change. This
// guard is what actually decides whether a run works, and it reads ET.
if (state !== "premarket" && flags.force !== true) {
  console.log(`Outside the premarket window (${state}). Nothing measured. Use --force to override.`);
  process.exit(0);
}

let file: any = {};
try {
  file = JSON.parse(await readFile(join(ROOT, "watchlist.json"), "utf8"));
} catch {
  console.warn("! watchlist.json missing or unreadable; falling back to a default list.");
}

const fromFlag = typeof flags.symbols === "string"
  ? flags.symbols.split(",").map((s) => s.trim()).filter(Boolean)
  : null;

const watchlist: string[] = (fromFlag ?? file.symbols ?? ["SPY", "QQQ", "AAPL"])
  .map((s: string) => s.trim().toUpperCase())
  .filter((s: string, i: number, arr: string[]) => s.length > 0 && arr.indexOf(s) === i);

const o = file.options ?? {};
const pm = file.premarket ?? {};

const benchmarks: string[] = Array.isArray(pm.benchmarks) && pm.benchmarks.length > 0
  ? pm.benchmarks.map((s: string) => s.trim().toUpperCase())
  : ["SPY", "QQQ"];

await mkdir(OUT, { recursive: true });
await mkdir(CACHE, { recursive: true });

console.log(`\nPremarket scan  ${now.toISOString()}  (${state})`);
console.log(`Watchlist: ${watchlist.join(", ")}`);
console.log(`Benchmarks: ${benchmarks.join(", ")}\n`);

const scan = await scanPremarket({
  watchlist,
  benchmarks,
  limit: pm.limit === 0 ? 0 : Number(pm.limit) || 15,
  minPrice: Number(o.moversMinPrice) || 3,
  minDollarVolume: Number(o.moversMinDollarVolume) || 20e6,
  minHintPct: Number(pm.minHintPct) || 2,
  minPremarketDollarVolume: Number(pm.minPremarketDollarVolume) || 250e3,
  cacheDir: CACHE,
  // Premarket bars must stay fresh; a stale premarket high is worse than none.
  // Daily bars do not change during the premarket, so they are fetched once a
  // morning and reused by every run after it.
  intraTtl: 60,
  dailyTtl: 6 * 3600,
  onProgress: (line) => console.log(line),
}, now);

const payload = JSON.stringify(scan, null, 1);
await writeFile(join(OUT, "latest.json"), payload, "utf8");

const traded = scan.names.filter((n) => n.bars > 0).length;
console.log(`\n${scan.names.length} on the board (${traded} trading), ${scan.skipped.length} withheld`);
for (const s of scan.skipped) console.log(`  -- ${s.symbol}: ${s.reason}`);
for (const n of scan.notes) console.log(`  ~ ${n}`);
console.log(`\n  ${join(OUT, "latest.json")}  ${(Buffer.byteLength(payload, "utf8") / 1024).toFixed(1)} KB\n`);

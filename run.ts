import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Analysis, Mover } from "./src/types.ts";
import { mapPool } from "./src/yahoo.ts";
import { analyzeSymbol } from "./src/pipeline.ts";
import { renderReport, marketPhase } from "./src/report.ts";
import { discoverMovers } from "./src/movers.ts";
import { loadRules } from "./src/rules.ts";
import { renderPractice, writeSessionPacks } from "./src/practice.ts";
import { harvest, loadForEmbed } from "./src/replay.ts";
import { harvestVol, loadVolForEmbed, loadCalibrations, loadEvents, recordEvents } from "./src/volindex.ts";
import { execFileSync } from "node:child_process";
import { loadJournal } from "./src/journal.ts";
import { renderJournal } from "./src/journalpage.ts";

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPORTS = join(ROOT, "reports");
const CACHE = join(ROOT, "cache");

interface Config {
  symbols: string[];
  options: {
    dailyLookbackDays: number;
    intradayDays: number;
    maxConfluenceLevels: number;
    moversLimit: number;
    moversMinPrice: number;
    moversMinDollarVolume: number;
  };
}

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

async function loadConfig(flags: Record<string, string | boolean>): Promise<Config> {
  let file: any = {};
  try {
    file = JSON.parse(await readFile(join(ROOT, "watchlist.json"), "utf8"));
  } catch {
    console.warn("! watchlist.json missing or unreadable; falling back to a default list.");
  }
  const fromFlag = typeof flags.symbols === "string"
    ? flags.symbols.split(",").map((s) => s.trim()).filter(Boolean)
    : null;

  const symbols = (fromFlag ?? file.symbols ?? ["SPY", "QQQ", "AAPL"])
    .map((s: string) => s.trim().toUpperCase())
    .filter((s: string, i: number, arr: string[]) => s.length > 0 && arr.indexOf(s) === i);

  const o = file.options ?? {};
  return {
    symbols,
    options: {
      dailyLookbackDays: Number(o.dailyLookbackDays) || 180,
      intradayDays: Number(o.intradayDays) || 2,
      maxConfluenceLevels: Number(o.maxConfluenceLevels) || 9,
      moversLimit: o.moversLimit === 0 ? 0 : Number(o.moversLimit) || 12,
      moversMinPrice: Number(o.moversMinPrice) || 3,
      moversMinDollarVolume: Number(o.moversMinDollarVolume) || 20e6,
    },
  };
}

/** Keeps the newest `keep` dated reports and deletes the rest. */
async function prune(keep = 40) {
  try {
    const files = (await readdir(REPORTS))
      .filter((f) => /^\d{4}-\d{2}-\d{2}_\d{4}\.html$/.test(f))
      .sort()
      .reverse();
    for (const f of files.slice(keep)) await unlink(join(REPORTS, f)).catch(() => {});
  } catch {
    /* reports dir may not exist yet */
  }
}

function stamp(d: Date): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}_${g("hour")}${g("minute")}`;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const config = await loadConfig(flags);
  const noCache = flags["no-cache"] === true;
  const generatedAt = new Date();

  await mkdir(REPORTS, { recursive: true });
  await mkdir(CACHE, { recursive: true });

  const phase = marketPhase(generatedAt);
  console.log(`\nMarket Prep  ${stamp(generatedAt)} ET  (${phase.label.replace(/&middot;/g, "-")})`);
  console.log(`Watchlist: ${config.symbols.join(", ")}\n`);

  const failures: { symbol: string; reason: string }[] = [];
  const analyses: Analysis[] = [];

  // Daily bars are stable once the session closes, so they cache for an hour.
  // Intraday must stay fresh -- a stale premarket high is worse than none.
  const dailyTtl = noCache ? 0 : 3600;
  const intraTtl = noCache ? 0 : 90;

  await mapPool(config.symbols, 3, async (symbol) => {
    try {
      const a = await analyzeSymbol(symbol, {
        cacheDir: CACHE,
        maxLevels: config.options.maxConfluenceLevels,
        dailyTtl,
        intraTtl,
        fundamentalsTtl: noCache ? 0 : 6 * 3600,
        newsTtl: noCache ? 0 : 900,
        options: flags["no-options"] !== true,
        optionsTtl: noCache ? 0 : 600,
        onWarn: (m) => console.warn(`  ~ ${m}`),
      });
      analyses.push(a);
      const arrow = a.changePct >= 0 ? "+" : "";
      console.log(
        `  ok ${symbol.padEnd(6)} ${a.price.toFixed(2).padStart(9)}  ${(arrow + a.changePct.toFixed(2) + "%").padStart(8)}  score ${a.watchScore.toFixed(0).padStart(3)}  ${a.headline.slice(0, 68)}`,
      );
    } catch (e) {
      const reason = (e as Error).message.replace(`${symbol}: `, "");
      failures.push({ symbol, reason });
      console.warn(`  !! ${symbol.padEnd(6)} ${reason}`);
    }
  });

  if (analyses.length === 0) {
    console.error("\nNo symbols could be analyzed. Nothing was written.");
    process.exitCode = 1;
    return;
  }

  let movers: Mover[] = [];
  let moversScanned = 0;
  let moversNotes: string[] = [];
  if (config.options.moversLimit > 0 && flags["no-movers"] !== true) {
    console.log("\nScanning movers...");
    try {
      const found = await discoverMovers({
        exclude: config.symbols,
        limit: config.options.moversLimit,
        minPrice: config.options.moversMinPrice,
        minDollarVolume: config.options.moversMinDollarVolume,
        cacheDir: CACHE,
      });
      movers = found.movers;
      moversScanned = found.scanned;
      moversNotes = found.notes;
      for (const m of movers) {
        console.log(
          `  ${m.symbol.padEnd(6)} ${m.price.toFixed(2).padStart(9)}  ${((m.changePct >= 0 ? "+" : "") + m.changePct.toFixed(2) + "%").padStart(8)}  ${m.lean.padEnd(11)} ${m.leanWhy.slice(0, 58)}`,
        );
      }
    } catch (e) {
      moversNotes.push(`The movers scan failed: ${(e as Error).message}`);
      console.warn(`  !! movers scan failed: ${(e as Error).message}`);
    }
  }

  const rules = await loadRules(join(ROOT, "rules.json")).catch((e) => {
    console.warn(`  ~ ${(e as Error).message}`);
    return null;
  });

  const html = renderReport({
    analyses,
    rules,
    movers,
    moversScanned,
    moversNotes,
    failures,
    generatedAt,
    lookbackDays: config.options.dailyLookbackDays,
    intradayDays: config.options.intradayDays,
  });

  const dated = join(REPORTS, `${stamp(generatedAt)}.html`);
  const latest = join(REPORTS, "latest.html");
  await writeFile(dated, html, "utf8");
  await writeFile(latest, html, "utf8");
  await prune(40);

  // The practice terminal is a sibling page, written next to the report so the
  // link between them works from the file system, OneDrive or a web host alike.
  const SESSIONS = join(ROOT, "sessions");
  if (flags["no-replay"] !== true) {
    // Harvesting is an extra, and it runs after the report is already on disk.
    // A network hiccup here must not throw away a finished run.
    try {
      // The first six watchlist names, plus every ticker already in the library.
      // Taking only the first six silently stopped recording TSLA once it moved
      // down the watchlist -- its days ran out at Sep 4 while the rest carried on.
      const recorded = await readdir(SESSIONS).catch(() => [] as string[]);
      const toRecord = [...new Set([...config.symbols.slice(0, 6), ...recorded])];
      const h = await harvest(toRecord, SESSIONS, CACHE, (m) => console.warn(`  ~ ${m}`));
      console.log(`  replay library: ${h.added} new${h.extended ? `, ${h.extended} given extended hours` : ""}, ${h.total} sessions total`);
    } catch (e) {
      console.warn(`  ~ replay harvest skipped (${(e as Error).message})`);
    }
    // The volatility the practice options are priced on: VXN and VIX for the
    // days just recorded, and a fresh measurement of how each ticker's options
    // trade against them. Both extras; neither may sink the run.
    try {
      const v = await harvestVol(join(ROOT, "volatility"), CACHE, (m) => console.warn(`  ~ ${m}`));
      console.log(`  volatility: ${v.added} new index day(s) recorded`);
    } catch (e) {
      console.warn(`  ~ volatility harvest skipped (${(e as Error).message})`);
    }
    try {
      // Upcoming reports, from the calendar the report already fetched, so the
      // practice page can warn on the days it cannot price honestly.
      const found: Record<string, number[]> = {};
      for (const a of analyses) {
        const d = a.catalysts?.fundamentals?.earningsDates;
        if (d?.length) found[a.symbol] = d;
      }
      const n = await recordEvents(join(ROOT, "volatility"), found);
      if (n) console.log(`  earnings calendar: ${n} new report date(s) filed`);
    } catch (e) {
      console.warn(`  ~ earnings calendar skipped (${(e as Error).message})`);
    }
    try {
      const out = execFileSync(process.execPath, [join(ROOT, "tools", "calibrate-vol.mjs")], { encoding: "utf8", timeout: 180000 });
      console.log(`  calibration: ${out.trim().split("\n").pop()}`);
    } catch (e) {
      console.warn(`  ~ calibration skipped (${String((e as Error).message).split("\n")[0]})`);
    }
  }

  try {
    const sessions = await loadForEmbed(SESSIONS, 22);   // 12 to trade, the rest behind them as history
    const VOL = join(ROOT, "volatility");
    const practice = await renderPractice(join(ROOT, "src", "vendor", "practice-app.html"), "latest.html", sessions, {
      embed: await loadVolForEmbed(VOL, sessions.map((s) => s.date)),
      calibrations: await loadCalibrations(VOL),
      events: await loadEvents(VOL),
      rulebook: rules,
    });
    await writeFile(join(REPORTS, "practice.html"), practice, "utf8");
    await writeSessionPacks(SESSIONS, join(REPORTS, "sessions"));   // the library beside the page, for Surprise me
  } catch (e) {
    console.warn(`  ~ practice page not written (${(e as Error).message})`);
  }

  try {
    const journal = await loadJournal(join(ROOT, "journal.json"));
    await writeFile(join(REPORTS, "journal.html"), renderJournal(journal), "utf8");
    const real = journal.trades.filter((t) => !t.practice).length;
    console.log(`  journal: ${real} real trade(s), ${journal.trades.length - real} from practice`);
  } catch (e) {
    console.warn(`  ~ journal page not written (${(e as Error).message})`);
  }

  const kb = (Buffer.byteLength(html, "utf8") / 1024).toFixed(0);
  console.log(`\n${analyses.length} analyzed, ${failures.length} failed  ->  ${kb} KB`);
  console.log(`  ${latest}`);
  console.log(`  ${dated}\n`);

  if (flags.open) {
    const { spawn } = await import("node:child_process");
    spawn("cmd", ["/c", "start", "", latest], { detached: true, stdio: "ignore" }).unref();
  }
}

main().catch((e) => {
  console.error("\nFatal:", e);
  process.exitCode = 1;
});

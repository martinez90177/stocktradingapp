import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Analysis, Mover } from "./src/types.ts";
import { mapPool } from "./src/yahoo.ts";
import { analyzeSymbol } from "./src/pipeline.ts";
import { renderReport, marketPhase } from "./src/report.ts";
import { discoverMovers } from "./src/movers.ts";
import { loadRules } from "./src/rules.ts";
import { renderPractice } from "./src/practice.ts";
import { harvest, loadForEmbed } from "./src/replay.ts";

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
    const h = await harvest(config.symbols.slice(0, 6), SESSIONS, CACHE, (m) => console.warn(`  ~ ${m}`));
    console.log(`  replay library: ${h.added} new, ${h.total} sessions total`);
  }

  try {
    const sessions = await loadForEmbed(SESSIONS, 30);
    const practice = await renderPractice(join(ROOT, "src", "vendor", "practice-app.html"), "latest.html", sessions);
    await writeFile(join(REPORTS, "practice.html"), practice, "utf8");
  } catch (e) {
    console.warn(`  ~ practice page not written (${(e as Error).message})`);
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

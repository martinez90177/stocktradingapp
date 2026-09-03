/**
 * Ad-hoc ticker lookup. Runs the same analysis the morning report runs, for any
 * symbol, right now.
 *
 *   node lookup.ts TSLA
 *   node lookup.ts TSLA AMD PLTR --open
 *   node lookup.ts NVDA --quiet        (write the page, skip the terminal dump)
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Analysis } from "./src/types.ts";
import { mapPool } from "./src/yahoo.ts";
import { analyzeSymbol, levelsText } from "./src/pipeline.ts";
import { renderReport } from "./src/report.ts";

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPORTS = join(ROOT, "reports");
const CACHE = join(ROOT, "cache");

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const symbols = argv
    .filter((a) => !a.startsWith("--"))
    .flatMap((a) => a.split(","))
    .map((s) => s.trim().toUpperCase())
    .filter((s, i, arr) => s && arr.indexOf(s) === i);

  if (symbols.length === 0) {
    console.error("\nUsage: node lookup.ts <SYMBOL> [SYMBOL...] [--open] [--quiet] [--fresh] [--no-options]\n");
    console.error("  node lookup.ts TSLA");
    console.error("  node lookup.ts TSLA,AMD --open\n");
    process.exitCode = 1;
    return;
  }

  await mkdir(REPORTS, { recursive: true });
  await mkdir(CACHE, { recursive: true });

  const fresh = flags.has("--fresh");
  const analyses: Analysis[] = [];
  const failures: { symbol: string; reason: string }[] = [];

  await mapPool(symbols, 3, async (symbol) => {
    try {
      analyses.push(
        await analyzeSymbol(symbol, {
          cacheDir: CACHE,
          maxLevels: 9,
          // A lookup is a deliberate "what is it doing right now", so the
          // price-sensitive feeds are pulled fresh by default.
          dailyTtl: fresh ? 0 : 600,
          intraTtl: fresh ? 0 : 60,
          fundamentalsTtl: fresh ? 0 : 6 * 3600,
          newsTtl: fresh ? 0 : 600,
          options: !flags.has("--no-options"),
          optionsTtl: fresh ? 0 : 300,
          onWarn: (m) => console.warn(`  ~ ${m}`),
        }),
      );
    } catch (e) {
      const reason = (e as Error).message.replace(`${symbol}: `, "");
      failures.push({ symbol, reason });
      console.error(`  !! ${symbol}: ${reason}`);
    }
  });

  if (analyses.length === 0) {
    console.error("\nNothing could be analyzed.\n");
    process.exitCode = 1;
    return;
  }

  analyses.sort((a, b) => b.grade.total - a.grade.total);

  if (!flags.has("--quiet")) {
    for (const a of analyses) console.log("\n" + levelsText(a) + "\n");
  }

  const html = renderReport({
    analyses,
    movers: [],
    moversScanned: 0,
    moversNotes: [],
    failures,
    generatedAt: new Date(),
    lookbackDays: 180,
    intradayDays: 2,
    title: `Lookup: ${analyses.map((a) => a.symbol).join(", ")}`,
  });

  const slug = analyses.map((a) => a.symbol).join("-").replace(/[^A-Z0-9-]/gi, "").slice(0, 40);
  const out = join(REPORTS, `lookup-${slug}.html`);
  await writeFile(out, html, "utf8");
  console.log(`Written: ${out}\n`);

  if (flags.has("--open")) {
    const { spawn } = await import("node:child_process");
    spawn("cmd", ["/c", "start", "", out], { detached: true, stdio: "ignore" }).unref();
  }
}

main().catch((e) => {
  console.error("\nFatal:", e);
  process.exitCode = 1;
});

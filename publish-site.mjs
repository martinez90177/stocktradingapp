/**
 * Assembles a static site from the latest run.
 *
 * Output is a plain folder of self-contained HTML with no build step and no
 * server requirement: open site/index.html from disk, drop the folder on any
 * host, or let the GitHub Pages workflow deploy it.
 *
 *   node run.ts && node publish-site.mjs
 */
import { readFile, writeFile, mkdir, rm, cp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPractice, writeSessionPacks, writeOptionPacks } from "./src/practice.ts";
import { loadForEmbed } from "./src/replay.ts";
import { loadVolForEmbed, loadCalibrations, loadEvents, loadIntraday, loadChainFit, libraryDates } from "./src/volindex.ts";
import { loadJournal } from "./src/journal.ts";
import { loadRules } from "./src/rules.ts";
import { renderJournal } from "./src/journalpage.ts";
import { renderPlan, loadPlanData } from "./src/planpage.ts";
import { injectSiteNav } from "./src/sitenav.ts";
import { injectTradeKit } from "./src/tradekit.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORTS = join(HERE, "reports");
const SITE = join(HERE, "site");

const report = await readFile(join(REPORTS, "latest.html"), "utf8").catch(() => null);
if (!report) {
  console.error("No reports/latest.html yet. Run `node run.ts` first.");
  process.exit(1);
}

await rm(SITE, { recursive: true, force: true });
await mkdir(SITE, { recursive: true });

// The report lands at index.html, so the practice page links back to that name
// rather than to latest.html.
// A report built before the shared nav bar existed gets it here; a newer one
// already carries it and is left as it is.
// Its old row of page links goes too: the bar replaces them.
const withNav = injectSiteNav(
  report.replace(/<a class="practicebtn[^"]*" href="(?:journal|practice|futures)\.html">[^<]*<\/a>\s*/g, ""),
  "prep",
  { prep: "#top" },
);
await writeFile(join(SITE, "index.html"), withNav, "utf8");
const sessions = await loadForEmbed(join(HERE, "sessions"), 22);   // 12 to trade, the rest behind them as history
await writeFile(
  join(SITE, "practice.html"),
  await renderPractice(
    join(HERE, "src", "vendor", "practice-app.html"),
    "index.html",
    sessions,
    {
      embed: await loadVolForEmbed(join(HERE, "volatility"), await libraryDates(join(HERE, "sessions"))),
      calibrations: await loadCalibrations(join(HERE, "volatility")),
      events: await loadEvents(join(HERE, "volatility")),
      intraday: await loadIntraday(join(HERE, "volatility")),
      chainfit: await loadChainFit(join(HERE, "volatility")),
      rulebook: await loadRules(join(HERE, "rules.json")).catch(() => null),
    },
  ),
  "utf8",
);

const packs = await writeSessionPacks(join(HERE, "sessions"), join(SITE, "sessions"));
console.log(`site/sessions/      ${packs.days} days across ${packs.symbols} tickers, for Surprise me`);

const opts = await writeOptionPacks(join(HERE, "options"), join(SITE, "options"));
console.log(opts.days
  ? `site/options/       ${opts.days} days across ${opts.symbols} tickers of real bid and ask`
  : `site/options/       none recorded yet (tools/record-options.mjs)`);

// Futures practice (NQ / MNQ / ES / MES). The page is static; the recorded bars it replays are
// copied beside it, so it works on GitHub Pages the same as locally.
await writeFile(join(SITE, "futures.html"), injectSiteNav(injectTradeKit(await readFile(join(HERE, "src", "vendor", "futures-app.html"), "utf8")), "futures"), "utf8");
const futuresDir = join(HERE, "futures");
const hasFutures = await readFile(join(futuresDir, "manifest.json"), "utf8").then(() => true, () => false);
if (hasFutures) {
  await cp(futuresDir, join(SITE, "futures"), { recursive: true });
  console.log("site/futures/       recorded NQ / MNQ / ES / MES bars for the futures page");
} else {
  console.log("site/futures/       none recorded yet (tools/record-futures.mjs)");
}

// Game Plan: posted levels -> stop, size and a yes/no for a funded account.
await writeFile(join(SITE, "plan.html"), renderPlan(await loadPlanData(HERE), "index.html"), "utf8");

await writeFile(
  join(SITE, "journal.html"),
  renderJournal(await loadJournal(join(HERE, "journal.json")), "index.html"),
  "utf8",
);

// Pages otherwise runs the output through Jekyll, which ignores some files.
await writeFile(join(SITE, ".nojekyll"), "", "utf8");

const kb = (n) => (n / 1024).toFixed(0) + " KB";
console.log(`site/index.html     ${kb(Buffer.byteLength(report, "utf8"))}`);
console.log(`site/practice.html  built`);
console.log(`\nOpen ${join(SITE, "index.html")}`);

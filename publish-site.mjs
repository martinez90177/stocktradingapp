/**
 * Assembles a static site from the latest run.
 *
 * Output is a plain folder of self-contained HTML with no build step and no
 * server requirement: open site/index.html from disk, drop the folder on any
 * host, or let the GitHub Pages workflow deploy it.
 *
 *   node run.ts && node publish-site.mjs
 */
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPractice } from "./src/practice.ts";
import { loadForEmbed } from "./src/replay.ts";
import { loadVolForEmbed, loadCalibrations, loadEvents } from "./src/volindex.ts";
import { loadJournal } from "./src/journal.ts";
import { loadRules } from "./src/rules.ts";
import { renderJournal } from "./src/journalpage.ts";

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
await writeFile(join(SITE, "index.html"), report, "utf8");
const sessions = await loadForEmbed(join(HERE, "sessions"), 22);   // 12 to trade, the rest behind them as history
await writeFile(
  join(SITE, "practice.html"),
  await renderPractice(
    join(HERE, "src", "vendor", "practice-app.html"),
    "index.html",
    sessions,
    {
      embed: await loadVolForEmbed(join(HERE, "volatility"), sessions.map((s) => s.date)),
      calibrations: await loadCalibrations(join(HERE, "volatility")),
      events: await loadEvents(join(HERE, "volatility")),
      rulebook: await loadRules(join(HERE, "rules.json")).catch(() => null),
    },
  ),
  "utf8",
);

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

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
import { loadJournal } from "./src/journal.ts";
import { renderJournal } from "./src/journalpage.ts";
import { renderPremarketPage } from "./src/premarketpage.ts";

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
await writeFile(
  join(SITE, "practice.html"),
  await renderPractice(
    join(HERE, "src", "vendor", "practice-app.html"),
    "index.html",
    await loadForEmbed(join(HERE, "sessions"), 30),
  ),
  "utf8",
);

await writeFile(
  join(SITE, "journal.html"),
  renderJournal(await loadJournal(join(HERE, "journal.json")), "index.html"),
  "utf8",
);

// The premarket board. It is deployed once and then polls for fresh scans, so
// this build only has to seed a first paint -- an empty one is fine, and is what
// happens when the site is rebuilt outside premarket hours.
const config = JSON.parse(await readFile(join(HERE, "watchlist.json"), "utf8").catch(() => "{}"));
const pm = config.premarket ?? {};
const seeded = await readFile(join(HERE, "premarket", "latest.json"), "utf8").catch(() => null);
const scan = seeded ? JSON.parse(seeded) : {
  generatedAt: Date.now(),
  window: "before-premarket",
  sessionDate: null,
  benchmarks: [],
  names: [],
  skipped: [],
  screensScanned: 0,
  notes: ["No scan has been published yet. The board fills in on the next premarket run."],
};

await writeFile(
  join(SITE, "premarket.html"),
  renderPremarketPage(scan, {
    dataUrl: pm.dataUrl ?? "premarket/latest.json",
    refreshMinutes: Number(pm.refreshMinutes) || 5,
    reportHref: "index.html",
  }),
  "utf8",
);

// Also shipped alongside the page, so the board still works from a file:// copy
// or any host that has no access to the data branch.
await mkdir(join(SITE, "premarket"), { recursive: true });
await writeFile(join(SITE, "premarket", "latest.json"), JSON.stringify(scan), "utf8");

// Pages otherwise runs the output through Jekyll, which ignores some files.
await writeFile(join(SITE, ".nojekyll"), "", "utf8");

const kb = (n) => (n / 1024).toFixed(0) + " KB";
console.log(`site/index.html     ${kb(Buffer.byteLength(report, "utf8"))}`);
console.log(`site/practice.html  built`);
console.log(`site/premarket.html ${seeded ? `seeded with ${scan.names?.length ?? 0} names` : "empty seed"}`);
console.log(`\nOpen ${join(SITE, "index.html")}`);

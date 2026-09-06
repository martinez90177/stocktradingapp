/**
 * Imports a thinkorswim / Schwab Account Statement CSV into the journal.
 *
 *   node import-trades.ts "C:/Users/GamerX/Downloads/2026-09-04-AccountStatement.csv"
 *   node import-trades.ts statement.csv --dry
 *
 * Export from thinkorswim: Monitor -> Account Statement, set the date range,
 * gear icon -> Export to file -> CSV.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadJournal, saveJournal, computeStats } from "./src/journal.ts";
import { importTos, dedupe } from "./src/tos.ts";

const ROOT = dirname(fileURLToPath(import.meta.url));
const JOURNAL = join(ROOT, "journal.json");

const argv = process.argv.slice(2);
const dry = argv.includes("--dry");
const file = argv.find((a) => !a.startsWith("--"));

if (!file) {
  console.error("\nUsage: node import-trades.ts <statement.csv> [--dry]\n");
  console.error("  thinkorswim: Monitor -> Account Statement -> gear -> Export to file -> CSV\n");
  process.exitCode = 1;
} else {
  const csv = await readFile(file, "utf8").catch((e) => {
    console.error(`Could not read ${file}: ${e.message}`);
    process.exit(1);
  });

  const { trades, notes } = importTos(csv);
  for (const nte of notes) console.log(`  ~ ${nte}`);

  if (trades.length === 0) {
    console.error("\nNothing to import.\n");
    process.exitCode = 1;
  } else {
    const journal = await loadJournal(JOURNAL);
    const { added, skipped } = dedupe(journal.trades, trades);

    console.log(`\n${trades.length} round trip(s) built, ${skipped} already in the journal, ${added.length} new.\n`);
    for (const t of added.slice(0, 25)) {
      const tag = t.instrument === "option" ? ` ${t.option?.type} ${t.option?.strike}` : "";
      const pnl = (t.pnl ?? 0) >= 0 ? `+$${(t.pnl ?? 0).toFixed(2)}` : `-$${Math.abs(t.pnl ?? 0).toFixed(2)}`;
      console.log(`  ${t.entryTime.slice(0, 10)}  ${t.symbol.padEnd(6)}${t.side.padEnd(6)}${String(t.qty).padStart(4)}${tag.padEnd(12)} ${pnl.padStart(11)}`);
    }
    if (added.length > 25) console.log(`  ... and ${added.length - 25} more`);

    const s = computeStats(added);
    console.log(`\n  net ${s.net >= 0 ? "+" : "-"}$${Math.abs(s.net).toFixed(2)}   ${s.wins}W / ${s.losses}L   win rate ${s.winRate?.toFixed(0) ?? "-"}%\n`);

    if (dry) {
      console.log("--dry: nothing written.\n");
    } else if (added.length > 0) {
      journal.trades.push(...added);
      await saveJournal(JOURNAL, journal);
      console.log(`Written to ${JOURNAL}`);
      console.log(`Run \`node run.ts\` to rebuild the journal page.\n`);
    }
  }
}

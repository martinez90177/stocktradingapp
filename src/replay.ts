import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Bar } from "./types.ts";
import { fetchSeries } from "./yahoo.ts";
import { etDate } from "./intraday.ts";

/**
 * Real trading sessions for the practice terminal.
 *
 * Yahoo only serves seven days of one-minute history, so a single fetch can
 * never build a deep library. Instead every run files the sessions it can see
 * into `sessions/`, and the library grows by a day per symbol per run. The
 * practice page embeds a sample of whatever has accumulated.
 *
 * These are measured bars, not a random walk. Where a minute genuinely had no
 * trade the bar is carried flat at the previous close with zero volume, which
 * states what happened rather than inventing a price, and sessions missing more
 * than a handful of minutes are rejected outright.
 */

const OPEN_MIN = 9 * 60 + 30;
const MINUTES = 390;
const MAX_GAPS = 12;

export interface ReplaySession {
  symbol: string;
  date: string;
  /** 390 bars, 9:30 to 16:00 inclusive of the open minute. */
  bars: [number, number, number, number, number][];
  /** How many of those minutes had no trade and were carried flat. */
  carried: number;
}

const etMinutes = (() => {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  return (t: number) => {
    const p: Record<string, string> = {};
    for (const x of fmt.formatToParts(new Date(t))) p[x.type] = x.value;
    return Number(p.hour) * 60 + Number(p.minute);
  };
})();

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Splits a 1-minute series into complete regular-hours sessions. */
export function splitSessions(symbol: string, bars: Bar[]): ReplaySession[] {
  const byDate = new Map<string, Map<number, Bar>>();
  for (const b of bars) {
    const m = etMinutes(b.t);
    if (m < OPEN_MIN || m >= OPEN_MIN + MINUTES) continue;
    const d = etDate(b.t);
    if (!byDate.has(d)) byDate.set(d, new Map());
    byDate.get(d)!.set(m - OPEN_MIN, b);
  }

  const out: ReplaySession[] = [];
  for (const [date, minutes] of byDate) {
    if (minutes.size < MINUTES - MAX_GAPS) continue;

    const first = minutes.get(0) ?? [...minutes.values()][0];
    if (!first) continue;

    const rows: ReplaySession["bars"] = [];
    let carried = 0;
    let prev = first.c;
    for (let i = 0; i < MINUTES; i++) {
      const b = minutes.get(i);
      if (b) {
        rows.push([r2(b.o), r2(b.h), r2(b.l), r2(b.c), Math.round(b.v)]);
        prev = b.c;
      } else {
        // No trade in this minute: the price did not move, and no volume traded.
        rows.push([r2(prev), r2(prev), r2(prev), r2(prev), 0]);
        carried++;
      }
    }
    out.push({ symbol, date, bars: rows, carried });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Files any new sessions into the library and returns how many were added. */
export async function harvest(
  symbols: string[],
  dir: string,
  cacheDir: string | null,
  onWarn?: (m: string) => void,
): Promise<{ added: number; total: number }> {
  let added = 0;
  for (const symbol of symbols) {
    try {
      const series = await fetchSeries(symbol, {
        range: "7d", interval: "1m", cacheDir: cacheDir ?? undefined, cacheTtl: 1800,
      });
      const sessions = splitSessions(symbol, series.bars);
      const symDir = join(dir, symbol.replace(/[^A-Z0-9_.-]/gi, "_"));
      await mkdir(symDir, { recursive: true });

      for (const s of sessions) {
        const file = join(symDir, `${s.date}.json`);
        try {
          await readFile(file);
          continue; // already filed
        } catch {
          /* new session */
        }
        await writeFile(file, JSON.stringify(s));
        added++;
      }
    } catch (e) {
      onWarn?.(`${symbol}: replay history unavailable (${(e as Error).message})`);
    }
  }

  const total = (await listSessions(dir)).length;
  return { added, total };
}

async function listSessions(dir: string): Promise<{ symbol: string; file: string }[]> {
  const out: { symbol: string; file: string }[] = [];
  let symbols: string[];
  try {
    symbols = await readdir(dir);
  } catch {
    return out;
  }
  for (const symbol of symbols) {
    try {
      for (const f of await readdir(join(dir, symbol))) {
        if (f.endsWith(".json")) out.push({ symbol, file: join(dir, symbol, f) });
      }
    } catch {
      /* not a directory */
    }
  }
  return out;
}

/**
 * Picks a spread of sessions to embed: newest first per symbol, interleaved so
 * one busy ticker cannot crowd out the rest.
 */
export async function loadForEmbed(dir: string, limit = 30): Promise<ReplaySession[]> {
  const all = await listSessions(dir);
  if (all.length === 0) return [];

  const bySymbol = new Map<string, string[]>();
  for (const { symbol, file } of all) {
    if (!bySymbol.has(symbol)) bySymbol.set(symbol, []);
    bySymbol.get(symbol)!.push(file);
  }
  for (const files of bySymbol.values()) files.sort().reverse();

  const picked: string[] = [];
  let round = 0;
  while (picked.length < limit) {
    let took = false;
    for (const files of bySymbol.values()) {
      if (round < files.length && picked.length < limit) {
        picked.push(files[round]);
        took = true;
      }
    }
    if (!took) break;
    round++;
  }

  const out: ReplaySession[] = [];
  for (const file of picked) {
    try {
      out.push(JSON.parse(await readFile(file, "utf8")));
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

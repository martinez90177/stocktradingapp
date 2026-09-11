/**
 * Real implied volatility for the practice terminal's option prices.
 *
 * The terminal's candles are recorded market data, but its option prices are
 * modelled -- nobody gives away historical intraday option quotes. What the
 * model needs most is the volatility the market was actually charging, and
 * that is public: VXN is the implied volatility of Nasdaq-100 options and VIX
 * of S&P 500 options, both published minute by minute.
 *
 * This file records those indexes the same way replay.ts records the stocks,
 * and loads the calibration that maps an index level to each symbol's own
 * options (see tools/calibrate-vol.mjs). Kept out of sessions/ on purpose:
 * everything in there is treated as a tradable ticker.
 */
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fetchSeries } from "./yahoo.ts";
import { splitSessions, fetchMinuteBars } from "./replay.ts";

/** Folder name -> Yahoo symbol. */
export const VOL_INDEXES: Record<string, string> = { VXN: "^VXN", VIX: "^VIX" };

/** Which index drives which symbol's options. Everything not listed follows VXN. */
export const INDEX_FOR: Record<string, string> = { SPY: "VIX", IWM: "VIX", DIA: "VIX" };
export const indexFor = (symbol: string) => INDEX_FOR[symbol] ?? "VXN";

export interface VolDay {
  /** 390 index closes, 9:30 to 15:59, when the day was recorded minute by minute. */
  m?: number[];
  /** The day's opening level, known at 9:30 -- used when there is no minute record. */
  o?: number;
}
export type VolEmbed = Record<string, Record<string, VolDay>>;

export interface Calibration {
  /** The session whose closing option prices were measured. */
  date: string;
  measuredAt: string;
  index: Record<string, number>;
  symbols: Record<string, { index: string; atm: number; ratio: number; skew: number; prints: number; spot: number; expiry: string }>;
}

/**
 * Files new days of VXN and VIX. Yahoo keeps about 30 days of minute records,
 * like the stocks, so this runs with every harvest; daily levels reach back
 * months and cover anything older.
 */
export async function harvestVol(
  dir: string,
  cacheDir: string | null,
  onWarn?: (m: string) => void,
): Promise<{ added: number }> {
  let added = 0;
  const dailyFile = join(dir, "daily.json");
  let daily: Record<string, Record<string, { o: number; c: number }>> = {};
  try { daily = JSON.parse(await readFile(dailyFile, "utf8")); } catch { /* first run */ }

  for (const [name, sym] of Object.entries(VOL_INDEXES)) {
    try {
      // The same 30-day reach as the stocks, so a backfilled day is priced on
      // its own minute-by-minute volatility rather than just its opening level.
      const bars = await fetchMinuteBars(sym, 29, cacheDir);
      const sub = join(dir, name);
      await mkdir(sub, { recursive: true });
      for (const s of splitSessions(name, bars)) {
        const file = join(sub, `${s.date}.json`);
        try { await readFile(file); continue; } catch { /* new day */ }
        await writeFile(file, JSON.stringify({ date: s.date, m: s.bars.map((b) => b[3]) }));
        added++;
      }
    } catch (e) {
      onWarn?.(`${name}: minute volatility unavailable (${(e as Error).message})`);
    }
    try {
      const d = await fetchSeries(sym, { range: "6mo", interval: "1d", cacheDir: cacheDir ?? undefined, cacheTtl: 3600 });
      const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });
      daily[name] = daily[name] ?? {};
      for (const b of d.bars) daily[name][fmt.format(new Date(b.t))] = { o: +b.o.toFixed(2), c: +b.c.toFixed(2) };
    } catch (e) {
      onWarn?.(`${name}: daily volatility unavailable (${(e as Error).message})`);
    }
  }
  await mkdir(dir, { recursive: true });
  await writeFile(dailyFile, JSON.stringify(daily));
  return { added };
}

/** The index levels the embedded sessions need, and nothing else. */
export async function loadVolForEmbed(dir: string, dates: string[]): Promise<VolEmbed> {
  const out: VolEmbed = {};
  let daily: Record<string, Record<string, { o: number; c: number }>> = {};
  try { daily = JSON.parse(await readFile(join(dir, "daily.json"), "utf8")); } catch { /* none yet */ }
  for (const name of Object.keys(VOL_INDEXES)) {
    out[name] = {};
    for (const date of new Set(dates)) {
      try {
        const rec = JSON.parse(await readFile(join(dir, name, `${date}.json`), "utf8"));
        if (Array.isArray(rec.m) && rec.m.length >= 380) { out[name][date] = { m: rec.m }; continue; }
      } catch { /* no minute record for that day */ }
      const d = daily[name]?.[date];
      if (d) out[name][date] = { o: d.o };
    }
  }
  return out;
}

/**
 * Earnings reports, which the volatility model cannot price: before a report a
 * ticker's options carry a premium for the move, and no index level captures
 * it. The practice page warns on any contract whose life spans one rather than
 * pretend. `timing` is "amc" (after the close), "bmo" (before the open), or
 * "unknown" when the calendar does not say.
 */
export interface EarningsEvent { date: string; timing: "amc" | "bmo" | "unknown"; source: string }
export type Events = Record<string, EarningsEvent[]>;

export async function loadEvents(dir: string): Promise<Events> {
  try { return JSON.parse(await readFile(join(dir, "events.json"), "utf8")); } catch { return {}; }
}

/** Files report dates the earnings calendar gives, keeping everything already known. */
export async function recordEvents(dir: string, found: Record<string, number[]>): Promise<number> {
  const ev = await loadEvents(dir);
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });
  let added = 0;
  for (const [sym, times] of Object.entries(found)) {
    for (const t of times) {
      const date = fmt.format(new Date(t));
      ev[sym] = ev[sym] ?? [];
      if (ev[sym].some((e) => e.date === date)) continue;
      ev[sym].push({ date, timing: "unknown", source: "Yahoo earnings calendar" });
      added++;
    }
    ev[sym]?.sort((a, b) => (a.date < b.date ? -1 : 1));
  }
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "events.json"), JSON.stringify(ev, null, 2) + "\n");
  return added;
}

/** Every calibration measured so far, newest last. */
export async function loadCalibrations(dir: string): Promise<Calibration[]> {
  const sub = join(dir, "calibration");
  try {
    const files = (await readdir(sub)).filter((f) => f.endsWith(".json")).sort();
    const out: Calibration[] = [];
    for (const f of files) {
      try { out.push(JSON.parse(await readFile(join(sub, f), "utf8"))); } catch { /* skip */ }
    }
    return out;
  } catch {
    return [];
  }
}

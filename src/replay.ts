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

/** One extended-hours bar: [minutes past 4:00 or past 16:00, o, h, l, c, v]. */
export type ExtBar = [number, number, number, number, number, number];

export interface ReplaySession {
  symbol: string;
  date: string;
  /** 390 bars, 9:30 to 16:00 inclusive of the open minute. */
  bars: [number, number, number, number, number][];
  /** How many of those minutes had no trade and were carried flat. */
  carried: number;
  /**
   * Pre-market (4:00 to 9:29) and after-hours (16:00 to 19:59), in 5-minute
   * bars, only where something traded. Absent on sessions recorded before
   * extended hours were kept and past Yahoo's reach for a backfill.
   */
  ext?: { pre: ExtBar[]; post: ExtBar[] };
}

const PRE_START = 4 * 60;
const POST_START = 16 * 60;
const POST_END = 20 * 60;
const EXT_TF = 5;

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

/**
 * Pre-market and after-hours, per date, in 5-minute bars. The pre-market
 * high and low are the levels a day opens against, and the tinted candles
 * before 9:30 show the drive into the open. Five minutes rather than one
 * keeps twelve days of seven tickers to about 200 KB on the page; sparse,
 * because a five-minute stretch nobody traded has no price to carry.
 */
export function splitExtended(bars: Bar[]): Map<string, { pre: ExtBar[]; post: ExtBar[] }> {
  const byDate = new Map<string, { pre: Map<number, Bar[]>; post: Map<number, Bar[]> }>();
  for (const b of bars) {
    const m = etMinutes(b.t);
    const seg = m >= PRE_START && m < OPEN_MIN ? "pre" : m >= POST_START && m < POST_END ? "post" : null;
    if (!seg) continue;
    const d = etDate(b.t);
    if (!byDate.has(d)) byDate.set(d, { pre: new Map(), post: new Map() });
    const off = m - (seg === "pre" ? PRE_START : POST_START);
    const bucket = Math.floor(off / EXT_TF) * EXT_TF;
    const seg_ = byDate.get(d)![seg];
    if (!seg_.has(bucket)) seg_.set(bucket, []);
    seg_.get(bucket)!.push(b);
  }
  const roll = (m: Map<number, Bar[]>): ExtBar[] =>
    [...m.entries()].sort((a, b) => a[0] - b[0]).map(([off, bs]) => {
      bs.sort((a, b) => a.t - b.t);
      let h = -Infinity, l = Infinity, v = 0;
      for (const b of bs) { if (b.h > h) h = b.h; if (b.l < l) l = b.l; v += b.v; }
      return [off, r2(bs[0].o), r2(h), r2(l), r2(bs[bs.length - 1].c), Math.round(v)];
    });
  const out = new Map<string, { pre: ExtBar[]; post: ExtBar[] }>();
  for (const [d, v] of byDate) out.set(d, { pre: roll(v.pre), post: roll(v.post) });
  return out;
}

/**
 * 1-minute bars reaching `days` back. Yahoo keeps about 30 days of them but
 * gives out 7 per request, so older weeks are fetched a window at a time. The
 * older windows are pinned to UTC midnight so a second run on the same day is
 * served from the cache instead of asking again. `prePost` asks for the
 * extended session too, which is cached apart from the regular one.
 */
export async function fetchMinuteBars(symbol: string, days: number, cacheDir: string | null, prePost = false): Promise<Bar[]> {
  const newest = await fetchSeries(symbol, { range: "7d", interval: "1m", prePost, cacheDir: cacheDir ?? undefined, cacheTtl: 1800 });
  const byT = new Map<number, Bar>(newest.bars.map((b) => [b.t, b]));
  const DAY = 86400, anchor = Math.floor(Date.now() / 1000 / DAY) * DAY;
  // Yahoo refuses a window that starts even slightly more than 30 days back.
  for (let back = 6; back < Math.min(days, 29); back += 7) {
    const p2 = anchor - back * DAY, p1 = Math.max(p2 - 7 * DAY, anchor - 29 * DAY);
    if (p1 >= p2) break;
    try {
      const s = await fetchSeries(symbol, { range: "7d", interval: "1m", prePost, period1: p1, period2: p2, cacheDir: cacheDir ?? undefined, cacheTtl: 86400 });
      for (const b of s.bars) if (!byT.has(b.t)) byT.set(b.t, b);
    } catch {
      break; // past what Yahoo keeps: stop reaching back
    }
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

export async function harvest(
  symbols: string[],
  dir: string,
  cacheDir: string | null,
  onWarn?: (m: string) => void,
  days = 29,
): Promise<{ added: number; extended: number; total: number }> {
  let added = 0;
  let extended = 0;
  for (const symbol of symbols) {
    try {
      const bars = await fetchMinuteBars(symbol, days, cacheDir, true);
      const sessions = splitSessions(symbol, bars);
      const ext = splitExtended(bars);
      const symDir = join(dir, symbol.replace(/[^A-Z0-9_.-]/gi, "_"));
      await mkdir(symDir, { recursive: true });

      for (const s of sessions) {
        const x = ext.get(s.date);
        if (x && (x.pre.length || x.post.length)) s.ext = x;
        const file = join(symDir, `${s.date}.json`);
        let have: ReplaySession | null = null;
        try {
          have = JSON.parse(await readFile(file, "utf8"));
        } catch {
          /* new session */
        }
        if (have) {
          // Filed before extended hours were kept: add them while Yahoo still has them.
          if (!have.ext && s.ext) {
            have.ext = s.ext;
            await writeFile(file, JSON.stringify(have));
            extended++;
          }
          continue;
        }
        await writeFile(file, JSON.stringify(s));
        added++;
      }
    } catch (e) {
      onWarn?.(`${symbol}: replay history unavailable (${(e as Error).message})`);
    }
  }

  const total = (await listSessions(dir)).length;
  return { added, extended, total };
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
 * The newest `perSymbol` sessions of every symbol. Counted per symbol rather
 * than in total: a total of 30 across seven tickers left about four days each,
 * which is both a short list to pick from and a thin history behind the day
 * being traded.
 */
export async function loadForEmbed(dir: string, perSymbol = 12): Promise<ReplaySession[]> {
  const limit = perSymbol * 1000;
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
      if (round < files.length && round < perSymbol && picked.length < limit) {
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

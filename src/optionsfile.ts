/**
 * The shape of a recorded option day, and the one function that grows it.
 *
 * Kept apart from the recorder so that the format has a single definition, and
 * so it can be tested without a market open: tools/record-options.mjs fills
 * these files minute by minute, and the practice terminal reads them back.
 *
 * A day is columnar. `minutes` are the minutes of the session that were
 * actually polled -- there is no pretending about the ones nobody watched --
 * and everything else is aligned to it. Each expiry carries its own strike
 * list and, per minute, one row holding a bid and an ask in cents for each
 * strike in that list, with -1 where the chain quoted nothing and a whole row
 * of `null` where that expiry was not read at all. Fixed-width rows of
 * mostly-unchanging integers, which git compresses to a fraction of their size.
 */

/** One expiry within a recorded day. `call` and `put` are one row per recorded minute. */
export interface OptionExpiry {
  /** The expiry itself, YYYY-MM-DD. */
  date: string;
  /** Strikes, ascending: the union of everything seen that day. */
  strikes: number[];
  /** Per minute: [bid, ask] in cents for each strike, flattened. null where not read. */
  call: (number[] | null)[];
  put: (number[] | null)[];
}

export interface OptionDay {
  symbol: string;
  /** The session, YYYY-MM-DD. */
  date: string;
  /** The feeds this day was recorded from, in the order `src` indexes them. */
  sources?: string[];
  /** Which feed supplied each recorded minute, as an index into `sources`. */
  src?: number[];
  /** Minutes from the 9:30 open that were recorded, ascending. */
  minutes: number[];
  /** The underlying at each of those minutes, in cents. */
  spot: number[];
  /**
   * How far behind the clock the feed's own timestamp was, in seconds, at each
   * recorded minute; -1 where the feed did not say. This is the difference
   * between a quote being this minute's and being a quarter of an hour old,
   * and no feed should be trusted about it without being asked.
   */
  lag?: number[];
  expiries: OptionExpiry[];
}

/** What one sweep of the chain saw: the same shape, for a single minute. */
export interface OptionSweep {
  spot: number;
  /** The feed's own timestamp for this data, epoch ms, where it gives one. */
  at?: number | null;
  /** Which feed this came from. */
  source?: string;
  expiries: { date: string; strikes: number[]; call: number[]; put: number[] }[];
}

export const emptyDay = (symbol: string, date: string): OptionDay =>
  ({ symbol, date, sources: [], minutes: [], spot: [], lag: [], src: [], expiries: [] });

/** Cents, or -1 for a price that is missing rather than zero. */
export const cents = (x: unknown): number =>
  typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.round(x * 100) : -1;

/**
 * Puts one sweep into a day, widening an expiry's strike list where the price
 * has moved far enough to bring new strikes into range. Re-recording a minute
 * replaces it, so a restart mid-session costs nothing.
 */
export function merge(day: OptionDay, minute: number, sweep: OptionSweep, wallMs = Date.now()): OptionDay {
  if (!day.lag) day.lag = day.minutes.map(() => -1);
  if (!day.sources) day.sources = [];
  if (!day.src) day.src = day.minutes.map(() => -1);
  const lag = sweep.at ? Math.max(0, Math.round((wallMs - sweep.at) / 1000)) : -1;
  let si = -1;
  if (sweep.source) {
    si = day.sources.indexOf(sweep.source);
    if (si < 0) si = day.sources.push(sweep.source) - 1;
  }
  const at = day.minutes.indexOf(minute);
  const row = at >= 0 ? at : day.minutes.length;
  if (at < 0) {
    day.minutes.push(minute);
    day.spot.push(cents(sweep.spot));
    day.lag.push(lag);
    day.src.push(si);
  } else {
    day.spot[row] = cents(sweep.spot);
    day.lag[row] = lag;
    day.src[row] = si;
  }

  for (const e of sweep.expiries) {
    let slot = day.expiries.find((x) => x.date === e.date);
    if (!slot) {
      slot = { date: e.date, strikes: [], call: [], put: [] };
      day.expiries.push(slot);
    }
    // A new strike opens the same gap in every row already written, so a row
    // stays exactly two numbers per strike however the band has moved.
    for (const k of e.strikes) {
      if (slot.strikes.includes(k)) continue;
      let i = slot.strikes.findIndex((x) => x > k);
      if (i < 0) i = slot.strikes.length;
      slot.strikes.splice(i, 0, k);
      for (const side of ["call", "put"] as const) {
        for (const line of slot[side]) if (line) line.splice(i * 2, 0, -1, -1);
      }
    }
    const width = slot.strikes.length * 2;
    for (const side of ["call", "put"] as const) {
      while (slot[side].length <= row) slot[side].push(null);
      const line = new Array(width).fill(-1);
      e.strikes.forEach((k, j) => {
        const i = slot!.strikes.indexOf(k);
        line[i * 2] = e[side][j * 2];
        line[i * 2 + 1] = e[side][j * 2 + 1];
      });
      slot[side][row] = line;
    }
  }

  while (day.lag.length < day.minutes.length) day.lag.push(-1);
  while (day.src!.length < day.minutes.length) day.src!.push(-1);
  // An expiry that appeared late keeps nulls for the minutes before it, which
  // read as "not recorded" rather than as a quote of nothing.
  for (const slot of day.expiries) {
    for (const side of ["call", "put"] as const) {
      while (slot[side].length < day.minutes.length) slot[side].push(null);
    }
  }
  return day;
}

/** The feed's typical lag in seconds across a recorded day, or null where it never said. */
export function typicalLag(day: OptionDay): number | null {
  const v = (day.lag ?? []).filter((x) => x >= 0).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
}

/** How many minutes each feed supplied, for a day recorded from more than one. */
export function sourceShare(day: OptionDay): Record<string, number> {
  const out: Record<string, number> = {};
  (day.src ?? []).forEach((i) => {
    const name = i >= 0 ? (day.sources ?? [])[i] ?? "unknown" : "unknown";
    out[name] = (out[name] ?? 0) + 1;
  });
  return out;
}

/** The recorded bid and ask for one contract at one minute, in dollars, or null where none was seen. */
export function quoteAt(
  day: OptionDay,
  expiry: string,
  strike: number,
  type: "call" | "put",
  minute: number,
): { bid: number; ask: number } | null {
  const e = day.expiries.find((x) => x.date === expiry);
  if (!e) return null;
  const k = e.strikes.indexOf(strike);
  if (k < 0) return null;
  // The last minute recorded at or before the one asked for: a gap in the
  // recording holds the previous quote rather than inventing one.
  let row = -1;
  for (let i = 0; i < day.minutes.length; i++) {
    if (day.minutes[i] <= minute) row = i; else break;
  }
  for (; row >= 0; row--) {
    const line = e[type][row];
    if (!line) continue;
    const bid = line[k * 2], ask = line[k * 2 + 1];
    if (bid >= 0 && ask >= 0) return { bid: bid / 100, ask: ask / 100 };
  }
  return null;
}

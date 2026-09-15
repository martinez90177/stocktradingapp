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
  /** Minutes from the 9:30 open that were recorded, ascending. */
  minutes: number[];
  /** The underlying at each of those minutes, in cents. */
  spot: number[];
  expiries: OptionExpiry[];
}

/** What one sweep of the chain saw: the same shape, for a single minute. */
export interface OptionSweep {
  spot: number;
  expiries: { date: string; strikes: number[]; call: number[]; put: number[] }[];
}

export const emptyDay = (symbol: string, date: string): OptionDay =>
  ({ symbol, date, minutes: [], spot: [], expiries: [] });

/** Cents, or -1 for a price that is missing rather than zero. */
export const cents = (x: unknown): number =>
  typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.round(x * 100) : -1;

/**
 * Puts one sweep into a day, widening an expiry's strike list where the price
 * has moved far enough to bring new strikes into range. Re-recording a minute
 * replaces it, so a restart mid-session costs nothing.
 */
export function merge(day: OptionDay, minute: number, sweep: OptionSweep): OptionDay {
  const at = day.minutes.indexOf(minute);
  const row = at >= 0 ? at : day.minutes.length;
  if (at < 0) {
    day.minutes.push(minute);
    day.spot.push(cents(sweep.spot));
  } else {
    day.spot[row] = cents(sweep.spot);
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

  // An expiry that appeared late keeps nulls for the minutes before it, which
  // read as "not recorded" rather than as a quote of nothing.
  for (const slot of day.expiries) {
    for (const side of ["call", "put"] as const) {
      while (slot[side].length < day.minutes.length) slot[side].push(null);
    }
  }
  return day;
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

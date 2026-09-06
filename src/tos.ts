import type { Trade } from "./journal.ts";

/**
 * Imports a thinkorswim / Schwab Account Statement CSV.
 *
 * The export is a multi-section file; the part that matters is the
 * "Account Trade History" block, with columns:
 *
 *   Exec Time, Spread, Side, Qty, Pos Effect, Symbol, Exp, Strike, Type, Price
 *
 * Those rows are **executions, not trades**. A round trip is one or more opens
 * matched against one or more closes, so the importer pairs them FIFO per
 * instrument and only then has an entry, an exit and a P&L. Treating each row
 * as a trade -- which is the usual shortcut -- doubles the trade count and
 * reports a P&L of roughly zero.
 */

/** Splits one CSV line, honouring quoted fields. */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const num = (s: string): number => {
  const v = Number(String(s).replace(/[$,()\s]/g, "").replace(/^-?$/, "0"));
  return Number.isFinite(v) ? v : 0;
};

interface Exec {
  time: string;
  side: "BUY" | "SELL";
  qty: number;
  posEffect: "OPEN" | "CLOSE" | "";
  symbol: string;
  price: number;
  option?: { expiry: string; strike: number; type: "call" | "put" };
}

/**
 * thinkorswim writes times like "1/15/26 09:31:07". Parsed as local wall-clock,
 * which is what the statement means, then stored as an ISO-like local stamp so
 * dates group correctly without a timezone shifting a trade into the wrong day.
 */
function parseTime(s: string): string | null {
  const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const [, mo, d, y, h, mi, se] = m;
  const year = y.length === 2 ? 2000 + Number(y) : Number(y);
  const p = (n: number | string) => String(n).padStart(2, "0");
  return `${year}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:${p(se ?? "00")}`;
}

/** Pulls the Account Trade History rows out of the statement. */
export function parseExecutions(csv: string): { execs: Exec[]; notes: string[] } {
  const notes: string[] = [];
  const lines = csv.split(/\r?\n/);

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/account\s+trade\s+history/i.test(lines[i])) { start = i; break; }
  }
  if (start === -1) {
    notes.push('No "Account Trade History" section found. Export from Monitor → Account Statement, gear icon → Export to file → CSV.');
    return { execs: [], notes };
  }

  // The header is the next line carrying "Exec Time".
  let head = -1;
  for (let i = start; i < Math.min(start + 6, lines.length); i++) {
    if (/exec\s*time/i.test(lines[i])) { head = i; break; }
  }
  if (head === -1) {
    notes.push('Found the trade history section but no "Exec Time" header row under it.');
    return { execs: [], notes };
  }

  const cols = splitCsv(lines[head]).map((c) => c.toLowerCase().replace(/[^a-z]/g, ""));
  const at = (row: string[], name: string) => {
    const i = cols.indexOf(name);
    return i === -1 ? "" : (row[i] ?? "");
  };

  const execs: Exec[] = [];
  let skipped = 0;
  for (let i = head + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) break; // section ends at the first blank line
    const row = splitCsv(line);
    if (row.length < 4) break;

    const time = parseTime(at(row, "exectime"));
    const symbol = at(row, "symbol").toUpperCase();
    if (!time || !symbol) { skipped++; continue; }

    const sideRaw = at(row, "side").toUpperCase();
    const side: Exec["side"] = sideRaw.startsWith("S") ? "SELL" : "BUY";
    const qty = Math.abs(num(at(row, "qty")));
    if (qty === 0) { skipped++; continue; }

    const peRaw = at(row, "poseffect").toUpperCase();
    const posEffect: Exec["posEffect"] = peRaw.includes("OPEN") ? "OPEN" : peRaw.includes("CLOSE") ? "CLOSE" : "";

    const price = Math.abs(num(at(row, "price")));
    const strike = num(at(row, "strike"));
    const typeRaw = at(row, "type").toUpperCase();
    const expiry = at(row, "exp");

    const option =
      strike > 0 && (typeRaw.startsWith("C") || typeRaw.startsWith("P"))
        ? { expiry, strike, type: (typeRaw.startsWith("C") ? "call" : "put") as "call" | "put" }
        : undefined;

    execs.push({ time, side, qty, posEffect, symbol, price, option });
  }

  if (skipped) notes.push(`${skipped} row(s) in the trade history could not be read and were skipped.`);
  if (execs.length === 0) notes.push("The trade history section was empty.");
  return { execs, notes };
}

const keyOf = (e: Exec) =>
  e.option ? `${e.symbol}|${e.option.expiry}|${e.option.strike}|${e.option.type}` : e.symbol;

let seq = 0;
const newId = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;

/**
 * Pairs executions into round-trip trades, FIFO within each instrument.
 *
 * A close larger than the oldest open is split across several opens, and a
 * partial close leaves the remainder of the open still working, so the maths
 * survives scaling in and out.
 */
export function toTrades(execs: Exec[]): { trades: Trade[]; notes: string[] } {
  const notes: string[] = [];
  const trades: Trade[] = [];
  const open = new Map<string, { e: Exec; left: number }[]>();
  let unmatched = 0;

  const sorted = [...execs].sort((a, b) => a.time.localeCompare(b.time));

  for (const e of sorted) {
    const k = keyOf(e);
    if (!open.has(k)) open.set(k, []);
    const lots = open.get(k)!;

    // Pos Effect is authoritative; when the broker leaves it blank, an
    // execution that can close existing inventory on the other side does.
    const opposite = lots.length > 0 && lots[0].e.side !== e.side;
    const isClose = e.posEffect === "CLOSE" || (e.posEffect === "" && opposite);

    if (!isClose) {
      lots.push({ e, left: e.qty });
      continue;
    }

    let remaining = e.qty;
    while (remaining > 0 && lots.length > 0) {
      const lot = lots[0];
      const q = Math.min(remaining, lot.left);
      const long = lot.e.side === "BUY";
      const mult = lot.e.option ? 100 : 1;
      const gross = (long ? e.price - lot.e.price : lot.e.price - e.price) * q * mult;

      trades.push({
        id: newId(),
        source: "tos",
        practice: false,
        symbol: lot.e.symbol,
        side: long ? "long" : "short",
        instrument: lot.e.option ? "option" : "shares",
        option: lot.e.option,
        qty: q,
        entryPrice: lot.e.price,
        entryTime: lot.e.time,
        exitPrice: e.price,
        exitTime: e.time,
        fees: 0,
        plannedStop: null,
        plannedTarget: null,
        pnl: Math.round(gross * 100) / 100,
        setup: null,
        mistakes: [],
        rating: null,
        notes: "",
      });

      lot.left -= q;
      remaining -= q;
      if (lot.left <= 0) lots.shift();
    }
    if (remaining > 0) unmatched++;
  }

  // Anything still open is a live position, not a completed trade.
  let stillOpen = 0;
  for (const lots of open.values()) stillOpen += lots.filter((l) => l.left > 0).length;

  if (unmatched) {
    notes.push(`${unmatched} closing execution(s) had no matching open in this file. Positions opened before the export window will not pair; export a wider date range to fix it.`);
  }
  if (stillOpen) {
    notes.push(`${stillOpen} position(s) are still open at the end of the file and were not imported as completed trades.`);
  }

  return { trades, notes };
}

export function importTos(csv: string): { trades: Trade[]; notes: string[] } {
  const { execs, notes } = parseExecutions(csv);
  if (execs.length === 0) return { trades: [], notes };
  const built = toTrades(execs);
  return { trades: built.trades, notes: [...notes, ...built.notes] };
}

/** Drops rows already present, matching on instrument, times and price. */
export function dedupe(existing: Trade[], incoming: Trade[]): { added: Trade[]; skipped: number } {
  const seen = new Set(
    existing.map((t) => `${t.symbol}|${t.entryTime}|${t.exitTime}|${t.qty}|${t.entryPrice}|${t.exitPrice}`),
  );
  const added: Trade[] = [];
  let skipped = 0;
  for (const t of incoming) {
    const k = `${t.symbol}|${t.entryTime}|${t.exitTime}|${t.qty}|${t.entryPrice}|${t.exitPrice}`;
    if (seen.has(k)) { skipped++; continue; }
    seen.add(k);
    added.push(t);
  }
  return { added, skipped };
}

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * The trade journal: what was taken, why, and what it cost.
 *
 * Practice trades and real trades live in the same store but are never mixed in
 * the statistics. A rehearsal P&L blended into a real win rate would make the
 * number worse than having none at all.
 */

export interface Trade {
  id: string;
  /** "manual" | "tos" | "practice" -- how the row got here. */
  source: "manual" | "tos" | "practice";
  /** Rehearsal, not real money. Kept apart in every statistic. */
  practice: boolean;
  symbol: string;
  side: "long" | "short";
  instrument: "shares" | "option";
  /** Option detail, when instrument is "option". */
  option?: { expiry: string; strike: number; type: "call" | "put" };
  qty: number;
  entryPrice: number;
  entryTime: string;
  exitPrice: number | null;
  exitTime: string | null;
  fees: number;
  /** What you planned before entering, used for the R multiple. */
  plannedStop: number | null;
  plannedTarget: number | null;
  /** Realised profit in dollars, net of fees. Null while the trade is open. */
  pnl: number | null;
  /** Playbook id. */
  setup: string | null;
  /** Mistake tags, e.g. "chased", "moved-stop". */
  mistakes: string[];
  /** Your own 1-5 grade of the execution, not the outcome. */
  rating: number | null;
  notes: string;
}

export interface Playbook {
  id: string;
  name: string;
  description: string;
  checklist: string[];
}

export interface DayNote {
  date: string;
  text: string;
}

export interface Journal {
  trades: Trade[];
  playbooks: Playbook[];
  notes: DayNote[];
}

export const MISTAKES: { id: string; label: string; why: string }[] = [
  { id: "chased", label: "Chased the entry", why: "Entered after the move had already left the level." },
  { id: "no-plan", label: "No plan", why: "Clicked without a written entry, stop and target." },
  { id: "moved-stop", label: "Moved the stop", why: "Widened the stop instead of taking the loss." },
  { id: "oversized", label: "Oversized", why: "Risked more than the plan allowed." },
  { id: "revenge", label: "Revenge trade", why: "Taken to win back a previous loss." },
  { id: "early-exit", label: "Exited early", why: "Closed a working trade before the target on nerves." },
  { id: "held-loser", label: "Held a loser", why: "Stayed in after the reason for the trade was gone." },
  { id: "fomo", label: "FOMO", why: "Entered because it was moving, not because it set up." },
  { id: "overtraded", label: "Overtraded", why: "Took a trade with no setup, out of boredom." },
  { id: "against-plan", label: "Broke the day plan", why: "Traded past the daily loss limit or outside the plan." },
];

const EMPTY: Journal = { trades: [], playbooks: [], notes: [] };

export async function loadJournal(path: string): Promise<Journal> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    return {
      trades: Array.isArray(raw.trades) ? raw.trades : [],
      playbooks: Array.isArray(raw.playbooks) ? raw.playbooks : [],
      notes: Array.isArray(raw.notes) ? raw.notes : [],
    };
  } catch {
    return { ...EMPTY };
  }
}

export async function saveJournal(path: string, j: Journal): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(j, null, 2) + "\n", "utf8");
}

/* ------------------------------------------------------------------ *
 * Derived values
 * ------------------------------------------------------------------ */

/** Dollars risked if the planned stop had been hit, per the position size. */
export function riskOf(t: Trade): number | null {
  if (t.plannedStop == null) return null;
  const mult = t.instrument === "option" ? 100 : 1;
  const per = Math.abs(t.entryPrice - t.plannedStop);
  return per > 0 ? per * t.qty * mult : null;
}

/**
 * The R multiple: profit expressed in units of what was risked.
 *
 * This is the number worth optimising. Dollars flatter a big position and
 * punish a small one; R says whether the trade was good relative to the risk
 * you actually took.
 */
export function rMultiple(t: Trade): number | null {
  const risk = riskOf(t);
  if (risk == null || risk <= 0 || t.pnl == null) return null;
  return t.pnl / risk;
}

export function isClosed(t: Trade): boolean {
  return t.exitPrice != null && t.pnl != null;
}

export interface Stats {
  trades: number;
  wins: number;
  losses: number;
  scratches: number;
  winRate: number | null;
  net: number;
  grossWin: number;
  grossLoss: number;
  /** Gross win over gross loss. Above 1 means the winners pay for the losers. */
  profitFactor: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  /** Average dollars per trade -- the number that actually compounds. */
  expectancy: number | null;
  /** Average R per trade, where the R multiple could be computed. */
  expectancyR: number | null;
  largestWin: number | null;
  largestLoss: number | null;
  maxDrawdown: number;
  bestStreak: number;
  worstStreak: number;
  /** Running net after each trade, for the equity curve. */
  equity: number[];
}

export function computeStats(trades: Trade[]): Stats {
  const closed = trades.filter(isClosed).sort((a, b) => (a.exitTime ?? "").localeCompare(b.exitTime ?? ""));
  const pnls = closed.map((t) => t.pnl as number);

  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const scratches = pnls.filter((p) => p === 0);

  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const net = pnls.reduce((a, b) => a + b, 0);

  // Peak-to-trough of the running equity, which is what a losing run feels like.
  let peak = 0;
  let run = 0;
  let maxDrawdown = 0;
  const equity: number[] = [];
  for (const p of pnls) {
    run += p;
    equity.push(run);
    peak = Math.max(peak, run);
    maxDrawdown = Math.max(maxDrawdown, peak - run);
  }

  let best = 0;
  let worst = 0;
  let cur = 0;
  for (const p of pnls) {
    if (p > 0) cur = cur > 0 ? cur + 1 : 1;
    else if (p < 0) cur = cur < 0 ? cur - 1 : -1;
    else cur = 0;
    best = Math.max(best, cur);
    worst = Math.min(worst, cur);
  }

  const rs = closed.map(rMultiple).filter((r): r is number => r != null);

  return {
    trades: closed.length,
    wins: wins.length,
    losses: losses.length,
    scratches: scratches.length,
    winRate: closed.length ? (wins.length / closed.length) * 100 : null,
    net,
    grossWin,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null,
    avgWin: wins.length ? grossWin / wins.length : null,
    avgLoss: losses.length ? -grossLoss / losses.length : null,
    expectancy: closed.length ? net / closed.length : null,
    expectancyR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
    largestWin: wins.length ? Math.max(...wins) : null,
    largestLoss: losses.length ? Math.min(...losses) : null,
    maxDrawdown,
    bestStreak: best,
    worstStreak: Math.abs(worst),
    equity,
  };
}

/** Net P&L per calendar day, for the calendar heat map. */
export function byDay(trades: Trade[]): Map<string, { net: number; trades: number }> {
  const out = new Map<string, { net: number; trades: number }>();
  for (const t of trades) {
    if (!isClosed(t) || !t.exitTime) continue;
    const day = t.exitTime.slice(0, 10);
    const cur = out.get(day) ?? { net: 0, trades: 0 };
    cur.net += t.pnl as number;
    cur.trades++;
    out.set(day, cur);
  }
  return out;
}

/** Stats sliced by a key, e.g. per playbook or per mistake tag. */
export function groupStats(
  trades: Trade[],
  keyOf: (t: Trade) => string[],
): { key: string; stats: Stats }[] {
  const buckets = new Map<string, Trade[]>();
  for (const t of trades) {
    for (const k of keyOf(t)) {
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k)!.push(t);
    }
  }
  return [...buckets.entries()]
    .map(([key, ts]) => ({ key, stats: computeStats(ts) }))
    .sort((a, b) => a.stats.net - b.stats.net);
}

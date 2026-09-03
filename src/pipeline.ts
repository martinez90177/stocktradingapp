import type { Analysis, Series } from "./types.ts";
import { fetchSeries } from "./yahoo.ts";
import { analyze } from "./analyze.ts";
import { buildCatalysts, fetchFundamentals, fetchNews } from "./catalysts.ts";
import { buildOptionsView } from "./options.ts";

export interface PipelineOptions {
  cacheDir: string | null;
  maxLevels?: number;
  dailyTtl?: number;
  intraTtl?: number;
  fundamentalsTtl?: number;
  newsTtl?: number;
  /** Set false to skip the options chain entirely. */
  options?: boolean;
  optionsTtl?: number;
  /** Called with non-fatal problems, e.g. a missing intraday feed. */
  onWarn?: (message: string) => void;
}

/**
 * The full read for one symbol: daily history, intraday session context,
 * catalysts, then the analysis over all of it.
 *
 * Shared so the scheduled report and the ad-hoc lookup cannot drift apart --
 * a level you look up at 11am is computed exactly the way the 8:15 run
 * computed it.
 */
export async function analyzeSymbol(symbol: string, opts: PipelineOptions): Promise<Analysis> {
  const cacheDir = opts.cacheDir ?? undefined;

  const daily: Series = await fetchSeries(symbol, {
    range: "2y", interval: "1d", cacheDir, cacheTtl: opts.dailyTtl ?? 3600,
  });

  let intraday: Series | null = null;
  try {
    intraday = await fetchSeries(symbol, {
      range: "5d", interval: "5m", prePost: true, cacheDir, cacheTtl: opts.intraTtl ?? 90,
    });
  } catch (e) {
    // The daily read stands on its own; only the session levels are lost.
    opts.onWarn?.(`${symbol}: intraday unavailable (${(e as Error).message})`);
  }

  const [fund, news] = await Promise.all([
    fetchFundamentals(symbol, opts.cacheDir, opts.fundamentalsTtl ?? 6 * 3600),
    fetchNews(symbol, opts.cacheDir, opts.newsTtl ?? 900, 8, daily.name),
  ]);

  const result = analyze(daily, intraday, opts.maxLevels ?? 9, buildCatalysts(fund, news, fund != null));

  // The chain is mapped onto the finished levels, so it runs last. Plenty of
  // symbols have no listed options; that is a normal outcome, not an error.
  if (opts.options !== false) {
    try {
      result.options = await buildOptionsView(result, opts.cacheDir, opts.optionsTtl ?? 600);
    } catch (e) {
      opts.onWarn?.(`${symbol}: options chain unavailable (${(e as Error).message})`);
    }
  }

  return result;
}

/** Plain-text level table, for terminal output. */
export function levelsText(a: Analysis): string {
  const lines: string[] = [];
  const w = (s: string, n: number) => s.padEnd(n);
  lines.push(`${a.symbol}  ${a.price.toFixed(2)}  ${a.changePct >= 0 ? "+" : ""}${a.changePct.toFixed(2)}%   grade ${a.grade.letter} (${a.grade.total.toFixed(0)}/100)  bias ${a.grade.bias}`);
  lines.push(`${a.name}`);
  if (a.session) lines.push(`\n  ${a.session.narrative}`);
  lines.push(`\n  ${w("PRICE", 11)}${w("DIST", 10)}${w("ATR", 8)}${w("CONF", 6)}WHAT AGREES`);

  const rows = a.levels.slice().sort((x, y) => y.price - x.price);
  let priceShown = false;
  for (const l of rows) {
    if (!priceShown && l.price < a.price) {
      lines.push(`  ${"-".repeat(28)}  price ${a.price.toFixed(2)}  ${"-".repeat(20)}`);
      priceShown = true;
    }
    lines.push(
      `  ${w(l.price.toFixed(2), 11)}${w(`${l.distancePct >= 0 ? "+" : ""}${l.distancePct.toFixed(2)}%`, 10)}` +
      `${w(`${l.distanceAtr >= 0 ? "+" : ""}${l.distanceAtr.toFixed(1)}`, 8)}${w(String(l.methods.length), 6)}${l.methods.join(", ")}`,
    );
  }
  if (!priceShown) lines.push(`  ${"-".repeat(28)}  price ${a.price.toFixed(2)}  ${"-".repeat(20)}`);

  const fib = a.fibs[0];
  if (fib) {
    lines.push(`\n  ${fib.label}: ${fib.anchorLow.toFixed(2)} -> ${fib.anchorHigh.toFixed(2)}   golden pocket ${fib.goldenPocket.low.toFixed(2)} - ${fib.goldenPocket.high.toFixed(2)}`);
  }
  for (const p of a.patterns.slice(0, 3)) {
    lines.push(`  ${p.status.toUpperCase()}: ${p.name}${p.trigger != null ? `  trigger ${p.trigger.toFixed(2)}` : ""}`);
  }
  for (const f of a.catalysts?.flags ?? []) lines.push(`  ! ${f.label}`);
  return lines.join("\n");
}

import { join } from "node:path";
import type { Analysis, OptionIdea, OptionsView } from "./types.ts";
import { authedJson, cachedJson } from "./catalysts.ts";

/* ------------------------------------------------------------------ *
 * Black-Scholes delta
 * ------------------------------------------------------------------ */

/** Abramowitz & Stegun 7.1.26 error function, good to ~1e-7. */
function erf(x: number): number {
  const s = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-a * a);
  return s * y;
}

const normCdf = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));

/**
 * Black-Scholes delta. Yahoo does not publish greeks, so this is computed from
 * the quoted implied volatility rather than reported by the exchange -- close
 * enough to compare contracts, not a substitute for your broker's figure.
 */
function delta(
  kind: "call" | "put",
  spot: number,
  strike: number,
  years: number,
  iv: number,
  rate = 0.04,
): number | null {
  if (!(spot > 0 && strike > 0 && years > 0 && iv > 0)) return null;
  const d1 = (Math.log(spot / strike) + (rate + (iv * iv) / 2) * years) / (iv * Math.sqrt(years));
  const nd1 = normCdf(d1);
  return kind === "call" ? nd1 : nd1 - 1;
}

/* ------------------------------------------------------------------ *
 * Chain fetch
 * ------------------------------------------------------------------ */

interface RawContract {
  strike: number;
  lastPrice: number;
  bid: number;
  ask: number;
  volume?: number;
  openInterest?: number;
  impliedVolatility?: number;
  inTheMoney?: boolean;
  contractSymbol: string;
  expiration: number;
}

async function fetchChain(symbol: string, expiry: number | null, cacheDir: string | null, ttl: number) {
  const key = `opt_${symbol.replace(/[^a-zA-Z0-9_.-]/g, "_")}${expiry ? `_${expiry}` : ""}.json`;
  const file = cacheDir ? join(cacheDir, key) : null;
  return cachedJson<any | null>(file, ttl, async () => {
    const base = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}${
      expiry ? `?date=${expiry}` : ""
    }`;
    const j = await authedJson(base);
    return j?.optionChain?.result?.[0] ?? null;
  });
}

/* ------------------------------------------------------------------ *
 * Contract shortlist
 * ------------------------------------------------------------------ */

const DAY = 86_400_000;

function build(
  kind: "call" | "put",
  c: RawContract,
  spot: number,
  expiryMs: number,
  atr: number,
  label: string,
  targetLevel: number | null,
): OptionIdea | null {
  const bid = Number(c.bid) || 0;
  const ask = Number(c.ask) || 0;
  const last = Number(c.lastPrice) || 0;
  // A contract with no two-sided market cannot be priced honestly.
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : last > 0 ? last : 0;
  if (mid <= 0) return null;

  const spread = bid > 0 && ask > 0 ? ask - bid : null;
  const spreadPct = spread != null && mid > 0 ? (spread / mid) * 100 : null;
  const days = Math.max(0, (expiryMs - Date.now()) / DAY);
  const years = days / 365;
  const iv = Number(c.impliedVolatility) || 0;

  const breakeven = kind === "call" ? c.strike + mid : c.strike - mid;
  const moveNeededPct = ((breakeven - spot) / spot) * 100;

  // What the stock typically covers over the contract's life, from its own
  // realised range rather than the option's implied vol.
  const expectedMove = atr > 0 ? atr * Math.sqrt(Math.max(days, 0.5)) : null;
  const needed = Math.abs(breakeven - spot);
  const moveRatio = expectedMove && expectedMove > 0 ? needed / expectedMove : null;

  return {
    kind,
    label,
    contractSymbol: c.contractSymbol,
    strike: c.strike,
    expiry: expiryMs,
    days,
    bid, ask, mid,
    spread, spreadPct,
    volume: Number(c.volume) || 0,
    openInterest: Number(c.openInterest) || 0,
    iv: iv > 0 ? iv : null,
    inTheMoney: c.inTheMoney === true,
    breakeven,
    moveNeededPct,
    expectedMove,
    moveRatio,
    delta: delta(kind, spot, c.strike, years, iv),
    targetLevel,
    liquidity: liquidityGrade(Number(c.openInterest) || 0, Number(c.volume) || 0, spreadPct),
  };
}

/**
 * The practical trap in retail options is not direction, it is paying a wide
 * spread on a contract nobody trades. Open interest, volume and the spread as a
 * share of the premium decide whether you can get in and back out.
 */
function liquidityGrade(oi: number, vol: number, spreadPct: number | null): OptionIdea["liquidity"] {
  if (spreadPct == null) return { tier: "thin", why: "no two-sided quote" };
  if (oi < 100 || spreadPct > 25) {
    return { tier: "thin", why: `${oi} open interest, ${spreadPct.toFixed(0)}% spread` };
  }
  if (oi < 1000 || spreadPct > 10) {
    return { tier: "fair", why: `${oi} open interest, ${spreadPct.toFixed(0)}% spread` };
  }
  return { tier: "good", why: `${oi.toLocaleString("en-US")} open interest, ${spreadPct.toFixed(1)}% spread` };
}

const nearestStrike = (list: RawContract[], target: number) =>
  list.length === 0
    ? null
    : list.reduce((best, c) => (Math.abs(c.strike - target) < Math.abs(best.strike - target) ? c : best));

/**
 * Assembles the chain context for one symbol: a couple of expiries, and within
 * each the contracts that sit at the money and at the measured levels.
 *
 * This maps the chain onto levels already computed from price. It does not pick
 * a trade -- the numbers that decide one are put side by side instead.
 */
export async function buildOptionsView(
  a: Analysis,
  cacheDir: string | null,
  ttl = 600,
): Promise<OptionsView | null> {
  const root = await fetchChain(a.symbol, null, cacheDir, ttl);
  if (!root || !Array.isArray(root.expirationDates) || root.expirationDates.length === 0) return null;

  const spot = a.price;
  const atr = a.indicators.atr14 ?? 0;
  const now = Date.now();

  // Three horizons: the next expiry, roughly a week out, roughly a month out.
  const expiries: number[] = root.expirationDates.map((d: number) => d * 1000);
  const pick = (targetDays: number) => {
    const eligible = expiries.filter((e) => (e - now) / DAY >= targetDays - 1.5);
    return eligible.length > 0 ? eligible[0] : null;
  };
  const chosen = [...new Set([pick(0), pick(6), pick(25)].filter((e): e is number => e != null))].slice(0, 3);
  if (chosen.length === 0) return null;

  const firstRes = a.levels.filter((l) => l.side === "resistance").sort((x, y) => x.price - y.price)[0];
  const firstSup = a.levels.filter((l) => l.side === "support").sort((x, y) => y.price - x.price)[0];

  const groups: OptionsView["groups"] = [];

  for (const expiryMs of chosen) {
    const isFirst = expiryMs === (root.options?.[0]?.expirationDate ?? 0) * 1000;
    const data = isFirst ? root : await fetchChain(a.symbol, Math.round(expiryMs / 1000), cacheDir, ttl);
    const opt = data?.options?.[0];
    if (!opt) continue;

    const calls: RawContract[] = opt.calls ?? [];
    const puts: RawContract[] = opt.puts ?? [];
    const ideas: OptionIdea[] = [];

    const atmCall = nearestStrike(calls, spot);
    if (atmCall) {
      const i = build("call", atmCall, spot, expiryMs, atr, "At the money", null);
      if (i) ideas.push(i);
    }
    if (firstRes) {
      const c = nearestStrike(calls, firstRes.price);
      if (c && (!atmCall || c.strike !== atmCall.strike)) {
        const i = build("call", c, spot, expiryMs, atr, `Strike at first resistance`, firstRes.price);
        if (i) ideas.push(i);
      }
    }
    const atmPut = nearestStrike(puts, spot);
    if (atmPut) {
      const i = build("put", atmPut, spot, expiryMs, atr, "At the money", null);
      if (i) ideas.push(i);
    }
    if (firstSup) {
      const p = nearestStrike(puts, firstSup.price);
      if (p && (!atmPut || p.strike !== atmPut.strike)) {
        const i = build("put", p, spot, expiryMs, atr, `Strike at first support`, firstSup.price);
        if (i) ideas.push(i);
      }
    }

    if (ideas.length > 0) {
      groups.push({
        expiry: expiryMs,
        days: Math.max(0, (expiryMs - now) / DAY),
        ideas,
      });
    }
  }

  if (groups.length === 0) return null;

  // Implied vol at the money, and what the market is pricing for the nearest
  // expiry versus what the stock has actually been doing.
  const atmIv = groups[0].ideas.find((i) => i.label === "At the money")?.iv ?? null;
  const impliedDayMove =
    atmIv != null && spot > 0 ? spot * atmIv * Math.sqrt(1 / 252) : null;

  return {
    spot,
    atmIv,
    impliedDayMove,
    atrDayMove: atr > 0 ? atr : null,
    groups,
  };
}

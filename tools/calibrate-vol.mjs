/**
 * Measures how each symbol's options are priced relative to VXN or VIX, from
 * real option trades, and files it for the practice terminal.
 *
 *   node tools/calibrate-vol.mjs
 *
 * Best run before the open or after the close, when the last prints are the
 * closing ones; during the session it measures the market as it stands. For
 * every symbol with recorded sessions or on the watchlist it takes the nearest
 * expiry, keeps out-of-the-money prints made within 20 minutes of the last
 * trade in the stock, backs an implied volatility out of each, and records:
 *
 *   atm    implied volatility at the money
 *   ratio  atm divided by the index level at the same moment
 *   skew   how volatility changes per unit of log-moneyness, near the money
 *
 * The practice page multiplies the replayed day's own index level by `ratio`,
 * so a quiet day is priced as quiet and a frightened one as frightened.
 *
 * Writes volatility/calibration/<session date>.json.
 */
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { authedJson } = await import(pathToFileURL(join(ROOT, "src", "catalysts.ts")).href);
const { indexFor, VOL_INDEXES } = await import(pathToFileURL(join(ROOT, "src", "volindex.ts")).href);

const N = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
const bs = (S, K, s, T, type, r = 0.04) => { const sq = s * Math.sqrt(T), d1 = (Math.log(S / K) + (r + s * s / 2) * T) / sq, d2 = d1 - sq;
  return type === "call" ? S * N(d1) - K * Math.exp(-r * T) * N(d2) : K * Math.exp(-r * T) * N(-d2) - S * N(-d1); };
const impliedVol = (S, K, p, T, type) => { let lo = 0.005, hi = 5;
  if (bs(S, K, hi, T, type) < p || bs(S, K, lo, T, type) > p) return null;
  for (let k = 0; k < 70; k++) { const m = (lo + hi) / 2; bs(S, K, m, T, type) > p ? hi = m : lo = m; } return lo; };

const et = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const etParts = (ms) => { const o = {}; for (const x of et.formatToParts(new Date(ms))) o[x.type] = x.value;
  return { date: `${o.year}-${o.month}-${o.day}`, min: (+o.hour % 24) * 60 + +o.minute }; };

/** Trading days from `nowMs` to the 4:00pm close on `expiryMs`, counting only what is left of today. */
function tradingDaysTo(nowMs, expiryMs) {
  // Yahoo stamps an expiry at midnight UTC of the expiry day. Read it in UTC:
  // shifted into New York time it lands on the evening before.
  const now = etParts(nowMs), exp = new Date(expiryMs).toISOString().slice(0, 10);
  let days = now.min >= 570 && now.min < 960 ? (960 - now.min) / 390 : 0;
  const d = new Date(now.date + "T12:00:00Z");
  for (;;) { d.setUTCDate(d.getUTCDate() + 1); const s = d.toISOString().slice(0, 10); if (s > exp) break;
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) days += 1; }
  return days;
}

async function symbols() {
  const set = new Set();
  try { for (const s of await readdir(join(ROOT, "sessions"))) set.add(s); } catch {}
  try { for (const s of JSON.parse(await readFile(join(ROOT, "watchlist.json"), "utf8")).symbols ?? []) set.add(s.toUpperCase()); } catch {}
  return [...set].filter((s) => /^[A-Z.]+$/.test(s)).sort();
}

async function measure(sym) {
  const base = `https://query2.finance.yahoo.com/v7/finance/options/${sym}`;
  const first = await authedJson(base);
  const r0 = first?.optionChain?.result?.[0];
  if (!r0) return { sym, why: "no chain" };
  for (const exp of r0.expirationDates.slice(0, 2)) {
    const j = exp === r0.expirationDates[0] ? first : await authedJson(`${base}?date=${exp}`);
    const r = j?.optionChain?.result?.[0]; if (!r) continue;
    const S = r.quote.regularMarketPrice, at = r.quote.regularMarketTime * 1000, o = r.options[0];
    const Tdays = tradingDaysTo(at, o.expirationDate * 1000);
    if (Tdays < 0.2) continue;                    // too close to expiry to read cleanly
    const T = Tdays / 252, pts = [];
    for (const [type, list] of [["call", o.calls], ["put", o.puts]]) for (const c of list) {
      const x = Math.log(c.strike / S);
      if ((at - c.lastTradeDate * 1000) / 60000 > 20) continue;
      if (Math.abs(x) > 0.04 || (type === "call" && c.strike < S) || (type === "put" && c.strike > S) || !(c.lastPrice > 0.03)) continue;
      const v = impliedVol(S, c.strike, c.lastPrice, T, type); if (v) pts.push({ x, v });
    }
    const near = pts.filter((p) => Math.abs(p.x) < 0.02);
    if (near.length < 4) continue;
    const w = (p) => 1 / (Math.abs(p.x) + 0.002);
    const atm = near.reduce((a, p) => a + p.v * w(p), 0) / near.reduce((a, p) => a + w(p), 0);
    const mx = near.reduce((a, p) => a + p.x, 0) / near.length, my = near.reduce((a, p) => a + p.v, 0) / near.length;
    const den = near.reduce((a, p) => a + (p.x - mx) ** 2, 0);
    const skew = den > 0 ? near.reduce((a, p) => a + (p.x - mx) * (p.v - my), 0) / den : 0;
    return { sym, S, at, atm, skew, skewT: Tdays, prints: pts.length, expiry: new Date(o.expirationDate * 1000).toISOString().slice(0, 10) };
  }
  return { sym, why: "too few fresh prints near the money" };
}

const index = {};
let stamp = 0;
for (const [name, y] of Object.entries(VOL_INDEXES)) {
  const j = await authedJson(`https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(y)}`);
  const q = j?.quoteResponse?.result?.[0];
  if (q?.regularMarketPrice) { index[name] = q.regularMarketPrice; stamp = Math.max(stamp, (q.regularMarketTime ?? 0) * 1000); }
}
if (!index.VXN || !index.VIX) { console.error("Could not read VXN and VIX; nothing written."); process.exit(1); }

const out = { date: "", measuredAt: new Date().toISOString(), index, symbols: {} };
for (const sym of await symbols()) {
  const m = await measure(sym);
  if (m.why) { console.log(`  ${sym.padEnd(6)} skipped: ${m.why}`); continue; }
  const idx = indexFor(sym), ratio = m.atm / (index[idx] / 100);
  out.date = out.date || etParts(m.at).date;
  out.symbols[sym] = { index: idx, atm: +m.atm.toFixed(4), ratio: +ratio.toFixed(3), skew: +m.skew.toFixed(3), skewT: +m.skewT.toFixed(2),
    prints: m.prints, spot: m.S, expiry: m.expiry };
  console.log(`  ${sym.padEnd(6)} ${(m.atm * 100).toFixed(1).padStart(5)}% at the money  = ${ratio.toFixed(2)} x ${idx}   skew ${m.skew.toFixed(2)}   ${m.prints} prints, ${m.expiry}`);
}
if (!Object.keys(out.symbols).length) { console.error("No symbol could be measured; nothing written."); process.exit(1); }
const dir = join(ROOT, "volatility", "calibration");
await mkdir(dir, { recursive: true });
await writeFile(join(dir, `${out.date}.json`), JSON.stringify(out, null, 2));
console.log(`\nVXN ${index.VXN}  VIX ${index.VIX}  ->  volatility/calibration/${out.date}.json`);
